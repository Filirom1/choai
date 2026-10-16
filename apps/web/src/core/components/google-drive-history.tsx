import { For, Show, createEffect, createSignal, on, onMount, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { DriveSnag } from "~/core/components/google-drive-panel"
import { DiffView } from "~/core/components/git/diff-view"
import { accessToken, getRevisionContent, loadIdentity, readDriveHistory, sessionToken, type DriveHistory, type DriveRevision, type Failure, type Snag } from "~/core/google-drive/index"
import { clientIdNow } from "~/core/google-drive/kept"
import { aroundChanges, changes, lineDiff } from "~/core/lib/diff"
import { Ok, type Result } from "~/core/lib/monad"
import type { GoogleDriveRemote } from "~/core/journal/remote"
import { t } from "~/core/i18n"

export function GoogleDriveHistory(props: {
  readonly remote: GoogleDriveRemote
  readonly revision: string | undefined
  readonly onChoose: (revision: string | undefined) => void
}): JSX.Element {
  const [history, setHistory] = createSignal<DriveHistory | undefined>()
  const [detail, setDetail] = createSignal<Result<{ readonly before: string; readonly after: string }, Failure> | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [snag, setSnag] = createSignal<Snag | undefined>()
  const [needsConnection, setNeedsConnection] = createSignal(false)
  const [detailAttempt, setDetailAttempt] = createSignal(0)

  const load = async (authorize: boolean): Promise<void> => {
    setBusy(true)
    setSnag(undefined)
    setNeedsConnection(false)
    const saved = sessionToken(clientIdNow())
    const identity = saved === undefined && authorize ? await loadIdentity() : Ok(undefined)
    if (!identity.ok) {
      setBusy(false)
      setNeedsConnection(true)
      return
    }
    const token = saved === undefined
      ? authorize ? await accessToken(clientIdNow()) : undefined
      : Ok(saved)
    if (token === undefined) {
      setBusy(false)
      setNeedsConnection(true)
      return
    }
    if (!token.ok) {
      setBusy(false)
      setNeedsConnection(true)
      return
    }
    const result = await readDriveHistory(token.value, props.remote)
    setBusy(false)
    if (!result.ok) {
      setSnag({ at: "drive", failure: result.error })
      setHistory(undefined)
      return
    }
    setHistory(result.value)
  }

  onMount(() => {
    if (sessionToken(clientIdNow()) !== undefined) void load(false)
    else setNeedsConnection(true)
  })

  const choose = (revision: DriveRevision): void => props.onChoose(revision.id)

  const selectedRevision = (): DriveRevision | undefined => {
    const revisions = history()?.revisions ?? []
    return revisions.find(({ id }) => id === props.revision) ?? (props.revision === undefined ? revisions[0] : undefined)
  }

  createEffect(on([() => props.revision, history], ([revisionId, read]) => {
    setDetail(undefined)
    const attempt = detailAttempt() + 1
    setDetailAttempt(attempt)
    const token = sessionToken(clientIdNow())
    const selected = read?.revisions.findIndex(({ id }) => id === revisionId) ?? -1
    const index = selected < 0 && revisionId === undefined ? 0 : selected
    const revision = read?.revisions[index]
    if (token === undefined || read === undefined || revision === undefined) {
      setBusy(false)
      return
    }
    setBusy(true)
    const previous = read.revisions[index + 1]
    void Promise.all([
      getRevisionContent(token, read.file.id, revision.id),
      previous === undefined ? Promise.resolve(Ok("")) : getRevisionContent(token, read.file.id, previous.id),
    ]).then(([after, before]) => {
      if (detailAttempt() !== attempt) return
      setBusy(false)
      setDetail(!after.ok ? after : !before.ok ? before : Ok({ before: before.value, after: after.value }))
      if (!after.ok) setSnag({ at: "drive", failure: after.error })
      else if (!before.ok) setSnag({ at: "drive", failure: before.error })
    })
  }))
  const selectedDetail = () => {
    const result = detail()
    return result?.ok === true ? result.value : undefined
  }
  const diff = () => {
    const result = detail()
    return result?.ok === true ? lineDiff(result.value.before, result.value.after) : undefined
  }
  const totals = () => {
    const lines = diff()
    return lines === undefined ? undefined : changes(lines)
  }

  return (
    <div class="@container flex flex-col gap-3">
      <header class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-sm font-medium">{t("gdrive.historyGraph")}</h2>
          <p class="truncate text-xs text-muted-foreground">{props.remote.path}</p>
        </div>
        <Button variant="ghost" size="sm" disabled={busy()} onClick={() => void load(true)}>{t("gdrive.readAgain")}</Button>
      </header>

      <Show when={busy()}><p class="text-xs text-muted-foreground">{t("gdrive.readingHistory")}</p></Show>
      <Show when={needsConnection()}>
        <div class="flex items-center gap-2">
          <p class="text-xs text-muted-foreground">{t("gdrive.historyConnect")}</p>
          <Button variant="outline" size="sm" disabled={busy()} onClick={() => void load(true)}>{t("gdrive.connect")}</Button>
        </div>
      </Show>
      <Show when={snag()}>{(cause) => <DriveSnag snag={cause()} />}</Show>

      <Show when={history()}>{(read) => (
        <Show when={read().revisions.length > 0} fallback={<p class="text-sm text-muted-foreground">{t("gdrive.noRevisions")}</p>}>
          <div class="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <ul class="flex min-w-0 flex-col">
              <For each={read().revisions}>{(revision, index) => (
                <li>
                  <button
                    type="button"
                    onClick={() => choose(revision)}
                    class="flex w-full items-center gap-2 pr-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                    classList={{ "bg-accent text-accent-foreground": props.revision === revision.id || (props.revision === undefined && index() === 0) }}
                  >
                    <RevisionNode latest={index() === 0} selected={props.revision === revision.id || (props.revision === undefined && index() === 0)} />
                    <span class="flex min-w-0 flex-1 items-center gap-2 py-2">
                      <span class="min-w-0 flex-1 truncate">{revision.lastModifyingUser?.displayName ?? revision.lastModifyingUser?.emailAddress ?? t("gdrive.unknownAuthor")}</span>
                      <Show when={index() === 0}><span class="shrink-0 rounded border border-primary px-1.5 py-px text-[0.65rem] font-medium text-primary">{t("gdrive.currentRevision")}</span></Show>
                      <Show when={revision.keepForever}><span class="shrink-0 rounded border px-1.5 py-px text-[0.65rem]">{t("gdrive.keptRevision")}</span></Show>
                      <span class="hidden shrink-0 text-muted-foreground @md:inline">{dateOf(revision)}</span>
                    </span>
                  </button>
                </li>
              )}</For>
            </ul>
            <div class="order-first min-w-0 @3xl:order-none">
              <Show when={selectedRevision()} fallback={<p class="hidden text-xs text-muted-foreground @3xl:block">{t("gdrive.chooseRevision")}</p>}>
                {(revision) => (
                  <Show when={selectedDetail()}>
                    <article class="flex flex-col gap-3">
                      <header class="flex flex-col gap-1">
                        <p class="text-sm font-medium">{revision().lastModifyingUser?.displayName ?? revision().lastModifyingUser?.emailAddress ?? t("gdrive.unknownAuthor")}</p>
                        <p class="text-xs text-muted-foreground">
                          {dateOf(revision())} · <code>{revision().id.slice(0, 8)}</code>
                        </p>
                        <Show when={totals()}>{(count) => <p class="text-xs text-muted-foreground">{t("gdrive.revisionChanges", { added: count().added, removed: count().removed })}</p>}</Show>
                      </header>
                      <Show when={diff()}>{(lines) => <DiffView lines={aroundChanges(lines())} />}</Show>
                    </article>
                  </Show>
                )}
              </Show>
            </div>
          </div>
        </Show>
      )}</Show>
    </div>
  )
}

const dateOf = (revision: DriveRevision): string =>
  revision.modifiedTime === undefined ? "" : new Date(revision.modifiedTime).toLocaleString()

function RevisionNode(props: { readonly latest: boolean; readonly selected: boolean }): JSX.Element {
  return (
    <svg width="24" height="40" viewBox="0 0 24 40" class="shrink-0" aria-hidden="true">
      <line x1="12" y1="0" x2="12" y2="40" stroke="var(--border)" stroke-width="2" />
      <circle cx="12" cy="20" r={props.latest ? 5 : 4} fill={props.selected ? "var(--background)" : "var(--primary)"} stroke="var(--primary)" stroke-width="2" />
    </svg>
  )
}

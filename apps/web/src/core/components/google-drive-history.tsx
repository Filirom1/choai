import { For, Show, createEffect, createSignal, on, onMount, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { DriveSnag } from "~/core/components/google-drive-panel"
import { DiffView } from "~/core/components/git/diff-view"
import { PinIcon, Trash2Icon } from "~/core/lib/ui/icons"
import { accessToken, deleteRevision, forgetSession, getRevisionContent, loadIdentity, pinRevision, readDriveHistory, sessionToken, type DriveHistory, type DriveRevision, type Failure, type Snag } from "~/core/google-drive/index"
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
  const [detail, setDetail] = createSignal<Result<{ readonly before: string | undefined; readonly after: string }, Failure> | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [snag, setSnag] = createSignal<Snag | undefined>()
  const [needsConnection, setNeedsConnection] = createSignal(false)
  const [detailAttempt, setDetailAttempt] = createSignal(0)
  const [changingRevision, setChangingRevision] = createSignal<{ readonly id: string; readonly action: "keep" | "delete" } | undefined>()

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
      if (result.error.kind === "unauthorised") {
        forgetSession()
        setNeedsConnection(true)
      }
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
  const tokenForChange = async (): Promise<string | undefined> => {
    const saved = sessionToken(clientIdNow())
    if (saved !== undefined) return saved
    const identity = await loadIdentity()
    if (!identity.ok) {
      setNeedsConnection(true)
      return undefined
    }
    const authorized = await accessToken(clientIdNow())
    if (!authorized.ok) {
      setNeedsConnection(true)
      return undefined
    }
    setNeedsConnection(false)
    return authorized.value
  }
  const remove = async (revision: DriveRevision): Promise<void> => {
    const read = history()
    if (read === undefined) return
    const confirmation = revision.keepForever
      ? t("gdrive.deleteKeptRevisionConfirm")
      : t("gdrive.deleteRevisionConfirm")
    if (!window.confirm(confirmation)) return
    const token = await tokenForChange()
    if (token === undefined) {
      return
    }
    setChangingRevision({ id: revision.id, action: "delete" })
    setSnag(undefined)
    const currentRevisionId = read.file.headRevisionId ?? read.revisions[0]?.id
    const result = await deleteRevision(token, read.file.id, revision, currentRevisionId)
    setChangingRevision(undefined)
    if (!result.ok) {
      if (result.error.kind === "unauthorised") {
        forgetSession()
        setNeedsConnection(true)
      }
      setSnag({ at: "drive", failure: result.error })
      return
    }
    if (props.revision === revision.id) props.onChoose(undefined)
    await load(false)
  }
  const keep = async (revision: DriveRevision): Promise<void> => {
    const read = history()
    if (read === undefined || revision.keepForever === true) return
    if (!window.confirm(t("gdrive.keepRevisionConfirm"))) return
    const token = await tokenForChange()
    if (token === undefined) return
    setChangingRevision({ id: revision.id, action: "keep" })
    setSnag(undefined)
    const result = await pinRevision(token, read.file.id, revision.id)
    setChangingRevision(undefined)
    if (!result.ok) {
      if (result.error.kind === "unauthorised") {
        forgetSession()
        setNeedsConnection(true)
      }
      setSnag({ at: "drive", failure: result.error })
      return
    }
    await load(false)
  }
  const selectedRevision = (): DriveRevision | undefined => {
    const revisions = history()?.revisions ?? []
    return revisions.find(({ id }) => id === props.revision) ?? (props.revision === undefined ? revisions[0] : undefined)
  }
  const isDownloadable = (revision: DriveRevision, read: DriveHistory): boolean =>
    revision.keepForever === true ||
    revision.id === read.file.headRevisionId ||
    (read.file.headRevisionId === undefined && revision.id === read.revisions[0]?.id)
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
    if (!isDownloadable(revision, read)) {
      setBusy(false)
      const failure: Failure = { kind: "revision-not-downloadable" }
      setDetail({ ok: false, error: failure })
      setSnag({ at: "drive", failure })
      return
    }
    setBusy(true)
    const previous = read.revisions[index + 1]
    const beforeRequest: Promise<Result<string | undefined, Failure>> =
      previous === undefined || !isDownloadable(previous, read)
        ? Promise.resolve(Ok(undefined))
        : getRevisionContent(token, read.file.id, previous.id)
    void Promise.all([
      getRevisionContent(token, read.file.id, revision.id),
      beforeRequest,
    ]).then(([after, before]) => {
      if (detailAttempt() !== attempt) return
      setBusy(false)
      setDetail(!after.ok
        ? after
        : !before.ok
          ? before
          : Ok({ before: before.value, after: after.value }))
      const failure = !after.ok ? after.error : !before.ok ? before.error : undefined
      if (failure !== undefined) {
        if (failure.kind === "unauthorised") {
          forgetSession()
          setNeedsConnection(true)
        }
        setSnag({ at: "drive", failure })
      }
    })
  }))
  const selectedDetail = () => {
    const result = detail()
    return result?.ok === true ? result.value : undefined
  }
  const diff = () => {
    const result = detail()
    return result?.ok === true && result.value.before !== undefined
      ? lineDiff(result.value.before, result.value.after)
      : undefined
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
        <Show when={history() !== undefined || snag() !== undefined}>
          <Button variant="ghost" size="sm" disabled={busy()} onClick={() => void load(true)}>{t("gdrive.readAgain")}</Button>
        </Show>
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
            <p class="select-none text-xs text-muted-foreground @3xl:col-span-2">
              {t("gdrive.downloadableRevisionsHelp")}
            </p>
            <ul class="flex min-w-0 flex-col">
              <For each={read().revisions}>{(revision) => {
                const current = (): boolean =>
                  revision.id === read().file.headRevisionId ||
                  (read().file.headRevisionId === undefined && revision.id === read().revisions[0]?.id)
                const changing = (): boolean => changingRevision()?.id === revision.id
                return (
                <li class="flex items-center">
                  <button
                    type="button"
                    disabled={!isDownloadable(revision, read())}
                    onClick={() => choose(revision)}
                    class="flex min-w-0 flex-1 items-center gap-2 pr-2 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    classList={{ "bg-accent text-accent-foreground": props.revision === revision.id || (props.revision === undefined && current()) }}
                  >
                    <RevisionNode latest={current()} selected={props.revision === revision.id || (props.revision === undefined && current())} />
                    <span class="flex min-w-0 flex-1 items-center gap-2 py-2">
                      <span class="min-w-0 flex-1 truncate">{revision.lastModifyingUser?.displayName ?? revision.lastModifyingUser?.emailAddress ?? t("gdrive.unknownAuthor")}</span>
                      <Show when={current()}><span class="shrink-0 rounded border border-primary px-1.5 py-px text-[0.65rem] font-medium text-primary">{t("gdrive.currentRevision")}</span></Show>
                      <Show when={revision.keepForever}><span class="shrink-0 rounded border px-1.5 py-px text-[0.65rem]">{t("gdrive.keptRevision")}</span></Show>
                      <span class="hidden shrink-0 text-muted-foreground @md:inline">{dateOf(revision)}</span>
                    </span>
                  </button>
                  <Show when={!revision.keepForever}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="size-7 shrink-0 p-0"
                      disabled={changingRevision() !== undefined}
                      aria-label={changing() && changingRevision()?.action === "keep"
                        ? t("gdrive.keepingRevision")
                        : t("gdrive.keepRevision")}
                      title={changing() && changingRevision()?.action === "keep"
                        ? t("gdrive.keepingRevision")
                        : t("gdrive.keepRevision")}
                      onClick={() => void keep(revision)}
                    >
                      <PinIcon class="h-4 w-4" />
                    </Button>
                  </Show>
                  <Show when={!current()}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="size-7 shrink-0 p-0"
                      disabled={changingRevision() !== undefined}
                      aria-label={changing() && changingRevision()?.action === "delete"
                        ? t("gdrive.deletingRevision")
                        : revision.keepForever ? t("gdrive.deleteKeptRevision") : t("gdrive.deleteRevision")}
                      title={changing() && changingRevision()?.action === "delete"
                        ? t("gdrive.deletingRevision")
                        : revision.keepForever ? t("gdrive.deleteKeptRevision") : t("gdrive.deleteRevision")}
                      onClick={() => void remove(revision)}
                    >
                      <Trash2Icon class="h-4 w-4" />
                    </Button>
                  </Show>
                </li>
                )
              }}</For>
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
                      <Show when={selectedDetail()?.before === undefined}>
                        <p class="text-xs text-muted-foreground">{t("gdrive.revisionComparisonUnavailable")}</p>
                        <pre class="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 font-mono text-xs leading-relaxed">
                          {selectedDetail()?.after}
                        </pre>
                      </Show>
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

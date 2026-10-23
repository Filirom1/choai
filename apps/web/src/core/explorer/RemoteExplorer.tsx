import { For, Show, createResource, createSignal, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { Button } from "~/core/components/ui/button"
import { ChangesList } from "~/core/components/pending-changes"
import { SnagNote, outcomeWords } from "~/core/components/github-panel"
import { behindNow, behindRevisionNow, pendingChangesNow } from "~/core/components/git/kept-in-view"
import { addressOf, lookingAt, type Looking } from "~/core/components/git/looking"

import { agreements, token } from "~/core/github/kept"
import { inspect as inspectGitHub, pull, push, type Outcome, type Snag } from "~/core/github/sync"
import { clientIdNow } from "~/core/google-drive/kept"
import { sessionToken } from "~/core/google-drive/auth"
import type { FileSnapshot } from "~/core/sync/conflict"
import { remoteChangeFiles, remoteChangesNow } from "~/core/sync/remote-changes"
import { journal } from "~/core/journal/store"
import { isGitHubRemote, isGoogleDriveRemote } from "~/core/journal/remote"
import { REMOTES, appPath, pageOf } from "~/core/address/address"
import { useMoves } from "~/core/address/moves"
import { getOrUndefined, type Result } from "~/core/lib/monad"
import { t } from "~/core/i18n"
import { requestRemoteReview } from "~/core/sync/review-request"

/**
 * The destinations and actions available for the open journal, with local
 * changes, incoming remote changes and history beside the provider choices.
 *
 * Taking is held back while anything is waiting, because taking replaces what
 * is here with the repository's copy. Sending first is also what settles two
 * devices having written: the entries from here are laid after the ones from
 * there, and then there is nothing left to take.
 */
export function RemoteExplorer(props: {
  /** Called once something has been chosen here, whatever it was. */
  readonly onChosen?: () => void
}): JSX.Element {
  const location = useLocation()
  const moves = useMoves()
  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [said, setSaid] = createSignal<string | undefined>(undefined)
  const [snag, setSnag] = createSignal<Snag | undefined>(undefined)
  const open = () => getOrUndefined(journal())
  const [key] = createResource(agreements, () => token())
  const connected = (): boolean => (key() ?? "") !== "" && (open()?.remote?.path ?? "") !== ""
  const sessionTokenForDrive = (): string | undefined => sessionToken(clientIdNow())
  const [githubReview] = createResource(
    () => {
      const current = open()
      return current !== undefined && connected() && isGitHubRemote(current.remote)
        ? `${current.bookId}:${agreements()}:${behindRevisionNow()}:${behindNow().join("\n")}`
        : undefined
    },
    () => inspectGitHub(),
  )

  const waiting = () => pendingChangesNow() ?? []
  const currentSnapshots = (result: Result<readonly FileSnapshot[], Snag> | undefined): readonly FileSnapshot[] | undefined =>
    result?.ok ? result.value : undefined
  const githubFailure = (): Snag | undefined => {
    const result = githubReview()
    return result !== undefined && !result.ok ? result.error : undefined
  }
  const currentRemoteChanges = () => {
    const current = open()
    const changes = remoteChangesNow()
    return current !== undefined && changes?.bookId === current.bookId ? changes : undefined
  }
  const githubFiles = (snapshots: readonly FileSnapshot[]): readonly { readonly path: string; readonly isNew: boolean; readonly status: "A" | "M" | "D" }[] =>
    snapshots.map((snapshot) => ({
      path: snapshot.path,
      isNew: snapshot.local.content === undefined && snapshot.destination.content !== undefined,
      status: snapshot.destination.content === undefined ? "D" : snapshot.local.content === undefined ? "A" : "M",
    }))
  const driveEmptyMessage = (): string => {
    const changes = currentRemoteChanges()
    if (sessionTokenForDrive() === undefined) return t("remotes.connectToCheckRemote")
    if (changes === undefined || changes.at === "checking") return t("remotes.checkingRemoteChanges")
    if (changes.at === "unavailable") return t("remotes.remoteUnavailable")
    return changes.paths.length === 0 ? t("remotes.noRemoteChanges") : t("remotes.checkingRemoteChanges")
  }
  const remoteEmptyMessage = (loading: boolean, failed: boolean, ready: boolean): string =>
    loading
      ? t("remotes.checkingRemoteChanges")
      : !ready
        ? t("remotes.connectToCheckRemote")
        : failed
          ? t("remotes.remoteUnavailable")
          : t("remotes.noRemoteChanges")
  const reviewRemoteChange = (path: string): void => {
    requestRemoteReview(path)
    go({ at: "remote-change", path })
  }

  const go = (looking: Looking): void => {
    moves.goTo(addressOf(looking))
    props.onChosen?.()
  }
  const selectedPath = (): string | undefined => {
    const now = lookingAt(pageOf(location.hash))
    return appPath(location.pathname) === REMOTES && (now.at === "local-change" || now.at === "change") ? now.path : undefined
  }
  const selectedRemoteChange = (): string | undefined => {
    const now = lookingAt(pageOf(location.hash))
    return appPath(location.pathname) === REMOTES && (now.at === "remote-change" || now.at === "change") ? now.path : undefined
  }
  const run = async (work: () => Promise<Result<Outcome, Snag>>): Promise<void> => {
    setBusy(true)
    setSaid(undefined)
    setSnag(undefined)
    const result = await work()
    setBusy(false)
    if (!result.ok) {
      setSnag(result.error)
      return
    }
    setSaid(outcomeWords(result.value))
  }

  const send = (): Promise<void> =>
    run(async () => {
      const written = message().trim()
      const sent = await push(written === "" ? undefined : written)
      if (sent.ok) setMessage("")
      return sent
    })
  const take = (): Promise<void> => run(pull)

  const place = (): string => {
    const remote = open()?.remote
    return !isGitHubRemote(remote) ? "" : `${remote.owner}/${remote.repo}`
  }
  const activeProvider = (): Provider | undefined => {
    const current = open()
    if (isGoogleDriveRemote(current?.remote)) return "google-drive"
    if (current?.remote === undefined && current?.local !== undefined) return "local"
    return isGitHubRemote(current?.remote) ? "github" : undefined
  }
  const chooseProvider = (provider: Provider): void =>
    go(provider === "github" ? { at: "connection" } : provider === "google-drive" ? { at: "drive" } : { at: "local" })
  const lookingAtConnection = (): boolean =>
    appPath(location.pathname) === REMOTES && lookingAt(pageOf(location.hash)).at === "connection"

  const remote = open()?.remote
  if (isGoogleDriveRemote(remote)) {
    return (
      <div class="flex flex-col gap-2 py-2">
        <ProviderMenu
          active={activeProvider()}
          selectedLabel={remote.folderName || remote.folderId}
          onChoose={chooseProvider}
        />
        <ChangesList files={waiting()} selected={selectedPath()} onChoose={(path) => go({ at: "local-change", path })} emptyMessage={t("remotes.noPendingChanges")} />
        <ChangesList
          files={remoteChangeFiles(currentRemoteChanges())}
          selected={selectedRemoteChange()}
          onChoose={reviewRemoteChange}
          emptyMessage={driveEmptyMessage()}
          title={t("remotes.remoteChanges")}
        />
        <Heading>{t("gdrive.history")}</Heading>
        <button
          type="button"
          onClick={() => go({ at: "drive-history", revision: undefined })}
          class="w-full px-3 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
          classList={{ "bg-accent text-accent-foreground": lookingAt(pageOf(location.hash)).at === "drive-history" }}
        >
          {t("gdrive.historyGraph")}
        </button>
      </div>
    )
  }

  if (open()?.remote === undefined && open()?.local !== undefined) {
    return (
      <div class="flex flex-col gap-2 py-2">
        <ProviderMenu active={activeProvider()} onChoose={chooseProvider} />
        <Heading>{t("local.title")}</Heading>
        <button type="button" onClick={() => go({ at: "local" })} class="w-full truncate px-3 py-1 text-left text-xs font-mono hover:bg-accent hover:text-accent-foreground">
          {open()?.local?.handle.name}
        </button>
        <ChangesList files={waiting()} selected={selectedPath()} onChoose={(path) => go({ at: "local-change", path })} emptyMessage={t("remotes.noPendingChanges")} />
        <ChangesList
          files={remoteChangeFiles(currentRemoteChanges())}
          selected={selectedRemoteChange()}
          onChoose={reviewRemoteChange}
          emptyMessage={t("remotes.noRemoteChanges")}
          title={t("remotes.remoteChanges")}
        />
      </div>
    )
  }

  if (!isGitHubRemote(open()?.remote)) {
    return (
      <div class="flex flex-col gap-2 py-2">
        <ProviderMenu active={undefined} onChoose={chooseProvider} />
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-2 py-2">
      <ProviderMenu active={activeProvider()} onChoose={chooseProvider} />
      <Heading>{t("git.repository")}</Heading>
      <button
        type="button"
        onClick={() => go({ at: "connection" })}
        title={connected() ? open()?.remote?.path : undefined}
        class="w-full truncate px-3 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
        classList={{
          "bg-accent text-accent-foreground": lookingAtConnection(),
          "font-mono": connected(),
          "font-medium text-primary": !connected(),
        }}
      >
        {connected() ? place() : t("git.connect")}
      </button>

      <Show when={connected()}>
        <div class="flex flex-col gap-2 px-3">
          <textarea
            rows={2}
            aria-label={t("git.message")}
            placeholder={t("git.messagePlaceholder")}
            class="w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={message()}
            onInput={(event) => setMessage(event.currentTarget.value)}
          />
          <Show when={behindNow().length > 0}>
            <p role="status" class="flex items-start gap-1.5 text-xs text-foreground">
              <span class="mt-1 size-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
              {waiting().length > 0 ? t("git.behindWhileWaiting") : t("git.behind")}
            </p>
          </Show>
          <div class="flex gap-2">
            <Button size="sm" class="h-8 flex-1" disabled={busy() || waiting().length === 0} onClick={() => void send()}>
              {t("git.send")}
            </Button>
            <Button
              variant={behindNow().length > 0 && waiting().length === 0 ? "default" : "outline"}
              size="sm"
              class="h-8 flex-1"
              disabled={busy() || waiting().length > 0}
              title={waiting().length > 0 ? t("git.pullAfterPush") : undefined}
              onClick={() => void take()}
            >
              {t("git.take")}
            </Button>
          </div>
          <Show when={busy()}>
            <p class="text-xs text-muted-foreground">{t("github.working")}</p>
          </Show>
          <Show when={said()}>{(words) => <p class="text-xs text-muted-foreground">{words()}</p>}</Show>
          <Show when={snag()}>{(cause) => <SnagNote snag={cause()} />}</Show>
        </div>

        <ChangesList files={waiting()} selected={selectedPath()} onChoose={(path) => go({ at: "local-change", path })} emptyMessage={t("git.noChanges")} />
        <Show when={githubFailure()}>{(cause) => <SnagNote snag={cause()} />}</Show>
        <ChangesList
          files={githubFiles(currentSnapshots(githubReview()) ?? [])}
          selected={selectedRemoteChange()}
          onChoose={reviewRemoteChange}
          emptyMessage={remoteEmptyMessage(githubReview.loading, githubFailure() !== undefined, connected())}
          title={t("remotes.remoteChanges")}
        />

        <Heading>{t("git.history")}</Heading>
        <button
          type="button"
          onClick={() => go({ at: "history", commit: undefined })}
          class="w-full px-3 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
          classList={{
            "bg-accent text-accent-foreground":
              appPath(location.pathname) === REMOTES && lookingAt(pageOf(location.hash)).at === "history",
          }}
        >
          {t("git.graph")}
        </button>
      </Show>
    </div>
  )
}

type Provider = "github" | "google-drive" | "local"

function ProviderMenu(props: {
  readonly active: Provider | undefined
  readonly selectedLabel?: string
  readonly onChoose: (provider: Provider) => void
}): JSX.Element {
  const choices = [
    { provider: "github", title: () => t("remotes.github") },
    { provider: "google-drive", title: () => t("remotes.drive") },
    { provider: "local", title: () => t("remotes.local") },
  ] as const
  return (
    <>
      <Heading>{t("remotes.destination")}</Heading>
      <div role="group" aria-label={t("remotes.destination")} class="flex flex-col gap-1">
        <For each={choices}>
          {(choice) => {
            const selected = () => choice.provider === props.active
            const disabled = () => props.active !== undefined && !selected()
            return (
              <button
                type="button"
                aria-current={selected() ? "page" : undefined}
                disabled={disabled()}
                onClick={() => props.onChoose(choice.provider)}
                class="flex w-full items-center justify-between gap-2 rounded px-3 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-50"
                classList={{ "bg-accent font-medium text-accent-foreground": selected() }}
              >
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="truncate">{choice.title()}</span>
                  <Show when={selected() && choice.provider === "google-drive" ? props.selectedLabel : undefined}>
                    {(label) => <span class="truncate text-[0.65rem] font-normal text-muted-foreground">{label()}</span>}
                  </Show>
                </span>
                <Show when={selected()}>
                  <span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </>
  )
}

function Heading(props: { readonly children: JSX.Element }): JSX.Element {
  return (
    <h3 class="mt-1 flex items-center gap-2 px-3 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
      {props.children}
    </h3>
  )
}

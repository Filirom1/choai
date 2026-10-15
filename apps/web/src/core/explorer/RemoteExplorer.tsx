import { Show, createResource, createSignal, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { Button } from "~/core/components/ui/button"
import { ChangesList } from "~/core/components/pending-changes"
import { SnagNote, outcomeWords } from "~/core/components/github-panel"
import { behindNow, pendingChangesNow } from "~/core/components/git/kept-in-view"
import { addressOf, lookingAt, type Looking } from "~/core/components/git/looking"

import { agreements, token } from "~/core/github/kept"
import { pull, push, type Outcome, type Snag } from "~/core/github/sync"
import { journal } from "~/core/journal/store"
import { isGitHubRemote, isGoogleDriveRemote } from "~/core/journal/remote"
import { REMOTES, appPath, pageOf } from "~/core/address/address"
import { useMoves } from "~/core/address/moves"
import { getOrUndefined, type Result } from "~/core/lib/monad"
import { t } from "~/core/i18n"

/**
 * The destinations and actions available for the open journal, with the
 * GitHub change list and history kept beside the provider choices.
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
  const [key] = createResource(agreements, () => token())

  const open = () => getOrUndefined(journal())
  const connected = (): boolean => (key() ?? "") !== "" && (open()?.remote?.path ?? "") !== ""
  const waiting = () => pendingChangesNow() ?? []

  const go = (looking: Looking): void => {
    moves.goTo(addressOf(looking))
    props.onChosen?.()
  }
  const selectedPath = (): string | undefined => {
    const now = lookingAt(pageOf(location.hash))
    return appPath(location.pathname) === REMOTES && now.at === "change" ? now.path : undefined
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
  const lookingAtConnection = (): boolean =>
    appPath(location.pathname) === REMOTES && lookingAt(pageOf(location.hash)).at === "connection"

  if (isGoogleDriveRemote(open()?.remote)) {
    const remote = open()?.remote
    return (
      <div class="flex flex-col gap-2 py-2">
        <Heading>{t("gdrive.title")}</Heading>
        <button
          type="button"
          onClick={() => go({ at: "drive" })}
          title={remote?.provider === "google-drive" ? remote.folderId : undefined}
          class="w-full truncate px-3 py-1 text-left text-xs font-mono hover:bg-accent hover:text-accent-foreground"
        >
          {remote?.provider === "google-drive" ? remote.folderName || remote.folderId : t("gdrive.title")}
        </button>
        <ChangesList files={waiting()} selected={selectedPath()} onChoose={(path) => go({ at: "change", path })} emptyMessage={t("remotes.noPendingChanges")} />
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
        <Heading>{t("local.title")}</Heading>
        <button type="button" onClick={() => go({ at: "local" })} class="w-full truncate px-3 py-1 text-left text-xs font-mono hover:bg-accent hover:text-accent-foreground">
          {open()?.local?.handle.name}
        </button>
        <ChangesList files={waiting()} selected={selectedPath()} onChoose={(path) => go({ at: "change", path })} emptyMessage={t("remotes.noPendingChanges")} />
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-2 py-2">
      {/* First, as the account an editor's source control is signed in with
          is: what everything below it sends to, and the way to change it. */}
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

        <ChangesList files={waiting()} selected={selectedPath()} onChoose={(path) => go({ at: "change", path })} emptyMessage={t("git.noChanges")} />

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

function Heading(props: { readonly children: JSX.Element }): JSX.Element {
  return (
    <h3 class="mt-1 flex items-center gap-2 px-3 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
      {props.children}
    </h3>
  )
}

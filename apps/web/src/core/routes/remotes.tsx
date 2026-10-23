import { For, Show, createSignal, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { GoogleDrivePanel } from "~/core/components/google-drive-panel"
import { GoogleDriveHistory } from "~/core/components/google-drive-history"
import { Button } from "~/core/components/ui/button"
import { LocalSyncPanel } from "~/core/components/local-sync-panel"
import { PendingChangeView } from "~/core/components/pending-changes"
import { pendingChangesNow } from "~/core/components/git/kept-in-view"
import { pageOf } from "~/core/address/address"
import { addressOf, lookingAt } from "~/core/components/git/looking"
import { useMoves } from "~/core/address/moves"
import { canOpenFolder, journal, openFiles, openFolder, opening, setLocalFolderActive } from "~/core/journal/store"
import { putDown } from "~/core/journal/switching"
import { isGoogleDriveRemote, type GoogleDriveRemote } from "~/core/journal/remote"
import { getOrUndefined } from "~/core/lib/monad"
import { t } from "~/core/i18n"
import Git from "./git"

export default function Remotes(): JSX.Element {
  const location = useLocation()
  const moves = useMoves()
  const [importingFromDrive, setImportingFromDrive] = createSignal(true)
  let folderChooser!: HTMLInputElement
  const current = () => getOrUndefined(journal())
  const looking = () => lookingAt(pageOf(location.hash))
  const changing = () => {
    const now = looking()
    return now.at === "local-change" || now.at === "change" ? now.path : ""
  }
  const selectedDriveRevision = () => {
    const now = looking()
    return now.at === "drive-history" ? now.revision : undefined
  }
  const showingLocal = (): boolean =>
    looking().at === "local" || current()?.local !== undefined
  const showingDrive = (): boolean =>
    looking().at === "drive" || (looking().at !== "connection" && isGoogleDriveRemote(current()?.remote))
  const active = () => current()?.local !== undefined ? "local" : current()?.remote?.provider
  const driveRemote = (): GoogleDriveRemote | undefined => {
    const remote = current()?.remote
    return isGoogleDriveRemote(remote) ? remote : undefined
  }
  const choices = [
    { provider: "github", title: t("remotes.github"), looking: { at: "connection" } as const },
    { provider: "google-drive", title: t("remotes.drive"), looking: { at: "drive" } as const },
    { provider: "local", title: t("remotes.local"), looking: { at: "local" } as const },
  ] as const
  const selected = () => choices.find((choice) => choice.provider === active())
  const then = async (open: () => Promise<{ ok: boolean } | undefined>): Promise<void> => {
    putDown()
    if ((await open())?.ok) moves.toTheJournal()
  }
  const choose = (provider: (typeof choices)[number]["provider"]): void => {
    if (provider === "local" && current()?.local === undefined) {
      if (canOpenFolder()) void then(openFolder)
      else folderChooser.click()
      return
    }
    if (provider === "local") void setLocalFolderActive()
    const destination = choices.find((choice) => choice.provider === provider)
    if (destination !== undefined) moves.goTo(addressOf(destination.looking))
  }
  if (looking().at === "remote-change") {
    return <p role="status" class="text-sm text-muted-foreground">{t("remotes.checkingRemoteChanges")}</p>
  }
  return (
    <div class="flex w-full flex-col gap-5">
      <header class="flex flex-col gap-1">
        <h1 class="text-xl font-semibold">{t("remotes.title")}</h1>
        <p class="text-sm text-muted-foreground">{t("remotes.lead")}</p>
      </header>
      <input
        ref={(element) => {
          folderChooser = element
          element.setAttribute("webkitdirectory", "")
        }}
        type="file"
        class="hidden"
        multiple
        onChange={(event) => {
          const chosen = event.currentTarget.files
          if (chosen !== null && chosen.length > 0) void then(() => openFiles(chosen))
        }}
      />
      <section class="grid gap-2 sm:grid-cols-3" aria-label={t("remotes.destination")}>
        <Show when={selected()} fallback={
          <For each={choices}>
            {(choice) => (
              <button
                type="button"
                disabled={opening()}
                onClick={() => choose(choice.provider)}
                class="flex min-h-12 items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{choice.title}</span>
              </button>
            )}
          </For>
        }>
          {(choice) => (
            <div aria-current="true" class="flex min-h-12 items-center justify-between gap-2 rounded-md border border-primary bg-accent px-3 py-2 text-left text-sm font-medium">
              <span>{choice().title}</span>
              <span class="rounded-full bg-primary/10 px-2 py-0.5 text-[0.65rem] text-primary">{t("remotes.active")}</span>
            </div>
          )}
        </Show>
      </section>
      <Show when={showingLocal()} fallback={
        <Show when={showingDrive()} fallback={<Git />}>
          <Show when={looking().at === "drive-history"} fallback={
            <Show when={looking().at === "local-change" || looking().at === "change"} fallback={
              <Show when={current() === undefined || importingFromDrive()} fallback={
                <>
                  <Button type="button" variant="outline" onClick={() => setImportingFromDrive(true)}>
                    {t("books.fromGoogleDrive")}
                  </Button>
                  <GoogleDrivePanel bound={{ into: "this-book" }} />
                </>
              }>
                <Show when={current() !== undefined}>
                  <Button type="button" variant="ghost" onClick={() => setImportingFromDrive(false)}>
                    {t("gdrive.manage")}
                  </Button>
                </Show>
                <GoogleDrivePanel bound={{ into: "new-book", taken: moves.toTheJournal }} />
              </Show>
            }>
              <PendingChangeView path={changing()} files={pendingChangesNow() ?? []} since={t("git.sinceSent")} back={t("remotes.backToSync")} backHref={addressOf({ at: "drive" })} emptyMessage={t("remotes.noPendingChanges")} />
            </Show>
          }>
            <Show when={driveRemote()}>{(remote) => (
              <GoogleDriveHistory
                remote={remote()}
                revision={selectedDriveRevision()}
                onChoose={(revision) => moves.goTo(addressOf({ at: "drive-history", revision }))}
              />
            )}</Show>
          </Show>
        </Show>
      }>
        <Show when={looking().at === "local-change" || looking().at === "change"} fallback={
          <Show when={current()?.local} fallback={<p class="text-sm text-muted-foreground">{t("local.notLinked")}</p>}>
            <LocalSyncPanel />
          </Show>
        }>
          <PendingChangeView path={changing()} files={pendingChangesNow() ?? []} since={t("git.sinceSaved")} back={t("remotes.backToSync")} backHref={addressOf({ at: "local" })} emptyMessage={t("remotes.noPendingChanges")} />
        </Show>
      </Show>
    </div>
  )
}

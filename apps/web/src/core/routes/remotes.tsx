import { For, Show, createSignal, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { GoogleDrivePanel } from "~/core/components/google-drive-panel"
import { Button } from "~/core/components/ui/button"
import { LocalSyncPanel } from "~/core/components/local-sync-panel"
import { pageOf } from "~/core/address/address"
import { addressOf, lookingAt } from "~/core/components/git/looking"
import { useMoves } from "~/core/address/moves"
import { journal, setLocalFolderActive } from "~/core/journal/store"
import { isGoogleDriveRemote } from "~/core/journal/remote"
import { getOrUndefined } from "~/core/lib/monad"
import { t } from "~/core/i18n"
import Git from "./git"

export default function Remotes(): JSX.Element {
  const location = useLocation()
  const moves = useMoves()
  const [importingFromDrive, setImportingFromDrive] = createSignal(true)
  const current = () => getOrUndefined(journal())
  const looking = () => lookingAt(pageOf(location.hash))
  const showingLocal = (): boolean =>
    looking().at === "local" || (looking().at !== "connection" && current()?.remote === undefined && current()?.local !== undefined)
  const showingDrive = (): boolean =>
    looking().at === "drive" || (looking().at !== "connection" && isGoogleDriveRemote(current()?.remote))
  const active = () => current()?.remote?.provider ?? (current()?.local === undefined ? undefined : "local")
  const choices = [
    { provider: "github", title: t("remotes.github"), looking: { at: "connection" } as const },
    { provider: "google-drive", title: t("remotes.drive"), looking: { at: "drive" } as const },
    { provider: "local", title: t("remotes.local"), looking: { at: "local" } as const },
  ] as const
  const choose = (provider: (typeof choices)[number]["provider"]): void => {
    if (provider === "local") void setLocalFolderActive()
    const destination = choices.find((choice) => choice.provider === provider)
    if (destination !== undefined) moves.goTo(addressOf(destination.looking))
  }
  return (
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header class="flex flex-col gap-1">
        <h1 class="text-xl font-semibold">{t("remotes.title")}</h1>
        <p class="text-sm text-muted-foreground">{t("remotes.lead")}</p>
      </header>
      <section class="grid gap-2 sm:grid-cols-3" aria-label={t("remotes.destination")}>
        <For each={choices}>
          {(choice) => (
            <button
              type="button"
              disabled={choice.provider === "local" && current()?.local === undefined}
              aria-pressed={active() === choice.provider}
              onClick={() => choose(choice.provider)}
              class="flex min-h-12 items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              classList={{ "border-primary bg-accent": active() === choice.provider }}
            >
              <span>{choice.title}</span>
              <Show when={active() === choice.provider}>
                <span class="rounded-full bg-primary/10 px-2 py-0.5 text-[0.65rem] text-primary">{t("remotes.active")}</span>
              </Show>
            </button>
          )}
        </For>
      </section>
      <Show when={showingLocal()} fallback={
        <Show when={showingDrive()} fallback={<Git />}>
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
        </Show>
      }>
        <Show when={current()?.local} fallback={<p class="text-sm text-muted-foreground">{t("local.notLinked")}</p>}>
          <LocalSyncPanel />
        </Show>
      </Show>
    </div>
  )
}

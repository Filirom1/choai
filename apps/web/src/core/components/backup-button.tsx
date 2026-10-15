import { Show, createEffect, createSignal, on, onCleanup, type Accessor, type JSX } from "solid-js"
import { A } from "@solidjs/router"

import { Button } from "~/core/components/ui/button"
import { DriveSnag } from "~/core/components/google-drive-panel"
import { SnagNote } from "~/core/components/github-panel"
import { TroubleNote } from "~/core/components/trouble-note"
import { localFailureWords } from "~/core/components/local-sync-panel"
import { push as pushGitHub, type Snag as GitHubSnag } from "~/core/github/sync"
import { push as pushDrive, type Snag as DriveFailure } from "~/core/google-drive/index"
import { isGoogleDriveRemote, isGitHubRemote } from "~/core/journal/remote"
import { journal, saveToLocalFolder, type LocalTrouble } from "~/core/journal/store"
import { changedPaths } from "~/core/journal/local"
import { isHiddenPath } from "~/core/journal/hidden"
import { differsFrom } from "~/core/journal/unsaved-text"
import { REMOTES } from "~/core/address/address"
import { getOrUndefined } from "~/core/lib/monad"
import { t } from "~/core/i18n"

type SaveFailure =
  | { readonly at: "github"; readonly snag: GitHubSnag }
  | { readonly at: "drive"; readonly snag: DriveFailure }
  | { readonly at: "local"; readonly trouble: LocalTrouble }

export function BackupButton(props: { readonly onSaved?: () => void; readonly saveRequest?: Accessor<number> } = {}): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const success = createFlash()
  const [failure, setFailure] = createSignal<SaveFailure | undefined>()
  const localSaveReady = (): boolean => {
    const open = getOrUndefined(journal())
    if (open?.remote !== undefined || open?.local === undefined) return true
    const edited = Object.entries(open.source.files).some(([path, text]) => !isHiddenPath(path) && differsFrom(path, text))
    return !edited && changedPaths(open.local.base, open.source.files).length > 0
  }

  const save = async (): Promise<void> => {
    if (busy() || !localSaveReady()) return
    success.clear()
    setBusy(true)
    setFailure(undefined)
    const open = getOrUndefined(journal())
    if (isGitHubRemote(open?.remote)) {
      const result = await pushGitHub()
      if (result.ok) {
        success.show()
        props.onSaved?.()
      } else setFailure({ at: "github", snag: result.error })
    } else if (isGoogleDriveRemote(open?.remote)) {
      const result = await pushDrive()
      if (result.ok) {
        success.show()
        props.onSaved?.()
      } else setFailure({ at: "drive", snag: result.error })
    } else if (open?.local !== undefined) {
      const result = await saveToLocalFolder()
      if (result.ok) {
        success.show()
        props.onSaved?.()
      } else setFailure({ at: "local", trouble: result.error })
    }
    setBusy(false)
  }

  createEffect(on(() => props.saveRequest?.(), (request) => {
    if (request !== undefined) void save()
  }, { defer: true }))

  return (
    <div class="flex shrink-0 flex-col items-start gap-1">
      <Button
        size="sm"
        disabled={busy() || !localSaveReady()}
        class={success.flashing() ? "bg-success text-success-foreground hover:bg-success/90 disabled:opacity-100" : ""}
        onClick={() => void save()}
      >
        <Show when={success.flashing()}><span aria-hidden="true">✓</span></Show>
        {busy() ? t("remotes.saving") : t("remotes.save")}
      </Button>
      <Show when={success.flashing()}><span role="status" class="sr-only">{t("remotes.saved")}</span></Show>
      <Show when={failure()}>{(cause) => <SaveFailureNote failure={cause()} />}</Show>
    </div>
  )
}

const FLASH_MS = 2500

function createFlash(): {
  readonly flashing: Accessor<boolean>
  readonly show: () => void
  readonly clear: () => void
} {
  const [flashing, setFlashing] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (pending: ReturnType<typeof setTimeout> | undefined): undefined => {
    if (pending !== undefined) clearTimeout(pending)
    return undefined
  }
  onCleanup(() => {
    timer = stop(timer)
  })
  const clear = (): void => {
    timer = stop(timer)
    setFlashing(false)
  }
  const show = (): void => {
    clear()
    setFlashing(true)
    timer = setTimeout(() => {
      timer = undefined
      setFlashing(false)
    }, FLASH_MS)
  }
  return { flashing, show, clear }
}

function SaveFailureNote(props: { readonly failure: SaveFailure }): JSX.Element {
  return (
    <div class="flex flex-col gap-1">
      {props.failure.at === "github" ? <SnagNote snag={props.failure.snag} /> : null}
      {props.failure.at === "drive" ? <DriveSnag snag={props.failure.snag} /> : null}
      {props.failure.at === "local" ? props.failure.trouble.at === "hledger"
        ? <TroubleNote trouble={props.failure.trouble.trouble} />
        : <p role="alert" class="text-xs text-error-foreground">{localFailureWords(props.failure.trouble)}</p> : null}
      <A href={REMOTES} class="text-xs underline underline-offset-2">{t("remotes.configure")}</A>
    </div>
  )
}

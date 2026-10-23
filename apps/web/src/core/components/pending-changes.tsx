import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { A } from "@solidjs/router"

import { DiffView } from "~/core/components/git/diff-view"
import { lineDiff, aroundChanges, changes } from "~/core/lib/diff"
import { t } from "~/core/i18n"
import type { Unsent } from "~/core/github/sync"
import { Button } from "~/core/components/ui/button"
import { TroubleNote } from "~/core/components/trouble-note"
import { discardLocalChange, type DiscardFailure } from "~/core/journal/local-resolution"

export interface ChangeListFile {
  readonly path: string
  readonly isNew: boolean
  readonly status?: "A" | "M" | "D"
}

export function ChangesList(props: {
  readonly files: readonly ChangeListFile[]
  readonly selected: string | undefined
  readonly onChoose: (path: string) => void
  readonly emptyMessage: string
  readonly title?: string
}): JSX.Element {
  return (
    <>
      <h3 class="mt-1 flex items-center gap-2 px-3 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {props.title ?? t("git.changes")}
        <Show when={props.files.length > 0}>
          <span class="rounded-full bg-muted px-1.5 text-[0.65rem] text-muted-foreground">{props.files.length}</span>
        </Show>
      </h3>
      <Show when={props.files.length > 0} fallback={<p class="px-3 text-xs text-muted-foreground">{props.emptyMessage}</p>}>
        <ul>
          <For each={props.files}>
            {(file) => {
              const status = file.status ?? (file.isNew ? "A" : "M")
              const statusTitle = status === "A" ? t("git.added") : status === "D" ? t("git.deleted") : t("git.modified")
              return (
                <li>
                <button
                  type="button"
                  onClick={() => props.onChoose(file.path)}
                  title={file.path}
                  class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                  classList={{ "bg-accent text-accent-foreground": props.selected === file.path }}
                >
                  <span class="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  <span
                    class="shrink-0 font-mono font-semibold"
                    classList={{ "text-success-foreground": status === "A", "text-error-foreground": status === "D", "text-primary": status === "M" }}
                    title={statusTitle}
                  >
                    {status}
                  </span>
                </button>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </>
  )
}

export function PendingChangeView(props: {
  readonly path: string
  readonly files: readonly Unsent[]
  readonly since: string
  readonly back: string
  readonly backHref: string
  readonly emptyMessage: string
}): JSX.Element {
  const file = () => props.files.find((each) => each.path === props.path)
  const [discardFailure, setDiscardFailure] = createSignal<{ readonly path: string; readonly failure: DiscardFailure }>()
  const diff = createMemo(() => {
    const found = file()
    return found === undefined ? [] : lineDiff(found.before, found.after)
  })
  const counted = () => changes(diff())
  const discard = async (): Promise<void> => {
    const selected = file()
    if (selected === undefined || !window.confirm(t("remotes.discardConfirm", { path: selected.path }))) return
    setDiscardFailure(undefined)
    const result = await discardLocalChange(selected.path, selected.after, selected.before, selected.isNew)
    if (!result.ok) setDiscardFailure({ path: selected.path, failure: result.error })
  }
  return (
    <div class="flex flex-col gap-3">
      <A href={props.backHref} class="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        {props.back}
      </A>
      <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 class="font-mono text-sm font-medium">{props.path}</h2>
        <span class="text-xs text-muted-foreground">{props.since}</span>
        <Show when={file()}>
          <span class="text-xs">
            <span class="text-success-foreground">+{counted().added}</span>{" "}
            <span class="text-error-foreground">−{counted().removed}</span>
          </span>
        </Show>
        <Show when={file()}>
          <Button size="sm" variant="outline" class="ml-auto" onClick={() => void discard()}>
            {t("remotes.discardLocal")}
          </Button>
        </Show>
      </header>
      <Show when={discardFailure()?.path === props.path ? discardFailure()?.failure : undefined}>
        {(failure) => <DiscardFailureNote failure={failure()} />}
      </Show>
      <Show when={file()} fallback={<p class="text-sm text-muted-foreground">{props.emptyMessage}</p>}>
        <DiffView lines={aroundChanges(diff())} />
      </Show>
    </div>
  )
}

function DiscardFailureNote(props: { readonly failure: DiscardFailure }): JSX.Element {
  return props.failure.at === "hledger"
    ? <TroubleNote trouble={props.failure.trouble} />
    : <p role="alert" class="text-sm text-error-foreground">{t("syncResolution.stale", { path: props.failure.path })}</p>
}

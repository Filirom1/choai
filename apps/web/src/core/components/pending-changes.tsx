import { For, Show, createMemo, type JSX } from "solid-js"
import { A } from "@solidjs/router"

import { DiffView } from "~/core/components/git/diff-view"
import { lineDiff, aroundChanges, changes } from "~/core/lib/diff"
import { t } from "~/core/i18n"
import type { Unsent } from "~/core/github/sync"

export function ChangesList(props: {
  readonly files: readonly Unsent[]
  readonly selected: string | undefined
  readonly onChoose: (path: string) => void
  readonly emptyMessage: string
}): JSX.Element {
  return (
    <>
      <h3 class="mt-1 flex items-center gap-2 px-3 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("git.changes")}
        <Show when={props.files.length > 0}>
          <span class="rounded-full bg-muted px-1.5 text-[0.65rem] text-muted-foreground">{props.files.length}</span>
        </Show>
      </h3>
      <Show when={props.files.length > 0} fallback={<p class="px-3 text-xs text-muted-foreground">{props.emptyMessage}</p>}>
        <ul>
          <For each={props.files}>
            {(file) => (
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
                    classList={{ "text-success-foreground": file.isNew, "text-primary": !file.isNew }}
                    title={file.isNew ? t("git.added") : t("git.modified")}
                  >
                    {file.isNew ? "A" : "M"}
                  </span>
                </button>
              </li>
            )}
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
  const diff = createMemo(() => {
    const found = file()
    return found === undefined ? [] : lineDiff(found.before, found.after)
  })
  const counted = () => changes(diff())
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
      </header>
      <Show when={file()} fallback={<p class="text-sm text-muted-foreground">{props.emptyMessage}</p>}>
        <DiffView lines={aroundChanges(diff())} />
      </Show>
    </div>
  )
}

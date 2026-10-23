import { For, Show, createMemo, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { parseCsv } from "~/core/journal/csv"
import { t } from "~/core/i18n"

export function CsvTextViewer(props: {
  readonly value: string
  readonly mode: "table" | "text"
  readonly onMode: (mode: "table" | "text") => void
  readonly onChange: (value: string) => void
  readonly label: string
}): JSX.Element {
  const parsed = createMemo(() => parseCsv(props.value))
  const rows = (): readonly (readonly string[])[] => {
    const result = parsed()
    return result.ok ? result.value : []
  }
  const columnIndexes = (): readonly number[] => {
    return Array.from({ length: Math.max(0, ...rows().map((row) => row.length)) }, (_, index) => index)
  }

  return (
    <div class="flex min-h-[24rem] flex-1 flex-col gap-2">
      <div class="flex items-center gap-2">
        <Button
          variant={props.mode === "table" ? "secondary" : "ghost"}
          size="sm"
          class={`rounded-md px-3 py-1.5 text-sm ${props.mode === "table" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          aria-pressed={props.mode === "table"}
          onClick={() => props.onMode("table")}
        >
          {t("source.csvTable")}
        </Button>
        <Button
          variant={props.mode === "text" ? "secondary" : "ghost"}
          size="sm"
          class={`rounded-md px-3 py-1.5 text-sm ${props.mode === "text" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          aria-pressed={props.mode === "text"}
          onClick={() => props.onMode("text")}
        >
          {t("source.csvText")}
        </Button>
        <Show when={props.mode === "table" && parsed().ok}>
          <span class="ml-auto text-xs text-muted-foreground">
            {t("source.csvDimensions", { rows: Math.max(0, rows().length - 1), columns: columnIndexes().length })}
          </span>
        </Show>
      </div>
      <Show when={props.mode === "table"} fallback={
        <textarea
          class="min-h-[24rem] w-full flex-1 resize-none rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          spellcheck={false}
          autocapitalize="off"
          autocorrect="off"
          aria-label={props.label}
          value={props.value}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      }>
        <Show when={parsed().ok} fallback={
          <p role="alert" class="rounded-md border border-error/40 p-3 text-sm text-error-foreground">
            {t("source.csvInvalid")}
          </p>
        }>
          <div class="min-h-[24rem] flex-1 overflow-auto rounded-md border border-border">
              <table class="w-full border-collapse text-left text-xs">
                <thead class="sticky top-0 bg-muted text-muted-foreground">
                  <tr>
                    <th class="w-12 border-b border-r border-border px-2 py-2 text-right font-medium">#</th>
                    <For each={columnIndexes()}>{(column) => {
                      const heading = rows()[0]?.[column] ?? ""
                      return (
                      <th class="max-w-72 whitespace-nowrap border-b border-r border-border px-3 py-2 font-medium">
                        {heading || <span class="text-muted-foreground/60">—</span>}
                      </th>
                      )
                    }}</For>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows().slice(1)}>{(row, index) => (
                    <tr class="odd:bg-background even:bg-muted/30">
                      <th class="border-b border-r border-border px-2 py-1.5 text-right font-mono font-normal text-muted-foreground">
                        {index() + 1}
                      </th>
                      <For each={columnIndexes()}>{(column) => (
                        <td class="max-w-72 whitespace-pre-wrap break-words border-b border-r border-border px-3 py-1.5 align-top">
                          {row[column] ?? ""}
                        </td>
                      )}</For>
                    </tr>
                  )}</For>
                </tbody>
              </table>
              <Show when={rows().length <= 1}>
                <p class="p-3 text-sm text-muted-foreground">{t("source.csvEmpty")}</p>
              </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}

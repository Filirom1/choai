import { For, Show, createResource, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { journal, removeBook, renameBook, type OpenJournal } from "~/core/journal/store"
import { keptForGood } from "~/core/journal/kept"
import { Button } from "~/core/components/ui/button"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { handOver } from "~/core/journal/handover"
import { DownloadIcon, ImportIcon } from "~/core/lib/ui/icons"
import { dock } from "~/core/dock"
import { selectCsv } from "~/core/statement/import-selection"
import { differsFrom } from "~/core/journal/unsaved-text"
import { sourceTree, type SourceTreeNode } from "~/core/journal/source-tree"
import { SOURCE, appPath, addressOfSourceFile } from "~/core/address/address"
import { useMoves } from "~/core/address/moves"
import { entryPath, fileShown } from "~/core/routes/source"
import { getOrUndefined } from "~/core/lib/monad"
import { t } from "~/core/i18n"
import { isHledgerLatestPath } from "~/core/journal/hidden"

/**
 * The explorer beside the journal's text: the files it is written in.
 *
 * The entry file first and then whatever it includes, as the journal holds
 * them. Choosing one is a change of address, so going back returns to the file
 * before it; a file with text typed over it and not saved is marked, since that
 * text is still there to be saved or lost.
 *
 * Under them, the book they make up: what it is called, whether this device
 * will keep it, and the two ways of letting it go — taking the files away, and
 * putting the book down. Here rather than among the settings, because they are
 * about these files and nothing else.
 */
export function SourceExplorer(props: {
  /** Called once something has been chosen here, whatever it was. */
  readonly onChosen?: () => void
}): JSX.Element {
  const location = useLocation()
  const moves = useMoves()

  const choose = (path: string): void => {
    moves.goTo(addressOfSourceFile(path))
    props.onChosen?.()
  }

  return (
    <Show
      when={getOrUndefined(journal())}
      fallback={<p class="px-3 py-2 text-xs text-muted-foreground">{t("accounts.noJournal")}</p>}
    >
      {(open) => (
        <div class="py-1">
          <SourceNodes
            nodes={inReadingOrder(open())}
            selected={fileShown(location.hash, open())}
            active={appPath(location.pathname) === SOURCE}
            open={open()}
            onChoose={choose}
          />
          <Book open={open()} />
        </div>
      )}
    </Show>
  )
}

/**
 * The entry file first, since it is where hledger starts reading and says what
 * else is read; then the rest by name, which is the order they come back from
 * the device in anyway.
 */
const inReadingOrder = (open: OpenJournal): readonly SourceTreeNode[] => {
  const entry = entryPath(open)
  const files = Object.keys(open.source.files).filter((path) => path !== entry && !isHledgerLatestPath(path))
  return [
    { kind: "file", path: entry },
    ...sourceTree([...files, ...open.source.attachments.map(({ path }) => path)].sort()),
  ]
}

function SourceNodes(props: {
  readonly nodes: readonly SourceTreeNode[]
  readonly selected: string
  readonly active: boolean
  readonly open: OpenJournal
  readonly onChoose: (path: string) => void
}): JSX.Element {
  return (
    <For each={props.nodes}>
      {(node) => node.kind === "folder"
        ? (
          <details class="min-w-0">
            <summary
              title={node.path}
              class="cursor-pointer px-3 py-1 font-mono text-xs hover:bg-accent hover:text-accent-foreground"
            >
              {node.path.split("/").at(-1)}/
            </summary>
            <div class="ml-3 border-l border-border pl-1">
              <SourceNodes {...props} nodes={node.children} />
            </div>
          </details>
        )
        : <SourceFile path={node.path} selected={props.selected} active={props.active} open={props.open} onChoose={props.onChoose} />}
    </For>
  )
}

function SourceFile(props: {
  readonly path: string
  readonly selected: string
  readonly active: boolean
  readonly open: OpenJournal
  readonly onChoose: (path: string) => void
}): JSX.Element {
  const name = (): string => props.path.split("/").at(-1) ?? props.path
  return (
    <div class="flex min-w-0 items-center">
      <button
        type="button"
        onClick={() => props.onChoose(props.path)}
        title={props.path}
        class="flex min-w-0 flex-1 items-center gap-1 px-3 py-1 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground"
        classList={{ "bg-accent text-accent-foreground": props.active && props.selected === props.path }}
      >
        <span class="min-w-0 truncate">{name()}</span>
        <Show when={differsFrom(props.path, props.open.source.files[props.path] ?? "")}>
          <span aria-label={t("source.unsaved")} title={t("source.unsaved")}>•</span>
        </Show>
      </button>
      <Show when={props.path.toLowerCase().endsWith(".csv")}>
        <button
          type="button"
          class="mr-2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("csvImport.title")}
          title={t("csvImport.title")}
          onClick={() => {
            selectCsv(props.path)
            dock.show("csv-importing")
          }}
        >
          <ImportIcon class="h-3.5 w-3.5" />
        </button>
      </Show>
    </div>
  )
}

/**
 * The book these files make up. Closing clears it from the device, so it says
 * so on the button rather than in a dialog afterwards.
 */
function Book(props: { readonly open: OpenJournal }): JSX.Element {
  const [promised] = createResource(keptForGood)
  return (
    <section class="mt-2 flex flex-col gap-2 border-t border-border px-3 pt-3 pb-2">
      <h2 class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("library.title")}</h2>
      {/* The name is the book's own, not the file's: two books can be kept
          in files called the same thing. */}
      <TextField>
        <TextFieldInput
          type="text"
          aria-label={t("library.title")}
          class="h-8 text-sm"
          value={props.open.source.label}
          onChange={(event) => void renameBook(event.currentTarget.value)}
        />
      </TextField>
      <p class="text-xs text-muted-foreground">{t("library.nameLives")}</p>
      <p class="text-xs text-muted-foreground">
        {promised() === false ? t("library.notKept") : t("library.kept")}
      </p>
      <div class="flex flex-col gap-1.5">
        <Button variant="outline" size="sm" class="justify-start gap-1.5" onClick={() => void handOver(props.open.bookId, props.open.source)}>
          <DownloadIcon class="h-3.5 w-3.5" />
          {t("journal.export")}
        </Button>
        <Button variant="outline" size="sm" class="justify-start" onClick={() => void removeBook(props.open.bookId)}>
          {t("library.close")}
        </Button>
      </div>
    </section>
  )
}

import { Show, createEffect, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { journal, loadAttachment, rewriteFile, type OpenJournal } from "~/core/journal/store"
import { differsFrom, holdText, letTextGo, unsavedText } from "~/core/journal/unsaved-text"
import { fileOfSource } from "~/core/address/address"
import type { Trouble } from "~/core/hledger/wire"
import { getOrUndefined } from "~/core/lib/monad"
import { Button } from "~/core/components/ui/button"
import { TroubleNote } from "~/core/components/trouble-note"
import { t } from "~/core/i18n"
import { dock } from "~/core/dock"
import { selectCsv } from "~/core/statement/import-selection"
import { bookSettings } from "~/core/journal/book-settings"
import { csvPathForRules } from "~/core/statement/hledger-import"
import { accessToken, clientId, clientIdNow, keepClientId, loadIdentity } from "~/core/google-drive/index"
import { isGoogleDriveRemote } from "~/core/journal/remote"
import { syntaxForSource } from "~/core/journal/source-syntax"
import { JournalTextEditor } from "~/core/components/journal-text-editor"
import { CsvTextViewer } from "~/core/components/csv-text-viewer"

/**
 * The journal as text, editable.
 *
 * Everything else in the app writes through hledger; this writes the file
 * directly, which is the point — corrections, re-ordering, a comment, a
 * directive. It is also the one place a file can be ruined in a keystroke, so
 * saving is a bargain: hledger reads the new text first, and a file that will
 * not read leaves the journal exactly as it was.
 */
export default function Source(): JSX.Element {
  return (
    <Show
      when={getOrUndefined(journal())}
      fallback={<p class="text-sm text-muted-foreground">{t("report.needsJournal")}</p>}
    >
      {(open) => <Editor open={open()} />}
    </Show>
  )
}

/**
 * One file at a time, the one the address names — chosen in the list beside
 * this page — or the one entries are read from where it names none.
 */
function Editor(props: { open: OpenJournal }): JSX.Element {
  const location = useLocation()
  const path = (): string => fileShown(location.hash, props.open)
  const [trouble, setTrouble] = createSignal<Trouble | undefined>(undefined)
  const [saving, setSaving] = createSignal(false)
  const [csvMode, setCsvMode] = createSignal<"table" | "text">("table")
  const [attachmentAttempt, setAttachmentAttempt] = createSignal(0)
  const [connectionFailure, setConnectionFailure] = createSignal<"identity" | "authorization" | undefined>()
  const [connecting, setConnecting] = createSignal(false)

  const attachment = (): OpenJournal["source"]["attachments"][number] | undefined =>
    props.open.source.attachments.find((file) => file.path === path())
  const isAttachment = (): boolean => attachment() !== undefined
  const syntax = (): ReturnType<typeof syntaxForSource> => syntaxForSource(path())
  const isCsv = (): boolean => path().toLowerCase().endsWith(".csv")
  createEffect(() => {
    path()
    setCsvMode("table")
  })
  const [blob] = createResource(
    () => (isAttachment() ? { path: path(), attempt: attachmentAttempt() } : undefined),
    ({ path: file }) => loadAttachment(props.open.bookId, file),
  )
  const driveAttachment = (): boolean => isAttachment() && isGoogleDriveRemote(props.open.remote)
  const connectDrive = async (): Promise<void> => {
    setConnecting(true)
    setConnectionFailure(undefined)
    const identity = await loadIdentity()
    if (!identity.ok) {
      setConnectionFailure("identity")
      setConnecting(false)
      return
    }
    const id = (await clientId()) ?? clientIdNow()
    const authorized = await accessToken(id)
    if (!authorized.ok) {
      setConnectionFailure("authorization")
      setConnecting(false)
      return
    }
    await keepClientId(id)
    setAttachmentAttempt((attempt) => attempt + 1)
    setConnecting(false)
  }
  const [previewUrl, setPreviewUrl] = createSignal<string | undefined>(undefined)
  createEffect(() => {
    const file = blob()
    const next = file === undefined ? undefined : URL.createObjectURL(file)
    setPreviewUrl(next)
    onCleanup(() => {
      if (next !== undefined) URL.revokeObjectURL(next)
    })
  })
  const stored = (): string => props.open.source.files[path()] ?? ""
  /** What is in the box: the edit in progress, or the file as it stands. */
  const text = (): string => unsavedText(path()) ?? stored()
  const changed = (): boolean => differsFrom(path(), stored())
  const csvForRules = (): string | undefined => {
    if (!path().toLowerCase().endsWith(".rules")) return undefined
    const settings = bookSettings()
    return csvPathForRules(
      path(),
      props.open.source.files,
      settings.ok ? settings.value.imports.csvFolder : "",
      settings.ok ? settings.value.imports.rulesFolder : "",
    )
  }

  const save = async (): Promise<void> => {
    const saved = path()
    setSaving(true)
    const result = await rewriteFile(saved, text())
    setSaving(false)
    setTrouble(result.ok ? undefined : result.error)
    if (result.ok) letTextGo(saved)
  }

  return (
    /* flex-1 asks the page column for the height it has; see app.tsx. */
    <div class="flex flex-1 flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <Show when={Object.keys(props.open.source.files).length + props.open.source.attachments.length > 1}>
          <p class="min-w-0 truncate font-mono text-xs text-muted-foreground">{path()}</p>
        </Show>
        <Show when={csvForRules()}>
          {(csv) => (
            <Button size="sm" variant="outline" onClick={() => {
              selectCsv(csv())
              dock.show("csv-importing")
            }}>
              {t("csvImport.test")}
            </Button>
          )}
        </Show>
      </div>

      {/* The box takes the height the screen has rather than a fixed number of
          lines: this is a file being edited, and a journal is longer than any
          height that would be picked here. Not resizable, because a handle that
          set its own height would be arguing with the one it is given — and
          there is nothing left to gain from dragging a box that is already as
          tall as the window. Below the height it can take, it keeps its floor
          and the page scrolls. */}
      <Show when={!isAttachment()} fallback={
        <Show when={blob.loading} fallback={
          <Show when={blob()} fallback={
            <div class="flex flex-col items-start gap-2">
              <p class="text-sm text-muted-foreground">
                {driveAttachment() ? t("source.attachmentDriveConnect") : t("source.attachmentFailed")}
              </p>
              <Show when={driveAttachment()}>
                <Button size="sm" variant="outline" disabled={connecting()} onClick={() => void connectDrive()}>
                  {connecting() ? t("gdrive.working") : t("gdrive.connect")}
                </Button>
                <Show when={connectionFailure()}>
                  {(failure) => <p role="alert" class="text-sm text-error-foreground">
                    {failure() === "identity" ? t("gdrive.oauthUnavailable") : t("gdrive.notConnected")}
                  </p>}
                </Show>
              </Show>
            </div>
          }>
            <Show when={attachment()?.type.startsWith("image/")} fallback={
              <iframe src={previewUrl()} title={path()} class="min-h-[36rem] w-full flex-1 rounded-md border border-border" />
            }>
              <img src={previewUrl()} alt={path()} class="max-h-[70vh] max-w-full rounded-md border border-border object-contain" />
            </Show>
          </Show>
        }><p class="text-sm text-muted-foreground">{t("source.loadingAttachment")}</p></Show>
      }>
        <Show when={isCsv()} fallback={
          <Show when={syntax()} fallback={
            <textarea
              class="min-h-[24rem] w-full flex-1 resize-none rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              spellcheck={false}
              autocapitalize="off"
              autocorrect="off"
              value={text()}
              onInput={(event) => holdText(path(), event.currentTarget.value)}
            />
          }>
            {(mode) => (
              <JournalTextEditor
                mode={mode()}
                value={text()}
                onChange={(written) => holdText(path(), written)}
                label={path()}
                class="min-h-[24rem] flex-1"
              />
            )}
          </Show>
        }>
          <CsvTextViewer
            value={text()}
            mode={csvMode()}
            onMode={setCsvMode}
            onChange={(written) => holdText(path(), written)}
            label={path()}
          />
        </Show>
      </Show>

      <Show when={!isAttachment()}>
        <div class="flex items-center gap-2">
          <Button size="sm" disabled={!changed() || saving()} onClick={() => void save()}>
            {t("source.save")}
          </Button>
          <p class="text-xs text-muted-foreground">
            {saving() ? t("source.checking") : changed() ? t("source.unsaved") : t("source.saved")}
          </p>
        </div>
      </Show>

      <Show when={trouble()}>{(cause) => <TroubleNote trouble={cause()} />}</Show>
    </div>
  )
}

/** The file entries are read from, as it is keyed among the others. */
export const entryPath = (open: OpenJournal): string => open.source.entry.replace(/^\//, "")

/** The file the address names, where the journal has one by that name; otherwise the entry file. */
export const fileShown = (hash: string, open: OpenJournal): string => {
  const named = fileOfSource(hash)
  return named !== undefined && (named in open.source.files || open.source.attachments.some(({ path }) => path === named)) ? named : entryPath(open)
}

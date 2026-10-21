import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { safeDocumentName, type DocumentSelection } from "~/core/journal/documents"
import { AttachmentLink } from "~/core/journal/AttachmentLink"
import { DocumentLink } from "~/core/journal/DocumentLink"
import { getOrUndefined } from "~/core/lib/monad"
import { compactImage } from "~/core/lib/image"
import { readPicture, type Trouble as OcrTrouble } from "~/core/lib/ocr/client"
import { PaperclipIcon } from "~/core/lib/ui/icons"
import { journal } from "~/core/journal/store"
import { documents } from "~/core/journal/book-settings"
import { t } from "~/core/i18n"

export function DocumentField(props: {
  readonly path: string | undefined
  readonly file: File | undefined
  readonly disabled?: boolean
  readonly onSelect: (selection: DocumentSelection | undefined) => void
  readonly onRecognisedText?: (text: readonly string[]) => void
}): JSX.Element {
  let picker: HTMLInputElement | undefined
  let camera: HTMLInputElement | undefined
  const [choosingExisting, setChoosingExisting] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [visibleCount, setVisibleCount] = createSignal(20)
  const [recognition, setRecognition] = createSignal<Recognition>({ kind: "idle" })
  const [recognitionAttempt, setRecognitionAttempt] = createSignal(0)
  const existingDocuments = () => {
    const folder = `${documents().folder}/`
    return getOrUndefined(journal())?.source.attachments.filter(({ path }) => path.startsWith(folder)) ?? []
  }
  const matchingDocuments = createMemo(() => {
    const query = searchKey(search().trim())
    return existingDocuments()
      .filter(({ path }) => searchKey(path).includes(query))
      .sort((left, right) => left.path.localeCompare(right.path))
  })
  const visibleDocuments = createMemo(() => matchingDocuments().slice(0, visibleCount()))

  createEffect(() => {
    if (props.file !== undefined) return
    setRecognitionAttempt((attempt) => attempt + 1)
    setRecognition({ kind: "idle" })
    props.onRecognisedText?.([])
  })

  const select = (selection: DocumentSelection | undefined): void => {
    setRecognitionAttempt((attempt) => attempt + 1)
    setRecognition({ kind: "idle" })
    props.onRecognisedText?.([])
    props.onSelect(selection)
  }

  const readText = async (): Promise<void> => {
    const file = props.file
    if (file === undefined) return
    const attempt = recognitionAttempt() + 1
    setRecognitionAttempt(attempt)
    setRecognition({ kind: "reading" })
    const result = await readPicture(file)
    if (recognitionAttempt() !== attempt) return
    if (!result.ok) {
      props.onRecognisedText?.([])
      setRecognition({ kind: "failed", trouble: result.error })
      return
    }
    const text = [...new Set(
      result.value.rows
        .flatMap((row) => row.map((line) => line.text.trim()))
        .filter((line) => line !== ""),
    )]
    props.onRecognisedText?.(text)
    setRecognition(text.length > 0 ? { kind: "read" } : { kind: "blank" })
  }

  return (
    <section class="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/20 p-3">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          <PaperclipIcon class="size-4" />
        </span>
        <div class="flex min-w-0 flex-col gap-1">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <h2 class="text-sm font-medium">{t("compose.document")}</h2>
            <span class="text-xs text-muted-foreground">{t("compose.documentOptional")}</span>
          </div>
          <p class="text-xs text-muted-foreground">{t("compose.documentHint")}</p>
        </div>
      </div>
      <Show when={!props.file && props.path}>
        {(path) => <DocumentLink path={path()} />}
      </Show>
      <Show when={props.file}>
        {(file) => (
          <div class="flex flex-col gap-1">
            <span class="truncate text-xs">{t("compose.pendingDocument", { name: file().name })}</span>
            <AttachmentLink file={file()} name={file().name} />
            <TextField>
              <TextFieldInput
                type="text"
                value={file().name}
                aria-label={t("compose.documentName")}
                disabled={props.disabled}
                onInput={(event) => {
                  const name = event.currentTarget.value.trim()
                  if (!safeDocumentName(name)) return
                  props.onSelect({ kind: "file", file: new File([file()], name, { type: file().type, lastModified: file().lastModified }) })
                }}
              />
            </TextField>
          </div>
        )}
      </Show>
      <input
        class="hidden"
        type="file"
        disabled={props.disabled}
        ref={(element) => { picker = element }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file !== undefined) void compactImage(file).then((compact) => select({ kind: "file", file: compact }))
        }}
      />
      <input
        class="hidden"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={props.disabled}
        ref={(element) => { camera = element }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file !== undefined) void compactImage(file).then((compact) => select({ kind: "file", file: compact }))
        }}
      />
      <div class="flex flex-wrap gap-2">
        <Button size="sm" disabled={props.disabled} onClick={() => picker?.click()}>
          {props.path || props.file ? t("compose.replaceDocument") : t("compose.chooseDocument")}
        </Button>
        <Button variant="outline" size="sm" disabled={props.disabled} onClick={() => camera?.click()}>
          {t("compose.takePhoto")}
        </Button>
        <Show when={props.file}>
          <Button variant="outline" size="sm" disabled={props.disabled || recognition().kind === "reading"} onClick={() => void readText()}>
            {t("compose.readText")}
          </Button>
        </Show>
        <Show when={existingDocuments().length > 0}>
          <Button
            variant="outline"
            size="sm"
            disabled={props.disabled}
            onClick={() => setChoosingExisting((shown) => !shown)}
          >
            {t("compose.chooseExistingDocument")}
          </Button>
        </Show>
        <Show when={props.path || props.file}>
          <Button variant="ghost" size="sm" disabled={props.disabled} onClick={() => select(undefined)}>
            {t("compose.removeDocument")}
          </Button>
        </Show>
      </div>
      <Show when={recognition().kind !== "idle"}>
        <p class="text-xs text-muted-foreground" aria-live="polite">
          {recognitionMessage(recognition())}
        </p>
      </Show>
      <Show when={choosingExisting()}>
        <div class="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-md border p-2">
          <TextField>
            <TextFieldInput
              type="search"
              value={search()}
              aria-label={t("compose.searchExistingDocuments")}
              placeholder={t("compose.searchExistingDocuments")}
              onInput={(event) => {
                setSearch(event.currentTarget.value)
                setVisibleCount(20)
              }}
            />
          </TextField>
          <Show when={matchingDocuments().length > 0} fallback={<p class="text-xs text-muted-foreground">{t("compose.noExistingDocuments")}</p>}>
            <p class="text-xs text-muted-foreground">
              {t("compose.existingDocumentsCount", {
                shown: visibleDocuments().length,
                total: matchingDocuments().length,
              })}
            </p>
          </Show>
          <For each={visibleDocuments()}>
            {(attachment) => (
              <div class="flex min-w-0 items-center justify-between gap-2">
                <DocumentLink path={attachment.path} />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={props.disabled}
                  onClick={() => {
                    select({ kind: "existing", path: attachment.path })
                    setChoosingExisting(false)
                  }}
                >
                  {t("compose.linkDocument")}
                </Button>
              </div>
            )}
          </For>
          <Show when={visibleDocuments().length < matchingDocuments().length}>
            <Button
              variant="outline"
              size="sm"
              disabled={props.disabled}
              onClick={() => setVisibleCount((count) => count + 20)}
            >
              {t("compose.moreExistingDocuments")}
            </Button>
          </Show>
        </div>
      </Show>
    </section>
  )
}

type Recognition =
  | { readonly kind: "idle" }
  | { readonly kind: "reading" }
  | { readonly kind: "read" }
  | { readonly kind: "blank" }
  | { readonly kind: "failed"; readonly trouble: OcrTrouble }

const recognitionMessage = (recognition: Recognition): string => {
  switch (recognition.kind) {
    case "idle":
      return ""
    case "reading":
      return t("compose.readingText")
    case "read":
      return t("compose.textSuggested")
    case "blank":
      return t("receipts.failed.blank")
    case "failed":
      return t(`receipts.failed.${recognition.trouble.kind}`)
  }
}

const searchKey = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()

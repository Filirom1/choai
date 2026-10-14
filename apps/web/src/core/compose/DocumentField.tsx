import { For, Show, createMemo, createSignal, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { safeDocumentName, type DocumentSelection } from "~/core/journal/documents"
import { AttachmentLink } from "~/core/journal/AttachmentLink"
import { DocumentLink } from "~/core/journal/DocumentLink"
import { getOrUndefined } from "~/core/lib/monad"
import { compactImage } from "~/core/lib/image"
import { journal } from "~/core/journal/store"
import { documents } from "~/core/journal/book-settings"
import { t } from "~/core/i18n"

export function DocumentField(props: {
  readonly path: string | undefined
  readonly file: File | undefined
  readonly disabled?: boolean
  readonly onSelect: (selection: DocumentSelection | undefined) => void
}): JSX.Element {
  let picker: HTMLInputElement | undefined
  let camera: HTMLInputElement | undefined
  const [choosingExisting, setChoosingExisting] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [visibleCount, setVisibleCount] = createSignal(20)
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

  return (
    <section class="flex flex-col gap-2 rounded-md border p-2">
      <span class="text-xs font-medium text-muted-foreground">{t("compose.document")}</span>
      <Show when={!props.file && props.path}>
        {(path) => <DocumentLink path={path()} />}
      </Show>
      <Show when={props.file} fallback={<Show when={!props.path}><span class="text-xs text-muted-foreground">{t("compose.noDocument")}</span></Show>}>
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
          if (file !== undefined) void compactImage(file).then((compact) => props.onSelect({ kind: "file", file: compact }))
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
          if (file !== undefined) void compactImage(file).then((compact) => props.onSelect({ kind: "file", file: compact }))
        }}
      />
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={props.disabled} onClick={() => picker?.click()}>
          {props.path || props.file ? t("compose.replaceDocument") : t("compose.chooseDocument")}
        </Button>
        <Button variant="outline" size="sm" disabled={props.disabled} onClick={() => camera?.click()}>
          {t("compose.takePhoto")}
        </Button>
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
          <Button variant="ghost" size="sm" disabled={props.disabled} onClick={() => props.onSelect(undefined)}>
            {t("compose.removeDocument")}
          </Button>
        </Show>
      </div>
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
                    props.onSelect({ kind: "existing", path: attachment.path })
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

const searchKey = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()

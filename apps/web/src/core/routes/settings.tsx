import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { LOCALES, LOCALE_NAMES, locale, setLocale, t } from "~/core/i18n"
import { Button } from "~/core/components/ui/button"
import { pageOf } from "~/core/address/address"
import { SCHEMES, scheme, setScheme } from "~/core/lib/theme"
import { ACCOUNT_SORTS } from "~/core/journal/declarations"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { DEFAULT_DOCUMENT_SETTINGS, validDocumentSettings } from "~/core/journal/documents"
import { BOOK_CONFIG_PATH, DEFAULT_BOOK_CONFIG, validImportSettings, type EntryDisplaySettings } from "~/core/journal/book-config"
import { bookSettings, saveBookSettings, type BookSettingsTrouble } from "~/core/journal/book-settings"
import { journal } from "~/core/journal/store"
import { getOrUndefined } from "~/core/lib/monad"

/**
 * What this page is made of, in the order it is made of it.
 *
 * One table, read twice: the page hangs an anchor on each section, and the list
 * beside it offers the same names in the same order.
 */
export interface Section {
  /** What the page calls this section, and what the address says when it is the one being read. */
  readonly id: string
  /** Read at the moment it is shown, so it comes out in the reader's language. */
  readonly name: () => string
}

export const SECTIONS: readonly Section[] = [
  { id: "language", name: () => t("settings.language") },
  { id: "appearance", name: () => t("settings.appearance") },
  { id: "book", name: () => t("settings.book") },
  { id: "account-sort", name: () => t("settings.accountSort") },
]

const ENTRY_DISPLAY_OPTIONS: readonly { readonly field: keyof EntryDisplaySettings; readonly label: () => string }[] = [
  { field: "date", label: () => t("settings.entryDate") },
  { field: "payee", label: () => t("settings.entryPayee") },
  { field: "note", label: () => t("settings.entryNote") },
  { field: "status", label: () => t("settings.entryStatus") },
  { field: "code", label: () => t("settings.entryCode") },
  { field: "transactionComment", label: () => t("settings.entryComment") },
  { field: "transactionTags", label: () => t("settings.entryTags") },
  { field: "postingDate", label: () => t("settings.postingDate") },
  { field: "postingComment", label: () => t("settings.postingComment") },
  { field: "postingTags", label: () => t("settings.postingTags") },
]

/** Everything set once and then left alone, one section at a time. */
export default function Settings(): JSX.Element {
  const location = useLocation()
  const [draft, setDraft] = createSignal({
    documents: DEFAULT_DOCUMENT_SETTINGS,
    invert: false,
    imports: { csvFolder: "", rulesFolder: "" },
    accountSort: DEFAULT_BOOK_CONFIG.accountSort,
    entryDisplay: DEFAULT_BOOK_CONFIG.entryDisplay,
  })
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<BookSettingsTrouble>()
  const section = createMemo(() => pageOf(location.hash))
  const open = () => getOrUndefined(journal())
  const configAddress = () => {
    const current = open()
    return current === undefined ? undefined : `${current.bookId}:${current.source.files[BOOK_CONFIG_PATH] ?? ""}`
  }

  createEffect(
    on(section, (hash) => {
      const named = hash.replace(/^#/, "")
      if (named !== "") document.getElementById(named)?.scrollIntoView({ block: "start" })
    }),
  )

  createEffect(
    on(configAddress, () => {
      const settings = bookSettings()
      setDraft(settings.ok
        ? {
            documents: settings.value.documents,
            invert: settings.value.invert,
            imports: settings.value.imports,
            accountSort: settings.value.accountSort,
            entryDisplay: settings.value.entryDisplay,
          }
        : {
            documents: DEFAULT_DOCUMENT_SETTINGS,
            invert: false,
            imports: { csvFolder: "", rulesFolder: "" },
            accountSort: DEFAULT_BOOK_CONFIG.accountSort,
            entryDisplay: DEFAULT_BOOK_CONFIG.entryDisplay,
          })
      setFailure(undefined)
    }),
  )

  const save = async (): Promise<void> => {
    setSaving(true)
    const saved = await saveBookSettings(draft())
    setFailure(saved.ok ? undefined : saved.error)
    setSaving(false)
  }

  const configurationFailure = (): string | undefined => {
    const settings = bookSettings()
    return settings.ok
      ? undefined
      : settings.error.kind === "invalid-config"
        ? t("settings.invalidConfig")
        : undefined
  }

  return (
    <div class="flex max-w-md flex-col gap-6 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-6">
      <section class="flex flex-col gap-4">
        <h2 class="text-sm font-medium">{t("settings.application")}</h2>
        <section id="language" class="flex flex-col gap-2">
          <h3 class="text-sm font-medium">{t("settings.language")}</h3>
          <div class="flex flex-wrap gap-2">
            <For each={LOCALES}>
              {(option) => (
                <Button
                  variant={locale() === option ? "default" : "outline"}
                  size="sm"
                  onClick={() => setLocale(option)}
                >
                  {LOCALE_NAMES[option]}
                </Button>
              )}
            </For>
          </div>
          <p class="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
        </section>
        <section id="appearance" class="flex flex-col gap-2">
          <h3 class="text-sm font-medium">{t("settings.appearance")}</h3>
          <div class="flex flex-wrap gap-2">
            <For each={SCHEMES}>
              {(option) => (
                <Button
                  variant={scheme() === option ? "default" : "outline"}
                  size="sm"
                  onClick={() => setScheme(option)}
                >
                  {t(`settings.scheme.${option}`)}
                </Button>
              )}
            </For>
          </div>
          <p class="text-xs text-muted-foreground">{t("settings.appearanceHint")}</p>
        </section>
      </section>
      <section id="book" class="flex flex-col gap-3">
        <div>
          <h2 class="text-sm font-medium">{t("settings.book")}</h2>
          <Show when={open()} fallback={<p class="text-xs text-muted-foreground">{t("settings.noBook")}</p>}>
            {(current) => <p class="text-xs text-muted-foreground">{t("settings.bookHint", { name: current().source.label })}</p>}
          </Show>
        </div>
        <section id="account-sort" class="flex flex-col gap-2">
          <h3 class="text-sm font-medium">{t("settings.accountSort")}</h3>
          <Show when={open()} fallback={<p class="text-xs text-muted-foreground">{t("settings.noBook")}</p>}>
            <div class="flex flex-wrap gap-2">
              <For each={ACCOUNT_SORTS}>
                {(option) => (
                  <Button
                    variant={draft().accountSort === option ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDraft({ ...draft(), accountSort: option })}
                  >
                    {t(`settings.accountSortOptions.${option}`)}
                  </Button>
                )}
              </For>
            </div>
            <p class="text-xs text-muted-foreground">{t("settings.accountSortHint")}</p>
          </Show>
        </section>
        <Show when={open()}>
          <Show when={configurationFailure()}>
            {(message) => <p role="alert" class="text-sm text-error">{message()}</p>}
          </Show>
          <label class="flex flex-col gap-1 text-sm">
            {t("settings.documentTag")}
            <TextField>
              <TextFieldInput
                value={draft().documents.tag}
                onInput={(event) => setDraft({ ...draft(), documents: { ...draft().documents, tag: event.currentTarget.value } })}
              />
            </TextField>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            {t("settings.documentFolder")}
            <TextField>
              <TextFieldInput
                value={draft().documents.folder}
                onInput={(event) => setDraft({ ...draft(), documents: { ...draft().documents, folder: event.currentTarget.value } })}
              />
            </TextField>
          </label>
          <p class="text-xs text-muted-foreground">
            {validDocumentSettings(draft().documents) ? t("settings.documentsHint") : t("settings.documentsInvalid")}
          </p>
          <div class="flex flex-col gap-2 border-t border-border pt-3">
            <h3 class="text-sm font-medium">{t("settings.importFolders")}</h3>
            <label class="flex flex-col gap-1 text-sm">
              {t("settings.csvFolder")}
              <TextField>
                <TextFieldInput
                  value={draft().imports.csvFolder}
                  placeholder=""
                  onInput={(event) => setDraft({ ...draft(), imports: { ...draft().imports, csvFolder: event.currentTarget.value } })}
                />
              </TextField>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              {t("settings.rulesFolder")}
              <TextField>
                <TextFieldInput
                  value={draft().imports.rulesFolder}
                  placeholder=""
                  onInput={(event) => setDraft({ ...draft(), imports: { ...draft().imports, rulesFolder: event.currentTarget.value } })}
                />
              </TextField>
            </label>
            <p class="text-xs" classList={{ "text-destructive": !validImportSettings(draft().imports), "text-muted-foreground": validImportSettings(draft().imports) }}>
              {t(validImportSettings(draft().imports) ? "settings.importFoldersHint" : "settings.importFoldersInvalid")}
            </p>
          </div>
          <label class="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              class="mt-1"
              checked={draft().invert}
              onChange={(event) => setDraft({ ...draft(), invert: event.currentTarget.checked })}
            />
            <span class="flex flex-col gap-1">
              <span>{t("settings.invertReports")}</span>
              <span class="text-xs text-muted-foreground">{t("settings.invertReportsHint")}</span>
            </span>
          </label>
          <div class="flex flex-col gap-2 border-t border-border pt-3">
            <div>
              <h3 class="text-sm font-medium">{t("settings.entryDisplay")}</h3>
              <p class="text-xs text-muted-foreground">{t("settings.entryDisplayHint")}</p>
            </div>
            <For each={ENTRY_DISPLAY_OPTIONS}>
              {(option) => (
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft().entryDisplay[option.field]}
                    onChange={(event) => setDraft({
                      ...draft(),
                      entryDisplay: { ...draft().entryDisplay, [option.field]: event.currentTarget.checked },
                    })}
                  />
                  <span>{option.label()}</span>
                </label>
              )}
            </For>
          </div>
          <Show when={failure()}>
            {(trouble) => <p role="alert" class="text-sm text-error">{settingsFailure(trouble())}</p>}
          </Show>
          <Button
            size="sm"
            class="self-start"
            disabled={saving() || !validDocumentSettings(draft().documents) || !validImportSettings(draft().imports) || configurationFailure() !== undefined}
            onClick={() => void save()}
          >
            {saving() ? t("settings.saving") : t("settings.saveBook")}
          </Button>
        </Show>
      </section>
    </div>
  )
}

const settingsFailure = (trouble: BookSettingsTrouble): string =>
  trouble.kind === "invalid-config"
    ? t("settings.invalidConfig")
    : t("settings.saveFailed")

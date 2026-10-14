import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"

import { LOCALES, LOCALE_NAMES, locale, setLocale, t } from "~/core/i18n"
import { Button } from "~/core/components/ui/button"
import { pageOf } from "~/core/address/address"
import { SCHEMES, scheme, setScheme } from "~/core/lib/theme"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { DEFAULT_DOCUMENT_SETTINGS, validDocumentSettings, type DocumentSettings } from "~/core/journal/documents"
import { bookSettings, saveDocumentSettings, type BookSettingsTrouble } from "~/core/journal/book-settings"
import { BOOK_CONFIG_PATH } from "~/core/journal/book-config"
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
]

/** Everything set once and then left alone, one section at a time. */
export default function Settings(): JSX.Element {
  const location = useLocation()
  const [draft, setDraft] = createSignal<DocumentSettings>(DEFAULT_DOCUMENT_SETTINGS)
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
      setDraft(settings.ok ? settings.value.documents : DEFAULT_DOCUMENT_SETTINGS)
      setFailure(undefined)
    }),
  )

  const save = async (): Promise<void> => {
    setSaving(true)
    const saved = await saveDocumentSettings(draft())
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
        <Show when={open()}>
          <Show when={configurationFailure()}>
            {(message) => <p role="alert" class="text-sm text-error">{message()}</p>}
          </Show>
          <label class="flex flex-col gap-1 text-sm">
            {t("settings.documentTag")}
            <TextField>
              <TextFieldInput
                value={draft().tag}
                onInput={(event) => setDraft({ ...draft(), tag: event.currentTarget.value })}
              />
            </TextField>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            {t("settings.documentFolder")}
            <TextField>
              <TextFieldInput
                value={draft().folder}
                onInput={(event) => setDraft({ ...draft(), folder: event.currentTarget.value })}
              />
            </TextField>
          </label>
          <p class="text-xs text-muted-foreground">
            {validDocumentSettings(draft()) ? t("settings.documentsHint") : t("settings.documentsInvalid")}
          </p>
          <Show when={failure()}>
            {(trouble) => <p role="alert" class="text-sm text-error">{settingsFailure(trouble())}</p>}
          </Show>
          <Button
            size="sm"
            class="self-start"
            disabled={saving() || !validDocumentSettings(draft()) || configurationFailure() !== undefined}
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

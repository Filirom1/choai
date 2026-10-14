import { Show, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TroubleNote } from "~/core/components/trouble-note"
import { getOrUndefined } from "~/core/lib/monad"
import { t } from "~/core/i18n"
import { EntryForm } from "./EntryForm"
import { DocumentField } from "./DocumentField"
import { EntryText } from "./EntryText"
import {
  editEntry,
  editEntryDraft,
  editing,
  editingDocumentFile,
  editingDocumentPath,
  chooseEditingDocument,
  editingShown,
  entrySaving,
  entryTrouble,
  removeEntry,
  saveEntry,
  showEditAsForm,
  showEditAsText,
  stopEditingEntry,
} from "./editing"
import { canBeForm, writtenOf } from "./surface"
import { emptyDraft, todayISO, type Draft } from "./draft"
import { declaredCommodity } from "~/core/journal/store"
import { documents } from "~/core/journal/documents"

/**
 * One entry, as the form it is written from or as the lines it is written on.
 *
 * The same form as writing a new entry, so the auto-completion is the same. An
 * entry the form would not write back exactly stays as its lines, since the
 * alignment, a status mark, or a comment on one posting is what the file holds.
 */
export function EntryEditor(): JSX.Element {
  return (
    <Show when={editing()}>
      {(span) => (
        <div class="flex flex-col gap-3 p-3">
          <p class="font-mono text-[11px] text-muted-foreground">
            {t("edit.where", { path: span().path, from: span().from, to: span().to })}
          </p>

          <Show
            when={editingShown().shows === "form"}
            fallback={
              <EntryText
                text={textOfEdit()}
                onText={editEntry}
                onForm={showEditAsForm}
                keptAsText={!canBeForm(textOfEdit(), declaredCommodity())}
              />
            }
          >
            {(_) => (
              <EntryForm draft={draftOfEdit} onEdit={editEntryDraft} hiddenEntryTags={[documents().tag]}>
                  <Button variant="ghost" size="sm" class="self-start px-1" onClick={showEditAsText}>
                    {t("compose.asText")}
                  </Button>
                </EntryForm>
            )}
          </Show>

          <DocumentField
            path={editingDocumentPath()}
            file={editingDocumentFile()}
            disabled={entrySaving()}
            onSelect={chooseEditingDocument}
          />

          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              class="text-error-foreground"
              disabled={entrySaving()}
              onClick={() => void removeEntry()}
            >
              {t("edit.remove")}
            </Button>
            <Button variant="ghost" size="sm" class="ml-auto" disabled={entrySaving()} onClick={stopEditingEntry}>
              {t("edit.cancel")}
            </Button>
            <Button size="sm" disabled={entrySaving()} onClick={() => void saveEntry(currentText())}>
              {t("edit.save")}
            </Button>
          </div>

          <Show when={getOrUndefined(entryTrouble())}>
            {(trouble) => <TroubleNote trouble={trouble()} />}
          </Show>
          <p class="text-xs text-muted-foreground">{t("edit.hint")}</p>
        </div>
      )}
    </Show>
  )
}

const textOfEdit = (): string => {
  const current = editingShown()
  return current.shows === "text" ? current.text : ""
}

const draftOfEdit = (): Draft => {
  const current = editingShown()
  return current.shows === "form" ? current.draft : emptyDraft(todayISO())
}

/** What gets written: the form as the text it becomes, or the text as it stands. */
const currentText = (): string => writtenOf(editingShown(), declaredCommodity())

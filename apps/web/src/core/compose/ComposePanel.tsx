import { Show, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TroubleNote } from "~/core/components/trouble-note"
import { getOrUndefined } from "~/core/lib/monad"
import { declaredCommodity } from "~/core/journal/store"
import { documents } from "~/core/journal/documents"
import { t } from "~/core/i18n"
import { EntryForm } from "./EntryForm"
import { DocumentField } from "./DocumentField"
import { EntryText } from "./EntryText"
import {
  chooseEntryDocument,
  editDraft,
  editText,
  entryDocumentFile,
  entryDocumentPath,
  entryShown,
  save,
  saving,
  savingTrouble,
  showAsForm,
  showAsText,
  writable,
} from "./store"
import { canBeForm } from "./surface"
import { emptyDraft, todayISO, type Draft } from "./draft"

/**
 * Writing an entry, beside the journal it goes into.
 *
 * The form is the same one used for correcting an entry, so auto-completion is
 * the same in both. The entry can be shown as the text it will be written as,
 * for the last adjustments by hand, and goes back to the form if it still reads
 * as the same entry.
 */
export function ComposePanel(): JSX.Element {
  const isText = (): boolean => entryShown().shows === "text"
  const textOf = (): string => {
    const current = entryShown()
    return current.shows === "text" ? current.text : ""
  }
  const draftOf = (): Draft => {
    const current = entryShown()
    return current.shows === "form" ? current.draft : emptyDraft(todayISO())
  }

  return (
    <div class="flex flex-col gap-3 p-3">
      <Show when={isText()} fallback={<EntryForm draft={draftOf} onEdit={editDraft} hiddenEntryTags={[documents().tag]}>
        <Button variant="ghost" size="sm" class="self-start px-1" onClick={showAsText}>
          {t("compose.asText")}
        </Button>
      </EntryForm>}>
        <EntryText
          text={textOf()}
          onText={editText}
          onForm={showAsForm}
          keptAsText={!canBeForm(textOf(), declaredCommodity())}
        />
      </Show>

      <DocumentField path={entryDocumentPath()} file={entryDocumentFile()} disabled={saving()} onSelect={chooseEntryDocument} />

      <Show when={getOrUndefined(savingTrouble())}>
        {(trouble) => <TroubleNote trouble={trouble()} />}
      </Show>

      <Button disabled={!writable() || saving()} onClick={() => void save()}>
        {t("compose.add")}
      </Button>
    </div>
  )
}

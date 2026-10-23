import { Show, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { JournalTextEditor } from "~/core/components/journal-text-editor"
import { t } from "~/core/i18n"

/**
 * An entry as the text it will be written as, for adjusting by hand.
 *
 * The form comes back only where the text still reads as the same entry. Where
 * it would lose something, the text stays and the screen says so.
 */
export function EntryText(props: {
  text: string
  onText: (text: string) => void
  onForm: () => void
  /** True when the form would lose something in the text, so going back is not offered. */
  keptAsText: boolean
}): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <JournalTextEditor
        mode="journal"
        class="min-h-40"
        label={t("compose.willBeWritten")}
        value={props.text}
        onChange={props.onText}
      />
      <Show
        when={!props.keptAsText}
        fallback={<p class="text-xs text-muted-foreground">{t("compose.keptAsText")}</p>}
      >
        <Button variant="ghost" size="sm" class="self-start px-1" onClick={props.onForm}>
          {t("compose.asForm")}
        </Button>
      </Show>
    </div>
  )
}

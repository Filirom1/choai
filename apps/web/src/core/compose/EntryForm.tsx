import { For, Index, Show, createResource, type Accessor, type JSX } from "solid-js"

import { ask } from "~/core/hledger/client"
import { declaredCommodity, journal } from "~/core/journal/store"
import { getOrUndefined } from "~/core/lib/monad"
import { Button } from "~/core/components/ui/button"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { t } from "~/core/i18n"
import { composeCompletions, tagNamesFor, valuesForName } from "./completions"
import { draftToJournal, hasBlankAmount, type Draft, type DraftEdit, type Tag } from "./draft"
import { EXAMPLE_FIGURE, amountExample } from "./hint"
import { Ghost, Labelled, OFFERED, StatusPicker, Tags, namesListOf, offeredOn, roomForSymbol, showPicker, valuesListOf } from "./FormParts"
import { ghostOf } from "./commodity"

/**
 * An entry as a form, for writing one and for correcting one.
 *
 * The same boxes in both places, so what the auto-completion offers when writing
 * a new entry is what it offers when an old one is corrected. The text it will be
 * written as is shown underneath, since that is what the file will contain.
 */
export function EntryForm(props: {
  draft: Accessor<Draft>
  onEdit: (edit: DraftEdit) => void
  /** The text of the entry as the form would write it, shown underneath. */
  children?: JSX.Element
}): JSX.Element {
  const listPrefix = `entry-form-${crypto.randomUUID()}-`
  const suggestions = useSuggestions()
  const accounts = (): readonly string[] => getOrUndefined(journal())?.summary.accounts ?? []
  const payees = (): readonly string[] => suggestions()?.payees ?? []
  const knownTags = (): readonly Tag[] => suggestions()?.tags ?? []
  /**
   * The example in the empty box.
   *
   * Where a default commodity is declared its symbol is already shown against
   * the box, so the example is the figure alone. Everywhere else the symbol has
   * to come from somewhere, and an example is the only place left: what gets
   * written is still exactly what was typed, and the symbol is only a nudge.
   */
  const amountHint = (): string =>
    declaredCommodity() !== undefined
      ? EXAMPLE_FIGURE
      : (amountExample(getOrUndefined(journal())?.summary.commodities ?? []) ?? t("compose.amount"))

  return (
    <div class="flex flex-col gap-3 p-3">
      <div class="flex gap-2">
        <Labelled label={t("compose.date")}>
          <TextFieldInput
            type="date"
            class="h-8"
            value={props.draft().date}
            onInput={(event) => props.onEdit({ kind: "fields", change: { date: event.currentTarget.value } })}
          />
        </Labelled>
        <StatusPicker
          status={props.draft().status}
          label={t("compose.entryStatus")}
          labelled
          onChange={(status) => props.onEdit({ kind: "fields", change: { status } })}
        />
      </div>

      <Labelled label={t("compose.code")}>
        <TextFieldInput
          type="text"
          class="h-8"
          placeholder={t("compose.codeHint")}
          value={props.draft().code ?? ""}
          onInput={(event) => props.onEdit({ kind: "fields", change: { code: event.currentTarget.value } })}
        />
      </Labelled>

      <Labelled label={t("compose.payee")}>
        <TextFieldInput
          type="text"
          class="h-8"
          placeholder={t("compose.payeeHint")}
          list={`${listPrefix}known-payees`}
          ref={(input) => {
            input.value = props.draft().payee
          }}
          onInput={(event) => {
            props.onEdit({ kind: "fields", change: { payee: event.currentTarget.value } })
            showPicker(event.currentTarget)
          }}
        />
      </Labelled>

      <Labelled label={t("compose.note")}>
        <TextFieldInput
          type="text"
          class="h-8"
          placeholder={t("compose.noteHint")}
          value={props.draft().note}
          onInput={(event) => props.onEdit({ kind: "fields", change: { note: event.currentTarget.value } })}
        />
      </Labelled>

      <Tags
        tags={props.draft().tags}
        offered={offeredOn("entry")}
        on="entry"
        listPrefix={listPrefix}
        onAdd={(name) => props.onEdit({ kind: "entryTag", edit: { kind: "add", name } })}
        onEdit={(index, change) => props.onEdit({ kind: "entryTag", edit: { kind: "change", index, change } })}
        onRemove={(index) => props.onEdit({ kind: "entryTag", edit: { kind: "remove", index } })}
        label={t("compose.tags")}
      />

      <datalist id={`${listPrefix}known-accounts`}>
        <For each={accounts()}>{(account) => <option value={account} />}</For>
      </datalist>
      <datalist id={`${listPrefix}known-payees`}>
        <For each={payees()}>{(payee) => <option value={payee} />}</For>
      </datalist>
      <For each={["entry", "posting"] as const}>
        {(on) => (
          <datalist id={namesListOf(on, listPrefix)}>
            <For each={tagNamesFor(offeredOn(on), knownTags())}>{(name) => <option value={name} />}</For>
          </datalist>
        )}
      </For>
      <For each={tagNamesFor(OFFERED, knownTags())}>
        {(name) => (
          <datalist id={valuesListOf(name, listPrefix)}>
            <For each={valuesForName(name, OFFERED, knownTags())}>{(value) => <option value={value} />}</For>
          </datalist>
        )}
      </For>

      <div class="flex flex-col gap-2">
        <span class="text-xs font-medium text-muted-foreground">{t("compose.postings")}</span>
        {/* Index rather than For: these rows are edited in place. For keys by
            the item itself, so every keystroke would replace the object, tear
            down the row and take the caret with it. */}
        <Index each={props.draft().postings}>
          {(posting, index) => (
            <div class="flex flex-col gap-1">
              <div class="flex gap-1">
                <StatusPicker
                  status={posting().status}
                  label={t("compose.postingStatus")}
                  onChange={(status) =>
                    props.onEdit({ kind: "posting", edit: { kind: "change", index, change: { status } } })
                  }
                />
                <TextField class="flex-1">
                  <TextFieldInput
                    type="text"
                    class="h-8"
                    list={`${listPrefix}known-accounts`}
                    placeholder={t("compose.account")}
                    ref={(input) => {
                      input.value = posting().account
                    }}
                    onInput={(event) => {
                      props.onEdit({
                        kind: "posting",
                        edit: { kind: "change", index, change: { account: event.currentTarget.value } },
                      })
                      showPicker(event.currentTarget)
                    }}
                  />
                </TextField>
                <TextField class="relative w-24">
                  <TextFieldInput
                    type="text"
                    class="h-8 text-right font-mono"
                    style={roomForSymbol(declaredCommodity())}
                    placeholder={amountHint()}
                    value={posting().amount}
                    onInput={(event) =>
                      props.onEdit({
                        kind: "posting",
                        edit: { kind: "change", index, change: { amount: event.currentTarget.value } },
                      })
                    }
                  />
                  <Show when={ghostOf(posting().amount, declaredCommodity())}>
                    {(symbol) => <Ghost of={symbol()} />}
                  </Show>
                </TextField>
              </div>
              <Tags
                tags={posting().tags}
                offered={offeredOn("posting")}
                on="posting"
                listPrefix={listPrefix}
                onAdd={(name) => props.onEdit({ kind: "posting", edit: { kind: "tag", index, edit: { kind: "add", name } } })}
                onEdit={(at, change) =>
                  props.onEdit({ kind: "posting", edit: { kind: "tag", index, edit: { kind: "change", index: at, change } } })
                }
                onRemove={(at) => props.onEdit({ kind: "posting", edit: { kind: "tag", index, edit: { kind: "remove", index: at } } })}
                label={t("compose.postingTags")}
                indented
              />
            </div>
          )}
        </Index>
        <Button
          variant="ghost"
          size="sm"
          class="self-start px-1"
          onClick={() => props.onEdit({ kind: "posting", edit: { kind: "add" } })}
        >
          {t("compose.addPosting")}
        </Button>
      </div>

      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-muted-foreground">{t("compose.willBeWritten")}</span>
        <pre class="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
          {draftToJournal(props.draft(), declaredCommodity())}
        </pre>
        <Show when={hasBlankAmount(props.draft())}>
          <span class="text-xs text-muted-foreground">{t("compose.hledgerFillsTheRest")}</span>
        </Show>
      </div>

      {props.children}
    </div>
  )
}

/**
 * The payees and tags already in the book, read once per book.
 *
 * Shared by writing and correcting, so the form that opens on an old entry has
 * the same suggestions as the one for a new one.
 */
function useSuggestions() {
  const [suggestions] = createResource(
    () => getOrUndefined(journal()),
    async (open) => {
      const [completions, entries] = await Promise.all([
        ask({ kind: "completions" }),
        ask({ kind: "entries", query: "", limit: Math.max(open.summary.transactions, 1), offset: 0 }),
      ])
      return composeCompletions(
        completions.ok ? completions.value : undefined,
        entries.ok ? entries.value.items : [],
      )
    },
  )
  return suggestions
}

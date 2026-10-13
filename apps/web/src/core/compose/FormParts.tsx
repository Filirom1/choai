import { For, Index, Show, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TextField, TextFieldInput } from "~/core/components/ui/text-field"
import { XIcon } from "~/core/lib/ui/icons"
import { t } from "~/core/i18n"
import { edition } from "~/edition"
import type { OfferedTag } from "~/edition/types"
import type { DefaultCommodity, Status } from "~/core/hledger/wire"
import type { Tag } from "./draft"

export const showPicker = (input: HTMLInputElement): void => {
  const picker = input as HTMLInputElement & { showPicker?: () => void }
  picker.showPicker?.()
}

/**
 * The parts a form of an entry is built from, shared by writing a new entry and
 * correcting one so both offer the same boxes, the same tags and the same
 * suggestions.
 */

/**
 * The tags this build's edition offers, and where each of them goes.
 *
 * Read once: an edition is settled before the app runs.
 */
export const OFFERED: readonly OfferedTag[] = edition.tags ?? []

export const offeredOn = (on: OfferedTag["on"]): readonly OfferedTag[] => OFFERED.filter((tag) => tag.on === on)

/** One list per name, shared by every box that tag is written in. */
export const valuesListOf = (name: string, prefix = ""): string => `${prefix}offered-tag-values-${name}`
export const namesListOf = (on: OfferedTag["on"], prefix = ""): string => `${prefix}offered-${on}-tag-names`

export const valuesFor = (name: string, prefix = ""): string | undefined =>
  name.trim() === "" ? undefined : valuesListOf(name.trim(), prefix)

/**
 * Any number of name-and-value pairs, with any names.
 *
 * hledger puts no vocabulary on these — a tag is whatever you write in a comment
 * — so neither does this. What an edition offers is a button that starts the
 * line with the name written and suggestions in the value box, and never a
 * limit on what can be typed there. A button leaves once its tag is on the
 * line, since a second one of the same name is not what anybody pressing it
 * meant.
 */
export function Tags(props: {
  tags: readonly Tag[]
  offered: readonly OfferedTag[]
  on: OfferedTag["on"]
  label: string
  indented?: boolean
  listPrefix?: string
  onAdd: (name: string) => void
  onEdit: (index: number, change: Partial<Tag>) => void
  onRemove: (index: number) => void
}): JSX.Element {
  const notYetWritten = (): readonly OfferedTag[] =>
    props.offered.filter((offer) => !props.tags.some((tag) => tag.name.trim() === offer.name))

  return (
    <div class="flex flex-col gap-1" classList={{ "pl-3": props.indented }}>
      <Show when={props.tags.length > 0}>
        <span class="text-xs font-medium text-muted-foreground">{props.label}</span>
      </Show>
      <Index each={props.tags}>
        {(tag, index) => (
          <div class="flex gap-1">
            <TextField class="flex-1">
              <TextFieldInput
                type="text"
                class="h-7 text-xs"
                placeholder={t("compose.tagName")}
                list={namesListOf(props.on, props.listPrefix)}
                ref={(input) => {
                  input.value = tag().name
                }}
                onInput={(event) => {
                  props.onEdit(index, { name: event.currentTarget.value })
                  showPicker(event.currentTarget)
                }}
              />
            </TextField>
            <TextField class="flex-1">
              <TextFieldInput
                type="text"
                class="h-7 text-xs"
                placeholder={t("compose.tagValue")}
                list={valuesFor(tag().name, props.listPrefix)}
                ref={(input) => {
                  input.value = tag().value
                }}
                onInput={(event) => {
                  props.onEdit(index, { value: event.currentTarget.value })
                  showPicker(event.currentTarget)
                }}
              />
            </TextField>
            <button
              type="button"
              onClick={() => props.onRemove(index)}
              aria-label={t("compose.removeTag")}
              title={t("compose.removeTag")}
              class="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <XIcon class="h-3 w-3" />
            </button>
          </div>
        )}
      </Index>
      <div class="flex flex-wrap gap-x-1">
        <Button variant="ghost" size="sm" class="px-1 text-xs" onClick={() => props.onAdd("")}>
          {t("compose.addTag")}
        </Button>
        <For each={notYetWritten()}>
          {(offer) => (
            <Button
              variant="ghost"
              size="sm"
              class="px-1 text-xs"
              title={`${offer.name}:`}
              onClick={() => props.onAdd(offer.name)}
            >
              {t("compose.addNamedTag", { name: offer.label() })}
            </Button>
          )}
        </For>
      </div>
    </div>
  )
}

/**
 * The symbol that will be written, shown where it will be written.
 *
 * Not put into the box: what is in the box is what was typed, and a symbol
 * standing in there would have to be deleted before a different one could be
 * typed. It leaves as soon as the figure names a commodity of its own, which is
 * how the box says that what was typed has taken the default's place.
 */
export function Ghost(props: { of: DefaultCommodity }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      class="pointer-events-none absolute inset-y-0 flex items-center px-3 font-mono text-sm text-muted-foreground/60"
      classList={{ "left-0": props.of.side === "left", "right-0": props.of.side === "right" }}
    >
      {props.of.symbol}
    </span>
  )
}

/**
 * Room kept for the symbol whether or not it is showing.
 *
 * Reserved from the moment the journal declares one, so that typing a symbol of
 * your own — which is what takes the ghost away — leaves the figure where it
 * was instead of jumping it across the box.
 */
export const roomForSymbol = (declared: DefaultCommodity | undefined): JSX.CSSProperties =>
  declared === undefined
    ? {}
    : { [`padding-${declared.side}`]: `calc(${declared.symbol.length}ch + 1.25rem)` }

export function Labelled(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <TextField class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">{props.label}</span>
      {props.children}
    </TextField>
  )
}

/** The three marks an entry or a posting can carry, in the order a reader meets them. */
export const STATUSES: readonly Status[] = ["Unmarked", "Pending", "Cleared"]

/**
 * Whether an entry or a posting is marked, and how: none, pending or cleared.
 *
 * A select rather than a box, because there are three states and not two. What
 * each one is called is the reader's word for it, and the mark it writes is
 * hledger's (`!`, `*`), shown beside it so the two can be matched.
 */
export function StatusPicker(props: {
  status: Status | undefined
  label: string
  /** Show the label above the box, as the other boxes of an entry do. A posting's row has no room for one. */
  labelled?: boolean
  onChange: (status: Status) => void
}): JSX.Element {
  const box = (compact: boolean): JSX.Element => (
    <select
      aria-label={props.label}
      title={props.label}
      class={`flex h-8 rounded-md border border-input bg-transparent py-0 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        compact ? "w-12 px-1 text-center" : "w-full pl-3 pr-2"
      }`}
      value={props.status ?? "Unmarked"}
      onChange={(event) => {
        const chosen = event.currentTarget.value
        if (isStatus(chosen)) props.onChange(chosen)
      }}
    >
      <For each={STATUSES}>
        {(status) => (
          <option class="bg-popover text-popover-foreground" value={status}>
            {compact ? markGlyph(status) : t(`compose.status.${status}`)}
          </option>
        )}
      </For>
    </select>
  )
  return props.labelled ? (
    <TextField class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">{props.label}</span>
      {box(false)}
    </TextField>
  ) : (
    <div class="shrink-0">{box(true)}</div>
  )
}

/**
 * The one character a row shows its mark as: hledger's own, or a blank for none.
 *
 * Kept to a single character so the account and the figure beside it keep the
 * room. The name is still given to the box, through its `title` and label.
 */
const markGlyph = (status: Status): string => {
  switch (status) {
    case "Unmarked":
      return " "
    case "Pending":
      return "!"
    case "Cleared":
      return "*"
  }
}

const isStatus = (value: string): value is Status => (STATUSES as readonly string[]).includes(value)

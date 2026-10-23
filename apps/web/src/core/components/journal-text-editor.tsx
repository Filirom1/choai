import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { syntaxHighlighting } from "@codemirror/language"
import { Compartment, EditorState } from "@codemirror/state"
import { classHighlighter } from "@lezer/highlight"
import { EditorView, keymap } from "@codemirror/view"

import { languageForSource, type SourceSyntax } from "~/core/journal/source-syntax"

const theme = EditorView.theme({
  "&": {
    display: "flex",
    flexDirection: "column",
    minHeight: "10rem",
    height: "100%",
    overflow: "hidden",
    border: "1px solid var(--input)",
    borderRadius: "var(--radius)",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  "&.cm-focused": {
    outline: "2px solid var(--ring)",
    outlineOffset: "2px",
  },
  ".cm-scroller": {
    flex: "1",
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.75rem",
    lineHeight: "1.625",
  },
  ".cm-content": {
    padding: "0.75rem",
    caretColor: "var(--foreground)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "var(--accent) !important",
  },
})

export function JournalTextEditor(props: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly mode: SourceSyntax
  readonly label?: string
  readonly disabled?: boolean
  readonly class?: string
}): JSX.Element {
  const editable = new Compartment()
  const [currentView, setCurrentView] = createSignal<EditorView>()
  let container!: HTMLDivElement
  let view: EditorView | undefined

  onMount(() => {
    const attributes = {
      role: "textbox",
      "aria-multiline": "true",
      spellcheck: "false",
      autocapitalize: "off",
      autocorrect: "off",
      ...(props.label === undefined ? {} : { "aria-label": props.label }),
    }
    view = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: [
          languageForSource(props.mode).extension,
          syntaxHighlighting(classHighlighter),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of(attributes),
          editable.of(EditorView.editable.of(!props.disabled)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) props.onChange(update.state.doc.toString())
          }),
          theme,
        ],
      }),
      parent: container,
    })
    setCurrentView(view)
    onCleanup(() => view?.destroy())
  })

  createEffect(() => {
    const current = view
    const value = props.value
    if (current === undefined || current.state.doc.toString() === value) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  })

  createEffect(() => {
    const current = currentView()
    if (current === undefined) return
    if (props.label === undefined) current.contentDOM.removeAttribute("aria-label")
    else current.contentDOM.setAttribute("aria-label", props.label)
  })

  createEffect(() => {
    const isEditable = !props.disabled
    const current = view
    if (current !== undefined) current.dispatch({ effects: editable.reconfigure(EditorView.editable.of(isEditable)) })
  })

  return <div ref={container} class={`journal-text-editor ${props.class ?? ""}`} />
}

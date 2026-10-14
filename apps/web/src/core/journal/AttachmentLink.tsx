import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"

export function AttachmentLink(props: { readonly file: Blob; readonly name: string }): JSX.Element {
  const [url, setUrl] = createSignal<string>()

  createEffect(() => {
    const next = URL.createObjectURL(props.file)
    setUrl(next)
    onCleanup(() => URL.revokeObjectURL(next))
  })

  return (
    <Show when={url()}>
      {(href) => (
        <a
          class="flex min-w-0 items-center gap-2 text-xs underline underline-offset-2"
          href={href()}
          target="_blank"
          rel="noreferrer"
          aria-label={props.name}
        >
          <Show when={props.file.type.startsWith("image/")}>
            <img src={href()} alt="" class="h-10 w-10 shrink-0 rounded border object-cover" />
          </Show>
          <span class="truncate">{props.name}</span>
        </a>
      )}
    </Show>
  )
}

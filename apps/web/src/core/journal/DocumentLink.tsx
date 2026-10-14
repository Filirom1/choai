import type { JSX } from "solid-js"

import { addressOfSourceFile } from "~/core/address/address"
import { useMoves } from "~/core/address/moves"

export function DocumentLink(props: { readonly path: string }): JSX.Element {
  const moves = useMoves()

  return (
    <a
      href={addressOfSourceFile(props.path)}
      class="min-w-0 truncate text-left text-xs underline underline-offset-2"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        moves.goTo(addressOfSourceFile(props.path))
      }}
    >
      {props.path}
    </a>
  )
}

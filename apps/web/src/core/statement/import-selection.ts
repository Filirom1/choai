import { createRoot, createSignal } from "solid-js"

const [selected, setSelected] = createRoot(() => createSignal<string | undefined>(undefined))

export const selectedCsv = selected
export const selectCsv = (path: string | undefined): void => {
  setSelected(path)
}

import { createMemo, createRoot } from "solid-js"

import { bookSettings } from "./book-settings"

export const accountSort = createRoot(() =>
  createMemo(() => {
    const settings = bookSettings()
    return settings.ok ? settings.value.accountSort : "chart"
  }),
)

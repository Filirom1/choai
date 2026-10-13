import { type JSX } from "solid-js"

import { Reconciliation } from "~/core/components/reconciliation"

/** The reconciliation screen, kept as a page so it has its own place in the rail. */
export default function Reconcile(): JSX.Element {
  return <Reconciliation />
}

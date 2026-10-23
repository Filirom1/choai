import { createSignal } from "solid-js"

import type { FileSnapshot } from "./conflict"

export type RemoteChanges =
  | { readonly bookId: string; readonly at: "checking" }
  | { readonly bookId: string; readonly at: "unavailable" }
  | {
      readonly bookId: string
      readonly at: "ready"
      readonly paths: readonly string[]
      readonly snapshots?: readonly FileSnapshot[]
    }

const [remoteChanges, setRemoteChanges] = createSignal<RemoteChanges | undefined>()

export const remoteChangesNow = remoteChanges

export const noteRemoteChangesChecking = (bookId: string): void => {
  setRemoteChanges((current) =>
    current?.bookId === bookId && current.at === "ready"
      ? current
      : { bookId, at: "checking" },
  )
}

export const noteRemoteChangesUnavailable = (bookId: string): void => {
  setRemoteChanges((current) =>
    current?.bookId === bookId && current.at === "ready"
      ? current
      : { bookId, at: "unavailable" },
  )
}

export const noteRemoteChangePaths = (bookId: string, paths: readonly string[]): void => {
  setRemoteChanges((current) => {
    if (current?.bookId === bookId && current.at === "ready" && current.snapshots !== undefined &&
      paths.length === current.paths.length && paths.every((path, index) => path === current.paths[index])) return current
    return { bookId, at: "ready", paths }
  })
}

export const noteRemoteChangeSnapshots = (bookId: string, snapshots: readonly FileSnapshot[]): void => {
  setRemoteChanges({
    bookId,
    at: "ready",
    paths: snapshots.map(({ path }) => path),
    snapshots,
  })
}

export const remoteChangeFiles = (
  changes: RemoteChanges | undefined,
): readonly { readonly path: string; readonly isNew: boolean; readonly status: "A" | "M" | "D" }[] => {
  if (changes?.at !== "ready") return []
  if (changes.snapshots !== undefined) return changes.snapshots.map((snapshot) => ({
    path: snapshot.path,
    isNew: snapshot.local.content === undefined && snapshot.destination.content !== undefined,
    status: snapshot.destination.content === undefined ? "D" : snapshot.local.content === undefined ? "A" : "M",
  }))
  return changes.paths.map((path) => ({ path, isNew: false, status: "M" }))
}

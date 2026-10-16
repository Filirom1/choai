import { lineDiff } from "~/core/lib/diff"

export type CapturedContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary"; readonly size: number; readonly fingerprint?: string }

export interface CapturedVersion {
  readonly content?: CapturedContent
  readonly identity?: string
  readonly fingerprint?: string
}

export type FileState =
  | "unchanged"
  | "added-local"
  | "added-destination"
  | "added-both"
  | "added-both-same"
  | "deleted-both"
  | "deleted-local"
  | "deleted-destination"
  | "deleted-local-changed-destination"
  | "deleted-destination-changed-local"
  | "changed-local"
  | "changed-destination"
  | "changed-both-same"
  | "changed-both"

export interface FileSnapshot {
  readonly bookId: string
  readonly path: string
  readonly role?: "accounting" | "companion" | "unknown"
  readonly base: CapturedVersion
  readonly local: CapturedVersion
  readonly destination: CapturedVersion
  readonly state: FileState
  readonly cause: "diverged" | "remote-changed" | "local-changed" | "missing-base"
  readonly capturedAt: number
}

export type ResolutionChoice =
  | { readonly take: "local" }
  | { readonly take: "destination" }
  | { readonly take: "manual"; readonly text: string }
  | { readonly take: "later" }

export type SyncDirection = "pull" | "push"

export interface BlockedSync {
  readonly side: "local" | "destination"
  readonly paths: readonly string[]
}

export const blockedSync = (
  direction: SyncDirection,
  localChanges: readonly string[],
  destinationChanges: readonly string[],
): BlockedSync | undefined => {
  const side = direction === "pull" ? "local" : "destination"
  const paths = direction === "pull" ? localChanges : destinationChanges
  return paths.length === 0 ? undefined : { side, paths }
}

export interface ResolutionSession {
  readonly id: string
  readonly bookId: string
  readonly snapshots: readonly FileSnapshot[]
  readonly choices: Readonly<Record<string, ResolutionChoice>>
  readonly createdAt: number
}

export type DiffLine =
  | { readonly kind: "same"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string }
  | { readonly kind: "added"; readonly text: string }

export type DiffSection =
  | { readonly kind: "lines"; readonly lines: readonly DiffLine[] }
  | { readonly kind: "folded"; readonly lines: readonly DiffLine[] }

const sameContent = (left: CapturedVersion, right: CapturedVersion): boolean => {
  if (left.content === undefined || right.content === undefined) return left.content === right.content
  if (left.content.kind !== right.content.kind) return false
  if (left.content.kind === "text" && right.content.kind === "text") return left.content.text === right.content.text
  if (left.content.kind === "binary" && right.content.kind === "binary") {
    return left.content.size === right.content.size &&
      left.content.fingerprint !== undefined && left.content.fingerprint === right.content.fingerprint
  }
  return false
}

const stateOf = (base: CapturedVersion, local: CapturedVersion, destination: CapturedVersion): FileState => {
  const hasBase = base.content !== undefined
  const hasLocal = local.content !== undefined
  const hasDestination = destination.content !== undefined
  if (!hasBase) {
    if (!hasLocal && !hasDestination) return "deleted-both"
    if (hasLocal && !hasDestination) return "added-local"
    if (!hasLocal && hasDestination) return "added-destination"
    return sameContent(local, destination) ? "added-both-same" : "added-both"
  }
  if (!hasLocal && !hasDestination) return "deleted-both"
  if (!hasLocal) return sameContent(base, destination) ? "deleted-local" : "deleted-local-changed-destination"
  if (!hasDestination) return sameContent(base, local) ? "deleted-destination" : "deleted-destination-changed-local"
  const localChanged = !sameContent(base, local)
  const destinationChanged = !sameContent(base, destination)
  if (!localChanged && !destinationChanged) return "unchanged"
  if (localChanged && !destinationChanged) return "changed-local"
  if (!localChanged && destinationChanged) return "changed-destination"
  return sameContent(local, destination) ? "changed-both-same" : "changed-both"
}

export const captureFile = (input: Omit<FileSnapshot, "state">): FileSnapshot => ({
  ...input,
  state: stateOf(input.base, input.local, input.destination),
})

export const automaticAdditions = (snapshots: readonly FileSnapshot[]): readonly FileSnapshot[] =>
  snapshots.filter(({ state }) => state === "added-destination")

export const sameVersions = (left: FileSnapshot, right: FileSnapshot): boolean =>
  left.bookId === right.bookId && left.path === right.path && left.role === right.role &&
  left.base.identity === right.base.identity && left.base.fingerprint === right.base.fingerprint &&
  sameContent(left.base, right.base) && left.local.identity === right.local.identity &&
  left.local.fingerprint === right.local.fingerprint && sameContent(left.local, right.local) &&
  left.destination.identity === right.destination.identity &&
  left.destination.fingerprint === right.destination.fingerprint && sameContent(left.destination, right.destination)

export const sameCapture = (left: FileSnapshot, right: FileSnapshot): boolean =>
  left.capturedAt === right.capturedAt && sameVersions(left, right)

export const diffText = (local: string, destination: string): readonly DiffLine[] =>
  lineDiff(local, destination).map(({ kind, text }) => ({ kind, text }))

export const diffSections = (lines: readonly DiffLine[], context = 3): readonly DiffSection[] => {
  const starts = lines.flatMap((line, index) =>
    index === 0 || line.kind !== lines[index - 1]?.kind ? [index] : [],
  )
  const runs = starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length))
  const visibleContext = Math.max(0, Math.floor(context))

  return runs.flatMap((run): readonly DiffSection[] => {
    if (run[0]?.kind !== "same" || run.length <= visibleContext * 2 + 1) {
      return [{ kind: "lines", lines: run }]
    }
    return [
      ...(visibleContext === 0 ? [] : [{ kind: "lines" as const, lines: run.slice(0, visibleContext) }]),
      { kind: "folded", lines: run.slice(visibleContext, run.length - visibleContext) },
      ...(visibleContext === 0 ? [] : [{ kind: "lines" as const, lines: run.slice(-visibleContext) }]),
    ]
  })
}

export const appendMergeProposal = (snapshot: FileSnapshot): string | undefined => {
  const { base, local, destination } = snapshot
  if (base.content?.kind !== "text" || local.content?.kind !== "text" || destination.content?.kind !== "text") return undefined
  if (!local.content.text.startsWith(base.content.text) || !destination.content.text.startsWith(base.content.text)) return undefined
  const localAddition = local.content.text.slice(base.content.text.length)
  const destinationAddition = destination.content.text.slice(base.content.text.length)
  if (localAddition.trim() === "" || destinationAddition.trim() === "") return undefined
  return `${base.content.text}\n${destinationAddition}\n${localAddition}`
}

export const choiceText = (snapshot: FileSnapshot, choice: ResolutionChoice): string | undefined => {
  switch (choice.take) {
    case "local": return snapshot.local.content?.kind === "text" ? snapshot.local.content.text : undefined
    case "destination": return snapshot.destination.content?.kind === "text" ? snapshot.destination.content.text : undefined
    case "manual": return choice.text
    case "later": return undefined
  }
}

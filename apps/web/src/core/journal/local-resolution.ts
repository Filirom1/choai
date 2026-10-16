import { Err, Ok, getOrUndefined, type Result } from "~/core/lib/monad"
import { readText } from "~/core/lib/text"
import { automaticAdditions, captureFile, sameVersions, type CapturedVersion, type FileSnapshot, type ResolutionChoice } from "~/core/sync/conflict"
import { companionsIn } from "~/core/journal/companions"
import { hledgerLatestPaths, isHiddenPath, isHledgerLatestPath } from "~/core/journal/hidden"
import { includedBy } from "~/core/journal/layout"
import { attachmentOf } from "~/core/journal/kept"
import { journal, noteLocalBinaryWritten, noteLocalTextWritten, removeAttachment, removeFile, replaceAttachment, restoreFile, rewriteFile } from "~/core/journal/store"
import { localFileVersion, localFilesBelow, localVersionIdentity, permitLocalFolder, readLocalFile, removeLocalFile, safeLocalPath, writeLocalFile, type LocalDiskFile, type LocalFailure } from "~/core/journal/local"
import type { Trouble } from "~/core/hledger/wire"
import type { OpenJournal } from "~/core/journal/store"

export type LocalResolutionFailure =
  | { readonly at: "local"; readonly failure: LocalFailure }
  | { readonly at: "stale"; readonly path: string }
  | { readonly at: "unsupported"; readonly path: string }
  | { readonly at: "hledger"; readonly trouble: Trouble }
  | { readonly at: "local-kept"; readonly path: string; readonly failure: LocalFailure }

const digest = async (blob: Blob): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const diskIdentity = localVersionIdentity

const fileAt = (files: readonly LocalDiskFile[], path: string): File | undefined =>
  files.find((file) => file.path === path)?.file

const textFile = (path: string): boolean => /\.(journal|hledger|ledger|rules|csv|tsv|ssv|txt|md|markdown|json|jsonl)$/i.test(path)
const binaryFile = (path: string): boolean => /\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(path)

const captureDiskFile = async (
  open: OpenJournal,
  diskFiles: readonly LocalDiskFile[],
  path: string,
  role: NonNullable<FileSnapshot["role"]>,
): Promise<Result<FileSnapshot, LocalResolutionFailure>> => {
  try {
    const disk = fileAt(diskFiles, path)
    const binary = role !== "accounting"
    const localBlob = binary ? await attachmentOf(open.bookId, path) : undefined
    const localText = open.source.files[path]
    const local: CapturedVersion = binary
      ? localBlob === undefined ? {} : { content: { kind: "binary", size: localBlob.size, fingerprint: await digest(localBlob) } }
      : localText === undefined ? {} : { content: { kind: "text", text: localText } }
    const destination: CapturedVersion = disk === undefined
      ? {}
      : binary
        ? { content: { kind: "binary", size: disk.size, fingerprint: await digest(disk) }, identity: await diskIdentity(disk) }
        : { content: { kind: "text", text: await readText(disk) }, identity: await diskIdentity(disk) }
    const baseText = open.local?.base[path]
    const baselineBinary = binary ? open.local?.versions?.[path] : undefined
    const base: CapturedVersion = binary
      ? baselineBinary === undefined ? {} : {
          content: { kind: "binary", size: baselineBinary.size, fingerprint: baselineBinary.fingerprint },
          identity: JSON.stringify(baselineBinary),
        }
      : baseText === undefined ? {} : { content: { kind: "text", text: baseText } }
    return Ok(captureFile({
      bookId: open.bookId,
      path,
      role,
      base,
      local,
      destination,
      cause: base.content === undefined ? "missing-base" : "local-changed",
      capturedAt: Date.now(),
    }))
  } catch (cause) {
    return Err({ at: "local", failure: { at: "filesystem", cause } })
  }
}

const diskFilesFor = async (open: OpenJournal): Promise<Result<readonly LocalDiskFile[], LocalFailure>> => {
  if (open.local === undefined) return Err({ at: "not-linked" })
  const permissionHandle = open.local.handle as FileSystemDirectoryHandle & {
    readonly queryPermission?: (options: { readonly mode: "read" }) => Promise<PermissionState>
  }
  try {
    if (permissionHandle.queryPermission !== undefined && await permissionHandle.queryPermission({ mode: "read" }) !== "granted") {
      return Err({ at: "permission" })
    }
    return Ok(await localFilesBelow(open.local.handle))
  } catch (cause) {
    return Err({ at: "filesystem", cause })
  }
}

const accountingAndCompanionPaths = (open: OpenJournal): Readonly<{ accounting: ReadonlySet<string>; companions: ReadonlySet<string> }> => {
  const allText = Object.values(open.source.files)
  return {
    accounting: new Set([...Object.keys(open.source.files), ...allText.flatMap(includedBy)]),
    companions: new Set([
      ...open.source.attachments.map(({ path }) => path),
      ...allText.flatMap(companionsIn),
    ]),
  }
}

const pending = (snapshot: FileSnapshot): boolean => ![
  "unchanged",
  "added-local",
  "changed-local",
  "changed-both-same",
  "added-both-same",
  "deleted-both",
].includes(snapshot.state)

export const inspectLocalResolution = async (): Promise<Result<readonly FileSnapshot[], LocalResolutionFailure>> => {
  const open = getOrUndefined(journal())
  if (open === undefined || open.local === undefined) return Err({ at: "local", failure: { at: "not-linked" } })
  const disk = await diskFilesFor(open)
  if (!disk.ok) return Err({ at: "local", failure: disk.error })
  const paths = accountingAndCompanionPaths(open)
  const managedLatest = [
    ...[...paths.companions].filter(isHledgerLatestPath),
    ...hledgerLatestPaths([...Object.keys(open.source.files), ...disk.value.map(({ path }) => path)]),
  ]
  const all = [...new Set([
    ...Object.keys(open.source.files),
    ...open.source.attachments.map(({ path }) => path),
    ...Object.keys(open.local.base),
    ...disk.value.map(({ path }) => path),
  ])].filter((path) => !isHiddenPath(path, managedLatest))
  const snapshots = await Promise.all(all.map(async (path) => {
    const role = paths.companions.has(path) && !isHledgerLatestPath(path)
      ? "companion" as const
      : paths.accounting.has(path) || textFile(path) || isHledgerLatestPath(path)
        ? "accounting" as const
        : binaryFile(path) ? "companion" as const : "unknown" as const
    return captureDiskFile(open, disk.value, path, role)
  }))
  const failure = snapshots.find((snapshot) => !snapshot.ok)
  if (failure !== undefined && !failure.ok) return failure
  const unresolved = snapshots.flatMap((snapshot) => snapshot.ok && pending(snapshot.value) ? [snapshot.value] : [])
  const adopted = await adoptLocalAdditions(automaticAdditions(unresolved))
  return adopted.ok ? Ok(unresolved.filter(({ state }) => state !== "added-destination")) : adopted
}

const recapture = async (
  open: OpenJournal,
  path: string,
  role: NonNullable<FileSnapshot["role"]>,
): Promise<Result<FileSnapshot, LocalResolutionFailure>> => {
  const files = await diskFilesFor(open)
  return files.ok ? captureDiskFile(open, files.value, path, role) : Err({ at: "local", failure: files.error })
}

const destinationStillMatches = async (open: OpenJournal, snapshot: FileSnapshot): Promise<Result<void, LocalResolutionFailure>> => {
  const disk = await readLocalFile(open.local!.handle, snapshot.path)
  if (!disk.ok) return Err({ at: "local", failure: disk.error })
  if (disk.value === undefined) return snapshot.destination.content === undefined ? Ok(undefined) : Err({ at: "stale", path: snapshot.path })
  try {
    const identity = await diskIdentity(disk.value)
    return identity === snapshot.destination.identity ? Ok(undefined) : Err({ at: "stale", path: snapshot.path })
  } catch (cause) {
    return Err({ at: "local", failure: { at: "filesystem", cause } })
  }
}

const applyDiskText = async (open: OpenJournal, path: string, text: string | undefined): Promise<Result<void, LocalResolutionFailure>> => {
  if (text === undefined) {
    if (open.source.files[path] === undefined) return Ok(undefined)
    const removed = await removeFile(path)
    return removed.ok ? Ok(undefined) : Err({ at: "hledger", trouble: removed.error })
  }
  const written = open.source.files[path] === undefined
    ? await restoreFile(path, text)
    : await rewriteFile(path, text)
  return written.ok ? Ok(undefined) : Err({ at: "hledger", trouble: written.error })
}

const applyDiskBlob = async (open: OpenJournal, path: string, blob: Blob | undefined): Promise<Result<void, LocalResolutionFailure>> => {
  if (blob === undefined) {
    if (!open.source.attachments.some(({ path: existing }) => existing === path)) return Ok(undefined)
    const removed = await removeAttachment(path)
    return removed.ok ? Ok(undefined) : Err({ at: "hledger", trouble: removed.error })
  }
  const replaced = await replaceAttachment(path, blob)
  return replaced.ok ? Ok(undefined) : Err({ at: "hledger", trouble: replaced.error })
}

export const resolveLocalResolution = async (
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
): Promise<Result<void, LocalResolutionFailure>> => {
  if (choice.take === "later") return Ok(undefined)
  if (snapshot.role === "unknown" && (snapshot.state !== "added-destination" || choice.take !== "destination")) {
    return Err({ at: "unsupported", path: snapshot.path })
  }
  const open = getOrUndefined(journal())
  if (open === undefined || open.local === undefined || open.bookId !== snapshot.bookId || !safeLocalPath(snapshot.path)) {
    return Err({ at: "stale", path: snapshot.path })
  }
  if (choice.take !== "destination") {
    const permitted = await permitLocalFolder(open.local)
    if (!permitted.ok) return Err({ at: "local", failure: permitted.error })
  }
  const current = await recapture(open, snapshot.path, snapshot.role ?? "unknown")
  if (!current.ok) return current
  if (!sameVersions(snapshot, current.value)) return Err({ at: "stale", path: snapshot.path })
  return snapshot.role === "accounting"
    ? resolveLocalText(open, snapshot, choice)
    : resolveLocalBinary(open, snapshot, choice)
}

const adoptLocalAdditions = async (snapshots: readonly FileSnapshot[]): Promise<Result<void, LocalResolutionFailure>> => {
  const [snapshot, ...later] = snapshots
  if (snapshot === undefined) return Ok(undefined)
  const adopted = await resolveLocalResolution(snapshot, { take: "destination" })
  return adopted.ok ? adoptLocalAdditions(later) : adopted
}

const resolveLocalText = async (
  open: OpenJournal,
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
): Promise<Result<void, LocalResolutionFailure>> => {
  const localText = snapshot.local.content?.kind === "text" ? snapshot.local.content.text : undefined
  const diskText = snapshot.destination.content?.kind === "text" ? snapshot.destination.content.text : undefined
  if (choice.take === "destination") {
    const checked = await destinationStillMatches(open, snapshot)
    if (!checked.ok) return checked
    const adopted = await applyDiskText(open, snapshot.path, diskText)
    if (!adopted.ok) return adopted
    const file = await readLocalFile(open.local!.handle, snapshot.path)
    if (!file.ok) return Err({ at: "local", failure: file.error })
    const version = file.value === undefined ? undefined : await localFileVersion(file.value)
    await noteLocalTextWritten(snapshot.path, diskText, version)
    return Ok(undefined)
  }
  const selected = choice.take === "manual" ? choice.text : localText
  const latest = choice.take === "manual"
    ? await destinationStillMatches(open, snapshot)
    : await recapture(open, snapshot.path, "accounting").then((result) => result.ok && sameVersions(snapshot, result.value)
      ? Ok(undefined)
      : result.ok ? Err({ at: "stale", path: snapshot.path }) : result)
  if (!latest.ok) return latest
  if (selected === undefined) {
    const removed = await removeLocalFile(open.local!.handle, snapshot.path)
    if (!removed.ok) return Err({ at: "local", failure: removed.error })
    await noteLocalTextWritten(snapshot.path, undefined)
    return Ok(undefined)
  }
  if (choice.take === "manual") {
    const adopted = await applyDiskText(open, snapshot.path, selected)
    if (!adopted.ok) return adopted
    const checked = await destinationStillMatches(open, snapshot)
    if (!checked.ok) return checked
  }
  const saved = await writeLocalFile(open.local!.handle, snapshot.path, new Blob([selected], { type: "text/plain;charset=utf-8" }))
  if (!saved.ok) return choice.take === "manual"
    ? Err({ at: "local-kept", path: snapshot.path, failure: saved.error })
    : Err({ at: "local", failure: saved.error })
  const file = await readLocalFile(open.local!.handle, snapshot.path)
  if (!file.ok) return Err({ at: "local", failure: file.error })
  if (file.value === undefined) return Err({ at: "stale", path: snapshot.path })
  await noteLocalTextWritten(snapshot.path, selected, await localFileVersion(file.value))
  return Ok(undefined)
}

const resolveLocalBinary = async (
  open: OpenJournal,
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
): Promise<Result<void, LocalResolutionFailure>> => {
  if (choice.take === "manual") return Err({ at: "unsupported", path: snapshot.path })
  const local = await attachmentOf(open.bookId, snapshot.path)
  const disk = await readLocalFile(open.local!.handle, snapshot.path)
  if (!disk.ok) return Err({ at: "local", failure: disk.error })
  if (choice.take === "destination") {
    const checked = await destinationStillMatches(open, snapshot)
    if (!checked.ok) return checked
    const adopted = await applyDiskBlob(open, snapshot.path, disk.value)
    if (!adopted.ok) return adopted
    await noteLocalBinaryWritten(snapshot.path, disk.value === undefined ? undefined : await localFileVersion(disk.value))
    return Ok(undefined)
  }
  const latest = await recapture(open, snapshot.path, snapshot.role ?? "companion")
  if (!latest.ok) return latest
  if (!sameVersions(snapshot, latest.value)) return Err({ at: "stale", path: snapshot.path })
  if (local === undefined) {
    const removed = await removeLocalFile(open.local!.handle, snapshot.path)
    if (!removed.ok) return Err({ at: "local", failure: removed.error })
    await noteLocalBinaryWritten(snapshot.path)
    return Ok(undefined)
  }
  const saved = await writeLocalFile(open.local!.handle, snapshot.path, local)
  if (!saved.ok) return Err({ at: "local", failure: saved.error })
  const file = await readLocalFile(open.local!.handle, snapshot.path)
  if (!file.ok) return Err({ at: "local", failure: file.error })
  if (file.value === undefined) return Err({ at: "stale", path: snapshot.path })
  await noteLocalBinaryWritten(snapshot.path, await localFileVersion(file.value))
  return Ok(undefined)
}

export const exportLocalResolution = async (snapshot: FileSnapshot): Promise<Result<Blob, LocalResolutionFailure>> => {
  if (snapshot.role === "unknown" && snapshot.destination.content?.kind !== "binary") return Err({ at: "unsupported", path: snapshot.path })
  const open = getOrUndefined(journal())
  if (open === undefined || open.local === undefined || open.bookId !== snapshot.bookId) return Err({ at: "stale", path: snapshot.path })
  const current = await recapture(open, snapshot.path, snapshot.role ?? "unknown")
  if (!current.ok) return current
  if (!sameVersions(snapshot, current.value)) return Err({ at: "stale", path: snapshot.path })
  const file = await readLocalFile(open.local.handle, snapshot.path)
  if (!file.ok) return Err({ at: "local", failure: file.error })
  if (file.value === undefined) return Err({ at: "stale", path: snapshot.path })
  return Ok(file.value)
}

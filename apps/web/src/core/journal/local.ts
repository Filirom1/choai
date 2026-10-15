import { readText } from "~/core/lib/text"
import { hledgerLatestPaths, isHiddenPath, isHledgerLatestPath } from "./hidden"
import { companionsAcross } from "./companions"
import { Err, Ok, type Result } from "~/core/lib/monad"

/** The folder and the text last read from or written to it survive browser visits. */
export interface LocalFolder {
  readonly handle: FileSystemDirectoryHandle
  readonly base: Readonly<Record<string, string>>
  readonly versions?: Readonly<Record<string, LocalFileVersion>>
}

export interface LocalFileVersion {
  readonly lastModified: number
  readonly size: number
  readonly fingerprint: string
}

export type LocalFailure =
  | { readonly at: "not-linked" }
  | { readonly at: "permission" }
  | { readonly at: "changed"; readonly path: string }
  | { readonly at: "unsafe-path"; readonly path: string }
  | { readonly at: "filesystem"; readonly cause: unknown }

const managedLatest = (files: Readonly<Record<string, string>>): readonly string[] => [
  ...companionsAcross(files).filter(isHledgerLatestPath),
  ...hledgerLatestPaths(Object.keys(files)),
]

export const changedPaths = (base: Readonly<Record<string, string>>, files: Readonly<Record<string, string>>): readonly string[] => {
  const latest = managedLatest(files)
  return Object.keys(files).filter((path) => !isHiddenPath(path, latest) && files[path] !== base[path])
}

export const differences = (before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): readonly string[] => {
  const together = { ...before, ...after }
  const latest = managedLatest(together)
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => !isHiddenPath(path, latest) && before[path] !== after[path])
}

export const safeLocalPath = (path: string): boolean =>
  path.length > 0 && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

type PermissionHandle = FileSystemDirectoryHandle & {
  readonly requestPermission: (options: { readonly mode: "readwrite" }) => Promise<PermissionState>
}

/** Request permissions only from a user action, including after a browser restart. */
export const permitLocalFolder = async (folder: LocalFolder): Promise<Result<void, LocalFailure>> => {
  try {
    return await (folder.handle as PermissionHandle).requestPermission({ mode: "readwrite" }) === "granted"
      ? Ok(undefined) : Err({ at: "permission" })
  } catch (cause) {
    return Err({ at: "filesystem", cause })
  }
}

export const localFileAt = async (folder: FileSystemDirectoryHandle, parts: readonly string[], create: boolean): Promise<FileSystemFileHandle> => {
  const [first, ...rest] = parts
  return rest.length === 0
    ? folder.getFileHandle(first, { create })
    : localFileAt(await folder.getDirectoryHandle(first, { create }), rest, create)
}

interface LocalFolderFileHandle {
  readonly kind: "file"
  readonly name: string
  readonly getFile: () => Promise<File>
}

interface LocalFolderDirectoryHandle {
  readonly kind: "directory"
  readonly name: string
  readonly values: () => AsyncIterableIterator<LocalFolderFileHandle | LocalFolderDirectoryHandle>
}

export interface LocalDiskFile {
  readonly path: string
  readonly file: File
}

export const fingerprintOf = async (blob: Blob): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const localFileVersion = async (file: File): Promise<LocalFileVersion> => ({
  lastModified: file.lastModified,
  size: file.size,
  fingerprint: await fingerprintOf(file),
})

export const localVersionIdentity = async (file: File): Promise<string> => {
  const version = await localFileVersion(file)
  return JSON.stringify([version.lastModified, version.size, version.fingerprint])
}

export const versionsOf = async (
  files: readonly LocalDiskFile[],
): Promise<Readonly<Record<string, LocalFileVersion>>> => Object.fromEntries(await Promise.all(files.map(async ({ path, file }) => [path, await localFileVersion(file)] as const)))

export const localFilesBelow = async (
  folder: FileSystemDirectoryHandle | LocalFolderDirectoryHandle,
  prefix = "",
): Promise<readonly LocalDiskFile[]> => {
  const directory = folder as LocalFolderDirectoryHandle
  const children: (LocalFolderFileHandle | LocalFolderDirectoryHandle)[] = []
  for await (const child of directory.values()) children.push(child)
  const nested = await Promise.all(children.filter((child) =>
    child.kind === "directory" ? !isHiddenPath(child.name) : !isHiddenPath(child.name) || isHledgerLatestPath(child.name),
  ).map(async (child) =>
    child.kind === "file"
      ? [{ path: `${prefix}${child.name}`, file: await child.getFile() }]
      : localFilesBelow(child, `${prefix}${child.name}/`),
  ))
  return nested.flat()
}

export const readLocalFile = async (
  folder: FileSystemDirectoryHandle,
  path: string,
): Promise<Result<File | undefined, LocalFailure>> => {
  if (!safeLocalPath(path)) return Err({ at: "unsafe-path", path })
  try {
    return Ok(await (await localFileAt(folder, path.split("/"), false)).getFile())
  } catch (cause) {
    return cause instanceof DOMException && cause.name === "NotFoundError"
      ? Ok(undefined)
      : Err({ at: "filesystem", cause })
  }
}

export const writeLocalFile = async (
  folder: FileSystemDirectoryHandle,
  path: string,
  blob: Blob,
): Promise<Result<void, LocalFailure>> => {
  if (!safeLocalPath(path)) return Err({ at: "unsafe-path", path })
  try {
    const writable = await (await localFileAt(folder, path.split("/"), true)).createWritable()
    await writable.write(blob)
    await writable.close()
    return Ok(undefined)
  } catch (cause) {
    return Err({ at: "filesystem", cause })
  }
}

export const removeLocalFile = async (
  folder: FileSystemDirectoryHandle,
  path: string,
): Promise<Result<void, LocalFailure>> => {
  if (!safeLocalPath(path)) return Err({ at: "unsafe-path", path })
  const [name, ...parents] = path.split("/").reverse()
  if (name === undefined) return Err({ at: "unsafe-path", path })
  try {
    const parent = parents.length === 0
      ? folder
      : await parentFolder(folder, parents.reverse())
    await parent.removeEntry(name)
    return Ok(undefined)
  } catch (cause) {
    return cause instanceof DOMException && cause.name === "NotFoundError"
      ? Ok(undefined)
      : Err({ at: "filesystem", cause })
  }
}

const parentFolder = async (folder: FileSystemDirectoryHandle, parts: readonly string[]): Promise<FileSystemDirectoryHandle> => {
  const [part, ...rest] = parts
  return rest.length === 0 || part === undefined
    ? part === undefined ? folder : folder.getDirectoryHandle(part)
    : parentFolder(await folder.getDirectoryHandle(part), rest)
}

/** Refuse a conflicting or unsafe path before writing any file. Filesystem writes are not a multi-file transaction. */
export const saveLocalFolder = async (
  folder: LocalFolder,
  files: Readonly<Record<string, string>>,
  written: (folder: LocalFolder) => Promise<void> = async () => undefined,
  companions: readonly { readonly path: string; readonly blob: Blob }[] = [],
): Promise<Result<LocalFolder, LocalFailure>> => {
  const paths = changedPaths(folder.base, files)
  const latest = managedLatest(files)
  const visibleCompanions = companions.filter(({ path }) => !isHiddenPath(path, latest))
  const unsafe = [...Object.keys(folder.base), ...Object.keys(folder.versions ?? {}), ...Object.keys(files), ...companions.map(({ path }) => path)]
    .find((path) => !safeLocalPath(path))
  if (unsafe !== undefined) return Err({ at: "unsafe-path", path: unsafe })
  const allowed = await permitLocalFolder(folder)
  if (!allowed.ok) return allowed
  return writeCheckedPaths(folder, files, paths, written, visibleCompanions)
}

const checkPaths = async (folder: LocalFolder, paths: readonly string[]): Promise<Result<void, LocalFailure>> => {
  const [path, ...rest] = paths
  if (path === undefined) return Ok(undefined)
  const disk = await readLocalFile(folder.handle, path)
  if (!disk.ok) return disk
  const expected = folder.versions?.[path]
  if (expected !== undefined) {
    if (disk.value === undefined || JSON.stringify(await localFileVersion(disk.value)) !== JSON.stringify(expected)) {
      return Err({ at: "changed", path })
    }
    return checkPaths(folder, rest)
  }
  const text = disk.value === undefined ? undefined : await readText(disk.value)
  return text !== folder.base[path] ? Err({ at: "changed", path }) : checkPaths(folder, rest)
}

const writeCheckedPaths = async (
  folder: LocalFolder,
  files: Readonly<Record<string, string>>,
  paths: readonly string[],
  written: (folder: LocalFolder) => Promise<void>,
  companions: readonly { readonly path: string; readonly blob: Blob }[],
): Promise<Result<LocalFolder, LocalFailure>> => {
  const latest = managedLatest(files)
  const checked = await checkPaths(folder, [...new Set([
    ...Object.keys(folder.base),
    ...Object.keys(folder.versions ?? {}),
    ...Object.keys(files),
  ])].filter((path) => !isHiddenPath(path, latest)))
  if (!checked.ok) return checked
  const saved = await writeCompanions(folder, companions, written)
  return saved.ok ? writePaths(saved.value, files, paths, written) : saved
}

const bytesEqual = async (one: Blob, other: Blob): Promise<boolean> => {
  if (one.size !== other.size) return false
  const [left, right] = await Promise.all([one.arrayBuffer(), other.arrayBuffer()])
  const expected = new Uint8Array(right)
  return new Uint8Array(left).every((byte, at) => byte === expected[at])
}

const writeCompanions = async (
  folder: LocalFolder,
  companions: readonly { readonly path: string; readonly blob: Blob }[],
  written: (folder: LocalFolder) => Promise<void>,
): Promise<Result<LocalFolder, LocalFailure>> => {
  const [one, ...rest] = companions
  if (one === undefined) return Ok(folder)
  const checked = await checkCompanion(folder, one.path, one.blob)
  if (!checked.ok) return checked
  if (!checked.value) return writeCompanions(folder, rest, written)
  try {
    const writable = await (await localFileAt(folder.handle, one.path.split("/"), true)).createWritable()
    await writable.write(one.blob)
    await writable.close()
    const file = await (await localFileAt(folder.handle, one.path.split("/"), false)).getFile()
    const versions = { ...folder.versions, [one.path]: await localFileVersion(file) }
    const next = { ...folder, versions }
    await written(next)
    return writeCompanions(next, rest, written)
  } catch (cause) {
    return Err({ at: "filesystem", cause })
  }
}

const checkCompanion = async (
  folder: LocalFolder,
  path: string,
  expected: Blob,
): Promise<Result<boolean, LocalFailure>> => {
  const disk = await readLocalFile(folder.handle, path)
  if (!disk.ok) return disk
  const baseline = folder.versions?.[path]
  if (baseline !== undefined) {
    if (disk.value === undefined || JSON.stringify(await localFileVersion(disk.value)) !== JSON.stringify(baseline)) {
      return Err({ at: "changed", path })
    }
    return Ok(expected.size !== baseline.size || await fingerprintOf(expected) !== baseline.fingerprint)
  }
  if (disk.value === undefined) return Ok(true)
  return await bytesEqual(disk.value, expected) ? Ok(false) : Err({ at: "changed", path })
}

const writePaths = async (
  folder: LocalFolder,
  files: Readonly<Record<string, string>>,
  paths: readonly string[],
  written: (folder: LocalFolder) => Promise<void>,
): Promise<Result<LocalFolder, LocalFailure>> => {
  const [path, ...rest] = paths
  if (path === undefined) return Ok(folder)
  const checked = await checkPaths(folder, [path])
  if (!checked.ok) return checked
  try {
    const writable = await (await localFileAt(folder.handle, path.split("/"), true)).createWritable()
    await writable.write(files[path])
    await writable.close()
    const file = await (await localFileAt(folder.handle, path.split("/"), false)).getFile()
    const versions = { ...folder.versions, [path]: await localFileVersion(file) }
    const next = { ...folder, base: { ...folder.base, [path]: files[path] }, versions }
    await written(next)
    return writePaths(next, files, rest, written)
  } catch (cause) {
    return Err({ at: "filesystem", cause })
  }
}

import { Err, Ok, type Result } from "~/core/lib/monad"
import type { GoogleDriveRemote } from "~/core/journal/remote"
import { FOLDER_MIME, listFilesInFolder, listRevisions, type DriveFile, type DriveRevision, type Failure } from "./api"

export interface DriveLocatedFile {
  readonly path: string
  readonly file: DriveFile
}

export interface DriveHistory {
  readonly file: DriveFile
  readonly revisions: readonly DriveRevision[]
}

export const listDriveFilesBelow = async (
  token: string,
  folderId: string,
  prefix = "",
  visited: ReadonlySet<string> = new Set(),
): Promise<Result<readonly DriveLocatedFile[], Failure>> => {
  if (visited.has(folderId)) return Ok([])
  const listed = await listFilesInFolder(token, folderId)
  if (!listed.ok) return Err(listed.error)
  const nextVisited = new Set([...visited, folderId])
  const branches = await Promise.all(listed.value.map(async (file) => {
    const path = prefix === "" ? file.name : `${prefix}/${file.name}`
    if (file.mimeType !== FOLDER_MIME) return Ok([{ path, file }])
    const children = await listDriveFilesBelow(token, file.id, path, nextVisited)
    return children.ok ? Ok([{ path, file }, ...children.value]) : children
  }))
  const failed = branches.find((branch) => !branch.ok)
  return failed !== undefined && !failed.ok
    ? Err(failed.error)
    : Ok(branches.flatMap((branch) => branch.ok ? branch.value : []))
}

const fileAt = async (
  token: string,
  folderId: string,
  segments: readonly string[],
): Promise<Result<DriveFile, Failure>> => {
  const [name, ...rest] = segments
  if (name === undefined) return Err({ kind: "no-such-file" })
  const listed = await listFilesInFolder(token, folderId)
  if (!listed.ok) return listed
  const match = listed.value.find((file) => file.name === name && (rest.length === 0 ? file.mimeType !== FOLDER_MIME : file.mimeType === FOLDER_MIME))
  if (match === undefined) return Err({ kind: "no-such-file" })
  return rest.length === 0 ? Ok(match) : fileAt(token, match.id, rest)
}

export const readDriveHistory = async (
  token: string,
  remote: GoogleDriveRemote,
  path = remote.path,
): Promise<Result<DriveHistory, Failure>> => {
  const located = await fileAt(token, remote.folderId, path.split("/").filter((segment) => segment !== ""))
  if (!located.ok) return located
  const revisions = await listRevisions(token, located.value.id)
  return revisions.ok
    ? Ok({ file: located.value, revisions: [...revisions.value].sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "")) })
    : revisions
}

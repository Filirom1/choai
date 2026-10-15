import { Err, Ok, type Result } from "~/core/lib/monad"
import type { GoogleDriveRemote } from "~/core/journal/remote"
import { listFilesInFolder, listRevisions, type DriveFile, type DriveRevision, type Failure } from "./api"

const FOLDER = "application/vnd.google-apps.folder"

export interface DriveHistory {
  readonly file: DriveFile
  readonly revisions: readonly DriveRevision[]
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
  const match = listed.value.find((file) => file.name === name && (rest.length === 0 ? file.mimeType !== FOLDER : file.mimeType === FOLDER))
  if (match === undefined) return Err({ kind: "no-such-file" })
  return rest.length === 0 ? Ok(match) : fileAt(token, match.id, rest)
}

export const readDriveHistory = async (token: string, remote: GoogleDriveRemote): Promise<Result<DriveHistory, Failure>> => {
  const located = await fileAt(token, remote.folderId, remote.path.split("/").filter((segment) => segment !== ""))
  if (!located.ok) return located
  const revisions = await listRevisions(token, located.value.id)
  return revisions.ok
    ? Ok({ file: located.value, revisions: [...revisions.value].sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "")) })
    : revisions
}

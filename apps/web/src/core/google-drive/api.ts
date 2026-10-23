import { Err, Ok, type Result } from "~/core/lib/monad"
import { textOf } from "~/core/lib/text"

const ROOT = "https://www.googleapis.com/drive/v3"
const UPLOAD = "https://www.googleapis.com/upload/drive/v3"
export const FOLDER_MIME = "application/vnd.google-apps.folder"

export interface DriveFile {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly md5Checksum?: string
  readonly modifiedTime?: string
  readonly version?: string
  readonly size?: string
  readonly parents?: readonly string[]
  readonly headRevisionId?: string
}

export interface DriveRevision {
  readonly id: string
  readonly modifiedTime?: string
  readonly keepForever?: boolean
  readonly lastModifyingUser?: { readonly displayName?: string; readonly emailAddress?: string }
}

export type Failure =
  | { readonly kind: "offline" }
  | { readonly kind: "unauthorised" }
  | { readonly kind: "revision-not-downloadable" }
  | { readonly kind: "no-such-file" }
  | { readonly kind: "conflict" }
  | { readonly kind: "protected-revision" }
  | { readonly kind: "refused"; readonly status: number }

const FILE_FIELDS = "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,version,size,parents,headRevisionId)"

export const listFilesInFolder = async (token: string, folderId: string): Promise<Result<readonly DriveFile[], Failure>> => {
  const q = `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`
  return pages(token, q, FILE_FIELDS)
}

export const listSharedWithMe = (token: string): Promise<Result<readonly DriveFile[], Failure>> =>
  pages(token, "sharedWithMe = true and trashed = false", FILE_FIELDS)

export const listStarred = (token: string): Promise<Result<readonly DriveFile[], Failure>> =>
  pages(token, "starred = true and trashed = false", FILE_FIELDS)

const pages = async (
  token: string,
  q: string,
  fields: string,
  pageToken?: string,
  found: readonly DriveFile[] = [],
): Promise<Result<readonly DriveFile[], Failure>> => {
  const query = new URLSearchParams({
    q,
    fields,
    pageSize: "1000",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    ...(pageToken === undefined ? {} : { pageToken }),
  })
  const response = await call(`${ROOT}/files?${query}`, { headers: authHeaders(token) })
  if (!response.ok) return response
  if (!response.value.ok) return Err(failureOf(response.value))
  const decoded = await json<{ files?: readonly DriveFile[]; nextPageToken?: string }>(response.value)
  if (!decoded.ok) return decoded
  const all = [...found, ...(decoded.value.files ?? [])]
  return decoded.value.nextPageToken === undefined ? Ok(all) : pages(token, q, fields, decoded.value.nextPageToken, all)
}

export const getFileMetadata = async (token: string, fileId: string): Promise<Result<DriveFile, Failure>> => {
  const fields = "id,name,mimeType,md5Checksum,modifiedTime,version,size,parents,headRevisionId"
  const response = await call(`${ROOT}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`, {
    headers: authHeaders(token),
    cache: "no-store",
  })
  if (!response.ok) return response
  if (!response.value.ok) return Err(failureOf(response.value))
  return json<DriveFile>(response.value)
}

export const getFileContent = async (token: string, fileId: string): Promise<Result<string, Failure>> => {
  const response = await call(`${ROOT}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(token) })
  if (!response.ok) return response
  if (!response.value.ok) return Err(failureOf(response.value))
  try {
    return Ok(textOf(await response.value.arrayBuffer()))
  } catch {
    return Err({ kind: "refused", status: response.value.status })
  }
}

export const listRevisions = async (
  token: string,
  fileId: string,
  pageToken?: string,
  found: readonly DriveRevision[] = [],
): Promise<Result<readonly DriveRevision[], Failure>> => {
  const query = new URLSearchParams({
    fields: "nextPageToken,revisions(id,modifiedTime,keepForever,lastModifyingUser(displayName,emailAddress))",
    pageSize: "1000",
    ...(pageToken === undefined ? {} : { pageToken }),
  })
  const response = await call(`${ROOT}/files/${encodeURIComponent(fileId)}/revisions?${query}`, { headers: authHeaders(token) })
  if (!response.ok) return response
  if (!response.value.ok) return Err(failureOf(response.value))
  const decoded = await json<{ readonly revisions?: readonly DriveRevision[]; readonly nextPageToken?: string }>(response.value)
  if (!decoded.ok) return decoded
  const all = [...found, ...(decoded.value.revisions ?? [])]
  return decoded.value.nextPageToken === undefined
    ? Ok(all)
    : listRevisions(token, fileId, decoded.value.nextPageToken, all)
}

export const getRevisionContent = async (token: string, fileId: string, revisionId: string): Promise<Result<string, Failure>> => {
  const response = await call(
    `${ROOT}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?alt=media`,
    { headers: authHeaders(token) },
  )
  if (!response.ok) return response
  if (!response.value.ok) return Err(await revisionFailureOf(response.value))
  try {
    return Ok(textOf(await response.value.arrayBuffer()))
  } catch {
    return Err({ kind: "refused", status: response.value.status })
  }
}

export const deleteRevision = async (
  token: string,
  fileId: string,
  revision: DriveRevision,
  currentRevisionId: string | undefined,
): Promise<Result<void, Failure>> => {
  if (revision.id === currentRevisionId) return Err({ kind: "protected-revision" })
  const response = await call(
    `${ROOT}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revision.id)}`,
    { method: "DELETE", headers: authHeaders(token) },
  )
  if (!response.ok) return response
  return response.value.ok ? Ok(undefined) : Err(failureOf(response.value))
}

export const getFileBlob = async (token: string, fileId: string): Promise<Result<Blob, Failure>> => {
  const response = await call(`${ROOT}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(token) })
  if (!response.ok) return response
  if (!response.value.ok) return Err(failureOf(response.value))
  try {
    return Ok(await response.value.blob())
  } catch {
    return Err({ kind: "refused", status: response.value.status })
  }
}

export const createFile = async (
  token: string,
  folderId: string,
  name: string,
  content: string,
): Promise<Result<DriveFile, Failure>> => {
  const metadata = { name, mimeType: "text/plain", parents: [folderId] }
  const boundary = `choai_${crypto.randomUUID()}`
  const body = multipartBody(boundary, metadata, content)
  const response = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,md5Checksum,modifiedTime,version,parents`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!response.ok) return response
  if (response.value.status === 412) return Err({ kind: "conflict" })
  if (!response.value.ok) return Err(failureOf(response.value))
  return json<DriveFile>(response.value)
}

export const createBinary = async (
  token: string,
  folderId: string,
  name: string,
  blob: Blob,
): Promise<Result<DriveFile, Failure>> => {
  const metadata = { name, mimeType: blob.type || "application/octet-stream", parents: [folderId] }
  const boundary = `choai_${crypto.randomUUID()}`
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ], { type: `multipart/related; boundary=${boundary}` })
  const response = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,md5Checksum,modifiedTime,version,size,parents`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!response.ok) return response
  if (response.value.status === 412) return Err({ kind: "conflict" })
  if (!response.value.ok) return Err(failureOf(response.value))
  return json<DriveFile>(response.value)
}

export const updateFile = async (
  token: string,
  fileId: string,
  content: string,
): Promise<Result<DriveFile, Failure>> => updateMedia(token, fileId, content, "text/plain; charset=utf-8")

export const updateBlob = async (
  token: string,
  fileId: string,
  blob: Blob,
): Promise<Result<DriveFile, Failure>> => updateMedia(token, fileId, blob, blob.type || "application/octet-stream")

const updateMedia = async (
  token: string,
  fileId: string,
  body: string | Blob,
  contentType: string,
): Promise<Result<DriveFile, Failure>> => {
  const fields = "id,name,mimeType,md5Checksum,modifiedTime,version,size,parents,headRevisionId"
  const response = await call(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${encodeURIComponent(fields)}`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": contentType },
    body,
  })
  if (!response.ok) return response
  if (response.value.status === 412) return Err({ kind: "conflict" })
  if (!response.value.ok) return Err(failureOf(response.value))
  return json<DriveFile>(response.value)
}

export const trashFile = async (token: string, fileId: string): Promise<Result<DriveFile, Failure>> => {
  const response = await call(`${ROOT}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,md5Checksum,modifiedTime,version,size,parents,headRevisionId`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  })
  if (!response.ok) return response
  if (!response.value.ok) return Err(failureOf(response.value))
  return json<DriveFile>(response.value)
}

export const pinRevision = async (
  token: string,
  fileId: string,
  revisionId: string,
): Promise<Result<void, Failure>> => setRevisionKeepForever(token, fileId, revisionId, true)

const setRevisionKeepForever = async (
  token: string,
  fileId: string,
  revisionId: string,
  keepForever: boolean,
): Promise<Result<void, Failure>> => {
  const response = await call(`${ROOT}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?fields=id,keepForever`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ keepForever }),
  })
  if (!response.ok) return response
  return response.value.ok ? Ok(undefined) : Err(failureOf(response.value))
}

export const createFolder = async (
  token: string,
  parentId: string,
  name: string,
): Promise<Result<DriveFile, Failure>> => {
  const response = await call(`${ROOT}/files?fields=id,name,mimeType,parents`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  if (!response.ok) return response
  if (!response.value.ok) return Err(failureOf(response.value))
  return json<DriveFile>(response.value)
}

export const multipartBody = (
  boundary: string,
  metadata: Readonly<Record<string, unknown>>,
  content: string,
): string => `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`

const json = async <T>(response: Response): Promise<Result<T, Failure>> => {
  try {
    return Ok((await response.json()) as T)
  } catch {
    return Err({ kind: "refused", status: response.status })
  }
}

const authHeaders = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}` })

const call = async (url: string, init: RequestInit): Promise<Result<Response, Failure>> => {
  try {
    return Ok(await fetch(url, init))
  } catch {
    return Err({ kind: "offline" })
  }
}

const failureOf = (response: Response): Failure => {
  if (response.status === 401 || response.status === 403) return { kind: "unauthorised" }
  if (response.status === 404) return { kind: "no-such-file" }
  if (response.status === 412) return { kind: "conflict" }
  return { kind: "refused", status: response.status }
}

const revisionFailureOf = async (response: Response): Promise<Failure> => {
  if (response.status !== 403) return failureOf(response)
  try {
    const body: unknown = await response.clone().json()
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "errors" in body.error &&
      Array.isArray(body.error.errors) &&
      body.error.errors.some((error: unknown) =>
        typeof error === "object" && error !== null && "reason" in error && error.reason === "cannotDownloadRevision",
      )
    ) return { kind: "revision-not-downloadable" }
  } catch {
    return failureOf(response)
  }
  return failureOf(response)
}

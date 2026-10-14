import { Err, Ok, type Result } from "~/core/lib/monad"

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

export type Failure =
  | { readonly kind: "offline" }
  | { readonly kind: "unauthorised" }
  | { readonly kind: "no-such-file" }
  | { readonly kind: "conflict" }
  | { readonly kind: "refused"; readonly status: number }

const FILE_FIELDS = "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,version,size,parents)"

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
    return Ok(await response.value.text())
  } catch {
    return Err({ kind: "refused", status: response.value.status })
  }
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
): Promise<Result<DriveFile, Failure>> => {
  const fields = "id,name,mimeType,md5Checksum,modifiedTime,version,size,parents,headRevisionId"
  const response = await call(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${encodeURIComponent(fields)}`, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "text/plain; charset=utf-8" },
    body: content,
  })
  if (!response.ok) return response
  if (response.value.status === 412) return Err({ kind: "conflict" })
  if (!response.value.ok) return Err(failureOf(response.value))
  return json<DriveFile>(response.value)
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

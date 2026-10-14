import { Err, Ok, getOrUndefined, type Result } from "~/core/lib/monad"
import { journal, loadAttachment, openBringingMissing, registerAttachmentLoader, type Attachment, type OpenJournal } from "~/core/journal/store"
import { documentPathsInFiles, documents } from "~/core/journal/documents"
import { putAttachments } from "~/core/journal/kept"
import type { GoogleDriveRemote } from "~/core/journal/remote"
import type { Trouble } from "~/core/hledger/wire"
import { isGoogleDriveRemote } from "~/core/journal/remote"
import { accessToken, sessionToken } from "./auth"
import {
  FOLDER_MIME,
  createBinary,
  createFile,
  createFolder,
  getFileBlob,
  getFileContent,
  getFileMetadata,
  listFilesInFolder,
  updateFile,
  type DriveFile,
  type Failure,
} from "./api"
import { agreementOf, agree, agreedOn, changedFromAgreement, clientId, type DriveAgreement } from "./kept"
import { fileName, parentPath, relativePath, safePath } from "./paths"

export { safePath } from "./paths"

export type Snag =
  | { readonly at: "not-connected" }
  | { readonly at: "no-place" }
  | { readonly at: "no-journal" }
  | { readonly at: "drive"; readonly failure: Failure }
  | { readonly at: "hledger"; readonly trouble: Trouble }
  | { readonly at: "conflict"; readonly path: string }
  | { readonly at: "local-changes"; readonly path: string }

export type Outcome =
  | { readonly did: "pulled"; readonly files: number }
  | { readonly did: "pushed"; readonly files: number }
  | { readonly did: "nothing" }

export interface Unsent {
  readonly path: string
  readonly before: string
  readonly after: string
  readonly isNew: boolean
}

interface LocatedFile {
  readonly path: string
  readonly file: DriveFile
}

const treeOf = async (
  token: string,
  folderId: string,
  prefix = "",
  visited: ReadonlySet<string> = new Set(),
): Promise<Result<readonly LocatedFile[], Failure>> => {
  if (visited.has(folderId)) return Ok([])
  const listed = await listFilesInFolder(token, folderId)
  if (!listed.ok) return listed
  const nextVisited = new Set([...visited, folderId])
  const branches = await Promise.all(listed.value.map(async (file) => {
    const path = relativePath(prefix, file.name)
    if (!safePath(path)) return Ok([] as readonly LocatedFile[])
    return file.mimeType === FOLDER_MIME
      ? treeOf(token, file.id, path, nextVisited)
      : Ok([{ path, file }])
  }))
  const failure = branches.find((branch) => !branch.ok)
  if (failure !== undefined && !failure.ok) return failure
  return Ok(branches.flatMap((branch) => branch.ok ? branch.value : []))
}

const extensionMime: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
}

const mimeOf = (file: DriveFile): string | undefined => {
  if (file.mimeType === "application/pdf" || file.mimeType.startsWith("image/")) return file.mimeType
  return extensionMime[file.name.split(".").pop()?.toLowerCase() ?? ""]
}

const isTextFile = (file: DriveFile): boolean =>
  mimeOf(file) === undefined &&
  (file.mimeType.startsWith("text/") || ["application/json", "application/x-ndjson"].includes(file.mimeType) ||
    /\.(journal|hledger|ledger|jsonl|rules|csv|txt)$/i.test(file.name))

const filesIn = async (token: string, remote: GoogleDriveRemote): Promise<Result<readonly LocatedFile[], Snag>> => {
  const tree = await treeOf(token, remote.folderId)
  if (!tree.ok) return Err({ at: "drive", failure: tree.error })
  const counts = tree.value.reduce((all, item) => new Map(all).set(item.path, (all.get(item.path) ?? 0) + 1), new Map<string, number>())
  const duplicate = [...counts].find(([, count]) => count > 1)?.[0]
  return duplicate === undefined ? tree : Err({ at: "conflict", path: duplicate })
}

const credentials = async (): Promise<Result<string, Snag>> => {
  const id = await clientId()
  if (id === undefined || id.trim() === "") return Err({ at: "not-connected" })
  const token = await accessToken(id)
  return token.ok ? Ok(token.value) : Err({ at: "not-connected" })
}

const reachable = async (): Promise<Result<{ readonly token: string; readonly open: OpenJournal; readonly remote: GoogleDriveRemote }, Snag>> => {
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ at: "no-journal" })
  if (!isGoogleDriveRemote(open.remote) || open.remote.path === "") return Err({ at: "no-place" })
  const token = await credentials()
  return token.ok ? Ok({ token: token.value, open, remote: open.remote }) : token
}

export const pull = async (): Promise<Result<Outcome, Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const [localChange] = await changedFiles(reach.value.open.bookId, reach.value.open.source.files)
  if (localChange !== undefined) return Err({ at: "local-changes", path: localChange.path })
  return take(reach.value.token, reach.value.remote, reach.value.open.bookId, reach.value.open.source.label)
}

export const pullAsNewBook = async (remote: GoogleDriveRemote): Promise<Result<Outcome, Snag>> => {
  if (!safePath(remote.path)) return Err({ at: "no-place" })
  const token = await credentials()
  return token.ok ? take(token.value, remote, crypto.randomUUID(), remote.folderName || "Google Drive") : token
}

const take = async (
  token: string,
  remote: GoogleDriveRemote,
  bookId: string,
  label: string,
): Promise<Result<Outcome, Snag>> => {
  if (!safePath(remote.path)) return Err({ at: "no-place" })
  const listed = await filesIn(token, remote)
  if (!listed.ok) return listed
  const textFiles = listed.value.filter(({ file }) => isTextFile(file))
  const entry = textFiles.find(({ path }) => path === remote.path)
  if (entry === undefined) return Err({ at: "drive", failure: { kind: "no-such-file" } })
  const texts = await Promise.all(textFiles.map(async ({ path, file }) => {
    const body = await getFileContent(token, file.id)
    return body.ok ? Ok({ path, text: body.value, file } as const) : Err({ path, failure: body.error } as const)
  }))
  const failed = texts.find((text) => !text.ok)
  if (failed !== undefined && !failed.ok) return Err({ at: "drive", failure: failed.error.failure })
  const fetched = texts.flatMap((text) => text.ok ? [text.value] : [])
  const decoded = Object.fromEntries(fetched.map(({ path, text }) => [path, text]))
  const linked = new Set(documentPathsInFiles(decoded, documents().tag))
  const fileTexts = Object.fromEntries(Object.entries(decoded).filter(([path]) => !linked.has(path)))
  const attachmentFiles = listed.value.filter(({ path, file }) => !isTextFile(file) || linked.has(path))
  const attachments: readonly Attachment[] = attachmentFiles.map(({ path, file }) => ({
    path,
    type: mimeOf(file) ?? (file.mimeType || "application/octet-stream"),
    size: Number(file.size ?? 0),
  }))
  const previous = getOrUndefined(journal())
  const localAttachments = previous?.bookId === bookId ? previous.source.attachments : []
  const missingAttachment = localAttachments.find((attachment) => !attachmentFiles.some((item) => item.path === attachment.path))
  if (missingAttachment !== undefined) return Err({ at: "local-changes", path: missingAttachment.path })
  const opened = await openBringingMissing(
    { label, files: fileTexts, attachments, entry: `/${remote.path}` },
    async (path) => fileTexts[path],
    remote,
    bookId,
  )
  if (!opened.ok) return Err({ at: "hledger", trouble: opened.error })

  await Promise.all(fetched.filter(({ path }) => !linked.has(path)).map(({ path, text, file }) => agree(bookId, agreementOf(path, file, text))))
  registerAttachmentLoader(bookId, async (path) => {
    const located = attachmentFiles.find((item) => item.path === path)
    if (located === undefined) return undefined
    const blob = await getFileBlob(token, located.file.id)
    if (!blob.ok) return undefined
    const metadata = attachments.find((item) => item.path === path)
    if (metadata !== undefined) await putAttachments(bookId, [{ ...metadata, blob: blob.value }])
    return blob.value
  })
  return Ok({ did: "pulled", files: fetched.length + attachments.length })
}

const changedFiles = async (
  book: string,
  files: Readonly<Record<string, string>>,
): Promise<readonly Unsent[]> => {
  const changes = await Promise.all(Object.entries(files).map(async ([path, after]) => {
    const agreement = await agreedOn(book, path)
    return agreement?.baseText === after ? undefined : {
      path,
      before: agreement?.baseText ?? "",
      after,
      isNew: agreement === undefined,
    }
  }))
  return changes.flatMap((file) => file === undefined ? [] : [file])
}

export const unsent = async (open: OpenJournal): Promise<readonly Unsent[]> => changedFiles(open.bookId, open.source.files)

export const behind = async (): Promise<Result<readonly string[], Snag>> => {
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ at: "no-journal" })
  if (!isGoogleDriveRemote(open.remote)) return Err({ at: "no-place" })
  const configuredId = await clientId()
  if (configuredId === undefined) return Err({ at: "not-connected" })
  const token = sessionToken(configuredId)
  if (token === undefined) return Err({ at: "not-connected" })
  const tree = await filesIn(token, open.remote)
  if (!tree.ok) return tree
  const paths = await Promise.all(Object.keys(open.source.files).map(async (path) => {
    const agreement = await agreedOn(open.bookId, path)
    if (agreement === undefined) return undefined
    const current = tree.value.find((item) => item.path === path)?.file
    return current === undefined || changedFromAgreement(current, agreement) ? path : undefined
  }))
  return Ok(paths.flatMap((path) => path === undefined ? [] : [path]))
}

export const push = async (): Promise<Result<Outcome, Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token, open, remote } = reach.value
  const changes = await changedFiles(open.bookId, open.source.files)
  if (changes.length === 0) return Ok({ did: "nothing" })
  const tree = await filesIn(token, remote)
  if (!tree.ok) return tree

  type Prepared = { readonly change: Unsent; readonly current?: LocatedFile; readonly agreement?: DriveAgreement }
  const prepared: readonly Result<Prepared, Snag>[] = await Promise.all(changes.map(async (change): Promise<Result<Prepared, Snag>> => {
    const current = tree.value.find((item) => item.path === change.path)
    const agreement = await agreedOn(open.bookId, change.path)
    if (agreement === undefined) return current === undefined ? Ok({ change }) : Err({ at: "conflict", path: change.path })
    if (current === undefined || changedFromAgreement(current.file, agreement)) return Err({ at: "conflict", path: change.path })
    return Ok({ change, current, agreement })
  }))
  const blocked = prepared.find((item) => !item.ok)
  if (blocked !== undefined && !blocked.ok) return blocked

  const attachments = await pushAttachments(token, remote, open, tree.value)
  if (!attachments.ok) return attachments
  const written: string[] = [...attachments.value]
  for (const item of prepared.flatMap((result) => result.ok ? [result.value] : [])) {
    const saved = item.current === undefined
      ? await createAtPath(token, remote.folderId, item.change.path, item.change.after)
      : await updateAgreedFile(token, item.change, item.current, item.agreement)
    if (!saved.ok) return saved
    await agree(open.bookId, agreementOf(item.change.path, saved.value, item.change.after))
    written.push(item.change.path)
  }
  return Ok({ did: "pushed", files: written.length })
}

const pushAttachments = async (
  token: string,
  remote: GoogleDriveRemote,
  open: OpenJournal,
  tree: readonly LocatedFile[],
): Promise<Result<readonly string[], Snag>> => {
  const sent: string[] = []
  for (const attachment of open.source.attachments) {
    if (tree.some((item) => item.path === attachment.path)) continue
    const blob = await loadAttachment(open.bookId, attachment.path)
    if (blob === undefined) return Err({ at: "conflict", path: attachment.path })
    const folder = await folderFor(token, remote.folderId, parentPath(attachment.path))
    if (!folder.ok) return folder
    const created = await createBinary(token, folder.value, fileName(attachment.path), blob)
    if (!created.ok) {
      return created.error.kind === "conflict"
        ? Err({ at: "conflict", path: attachment.path })
        : Err({ at: "drive", failure: created.error })
    }
    sent.push(attachment.path)
  }
  return Ok(sent)
}

const updateAgreedFile = async (
  token: string,
  change: Unsent,
  current: LocatedFile,
  agreement: DriveAgreement | undefined,
): Promise<Result<DriveFile, Snag>> => {
  if (agreement === undefined) return Err({ at: "conflict", path: change.path })
  const latest = await getFileMetadata(token, current.file.id)
  if (!latest.ok) return Err({ at: "drive", failure: latest.error })
  if (changedFromAgreement(latest.value, agreement)) return Err({ at: "conflict", path: change.path })
  const updated = await updateFile(token, current.file.id, change.after)
  return updated.ok
    ? updated
    : updated.error.kind === "conflict"
      ? Err({ at: "conflict", path: change.path })
      : Err({ at: "drive", failure: updated.error })
}

const createAtPath = async (
  token: string,
  root: string,
  path: string,
  text: string,
): Promise<Result<DriveFile, Snag>> => {
  const folder = await folderFor(token, root, parentPath(path))
  if (!folder.ok) return folder
  const created = await createFile(token, folder.value, fileName(path), text)
  return created.ok
    ? created
    : created.error.kind === "conflict"
      ? Err({ at: "conflict", path })
      : Err({ at: "drive", failure: created.error })
}

const folderFor = async (token: string, root: string, path: string): Promise<Result<string, Snag>> => {
  const [part, ...rest] = path.split("/").filter(Boolean)
  if (part === undefined) return Ok(root)
  const listed = await listFilesInFolder(token, root)
  if (!listed.ok) return Err({ at: "drive", failure: listed.error })
  const found = listed.value.find((file) => file.name === part && file.mimeType === FOLDER_MIME)
  const folder = found === undefined ? await createFolder(token, root, part) : Ok(found)
  if (!folder.ok) return Err({ at: "drive", failure: folder.error })
  return folderFor(token, folder.value.id, rest.join("/"))
}

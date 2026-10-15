import { Err, Ok, getOrUndefined, type Result } from "~/core/lib/monad"
import { journal, loadAttachment, openBringingMissing, registerAttachmentLoader, removeAttachment, removeFile, replaceAttachment, restoreFile, rewriteFile, type Attachment, type OpenJournal } from "~/core/journal/store"
import { BOOK_CONFIG_PATH, documentSettingsFromFiles } from "~/core/journal/book-config"
import { documentPathsInFiles } from "~/core/journal/documents"
import { attachmentOf, putAttachments } from "~/core/journal/kept"
import type { GoogleDriveRemote } from "~/core/journal/remote"
import type { Trouble } from "~/core/hledger/wire"
import { isGoogleDriveRemote } from "~/core/journal/remote"
import { accessToken, sessionToken } from "./auth"
import { companionsIn } from "~/core/journal/companions"
import { isHiddenPath as hiddenPath } from "~/core/journal/hidden"
import { includedBy } from "~/core/journal/layout"
import { captureFile, sameVersions, type CapturedVersion, type FileSnapshot, type ResolutionChoice } from "~/core/sync/conflict"
import {
  FOLDER_MIME,
  createBinary,
  createFile,
  createFolder,
  getFileBlob,
  getFileContent,
  getFileMetadata,
  listFilesInFolder,
  updateBlob,
  updateFile,
  pinRevision,
  trashFile,
  type DriveFile,
  type Failure,
} from "./api"
import { agreementOf, agree, agreedOn, agreementsFor, changedFromAgreement, clientId, forgetAgreement, keepDriveRecovery, type DriveAgreement } from "./kept"
import { blockedSync } from "~/core/sync/conflict"
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
    if (!safePath(path) || hiddenPath(path)) return Ok([] as readonly LocatedFile[])
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

const isTextPath = (path: string): boolean =>
  /\.(journal|hledger|ledger|jsonl|rules|csv|txt)$/i.test(path)

const isTextFile = (file: DriveFile): boolean =>
  mimeOf(file) === undefined &&
  (file.mimeType.startsWith("text/") || ["application/json", "application/x-ndjson"].includes(file.mimeType) ||
    isTextPath(file.name))

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
  const local = await localChanges(reach.value.token, reach.value.remote, reach.value.open)
  if (!local.ok) return local
  const blocked = blockedSync("pull", local.value, [])
  if (blocked !== undefined) return Err({ at: "local-changes", path: blocked.paths[0] ?? "" })
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
  const legacyConfigPath = `${BOOK_CONFIG_PATH.slice(0, -1)}/${BOOK_CONFIG_PATH}`
  const hasConfig = fetched.some(({ path }) => path === BOOK_CONFIG_PATH)
  const bookFiles = fetched.flatMap((file) => file.path !== legacyConfigPath
    ? [file]
    : hasConfig
      ? []
      : [{ ...file, path: BOOK_CONFIG_PATH }])
  const decoded = Object.fromEntries(bookFiles.map(({ path, text }) => [path, text]))
  const linked = new Set(documentPathsInFiles(decoded, documentSettingsFromFiles(decoded).tag))
  const fileTexts = Object.fromEntries(Object.entries(decoded).filter(([path]) => !linked.has(path)))
  const attachmentFiles = listed.value.filter(({ path, file }) => !isTextFile(file) || linked.has(path))
  const attachments: readonly Attachment[] = attachmentFiles.map(({ path, file }) => ({
    path,
    type: mimeOf(file) ?? (file.mimeType || "application/octet-stream"),
    size: Number(file.size ?? 0),
  }))
  const previous = getOrUndefined(journal())
  const localAttachments = previous?.bookId === bookId ? previous.source.attachments : []
  const missingAttachment = localAttachments.find((attachment) =>
    !hiddenPath(attachment.path) && !attachmentFiles.some((item) => item.path === attachment.path),
  )
  if (missingAttachment !== undefined) return Err({ at: "local-changes", path: missingAttachment.path })
  const opened = await openBringingMissing(
    { label, files: fileTexts, attachments, entry: `/${remote.path}` },
    async (path) => fileTexts[path],
    remote,
    bookId,
  )
  if (!opened.ok) return Err({ at: "hledger", trouble: opened.error })

  await Promise.all([
    ...bookFiles.filter(({ path }) => !linked.has(path)).map(({ path, text, file }) => agree(bookId, agreementOf(path, file, text))),
    ...attachmentFiles.map(({ path, file }) => agree(bookId, agreementOf(path, file, ""))),
  ])
  registerAttachmentLoader(bookId, async (path) => {
    const located = attachmentFiles.find((item) => item.path === path)
    if (located === undefined) return undefined
    const blob = await getFileBlob(token, located.file.id)
    if (!blob.ok) return undefined
    const metadata = attachments.find((item) => item.path === path)
    if (metadata !== undefined) {
      await putAttachments(bookId, [{ ...metadata, blob: blob.value }])
      const version = await binaryVersion(blob.value)
      if (version.ok && version.value.content?.kind === "binary") {
        await agree(bookId, {
          ...agreementOf(path, located.file, ""),
          baseBinary: { size: version.value.content.size, fingerprint: version.value.content.fingerprint ?? "" },
        })
      }
    }
    return blob.value
  })
  return Ok({ did: "pulled", files: fetched.length + attachments.length })
}

const changedFiles = async (
  book: string,
  files: Readonly<Record<string, string>>,
): Promise<readonly Unsent[]> => {
  const changes = await Promise.all(Object.entries(files).filter(([path]) => !hiddenPath(path)).map(async ([path, after]) => {
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

const sameBytes = async (left: Blob, right: Blob): Promise<boolean> => {
  if (left.size !== right.size) return false
  const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()])
  const expected = new Uint8Array(rightBytes)
  return new Uint8Array(leftBytes).every((byte, index) => byte === expected[index])
}

const localBinaryChanged = async (
  token: string,
  bookId: string,
  path: string,
  file: DriveFile,
  agreement: DriveAgreement | undefined,
): Promise<Result<boolean, Failure>> => {
  const local = await attachmentOf(bookId, path)
  if (local === undefined) return Ok(false)
  if (agreement?.baseBinary !== undefined) {
    const version = await binaryVersion(local)
    return version.ok
      ? Ok(version.value.content?.kind !== "binary" || version.value.content.fingerprint !== agreement.baseBinary.fingerprint)
      : version
  }
  const remote = await getFileBlob(token, file.id)
  if (!remote.ok) return remote
  const same = await sameBytes(local, remote.value)
  if (!same) return Ok(true)
  const version = await binaryVersion(local)
  if (!version.ok || version.value.content?.kind !== "binary") return version.ok ? Err({ kind: "refused", status: 0 }) : version
  await agree(bookId, {
    ...agreementOf(path, file, ""),
    baseBinary: { size: version.value.content.size, fingerprint: version.value.content.fingerprint ?? "" },
  })
  return Ok(false)
}

const localChanges = async (
  token: string,
  remote: GoogleDriveRemote,
  open: OpenJournal,
): Promise<Result<readonly string[], Snag>> => {
  const agreements = await agreementsFor(open.bookId)
  const baseByPath = new Map(agreements.map((agreement) => [agreement.path, agreement]))
  const textPaths = [...new Set([...Object.keys(open.source.files), ...agreements.map(({ path }) => path)])]
    .filter((path) => !hiddenPath(path))
  const changedText = textPaths.filter((path) => open.source.files[path] !== baseByPath.get(path)?.baseText)
  const tree = await filesIn(token, remote)
  if (!tree.ok) return tree
  const binaryChanges = await Promise.all(open.source.attachments.filter(({ path }) => !hiddenPath(path)).map(async ({ path }): Promise<Result<string | undefined, Snag>> => {
    if (await attachmentOf(open.bookId, path) === undefined) return Ok(undefined)
    const destination = tree.value.find((item) => item.path === path)
    if (destination === undefined) return Ok(path)
    const agreement = baseByPath.get(path)
    const changed = await localBinaryChanged(token, open.bookId, path, destination.file, agreement)
    return changed.ok ? Ok(changed.value ? path : undefined) : Err({ at: "drive", failure: changed.error })
  }))
  const failed = binaryChanges.find((change) => !change.ok)
  if (failed !== undefined && !failed.ok) return failed
  return Ok([...new Set([
    ...changedText,
    ...binaryChanges.flatMap((change) => change.ok && change.value !== undefined ? [change.value] : []),
  ])])
}

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
  const localPaths = new Set([
    ...Object.keys(open.source.files).filter((path) => !hiddenPath(path)),
    ...open.source.attachments.map(({ path }) => path).filter((path) => !hiddenPath(path)),
  ])
  const paths = [...new Set([...localPaths, ...tree.value.map(({ path }) => path)])]
  const changed = await Promise.all(paths.map(async (path) => {
    const current = tree.value.find((item) => item.path === path)?.file
    const agreement = await agreedOn(open.bookId, path)
    if (agreement === undefined) return current !== undefined && !localPaths.has(path) ? path : undefined
    return current === undefined || changedFromAgreement(current, agreement) ? path : undefined
  }))
  const binaryChanges = await Promise.all(open.source.attachments.filter(({ path }) => !hiddenPath(path)).map(async ({ path }): Promise<Result<string | undefined, Snag>> => {
    const destination = tree.value.find((item) => item.path === path)
    if (destination === undefined) return Ok(undefined)
    const agreement = await agreedOn(open.bookId, path)
    const changed = await localBinaryChanged(token, open.bookId, path, destination.file, agreement)
    return changed.ok ? Ok(changed.value ? path : undefined) : Err({ at: "drive", failure: changed.error })
  }))
  const failed = binaryChanges.find((change) => !change.ok)
  if (failed !== undefined && !failed.ok) return failed
  return Ok([...new Set([
    ...changed.flatMap((path) => path === undefined ? [] : [path]),
    ...binaryChanges.flatMap((change) => change.ok && change.value !== undefined ? [change.value] : []),
  ])])
}

export const push = async (): Promise<Result<Outcome, Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token, open, remote } = reach.value
  const changedAtDestination = await behind()
  if (!changedAtDestination.ok) return changedAtDestination
  const destinationConflict = blockedSync("push", [], changedAtDestination.value)
  if (destinationConflict !== undefined) return Err({ at: "conflict", path: destinationConflict.paths[0] ?? "" })
  const tree = await filesIn(token, remote)
  if (!tree.ok) return tree
  const repaired = await repairMisplacedBookConfig(token, remote, open, tree.value)
  if (!repaired.ok) return repaired
  const changes = await changedFiles(open.bookId, open.source.files)

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
  if (changes.length === 0 && attachments.value.length === 0 && !repaired.value) return Ok({ did: "nothing" })
  const written: string[] = repaired.value ? [BOOK_CONFIG_PATH, ...attachments.value] : [...attachments.value]
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

/** Bring forward a settings file Drive placed under the folder from the old root-path calculation. */
const repairMisplacedBookConfig = async (
  token: string,
  remote: GoogleDriveRemote,
  open: OpenJournal,
  files: readonly LocatedFile[],
): Promise<Result<boolean, Snag>> => {
  const config = open.source.files[BOOK_CONFIG_PATH]
  const canonical = files.find(({ path }) => path === BOOK_CONFIG_PATH)
  const misplacedPath = `${BOOK_CONFIG_PATH.slice(0, -1)}/${BOOK_CONFIG_PATH}`
  const misplaced = files.find(({ path }) => path === misplacedPath)
  if (config === undefined || canonical !== undefined || misplaced === undefined) return Ok(false)

  const body = await getFileContent(token, misplaced.file.id)
  if (!body.ok) return Err({ at: "drive", failure: body.error })
  const agreement = await agreedOn(open.bookId, BOOK_CONFIG_PATH)
  if (agreement !== undefined && (changedFromAgreement(misplaced.file, agreement) || body.value !== agreement.baseText)) {
    return Err({ at: "conflict", path: BOOK_CONFIG_PATH })
  }
  if (agreement === undefined && body.value !== config) return Err({ at: "conflict", path: BOOK_CONFIG_PATH })

  const created = await createAtPath(token, remote.folderId, BOOK_CONFIG_PATH, config)
  if (!created.ok) return created
  await agree(open.bookId, agreementOf(BOOK_CONFIG_PATH, created.value, config))
  return Ok(true)
}

const pushAttachments = async (
  token: string,
  remote: GoogleDriveRemote,
  open: OpenJournal,
  tree: readonly LocatedFile[],
): Promise<Result<readonly string[], Snag>> => {
  const sent: string[] = []
  for (const attachment of open.source.attachments.filter(({ path }) => !hiddenPath(path))) {
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
    const version = await binaryVersion(blob)
    if (!version.ok || version.value.content?.kind !== "binary") {
      return Err({ at: "drive", failure: version.ok ? { kind: "refused", status: 0 } : version.error })
    }
    await agree(open.bookId, {
      ...agreementOf(attachment.path, created.value, ""),
      baseBinary: { size: version.value.content.size, fingerprint: version.value.content.fingerprint ?? "" },
    })
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

export type ResolutionFailure =
  | { readonly at: "drive"; readonly failure: Failure }
  | { readonly at: "stale"; readonly path: string }
  | { readonly at: "unsupported"; readonly path: string }
  | { readonly at: "hledger"; readonly trouble: Trouble }
  | { readonly at: "local-kept"; readonly path: string; readonly failure: Failure }
  | { readonly at: "uncertain"; readonly path: string; readonly revisionId?: string }

const identityOf = (file: DriveFile): string => JSON.stringify([
  file.id,
  file.md5Checksum,
  file.version,
  file.modifiedTime,
  file.size,
  file.headRevisionId,
])

const identityOfAgreement = (agreement: DriveAgreement): string => JSON.stringify([
  agreement.fileId,
  agreement.md5Checksum,
  agreement.version,
  agreement.modifiedTime,
  agreement.size,
  agreement.headRevisionId,
])

const binaryVersion = async (blob: Blob, identity?: string): Promise<Result<CapturedVersion, Failure>> => {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    return Ok({
      content: { kind: "binary", size: blob.size, fingerprint },
      ...(identity === undefined ? {} : { identity }),
    })
  } catch {
    return Err({ kind: "refused", status: 0 })
  }
}

const cachedBinaryIsUnchanged = async (
  bookId: string,
  path: string,
  agreement: DriveAgreement | undefined,
  file: DriveFile | undefined,
): Promise<Result<boolean, Failure>> => {
  if (agreement === undefined || file === undefined || changedFromAgreement(file, agreement)) return Ok(false)
  const local = await attachmentOf(bookId, path)
  if (local === undefined) return Ok(true)
  if (agreement.baseBinary === undefined) return Ok(false)
  const version = await binaryVersion(local)
  return version.ok
    ? Ok(version.value.content?.kind === "binary" && version.value.content.fingerprint === agreement.baseBinary.fingerprint)
    : version
}

const snapshotFromDrive = async (
  token: string,
  open: OpenJournal,
  path: string,
  role: NonNullable<FileSnapshot["role"]>,
  agreement: DriveAgreement | undefined,
  destinationFile: DriveFile | undefined,
): Promise<Result<FileSnapshot, ResolutionFailure>> => {
  const textual = destinationFile === undefined ? isTextPath(path) : isTextFile(destinationFile)
  const binary = !textual && (role !== "accounting" || agreement?.baseBinary !== undefined)
  const localText = open.source.files[path]
  const localBlob = binary ? await loadAttachment(open.bookId, path) : undefined
  const destinationText = !binary && destinationFile !== undefined
    ? await getFileContent(token, destinationFile.id)
    : undefined
  if (destinationText !== undefined && !destinationText.ok) return Err({ at: "drive", failure: destinationText.error })
  const destinationBlob = binary && destinationFile !== undefined
    ? await getFileBlob(token, destinationFile.id)
    : undefined
  if (destinationBlob !== undefined && !destinationBlob.ok) return Err({ at: "drive", failure: destinationBlob.error })
  const localVersion: Result<CapturedVersion, Failure> = binary
    ? localBlob === undefined ? Ok({}) : await binaryVersion(localBlob)
    : Ok(localText === undefined ? {} : { content: { kind: "text", text: localText } })
  if (!localVersion.ok) return Err({ at: "drive", failure: localVersion.error })
  const destinationVersion: Result<CapturedVersion, Failure> = binary
    ? destinationBlob?.ok ? await binaryVersion(destinationBlob.value, destinationFile === undefined ? undefined : identityOf(destinationFile)) : Ok({})
    : destinationText?.ok && destinationFile !== undefined
      ? Ok({ content: { kind: "text", text: destinationText.value }, identity: identityOf(destinationFile) })
      : Ok({})
  if (!destinationVersion.ok) return Err({ at: "drive", failure: destinationVersion.error })
  const base: CapturedVersion = agreement === undefined
    ? {}
    : agreement.baseBinary === undefined
      ? { content: { kind: "text", text: agreement.baseText }, identity: identityOfAgreement(agreement) }
      : {
          content: { kind: "binary", ...agreement.baseBinary },
          identity: identityOfAgreement(agreement),
        }
  return Ok(captureFile({
    bookId: open.bookId,
    path,
    role,
    base,
    local: localVersion.value,
    destination: destinationVersion.value,
    cause: agreement === undefined ? "missing-base" : "diverged",
    capturedAt: Date.now(),
  }))
}

export const inspectResolution = async (): Promise<Result<readonly FileSnapshot[], Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token, open, remote } = reach.value
  const tree = await filesIn(token, remote)
  if (!tree.ok) return tree
  const agreements = await agreementsFor(open.bookId)
  const agreementByPath = new Map(agreements.map((agreement) => [agreement.path, agreement]))
  const declared = new Set(Object.values(open.source.files).flatMap(companionsIn))
  const included = new Set(Object.values(open.source.files).flatMap(includedBy))
  const localAttachments = new Set(open.source.attachments.map(({ path }) => path))
  const allPaths = [...new Set([
    ...Object.keys(open.source.files),
    ...localAttachments,
    ...agreements.map(({ path }) => path),
    ...tree.value.map(({ path }) => path),
  ])].filter((path) => !hiddenPath(path))
  const captures = await Promise.all(allPaths.map(async (path) => {
    const agreement = agreementByPath.get(path)
    const located = tree.value.find((item) => item.path === path)
    const fileIsText = located === undefined ? isTextPath(path) : isTextFile(located.file)
    const knownBinary = !fileIsText && (localAttachments.has(path) || declared.has(path) || agreement?.baseBinary !== undefined ||
      /\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(path))
    const knownCompanion = localAttachments.has(path) || declared.has(path) || knownBinary
    const knownAccounting = open.source.files[path] !== undefined || included.has(path) || /\.(journal|hledger|ledger)$/i.test(path)
    const role = knownCompanion ? "companion" as const : knownAccounting ? "accounting" as const : "unknown" as const
    const file = located?.file
    const unchangedBinary = role === "companion"
      ? await cachedBinaryIsUnchanged(open.bookId, path, agreement, file)
      : Ok(false)
    if (!unchangedBinary.ok) return Err({ at: "drive", failure: unchangedBinary.error })
    return unchangedBinary.value
      ? Ok(undefined)
      : snapshotFromDrive(token, open, path, role, agreement, file).then((result) => result.ok ? Ok(result.value) : result)
  }))
  const failure = captures.find((capture) => !capture.ok)
  if (failure !== undefined && !failure.ok) return Err(failure.error as Snag)
  const snapshots = captures.flatMap((capture) => capture.ok && capture.value !== undefined ? [capture.value] : [])
  const relevant = snapshots.filter(({ state }) => ![
    "unchanged",
    "added-local",
    "changed-local",
    "changed-both-same",
    "added-both-same",
    "deleted-both",
  ].includes(state))
  await Promise.all(snapshots.map(async (snapshot) => {
    if (snapshot.role === "unknown" || snapshot.destination.content === undefined) return
    const file = tree.value.find((item) => item.path === snapshot.path)?.file
    if (file === undefined) return
    if (snapshot.destination.content.kind === "text") {
      if (snapshot.local.content?.kind === "text" && snapshot.local.content.text === snapshot.destination.content.text) {
        await agree(open.bookId, agreementOf(snapshot.path, file, snapshot.destination.content.text))
      }
      return
    }
    if (snapshot.local.content?.kind !== "binary" || snapshot.local.content.fingerprint !== snapshot.destination.content.fingerprint) return
    await agree(open.bookId, {
      ...agreementOf(snapshot.path, file, ""),
      baseBinary: { size: snapshot.destination.content.size, fingerprint: snapshot.destination.content.fingerprint ?? "" },
    })
  }))
  return Ok(relevant)
}

const currentDriveSnapshot = async (
  token: string,
  open: OpenJournal,
  remote: GoogleDriveRemote,
  snapshot: FileSnapshot,
): Promise<Result<{ readonly snapshot: FileSnapshot; readonly file?: DriveFile }, ResolutionFailure>> => {
  const tree = await filesIn(token, remote)
  if (!tree.ok) return Err({ at: "drive", failure: tree.error.at === "drive" ? tree.error.failure : { kind: "refused", status: 0 } })
  const file = tree.value.find((item) => item.path === snapshot.path)?.file
  const agreement = await agreedOn(open.bookId, snapshot.path)
  const captured = await snapshotFromDrive(token, open, snapshot.path, snapshot.role ?? "unknown", agreement, file)
  return captured.ok ? Ok({ snapshot: captured.value, ...(file === undefined ? {} : { file }) }) : captured
}

const retainAndRecheckRevision = async (
  token: string,
  open: OpenJournal,
  path: string,
  before: DriveFile,
): Promise<Result<DriveFile, ResolutionFailure>> => {
  const first = await getFileMetadata(token, before.id)
  if (!first.ok) return Err({ at: "drive", failure: first.error })
  if (identityOf(first.value) !== identityOf(before)) return Err({ at: "stale", path })
  const revisionId = first.value.headRevisionId
  if (revisionId === undefined) return Err({ at: "unsupported", path })
  const pinned = await pinRevision(token, first.value.id, revisionId)
  if (!pinned.ok && !(await keepDriveRecovery({
    bookId: open.bookId,
    path,
    fileId: first.value.id,
    revisionId,
    keptAt: Date.now(),
  }))) return Err({ at: "drive", failure: pinned.error })
  const latest = await getFileMetadata(token, first.value.id)
  if (!latest.ok) return Err({ at: "drive", failure: latest.error })
  return identityOf(latest.value) === identityOf(first.value)
    ? Ok(latest.value)
    : Err({ at: "stale", path })
}

const verifyTextWrite = async (token: string, file: DriveFile, expected: string, path: string): Promise<Result<DriveFile, ResolutionFailure>> => {
  const latest = await getFileMetadata(token, file.id)
  if (!latest.ok) return Err({ at: "uncertain", path })
  const body = await getFileContent(token, file.id)
  return body.ok && body.value === expected ? Ok(latest.value) : Err({ at: "uncertain", path })
}

const verifyBinaryWrite = async (token: string, file: DriveFile, expected: Blob, path: string): Promise<Result<DriveFile, ResolutionFailure>> => {
  const latest = await getFileMetadata(token, file.id)
  if (!latest.ok) return Err({ at: "uncertain", path })
  const body = await getFileBlob(token, file.id)
  if (!body.ok || !(await sameBytes(body.value, expected))) return Err({ at: "uncertain", path })
  return Ok(latest.value)
}

export const resolveResolution = async (
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
): Promise<Result<void, ResolutionFailure>> => {
  if (choice.take === "later" || snapshot.role === "unknown") return choice.take === "later" ? Ok(undefined) : Err({ at: "unsupported", path: snapshot.path })
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ at: "unsupported", path: snapshot.path })
  if (open.bookId !== snapshot.bookId || !isGoogleDriveRemote(open.remote) || !safePath(snapshot.path)) {
    return Err({ at: "stale", path: snapshot.path })
  }
  const permission = await credentials()
  if (!permission.ok) return Err({ at: "drive", failure: permission.error.at === "drive" ? permission.error.failure : { kind: "unauthorised" } })
  const token = permission.value
  const current = await currentDriveSnapshot(token, open, open.remote, snapshot)
  if (!current.ok) return current
  if (!sameVersions(snapshot, current.value.snapshot)) return Err({ at: "stale", path: snapshot.path })
  return [snapshot.local, snapshot.destination].some((version) => version.content?.kind === "binary")
    ? resolveDriveBinary(token, open, open.remote, current.value.file, snapshot, choice)
    : resolveDriveText(token, open, open.remote, current.value.file, snapshot, choice)
}

const resolveDriveText = async (
  token: string,
  open: OpenJournal,
  remote: GoogleDriveRemote,
  existing: DriveFile | undefined,
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
): Promise<Result<void, ResolutionFailure>> => {
  const local = snapshot.local.content?.kind === "text" ? snapshot.local.content.text : undefined
  const destination = snapshot.destination.content?.kind === "text" ? snapshot.destination.content.text : undefined
  if (choice.take === "destination") {
    if (destination === undefined) {
      if (open.source.files[snapshot.path] !== undefined) {
        const removed = await removeFile(snapshot.path)
        if (!removed.ok) return Err({ at: "hledger", trouble: removed.error })
      }
      await forgetAgreement(open.bookId, snapshot.path)
      return Ok(undefined)
    }
    const adopted = local === undefined ? await restoreFile(snapshot.path, destination) : await rewriteFile(snapshot.path, destination)
    if (!adopted.ok) return Err({ at: "hledger", trouble: adopted.error })
    if (existing !== undefined) await agree(open.bookId, agreementOf(snapshot.path, existing, destination))
    return Ok(undefined)
  }
  const text = choice.take === "manual" ? choice.text : local
  if (text === undefined) {
    if (existing !== undefined) {
      const checked = await getFileMetadata(token, existing.id)
      if (!checked.ok) return Err({ at: "drive", failure: checked.error })
      if (snapshot.destination.identity !== identityOf(checked.value)) return Err({ at: "stale", path: snapshot.path })
      const trashed = await trashFile(token, existing.id)
      if (!trashed.ok) return Err({ at: "drive", failure: trashed.error })
    }
    await forgetAgreement(open.bookId, snapshot.path)
    return Ok(undefined)
  }
  if (choice.take === "manual") {
    const adopted = local === undefined ? await restoreFile(snapshot.path, text) : await rewriteFile(snapshot.path, text)
    if (!adopted.ok) return Err({ at: "hledger", trouble: adopted.error })
  }
  let saved: Result<DriveFile, Failure>
  if (existing === undefined) {
    const checked = await currentDriveSnapshot(token, open, remote, snapshot)
    if (!checked.ok) return checked
    if (!sameVersions(snapshot, checked.value.snapshot) || checked.value.file !== undefined) return Err({ at: "stale", path: snapshot.path })
    const folder = await folderFor(token, remote.folderId, parentPath(snapshot.path))
    if (!folder.ok) return Err({ at: "drive", failure: folder.error.at === "drive" ? folder.error.failure : { kind: "refused", status: 0 } })
    const finalCheck = await currentDriveSnapshot(token, open, remote, snapshot)
    if (!finalCheck.ok) return finalCheck
    if (finalCheck.value.file !== undefined || !sameVersions(snapshot, finalCheck.value.snapshot)) return Err({ at: "stale", path: snapshot.path })
    saved = await createFile(token, folder.value, fileName(snapshot.path), text)
  } else {
    const ready = await retainAndRecheckRevision(token, open, snapshot.path, existing)
    if (!ready.ok) return ready
    saved = await updateFile(token, ready.value.id, text)
  }
  if (!saved.ok) return choice.take === "manual"
    ? Err({ at: "local-kept", path: snapshot.path, failure: saved.error })
    : Err({ at: "drive", failure: saved.error })
  const verified = await verifyTextWrite(token, saved.value, text, snapshot.path)
  if (!verified.ok) return verified
  await agree(open.bookId, agreementOf(snapshot.path, verified.value, text))
  return Ok(undefined)
}

const resolveDriveBinary = async (
  token: string,
  open: OpenJournal,
  remote: GoogleDriveRemote,
  existing: DriveFile | undefined,
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
): Promise<Result<void, ResolutionFailure>> => {
  if (choice.take === "manual") return Err({ at: "unsupported", path: snapshot.path })
  const local = await attachmentOf(open.bookId, snapshot.path)
  if (choice.take === "destination") {
    if (existing === undefined) {
      if (open.source.attachments.some(({ path }) => path === snapshot.path)) {
        const removed = await removeAttachment(snapshot.path)
        if (!removed.ok) return Err({ at: "hledger", trouble: removed.error })
      }
      await forgetAgreement(open.bookId, snapshot.path)
      return Ok(undefined)
    }
    const fetched = await getFileBlob(token, existing.id)
    if (!fetched.ok) return Err({ at: "drive", failure: fetched.error })
    const adopted = await replaceAttachment(snapshot.path, fetched.value)
    if (!adopted.ok) return Err({ at: "hledger", trouble: adopted.error })
    const version = await binaryVersion(fetched.value)
    if (!version.ok || version.value.content?.kind !== "binary") return Err({ at: "unsupported", path: snapshot.path })
    await agree(open.bookId, {
      ...agreementOf(snapshot.path, existing, ""),
      baseBinary: { size: version.value.content.size, fingerprint: version.value.content.fingerprint ?? "" },
    })
    return Ok(undefined)
  }
  if (local === undefined) {
    if (existing !== undefined) {
      const latest = await getFileMetadata(token, existing.id)
      if (!latest.ok) return Err({ at: "drive", failure: latest.error })
      if (snapshot.destination.identity !== identityOf(latest.value)) return Err({ at: "stale", path: snapshot.path })
      const trashed = await trashFile(token, existing.id)
      if (!trashed.ok) return Err({ at: "drive", failure: trashed.error })
    }
    await forgetAgreement(open.bookId, snapshot.path)
    return Ok(undefined)
  }
  let saved: Result<DriveFile, Failure>
  if (existing === undefined) {
    const checked = await currentDriveSnapshot(token, open, remote, snapshot)
    if (!checked.ok) return checked
    if (!sameVersions(snapshot, checked.value.snapshot) || checked.value.file !== undefined) return Err({ at: "stale", path: snapshot.path })
    const folder = await folderFor(token, remote.folderId, parentPath(snapshot.path))
    if (!folder.ok) return Err({ at: "drive", failure: folder.error.at === "drive" ? folder.error.failure : { kind: "refused", status: 0 } })
    const finalCheck = await currentDriveSnapshot(token, open, remote, snapshot)
    if (!finalCheck.ok) return finalCheck
    if (finalCheck.value.file !== undefined || !sameVersions(snapshot, finalCheck.value.snapshot)) return Err({ at: "stale", path: snapshot.path })
    saved = await createBinary(token, folder.value, fileName(snapshot.path), local)
  } else {
    const ready = await retainAndRecheckRevision(token, open, snapshot.path, existing)
    if (!ready.ok) return ready
    saved = await updateBlob(token, ready.value.id, local)
  }
  if (!saved.ok) return Err({ at: "drive", failure: saved.error })
  const verified = await verifyBinaryWrite(token, saved.value, local, snapshot.path)
  if (!verified.ok) return verified
  const version = await binaryVersion(local)
  if (!version.ok || version.value.content?.kind !== "binary") return Err({ at: "unsupported", path: snapshot.path })
  await agree(open.bookId, {
    ...agreementOf(snapshot.path, verified.value, ""),
    baseBinary: { size: version.value.content.size, fingerprint: version.value.content.fingerprint ?? "" },
  })
  return Ok(undefined)
}

export const exportUnknownResolution = async (snapshot: FileSnapshot): Promise<Result<Blob, ResolutionFailure>> => {
  if (snapshot.role !== "unknown" || snapshot.destination.content?.kind !== "binary") return Err({ at: "unsupported", path: snapshot.path })
  const open = getOrUndefined(journal())
  if (open === undefined || open.bookId !== snapshot.bookId || !isGoogleDriveRemote(open.remote)) return Err({ at: "stale", path: snapshot.path })
  const token = await credentials()
  if (!token.ok) return Err({ at: "drive", failure: token.error.at === "drive" ? token.error.failure : { kind: "unauthorised" } })
  const tree = await filesIn(token.value, open.remote)
  if (!tree.ok) return Err({ at: "drive", failure: tree.error.at === "drive" ? tree.error.failure : { kind: "refused", status: 0 } })
  const file = tree.value.find((item) => item.path === snapshot.path)?.file
  if (file === undefined || identityOf(file) !== snapshot.destination.identity) return Err({ at: "stale", path: snapshot.path })
  const blob = await getFileBlob(token.value, file.id)
  if (!blob.ok) return Err({ at: "drive", failure: blob.error })
  const version = await binaryVersion(blob.value, identityOf(file))
  return version.ok && version.value.content?.kind === "binary" &&
    version.value.content.fingerprint === snapshot.destination.content.fingerprint
    ? Ok(blob.value)
    : Err({ at: "stale", path: snapshot.path })
}

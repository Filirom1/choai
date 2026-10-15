import { beforeEach, expect, mock, test } from "bun:test"
import { Err, Ok, Some } from "../src/core/lib/monad"
import { captureFile, type FileSnapshot, type ResolutionSession } from "../src/core/sync/conflict"
import type { LocalDiskFile } from "../src/core/journal/local"
import type { DriveFile } from "../src/core/google-drive/api"
import type { GitHubRemote } from "../src/core/journal/remote"
import type { Agreed } from "../src/core/github/kept"

let open: any
let disk: readonly LocalDiskFile[] = []
let diskReads = 0
let diskReadSequence: readonly (readonly LocalDiskFile[])[] = []
let localPermission: PermissionState = "granted"
let localWrites: readonly string[] = []
let localRemovals: readonly string[] = []
let localBlobs: Readonly<Record<string, Blob>> = {}
let trialFailure: { readonly kind: "read-failed"; readonly detail: string } | undefined

let driveFile: DriveFile | undefined
let driveFiles: readonly DriveFile[] | undefined
let driveText = "destination\n"
let driveTexts: Readonly<Record<string, string>> = {}
let driveBlobs: Readonly<Record<string, Blob>> = {}
let driveLoadedAttachments: Readonly<Record<string, Blob>> = {}
let driveMetadataReads = 0
let driveMetadataFailureAt: number | undefined
let driveMetadataSequence: readonly (DriveFile | undefined)[] = []
let drivePinResult: ReturnType<typeof Ok> | ReturnType<typeof Err> = Ok(undefined)
let driveVerificationText: string | undefined
let driveUpdates: readonly string[] = []
let driveTrashes: readonly string[] = []
let driveRecoveries: readonly string[] = []
let driveAgreements: readonly unknown[] = []

let githubText = "destination\n"
let githubSha = "sha-reviewed"
let githubBlob = new Blob([Uint8Array.of(3, 4)], { type: "image/jpeg" })
let githubDeletions: readonly { readonly path: string; readonly sha: string }[] = []
let githubUploads: readonly { readonly path: string; readonly blob: Blob }[] = []
let githubReplacements: readonly { readonly path: string; readonly blob: Blob }[] = []
let githubAgreements: readonly unknown[] = []
let githubTree: readonly string[] = []
let githubBinaryFailPath: string | undefined

let sessions: readonly ResolutionSession[] = []
let failedPuts = 0
let failedDeletes = 0
let deleteAttempts = 0

const localHandle = { kind: "directory", name: "book" }
const driveRemote = { provider: "google-drive", folderId: "folder-1", folderName: "Books", path: "main.journal" }
const githubRemote: GitHubRemote = { provider: "github", owner: "owner", repo: "books", branch: "main", path: "books/main.journal" }

const fingerprint = async (blob: Blob): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const localIdentity = async (file: File): Promise<string> => JSON.stringify([
  file.lastModified,
  file.size,
  await fingerprint(file),
])

mock.module("../src/core/journal/store", () => ({
  journal: () => Some(open),
  loadAttachment: async (_bookId: string, path: string) => driveLoadedAttachments[path] ?? localBlobs[path] ?? (path === "receipt.jpg" ? githubLocalBlob : undefined),
  openBringingMissing: async () => Ok(open),
  registerAttachmentLoader: () => undefined,
  noteLocalBinaryWritten: async () => undefined,
  noteLocalTextWritten: async () => undefined,
  removeAttachment: async () => Ok(undefined),
  removeFile: async () => Ok(undefined),
  replaceAttachment: async (path: string, blob: Blob) => {
    githubReplacements = [...githubReplacements, { path, blob }]
    return Ok(undefined)
  },
  restoreFile: async () => trialFailure === undefined ? Ok(undefined) : Err(trialFailure),
  rewriteFile: async () => trialFailure === undefined ? Ok(undefined) : Err(trialFailure),
}))

mock.module("../src/core/journal/kept", () => ({
  attachmentOf: async (_bookId: string, path: string) => localBlobs[path] ?? (path === "receipt.jpg" ? githubLocalBlob : undefined),
  putAttachments: async () => undefined,
}))

mock.module("../src/core/journal/local", () => ({
  localFileVersion: async (file: File) => ({ lastModified: file.lastModified, size: file.size, fingerprint: await fingerprint(file) }),
  localFilesBelow: async () => {
    const selected = diskReadSequence[diskReads] ?? disk
    diskReads += 1
    return selected
  },
  localVersionIdentity: localIdentity,
  permitLocalFolder: async () => localPermission === "granted" ? Ok(undefined) : Err({ at: "permission" }),
  readLocalFile: async (_handle: FileSystemDirectoryHandle, path: string) => Ok(disk.find(({ path: itemPath }) => itemPath === path)?.file),
  removeLocalFile: async (_handle: FileSystemDirectoryHandle, path: string) => {
    localRemovals = [...localRemovals, path]
    return Ok(undefined)
  },
  safeLocalPath: (path: string) => path.length > 0 && !path.includes(".."),
  writeLocalFile: async (_handle: FileSystemDirectoryHandle, path: string) => {
    localWrites = [...localWrites, path]
    return Ok(undefined)
  },
}))

let githubLocalBlob: Blob | undefined

mock.module("../src/core/google-drive/auth", () => ({
  accessToken: async () => Ok("token"),
  sessionToken: () => "token",
}))

mock.module("../src/core/google-drive/kept", () => ({
  agreementOf: (path: string, file: DriveFile, baseText: string) => ({ path, fileId: file.id, md5Checksum: file.md5Checksum, version: file.version, modifiedTime: file.modifiedTime, size: file.size, headRevisionId: file.headRevisionId, baseText }),
  agree: async (_bookId: string, agreement: unknown) => { driveAgreements = [...driveAgreements, agreement] },
  agreedOn: async () => undefined,
  agreementsFor: async () => [],
  changedFromAgreement: () => false,
  clientId: async () => "client",
  forgetAgreement: async () => undefined,
  keepDriveRecovery: async ({ revisionId }: { revisionId: string }) => {
    driveRecoveries = [...driveRecoveries, revisionId]
    return true
  },
}))

mock.module("../src/core/google-drive/api", () => ({
  FOLDER_MIME: "application/vnd.google-apps.folder",
  createBinary: async () => Err({ kind: "refused", status: 500 }),
  createFile: async () => Err({ kind: "refused", status: 500 }),
  createFolder: async () => Err({ kind: "refused", status: 500 }),
  getFileBlob: async (_token: string, id: string) => driveBlobs[id] === undefined
    ? Err({ kind: "refused", status: 500 })
    : Ok(driveBlobs[id]!),
  getFileContent: async (_token: string, id: string) => Ok(driveUpdates.length > 0
    ? driveVerificationText ?? driveTexts[id] ?? driveText
    : driveTexts[id] ?? driveText),
  getFileMetadata: async () => {
    const index = driveMetadataReads
    driveMetadataReads += 1
    if (index === driveMetadataFailureAt) return Err({ kind: "refused", status: 503 })
    const value = driveMetadataSequence[index] ?? driveFile
    return value === undefined ? Err({ kind: "refused", status: 404 }) : Ok(value)
  },
  listFilesInFolder: async () => Ok(driveFiles ?? (driveFile === undefined ? [] : [driveFile])),
  pinRevision: async () => drivePinResult,
  trashFile: async (_token: string, id: string) => {
    driveTrashes = [...driveTrashes, id]
    return Ok(undefined)
  },
  updateBlob: async () => Err({ kind: "refused", status: 500 }),
  updateFile: async (_token: string, id: string, text: string) => {
    driveUpdates = [...driveUpdates, text]
    driveText = text
    return Ok({ ...(driveFile ?? driveFixture()), id, version: "2", md5Checksum: "new-checksum", headRevisionId: "revision-2" })
  },
}))

mock.module("../src/core/github/kept", () => ({
  token: async () => "token",
  agree: async (_bookId: string, agreement: Agreed) => { githubAgreements = [...githubAgreements, agreement] },
  agreedOn: async () => undefined,
  agreementsFor: async () => [],
  forgetAgreement: async () => undefined,
}))

mock.module("../src/core/github/api", () => ({
  deleteFile: async (_token: string, where: { path: string }, sha: string) => {
    githubDeletions = [...githubDeletions, { path: where.path, sha }]
    return Ok(undefined)
  },
  fetchBinary: async () => Ok({ blob: githubBlob, sha: githubSha }),
  fetchFile: async () => Ok({ text: githubText, sha: githubSha }),
  putBinary: async (_token: string, where: { path: string }, blob: Blob) => {
    if (where.path === githubBinaryFailPath) return Err({ kind: "refused", status: 503 })
    githubUploads = [...githubUploads, { path: where.path, blob }]
    return Ok("sha-uploaded")
  },
  putFile: async () => Ok({ sha: "sha-uploaded" }),
  repositoryFiles: async () => Ok(githubTree),
}))

mock.module("../src/core/lib/idb", () => ({
  STORE: { resolutions: "resolutions" },
  within: async (_mode: IDBTransactionMode, _stores: readonly string[], work: (transaction: IDBTransaction) => unknown) => {
    if (failedPuts > 0) {
      failedPuts -= 1
      throw new Error("storage unavailable")
    }
    if (failedDeletes > 0) {
      failedDeletes -= 1
      deleteAttempts += 1
      throw new Error("storage unavailable")
    }
    const request = { result: [...sessions] }
    const transaction = {
      objectStore: () => ({
        getAll: () => request,
        put: (session: ResolutionSession) => {
          sessions = [...sessions.filter(({ id }) => id !== session.id), session]
          return undefined
        },
        delete: (id: string) => {
          deleteAttempts += 1
          sessions = sessions.filter((session) => session.id !== id)
          return undefined
        },
      }),
    }
    return work(transaction as unknown as IDBTransaction)
  },
}))

const [localResolution, driveResolution, githubResolution, persistence] = await Promise.all([
  import("../src/core/journal/local-resolution"),
  import("../src/core/google-drive/sync"),
  import("../src/core/github/sync"),
  import("../src/core/sync/kept"),
])

const driveFixture = (overrides: Partial<DriveFile> = {}): DriveFile => ({
  id: "drive-file-1",
  name: "main.journal",
  mimeType: "text/plain",
  md5Checksum: "checksum-1",
  version: "1",
  modifiedTime: "2026-05-01T00:00:00Z",
  size: "12",
  headRevisionId: "revision-1",
  ...overrides,
})

const snapshotOfText = async (destination = "destination\n", local: string | null = "local\n"): Promise<FileSnapshot> => captureFile({
  bookId: "book-1",
  path: "main.journal",
  role: "accounting",
  base: { content: { kind: "text", text: "base\n" } },
  local: local === null ? {} : { content: { kind: "text", text: local } },
  destination: {
    content: { kind: "text", text: destination },
    identity: await localIdentity(new File([destination], "main.journal", { lastModified: 7 })),
  },
  cause: "diverged",
  capturedAt: 1,
})

const file = (path: string, contents: string | Uint8Array, lastModified = 7): LocalDiskFile => ({
  path,
  file: new File([typeof contents === "string" ? contents : Uint8Array.from(contents).buffer as ArrayBuffer], path.split("/").pop() ?? path, { lastModified }),
})

const gitTextSnapshot = (local: string | null = "local\n", destination = "destination\n", identity = "sha-reviewed"): FileSnapshot => captureFile({
  bookId: "book-1",
  path: "main.journal",
  role: "accounting",
  base: {},
  local: local === null ? {} : { content: { kind: "text", text: local } },
  destination: { content: { kind: "text", text: destination }, identity },
  cause: "missing-base",
  capturedAt: 1,
})

const gitBinarySnapshot = async (role: "companion" | "unknown"): Promise<FileSnapshot> => captureFile({
  bookId: "book-1",
  path: role === "unknown" ? "archive.bin" : "receipt.jpg",
  role,
  base: {},
  local: githubLocalBlob === undefined ? {} : { content: { kind: "binary", size: githubLocalBlob.size, fingerprint: await fingerprint(githubLocalBlob) } },
  destination: { content: { kind: "binary", size: githubBlob.size, fingerprint: await fingerprint(githubBlob) }, identity: githubSha },
  cause: "missing-base",
  capturedAt: 1,
})

const driveTextSnapshot = (local: string | null = "local\n"): FileSnapshot => captureFile({
  bookId: "book-1",
  path: "main.journal",
  role: "accounting",
  base: {},
  local: local === null ? {} : { content: { kind: "text", text: local } },
  destination: {
    content: { kind: "text", text: "destination\n" },
    identity: JSON.stringify([driveFile?.id, driveFile?.md5Checksum, driveFile?.version, driveFile?.modifiedTime, driveFile?.size, driveFile?.headRevisionId]),
  },
  cause: "missing-base",
  capturedAt: 1,
})

const session = (id: string, bookId: string): ResolutionSession => ({ id, bookId, snapshots: [], choices: {}, createdAt: 1 })

beforeEach(() => {
  open = {
    bookId: "book-1",
    source: { label: "Book", files: { "main.journal": "local\n" }, entry: "main.journal", attachments: [] },
    local: { handle: localHandle, base: { "main.journal": "base\n" } },
    summary: {},
  }
  disk = [file("main.journal", "destination\n")]
  diskReads = 0
  diskReadSequence = []
  localPermission = "granted"
  localWrites = []
  localRemovals = []
  localBlobs = {}
  githubLocalBlob = undefined
  trialFailure = undefined
  driveFile = driveFixture()
  driveFiles = undefined
  driveText = "destination\n"
  driveTexts = {}
  driveBlobs = {}
  driveLoadedAttachments = {}
  driveMetadataReads = 0
  driveMetadataFailureAt = undefined
  driveMetadataSequence = []
  drivePinResult = Ok(undefined)
  driveVerificationText = undefined
  driveUpdates = []
  driveTrashes = []
  driveRecoveries = []
  driveAgreements = []
  githubText = "destination\n"
  githubSha = "sha-reviewed"
  githubBlob = new Blob([Uint8Array.of(3, 4)], { type: "image/jpeg" })
  githubDeletions = []
  githubUploads = []
  githubReplacements = []
  githubAgreements = []
  githubTree = []
  githubBinaryFailPath = undefined
  sessions = []
  failedPuts = 0
  failedDeletes = 0
  deleteAttempts = 0
})

test("local resolution refuses lost permission and a destination changed after review", async () => {
  localPermission = "denied"
  expect(await localResolution.resolveLocalResolution(await snapshotOfText(), { take: "local" })).toMatchObject({ ok: false, error: { at: "local", failure: { at: "permission" } } })
  expect(localWrites).toEqual([])

  localPermission = "granted"
  diskReadSequence = [[file("main.journal", "destination\n")], [file("main.journal", "late edit\n")]]
  expect(await localResolution.resolveLocalResolution(await snapshotOfText(), { take: "local" })).toEqual({ ok: false, error: { at: "stale", path: "main.journal" } })
  expect(localWrites).toEqual([])
})

test("local comparison tracks Markdown documentation as text", async () => {
  const original = "Notes du dossier\n"
  const readme = file("historique/README.md", "Modifié ailleurs\n")
  const baseline = file("historique/README.md", original)
  disk = [file("main.journal", "base\n"), readme]
  open = {
    ...open,
    source: { ...open.source, files: { ...open.source.files, "historique/README.md": original } },
    local: {
      ...open.local,
      base: { ...open.local.base, "historique/README.md": original },
      versions: {
        "historique/README.md": {
          lastModified: baseline.file.lastModified,
          size: baseline.file.size,
          fingerprint: await fingerprint(baseline.file),
        },
      },
    },
  }

  const inspected = await localResolution.inspectLocalResolution()
  expect(inspected.ok && inspected.value).toContainEqual(expect.objectContaining({
    path: "historique/README.md", role: "accounting", state: "changed-destination",
  }))
})

test("local deletion, unknown export and binary companion inspection retain their file roles", async () => {
  open = { ...open, source: { ...open.source, files: {} } }
  expect(await localResolution.resolveLocalResolution(await snapshotOfText("destination\n", null), { take: "local" })).toEqual({ ok: true, value: undefined })
  expect(localRemovals).toEqual(["main.journal"])

  const unknownFile = file("archive.bin", Uint8Array.of(1, 2, 3))
  disk = [unknownFile]
  const unknown = captureFile({
    bookId: "book-1", path: "archive.bin", role: "unknown", base: {}, local: {},
    destination: { content: { kind: "binary", size: unknownFile.file.size, fingerprint: await fingerprint(unknownFile.file) }, identity: await localIdentity(unknownFile.file) },
    cause: "missing-base", capturedAt: 1,
  })
  const exported = await localResolution.exportLocalResolution(unknown)
  expect(exported.ok && await exported.value.arrayBuffer()).toEqual(await unknownFile.file.arrayBuffer())
  expect(await localResolution.resolveLocalResolution(unknown, { take: "destination" })).toMatchObject({ ok: false, error: { at: "unsupported" } })

  const companion = new Blob([Uint8Array.of(1, 2)], { type: "image/jpeg" })
  open = {
    ...open,
    source: { ...open.source, attachments: [{ path: "receipt.jpg", type: "image/jpeg", size: companion.size }] },
    local: { ...open.local, versions: { "receipt.jpg": { lastModified: 1, size: companion.size, fingerprint: "baseline" } } },
  }
  localBlobs = { "receipt.jpg": companion }
  disk = [file("receipt.jpg", Uint8Array.of(3, 4))]
  const inspected = await localResolution.inspectLocalResolution()
  const captured = inspected.ok ? inspected.value.find(({ path }) => path === "receipt.jpg") : undefined
  expect(captured).toMatchObject({ role: "companion", state: "changed-both", local: { content: { kind: "binary" } }, destination: { content: { kind: "binary" } } })
})

test("Drive comparison loads lazy companions, keeps text companions textual, and ignores dotfiles", async () => {
  const receipt = new Blob([Uint8Array.of(7, 8)], { type: "application/pdf" })
  const files = [
    driveFixture(),
    driveFixture({ id: "settings", name: "choai-settings.jsonl", mimeType: "application/x-ndjson" }),
    driveFixture({ id: "lock", name: ".~lock.00022882101.csv#", mimeType: "application/octet-stream" }),
    driveFixture({ id: "hidden", name: ".notes.jsonl", mimeType: "application/x-ndjson" }),
    driveFixture({ id: "receipt", name: "receipt.pdf", mimeType: "application/pdf", size: String(receipt.size) }),
  ]
  driveFiles = files
  driveTexts = {
    "drive-file-1": "; choai-file: choai-settings.jsonl\n",
    settings: "{}\n",
  }
  driveBlobs = { receipt }
  driveLoadedAttachments = { "receipt.pdf": receipt }
  open = {
    ...open,
    remote: driveRemote,
    local: undefined,
    source: {
      ...open.source,
      files: {
        "main.journal": "; choai-file: choai-settings.jsonl\n",
        "choai-settings.jsonl": "{}\n",
      },
      attachments: [{ path: "receipt.pdf", type: "application/pdf", size: receipt.size }],
    },
  }

  expect(await driveResolution.behind()).toEqual({ ok: true, value: [] })
  const inspected = await driveResolution.inspectResolution()
  expect(inspected).toEqual({ ok: true, value: [] })
  expect(driveAgreements).toContainEqual(expect.objectContaining({
    path: "receipt.pdf",
    baseBinary: { size: receipt.size, fingerprint: await fingerprint(receipt) },
  }))
})

test("Drive stops on a stale metadata recheck, retains recovery, and reports unverifiable writes", async () => {
  open = { ...open, remote: driveRemote, local: undefined }
  driveMetadataSequence = [driveFixture({ version: "2", md5Checksum: "late" })]
  expect(await driveResolution.resolveResolution(driveTextSnapshot(), { take: "local" })).toEqual({ ok: false, error: { at: "stale", path: "main.journal" } })
  expect(driveUpdates).toEqual([])

  driveMetadataReads = 0
  driveMetadataSequence = []
  driveMetadataFailureAt = 0
  expect(await driveResolution.resolveResolution(driveTextSnapshot(), { take: "local" })).toMatchObject({ ok: false, error: { at: "drive" } })
  expect(driveUpdates).toEqual([])

  driveMetadataReads = 0
  driveMetadataFailureAt = undefined
  drivePinResult = Err({ kind: "refused", status: 403 })
  expect(await driveResolution.resolveResolution(driveTextSnapshot(), { take: "local" })).toEqual({ ok: true, value: undefined })
  expect(driveRecoveries).toEqual(["revision-1"])
  expect(driveAgreements).toHaveLength(1)

  driveUpdates = []
  driveAgreements = []
  driveText = "destination\n"
  driveMetadataReads = 0
  driveVerificationText = "unexpected\n"
  expect(await driveResolution.resolveResolution(driveTextSnapshot(), { take: "local" })).toEqual({ ok: false, error: { at: "uncertain", path: "main.journal" } })
  expect(driveAgreements).toEqual([])
})

test("Drive trashes a reviewed remote file only for an explicit local deletion", async () => {
  open = { ...open, remote: driveRemote, local: undefined, source: { ...open.source, files: {} } }
  expect(await driveResolution.resolveResolution(driveTextSnapshot(null), { take: "local" })).toEqual({ ok: true, value: undefined })
  expect(driveTrashes).toEqual(["drive-file-1"])
})

test("GitHub revalidates SHAs, honors reviewed deletions, and keeps binaries whole-file only", async () => {
  open = { ...open, local: undefined, remote: githubRemote }
  githubSha = "sha-new"
  expect(await githubResolution.resolve(gitTextSnapshot(), { take: "local" })).toEqual({ ok: false, error: { at: "stale", path: "main.journal" } })
  expect(githubDeletions).toEqual([])

  githubSha = "sha-reviewed"
  open = { ...open, source: { ...open.source, files: {} } }
  expect(await githubResolution.resolve(gitTextSnapshot(null), { take: "local" })).toEqual({ ok: true, value: undefined })
  expect(githubDeletions).toEqual([{ path: "books/main.journal", sha: "sha-reviewed" }])

  githubLocalBlob = new Blob([Uint8Array.of(1, 2)], { type: "image/jpeg" })
  open = { ...open, source: { ...open.source, attachments: [{ path: "receipt.jpg", type: "image/jpeg", size: githubLocalBlob.size }] } }
  expect(await githubResolution.resolve(await gitBinarySnapshot("companion"), { take: "local" })).toEqual({ ok: true, value: undefined })
  expect(githubUploads.map(({ path }) => path)).toEqual(["books/receipt.jpg"])
})

test("a partial GitHub push reports completed paths and retries only what remains", async () => {
  open = {
    ...open,
    local: undefined,
    remote: githubRemote,
    source: {
      ...open.source,
      attachments: [
        { path: "first.jpg", type: "image/jpeg", size: 1 },
        { path: "second.jpg", type: "image/jpeg", size: 1 },
      ],
    },
  }
  localBlobs = {
    "first.jpg": new Blob([Uint8Array.of(1)]),
    "second.jpg": new Blob([Uint8Array.of(2)]),
  }
  githubBinaryFailPath = "books/second.jpg"

  expect(await githubResolution.push()).toMatchObject({
    ok: false,
    error: { at: "partial", written: ["first.jpg"], remaining: ["second.jpg", "main.journal"] },
  })
  expect(githubUploads.map(({ path }) => path)).toEqual(["books/first.jpg"])

  githubBinaryFailPath = undefined
  githubTree = ["books/first.jpg"]
  expect(await githubResolution.push()).toEqual({ ok: true, value: { did: "pushed", files: 2 } })
  expect(githubUploads.map(({ path }) => path)).toEqual(["books/first.jpg", "books/second.jpg"])
})

test("manual GitHub text is validated before upload, and unknown binaries remain export-only", async () => {
  open = { ...open, local: undefined, remote: githubRemote }
  trialFailure = { kind: "read-failed", detail: "invalid journal" }
  expect(await githubResolution.resolve(gitTextSnapshot(), { take: "manual", text: "invalid" })).toEqual({ ok: false, error: { at: "hledger", trouble: trialFailure } })
  expect(githubAgreements).toEqual([])

  trialFailure = undefined
  const unknown = await gitBinarySnapshot("unknown")
  expect(await githubResolution.resolve(unknown, { take: "destination" })).toMatchObject({ ok: false, error: { at: "unsupported" } })
  expect((await githubResolution.exportUnknown(unknown)).ok).toBe(true)
  expect(githubReplacements).toEqual([])
})

test("resolution sessions stay scoped to a book, keep storage failures structured, and retry cleanup", async () => {
  expect(await persistence.keepResolution(session("one", "book-a"))).toEqual({ ok: true, value: undefined })
  expect(await persistence.keepResolution(session("two", "book-b"))).toEqual({ ok: true, value: undefined })
  expect(await persistence.resolutionsFor("book-a")).toEqual({ ok: true, value: [session("one", "book-a")] })

  failedPuts = 1
  expect((await persistence.keepResolution(session("failed", "book-a"))).ok).toBe(false)
  sessions = [session("one", "book-a")]
  failedDeletes = 2
  expect(await persistence.forgetResolution("one")).toEqual({ ok: true, value: undefined })
  expect(deleteAttempts).toBe(3)

  failedDeletes = 3
  const failedCleanup = await persistence.forgetResolution("still-fails")
  expect(failedCleanup.ok).toBe(false)
  expect(deleteAttempts).toBe(6)
})

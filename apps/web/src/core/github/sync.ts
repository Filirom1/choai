import { Err, Ok, getOrUndefined, type Result } from "~/core/lib/monad"
import { journal, loadAttachment, openBringingMissing, registerAttachmentLoader, removeAttachment, removeFile, replaceAttachment, restoreFile, rewriteFile, type Attachment, type OpenJournal } from "~/core/journal/store"
import { companionsIn } from "~/core/journal/companions"
import { documentSettingsFromFiles } from "~/core/journal/book-config"
import { documentPathsInFiles } from "~/core/journal/documents"
import { includedBy } from "~/core/journal/layout"
import { hledgerLatestPaths, isHiddenPath, isHledgerLatestPath } from "~/core/journal/hidden"
import { attachmentOf, putAttachments, type GitHubRemote } from "~/core/journal/kept"
import { isGitHubRemote } from "~/core/journal/remote"
import type { Trouble } from "~/core/hledger/wire"
import { deleteFile, fetchBinary, fetchFile, putBinary, putFile, repositoryFiles, type Failure, type Where } from "./api"
import { agree, agreedOn, agreementsFor, forgetAgreement, token, type Agreed } from "./kept"
import { appendMergeProposal, blockedSync, captureFile, choiceText, sameVersions, type CapturedVersion, type FileSnapshot, type ResolutionChoice } from "~/core/sync/conflict"

/**
 * Keeping the books here and the books in the repository the same.
 *
 * Two devices are the ordinary case — a phone that writes entries on the way
 * home and a desktop that writes them in an editor — so a push has to expect
 * that the file has moved on. GitHub refuses such a write rather than
 * overwriting, and the refusal is where this earns its keep.
 *
 * What it does with the refusal is the whole design: with the text both sides
 * last agreed on kept here, entries added in each place are laid one after the
 * other. Anything else — an edit inside the shared part — is not merged and not
 * guessed at; it is reported, with both texts still intact.
 */

/** What went wrong, told apart by who said no. */
type Cause =
  | { readonly at: "not-connected" }
  | { readonly at: "no-place" }
  | { readonly at: "no-journal" }
  | { readonly at: "github"; readonly failure: Failure }
  | { readonly at: "hledger"; readonly trouble: Trouble }
  | { readonly at: "local-changes"; readonly path: string }
  /** Both sides changed the same text; only a person can say what was meant. */
  | { readonly at: "diverged"; readonly path: string; readonly snapshot?: FileSnapshot; readonly proposal?: string }

export type Snag = Cause | {
  readonly at: "partial"
  readonly written: readonly string[]
  readonly remaining: readonly string[]
  readonly cause: Cause
}

/** What came of it, in the words the reader gets. */
export type Outcome =
  | { readonly did: "pulled"; readonly files: number }
  | { readonly did: "pushed"; readonly files: number }
  | { readonly did: "nothing" }

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1)
const mimeOf = (path: string): string => ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream")
const journalPath = (path: string): boolean => /\.(journal|hledger|ledger)$/i.test(path)
/**
 * What is taken as text beside the journal, as a folder or Drive would take it.
 *
 * GitHub says nothing of a file's type, so the name has to: rules, statements
 * and notes kept with the books are part of them, and left behind they would be
 * reported as arriving from the other side on the first comparison.
 */
const textPath = (path: string): boolean => journalPath(path) || /\.(rules|csv|tsv|ssv|txt|md|markdown|json|jsonl)$/i.test(path)
const binaryPath = (path: string): boolean => /\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(path)
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
const agreementMatches = (current: Agreed | undefined, next: Agreed): boolean =>
  current !== undefined &&
  current.path === next.path &&
  current.repoPath === next.repoPath &&
  current.sha === next.sha &&
  current.baseText === next.baseText &&
  current.baseBinary?.size === next.baseBinary?.size &&
  current.baseBinary?.fingerprint === next.baseBinary?.fingerprint

const binaryVersion = async (blob: Blob, identity?: string): Promise<Result<CapturedVersion, Failure>> => {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    return Ok({
      content: { kind: "binary" as const, size: blob.size, fingerprint },
      ...(identity === undefined ? {} : { identity }),
    })
  } catch (cause) {
    return Err({ kind: "refused" as const, status: 0, detail: `Could not fingerprint companion: ${String(cause)}` })
  }
}

const where = (remote: GitHubRemote, path: string): Where => ({
  owner: remote.owner.trim(),
  repo: remote.repo.trim(),
  branch: remote.branch.trim(),
  path,
})

/**
 * What it takes to reach a book: the account's token, and the book's own place.
 *
 * Two different absences, because they are fixed in two different screens — the
 * token once for the account, the place for this book.
 */
export const reachable = async (): Promise<Result<{ token: string; open: OpenJournal; remote: GitHubRemote }, Snag>> => {
  const key = await token()
  if (key === undefined || key === "") return Err({ at: "not-connected" })
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ at: "no-journal" })
  if (!isGitHubRemote(open.remote) || open.remote.path === "") return Err({ at: "no-place" })
  return Ok({ token: key, open, remote: open.remote })
}

/**
 * Take the repository's copy and open it.
 *
 * The entry file is fetched by name; the files it includes are fetched as
 * hledger asks for them, from the directory the entry file sits in — which is
 * how the `include` lines resolve on a disk, so it is how they resolve here.
 */
export const pull = async (): Promise<Result<Outcome, Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const pending = await localChangedPaths(reach.value.token, reach.value.open, reach.value.remote)
  const blocked = blockedSync("pull", pending, [])
  if (blocked !== undefined) return Err({ at: "local-changes", path: blocked.paths[0] ?? "" })
  return take(reach.value.token, reach.value.remote, reach.value.open.bookId, reach.value.open.source.label)
}

/**
 * Take a copy as a book of its own.
 *
 * How someone with books already in a repository arrives: nothing has to be
 * made here first and then thrown away. The name is the repository's, which is
 * what the reader called it when they made it, and it can be changed after.
 */
export const pullAsNewBook = async (remote: GitHubRemote): Promise<Result<Outcome, Snag>> => {
  const key = await token()
  if (key === undefined || key === "") return Err({ at: "not-connected" })
  if (remote.path === "") return Err({ at: "no-place" })
  return take(key, remote, crypto.randomUUID(), `${remote.owner}/${remote.repo}`)
}

const take = async (
  key: string,
  remote: GitHubRemote,
  into: string,
  name: string,
): Promise<Result<Outcome, Snag>> => {
  const entry = nameOf(remote.path)
  const directory = directoryOf(remote.path)
  const tree = await repositoryFiles(key, { owner: remote.owner, repo: remote.repo }, remote.branch || "HEAD")
  if (!tree.ok) return Err({ at: "github", failure: tree.error })
  const relative = (path: string): string => path.slice(directory.length)
  const root = await fetchFile(key, where(remote, remote.path))
  if (!root.ok) return Err({ at: "github", failure: root.error })
  const declared = new Set(companionsIn(root.value.text))
  const relativePaths = tree.value.filter((path) => path === remote.path || path.startsWith(directory)).map(relative)
  const latestPaths = new Set([
    ...[...declared].filter(isHledgerLatestPath),
    ...hledgerLatestPaths(relativePaths),
  ])
  const paths = tree.value.filter((path) =>
    (path === remote.path || path.startsWith(directory)) &&
    (!isHiddenPath(path) || latestPaths.has(relative(path))),
  )
  if (!paths.includes(remote.path)) return Err({ at: "github", failure: { kind: "no-such-file" } })
  const included = new Set(includedBy(root.value.text))
  const latestCompanion = (path: string): boolean => latestPaths.has(relative(path))
  const knownText = (path: string): boolean => textPath(path) || included.has(relative(path)) || latestCompanion(path)
  const knownBinary = (path: string): boolean => binaryPath(path) && !latestCompanion(path)
  const unknown = (path: string): boolean => path !== remote.path &&
    !knownText(path) && !knownBinary(path) && !declared.has(relative(path))
  const binary = (path: string): boolean => knownBinary(path) || (declared.has(relative(path)) && !latestCompanion(path)) || unknown(path)
  const fetched = await Promise.all(paths.filter((path) => path === remote.path || (!binary(path) && !unknown(path))).map(async (repoPath) => {
    if (repoPath === remote.path) {
      return { kind: "text" as const, path: relative(repoPath), repoPath, text: root.value.text, sha: root.value.sha }
    }
    const file = await fetchFile(key, where(remote, repoPath))
    return file.ok
      ? { kind: "text" as const, path: relative(repoPath), repoPath, text: file.value.text, sha: file.value.sha }
      : { kind: "failure" as const, error: file.error }
  }))
  const failure = fetched.find((file) => file.kind === "failure")
  if (failure?.kind === "failure") return Err({ at: "github", failure: failure.error })
  const brought = new Map<string, { text: string; sha: string; repoPath: string }>()
  fetched.forEach((file) => {
    if (file.kind === "text") brought.set(file.path, { text: file.text, sha: file.sha, repoPath: file.repoPath })
  })
  const broughtFiles = Object.fromEntries([...brought].map(([path, file]) => [path, file.text]))
  const linked = new Set(documentPathsInFiles(broughtFiles, documentSettingsFromFiles(broughtFiles).tag))
  const attachmentPaths = paths.filter((path) =>
    (!unknown(path) && binary(path)) || linked.has(relative(path)),
  )
  attachmentPaths.forEach((path) => brought.delete(relative(path)))
  const attachments: readonly Attachment[] = attachmentPaths.map((path) => ({ path: relative(path), type: mimeOf(path), size: 0 }))

  const opened = await openBringingMissing(
    {
      label: name,
      files: Object.fromEntries([...brought].map(([path, file]) => [path, file.text])),
      attachments,
      entry: `/${entry}`,
    },
    async (path) => {
      const file = brought.get(path)
      return file?.text
    },
    remote,
    into,
  )
  if (!opened.ok) return Err({ at: "hledger", trouble: opened.error })

  registerAttachmentLoader(into, async (path) => {
    const repoPath = `${directory}${path}`
    const file = await fetchBinary(key, where(remote, repoPath))
    if (!file.ok) return undefined
    const metadata = attachments.find((attachment) => attachment.path === path)
    const blob = new Blob([file.value.blob], { type: metadata?.type ?? "application/octet-stream" })
    if (metadata !== undefined) await putAttachments(into, [{ ...metadata, blob }])
    return blob
  })

  await Promise.all(
    [...brought].map(([path, file]) =>
      agree(into, { path, repoPath: file.repoPath, sha: file.sha, baseText: file.text, at: Date.now() }),
    ),
  )
  return Ok({ did: "pulled", files: brought.size + attachments.length })
}

/**
 * The files the journal declares beside itself, fetched after it.
 *
 * hledger asks for what it `include`s and for nothing else, so without this a
 * companion would be pushed from the device that made it and never come back to
 * any other — which is the same as losing it, only slower. What the journal
 * declares is the whole of what is looked for; see `journal/companions.ts`.
 *
 * One that is not in the repository is not a failure. A book that has declared
 * a companion and not yet sent it is the ordinary state of one being started,
 * and the file is here already in that case.
 */
/** Every file of the open journal that is not already what the repository has. */
const localChangedPaths = async (
  key: string,
  open: OpenJournal,
  remote: GitHubRemote,
): Promise<readonly string[]> => {
  const agreements = await agreementsFor(open.bookId)
  const byPath = new Map(agreements.map((agreement) => [agreement.path, agreement]))
  const binaryPaths = new Set([
    ...open.source.attachments.map(({ path }) => path),
    ...agreements.filter(({ baseBinary }) => baseBinary !== undefined).map(({ path }) => path),
  ])
  const latest = [...new Set([
    ...Object.values(open.source.files).flatMap(companionsIn),
    ...hledgerLatestPaths(Object.keys(open.source.files)),
  ])].filter(isHledgerLatestPath)
  const textPaths = [...new Set([...Object.keys(open.source.files), ...agreements.map(({ path }) => path)])]
    .filter((path) => !isHiddenPath(path, latest) && !binaryPaths.has(path))
  const changedText = textPaths.filter((path) => open.source.files[path] !== byPath.get(path)?.baseText)
  const changedBinary = await Promise.all([...binaryPaths].filter((path) => !isHiddenPath(path)).map(async (path) => {
    const agreement = byPath.get(path)
    const localBlob = await attachmentOf(open.bookId, path)
    if (localBlob === undefined) return open.source.attachments.some((attachment) => attachment.path === path) ? undefined : path
    const local = await binaryVersion(localBlob)
    if (!local.ok) return path
    const base = agreement?.baseBinary
    if (base !== undefined) {
      return local.value.content?.kind === "binary" && local.value.content.size === base.size &&
        local.value.content.fingerprint === base.fingerprint ? undefined : path
    }
    const fetched = await fetchBinary(key, where(remote, agreement?.repoPath ?? `${directoryOf(remote.path)}${path}`))
    if (!fetched.ok) return path
    const destination = await binaryVersion(fetched.value.blob)
    const localContent = local.value.content
    const destinationContent = destination.ok ? destination.value.content : undefined
    return localContent?.kind === "binary" && destinationContent?.kind === "binary" &&
      localContent.size === destinationContent.size &&
      localContent.fingerprint === destinationContent.fingerprint ? undefined : path
  }))
  return [...new Set([...changedText, ...changedBinary.flatMap((path) => path === undefined ? [] : [path])])]
}

const changedFiles = async (
  book: string,
  files: Readonly<Record<string, string>>,
): Promise<readonly { path: string; text: string; agreed: Agreed | undefined }[]> => {
  const latest = [...new Set([
    ...Object.values(files).flatMap(companionsIn),
    ...hledgerLatestPaths(Object.keys(files)),
  ])].filter(isHledgerLatestPath)
  const all = await Promise.all(
    Object.entries(files).filter(([path]) => !isHiddenPath(path, latest)).map(async ([path, text]) => ({ path, text, agreed: await agreedOn(book, path) })),
  )
  return all.filter((file) => file.agreed?.baseText !== file.text)
}

/** One file a push would send, beside what it was when the two sides last agreed. */
export interface Unsent {
  readonly path: string
  /** Empty for a file the repository has never had. */
  readonly before: string
  readonly after: string
  readonly isNew: boolean
}

/** What a push of this book would send now. */
export const unsent = async (open: OpenJournal): Promise<readonly Unsent[]> =>
  (await changedFiles(open.bookId, open.source.files)).map((file) => ({
    path: file.path,
    before: file.agreed?.baseText ?? "",
    after: file.text,
    isNew: file.agreed === undefined,
  }))

export const inspect = async (): Promise<Result<readonly FileSnapshot[], Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token: key, open, remote } = reach.value
  const tree = await repositoryFiles(key, { owner: remote.owner, repo: remote.repo }, remote.branch || "HEAD")
  if (!tree.ok) return Err({ at: "github", failure: tree.error })
  const directory = directoryOf(remote.path)
  const relativeTreePaths = tree.value.filter((path) => path.startsWith(directory)).map((path) => path.slice(directory.length))
  const companionPaths = new Set([
    ...Object.values(open.source.files).flatMap(companionsIn),
    ...hledgerLatestPaths([...relativeTreePaths, ...Object.keys(open.source.files)]),
  ])
  const remotePaths = tree.value.flatMap((path) => path.startsWith(directory) &&
    (!isHiddenPath(path) || (isHledgerLatestPath(path.slice(directory.length)) && companionPaths.has(path.slice(directory.length))))
    ? [path.slice(directory.length)] : [])
  const knownAgreements = await agreementsFor(open.bookId)
  const agreementByPath = new Map(knownAgreements.map((agreement) => [agreement.path, agreement]))
  const includedPaths = new Set(Object.values(open.source.files).flatMap(includedBy))
  const paths = [...new Set([
    ...Object.keys(open.source.files),
    ...open.source.attachments.map(({ path }) => path),
    ...knownAgreements.map((agreement) => agreement.path),
    ...remotePaths,
  ])].filter((path) => !isHiddenPath(path, [...companionPaths].filter(isHledgerLatestPath)))
  const files = await Promise.all(paths.map(async (path) => {
    const agreement = agreementByPath.get(path)
    const repoPath = agreement?.repoPath ?? `${directory}${path}`
    const localAttachment = open.source.attachments.some((attachment) => attachment.path === path)
    const latestCompanion = isHledgerLatestPath(path) && companionPaths.has(path)
    const knownCompanion = localAttachment || (companionPaths.has(path) && !latestCompanion) || agreement?.baseBinary !== undefined || (binaryPath(path) && !latestCompanion)
    const knownAccounting = open.source.files[path] !== undefined || includedPaths.has(path) || textPath(path) || latestCompanion
    const isBinary = knownCompanion || (!knownAccounting && !knownCompanion)
    const role = knownCompanion || latestCompanion ? "companion" as const : knownAccounting ? "accounting" as const : "unknown" as const
    if (isBinary) {
      const declaredLocally = open.source.attachments.some((attachment) => attachment.path === path)
      const [storedBlob, fetched] = await Promise.all([
        declaredLocally ? attachmentOf(open.bookId, path) : undefined,
        fetchBinary(key, where(remote, repoPath)),
      ])
      if (!fetched.ok && fetched.error.kind !== "no-such-file") return Err({ path, snag: { at: "github", failure: fetched.error } } as const)
      const localBlob = storedBlob ?? (declaredLocally && fetched.ok ? fetched.value.blob : undefined)
      const local = localBlob === undefined ? Ok({}) : await binaryVersion(localBlob)
      if (!local.ok) return Err({ path, snag: { at: "github", failure: local.error } } as const)
      const destinationResult = fetched.ok ? await binaryVersion(fetched.value.blob, fetched.value.sha) : undefined
      if (destinationResult !== undefined && !destinationResult.ok) {
        return Err({ path, snag: { at: "github", failure: destinationResult.error } } as const)
      }
      const destination = destinationResult?.ok ? destinationResult.value : {}
      const base = agreement?.baseBinary === undefined ? {} : {
        content: { kind: "binary" as const, ...agreement.baseBinary },
        identity: agreement.sha,
      }
      const snapshot = captureFile({
        bookId: open.bookId,
        path,
        role,
        base,
        local: local.value,
        destination,
        cause: agreement === undefined ? "missing-base" : "diverged",
        capturedAt: Date.now(),
      })
      if (snapshot.state === "deleted-both") await forgetAgreement(open.bookId, path)
      const binaryContent = destinationResult?.ok ? destinationResult.value.content : undefined
      if (fetched.ok && binaryContent?.kind === "binary" && binaryContent.fingerprint !== undefined &&
        ["unchanged", "added-both-same", "changed-both-same"].includes(snapshot.state)) {
        const next: Agreed = {
          path,
          repoPath,
          sha: fetched.value.sha,
          baseText: "",
          baseBinary: { size: binaryContent.size, fingerprint: binaryContent.fingerprint },
          at: Date.now(),
        }
        if (!agreementMatches(agreement, next)) await agree(open.bookId, next)
      }
      return Ok({ path, snapshot } as const)
    }
    const localText = open.source.files[path]
    const fetched = await fetchFile(key, where(remote, repoPath))
    if (!fetched.ok && fetched.error.kind !== "no-such-file") return Err({ path, snag: { at: "github", failure: fetched.error } } as const)
    const destination = fetched.ok
      ? { content: { kind: "text" as const, text: fetched.value.text }, identity: fetched.value.sha }
      : {}
    const base = agreement === undefined ? {} : {
      content: { kind: "text" as const, text: agreement.baseText },
      identity: agreement.sha,
    }
    const local = localText === undefined ? {} : { content: { kind: "text" as const, text: localText } }
    const snapshot = captureFile({
      bookId: open.bookId,
      path,
      role,
      base,
      local,
      destination,
      cause: agreement === undefined ? "missing-base" : "diverged",
      capturedAt: Date.now(),
    })
    if (snapshot.state === "deleted-both") await forgetAgreement(open.bookId, path)
    if (fetched.ok && ["unchanged", "added-both-same", "changed-both-same"].includes(snapshot.state)) {
      const next: Agreed = { path, repoPath, sha: fetched.value.sha, baseText: fetched.value.text, at: Date.now() }
      if (!agreementMatches(agreement, next)) await agree(open.bookId, next)
    }
    return Ok({ path, snapshot } as const)
  }))
  const failed = files.find((file) => !file.ok)
  if (failed !== undefined && !failed.ok) return Err(failed.error.snag)
  return Ok(files.flatMap((file) => {
    if (!file.ok) return []
    const { snapshot } = file.value
    return snapshot.state === "unchanged" || snapshot.state === "added-local" || snapshot.state === "changed-local" ||
      snapshot.state === "changed-both-same" || snapshot.state === "added-both-same" || snapshot.state === "deleted-both"
      ? []
      : [snapshot]
  }))
}

export type ResolutionFailure =
  | Snag
  | { readonly at: "stale"; readonly path: string }
  | { readonly at: "local-kept"; readonly path: string; readonly failure: Failure }
  | { readonly at: "unsupported"; readonly path: string }

export const resolve = async (
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
): Promise<Result<void, ResolutionFailure>> => {
  if (choice.take === "later") return Ok(undefined)
  if (snapshot.role === "unknown") return Err({ at: "unsupported", path: snapshot.path })
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token: key, open, remote } = reach.value
  if (open.bookId !== snapshot.bookId) return Err({ at: "stale", path: snapshot.path })
  const localText = open.source.files[snapshot.path]
  const agreement = await agreedOn(open.bookId, snapshot.path)
  const repoPath = agreement?.repoPath ?? `${directoryOf(remote.path)}${snapshot.path}`
  const isBinary = [snapshot.base, snapshot.local, snapshot.destination]
    .some((version) => version.content?.kind === "binary")
  if (isBinary) return resolveBinary(key, open, remote, repoPath, snapshot, choice, agreement)
  const fetched = await fetchFile(key, where(remote, repoPath))
  if (!fetched.ok && fetched.error.kind !== "no-such-file") return Err({ at: "github", failure: fetched.error })
  const destination = fetched.ok
    ? { content: { kind: "text" as const, text: fetched.value.text }, identity: fetched.value.sha }
    : {}
  const base = agreement === undefined ? {} : {
    content: { kind: "text" as const, text: agreement.baseText },
    identity: agreement.sha,
  }
  const local = localText === undefined ? {} : { content: { kind: "text" as const, text: localText } }
  const current = captureFile({
    bookId: open.bookId,
    path: snapshot.path,
    role: snapshot.role,
    base,
    local,
    destination,
    cause: agreement === undefined ? "missing-base" : "diverged",
    capturedAt: Date.now(),
  })
  if (!sameVersions(snapshot, current)) return Err({ at: "stale", path: snapshot.path })

  if (choice.take === "local" && localText === undefined) {
    if (fetched.ok) {
      const removed = await deleteFile(key, where(remote, repoPath), fetched.value.sha, `Delete ${repoPath}`)
      if (!removed.ok) return Err({ at: "github", failure: removed.error })
    }
    await forgetAgreement(open.bookId, snapshot.path)
    return Ok(undefined)
  }

  if (choice.take === "destination" && !fetched.ok) {
    if (localText !== undefined) {
      const removed = await removeFile(snapshot.path)
      if (!removed.ok) return Err({ at: "hledger", trouble: removed.error })
    }
    await forgetAgreement(open.bookId, snapshot.path)
    return Ok(undefined)
  }

  const resultText = choiceText(snapshot, choice)
  if (resultText === undefined) return Err({ at: "unsupported", path: snapshot.path })
  if (choice.take === "destination") {
    if (!fetched.ok) return Err({ at: "unsupported", path: snapshot.path })
    const adopted = localText === undefined
      ? await restoreFile(snapshot.path, resultText)
      : await rewriteFile(snapshot.path, resultText)
    if (!adopted.ok) return Err({ at: "hledger", trouble: adopted.error })
    await agree(open.bookId, { path: snapshot.path, repoPath, sha: fetched.value.sha, baseText: resultText, at: Date.now() })
    return Ok(undefined)
  }

  const manual = choice.take === "manual"
  const adopted = manual
    ? localText === undefined ? await restoreFile(snapshot.path, resultText) : await rewriteFile(snapshot.path, resultText)
    : undefined
  if (adopted !== undefined && !adopted.ok) return Err({ at: "hledger", trouble: adopted.error })
  const written = await putFile(key, where(remote, repoPath), resultText, fetched.ok ? fetched.value.sha : undefined, `Resolve ${repoPath}`)
  if (!written.ok) return manual
    ? Err({ at: "local-kept", path: snapshot.path, failure: written.error })
    : Err({ at: "github", failure: written.error })
  await agree(open.bookId, { path: snapshot.path, repoPath, sha: written.value.sha, baseText: resultText, at: Date.now() })
  return Ok(undefined)
}

export const exportUnknown = async (snapshot: FileSnapshot): Promise<Result<Blob, ResolutionFailure>> => {
  if (snapshot.role !== "unknown" || snapshot.destination.content?.kind !== "binary") {
    return Err({ at: "unsupported", path: snapshot.path })
  }
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token: key, open, remote } = reach.value
  if (open.bookId !== snapshot.bookId) return Err({ at: "stale", path: snapshot.path })
  const agreement = await agreedOn(open.bookId, snapshot.path)
  const repoPath = agreement?.repoPath ?? `${directoryOf(remote.path)}${snapshot.path}`
  const fetched = await fetchBinary(key, where(remote, repoPath))
  if (!fetched.ok) return fetched.error.kind === "no-such-file"
    ? Err({ at: "stale", path: snapshot.path })
    : Err({ at: "github", failure: fetched.error })
  const current = await binaryVersion(fetched.value.blob, fetched.value.sha)
  if (!current.ok) return Err({ at: "github", failure: current.error })
  const captured = snapshot.destination.content
  const now = current.value.content
  return captured?.kind === "binary" && now?.kind === "binary" &&
    snapshot.destination.identity === fetched.value.sha && captured.size === now.size &&
    captured.fingerprint !== undefined && captured.fingerprint === now.fingerprint
    ? Ok(fetched.value.blob)
    : Err({ at: "stale", path: snapshot.path })
}

const resolveBinary = async (
  key: string,
  open: OpenJournal,
  remote: GitHubRemote,
  repoPath: string,
  snapshot: FileSnapshot,
  choice: ResolutionChoice,
  agreement: Agreed | undefined,
): Promise<Result<void, ResolutionFailure>> => {
  if (choice.take === "manual") return Err({ at: "unsupported", path: snapshot.path })
  const [storedBlob, fetched] = await Promise.all([
    attachmentOf(open.bookId, snapshot.path),
    fetchBinary(key, where(remote, repoPath)),
  ])
  if (!fetched.ok && fetched.error.kind !== "no-such-file") return Err({ at: "github", failure: fetched.error })
  const declaredLocally = open.source.attachments.some(({ path }) => path === snapshot.path)
  const localBlob = storedBlob ?? (declaredLocally && fetched.ok ? fetched.value.blob : undefined)
  const local: Result<CapturedVersion, Failure> = localBlob === undefined ? Ok({}) : await binaryVersion(localBlob)
  if (!local.ok) return Err({ at: "github", failure: local.error })
  const destination: Result<CapturedVersion, Failure> = fetched.ok ? await binaryVersion(fetched.value.blob, fetched.value.sha) : Ok({})
  if (!destination.ok) return Err({ at: "github", failure: destination.error })
  const base = agreement?.baseBinary === undefined ? {} : {
    content: { kind: "binary" as const, ...agreement.baseBinary },
    identity: agreement.sha,
  }
  const current = captureFile({
    bookId: open.bookId,
    path: snapshot.path,
    role: snapshot.role,
    base,
    local: local.value,
    destination: destination.value,
    cause: agreement === undefined ? "missing-base" : "diverged",
    capturedAt: Date.now(),
  })
  if (!sameVersions(snapshot, current)) return Err({ at: "stale", path: snapshot.path })

  if (choice.take === "local") {
    if (localBlob === undefined) {
      if (open.source.attachments.some(({ path }) => path === snapshot.path)) {
        return Err({ at: "unsupported", path: snapshot.path })
      }
      if (fetched.ok) {
        const removed = await deleteFile(key, where(remote, repoPath), fetched.value.sha, `Delete ${repoPath}`)
        if (!removed.ok) return Err({ at: "github", failure: removed.error })
      }
      await forgetAgreement(open.bookId, snapshot.path)
      return Ok(undefined)
    }
    const saved = await putBinary(key, where(remote, repoPath), localBlob, fetched.ok ? fetched.value.sha : undefined, `Resolve ${repoPath}`)
    if (!saved.ok) return Err({ at: "github", failure: saved.error })
    if (local.value.content?.kind !== "binary" || local.value.content.fingerprint === undefined) {
      return Err({ at: "unsupported", path: snapshot.path })
    }
    await agree(open.bookId, {
      path: snapshot.path,
      repoPath,
      sha: saved.value,
      baseText: "",
      baseBinary: { size: local.value.content.size, fingerprint: local.value.content.fingerprint },
      at: Date.now(),
    })
    return Ok(undefined)
  }

  if (!fetched.ok) {
    if (open.source.attachments.some(({ path }) => path === snapshot.path)) {
      const removed = await removeAttachment(snapshot.path)
      if (!removed.ok) return Err({ at: "hledger", trouble: removed.error })
    }
    await forgetAgreement(open.bookId, snapshot.path)
    return Ok(undefined)
  }

  const blob = new Blob([fetched.value.blob], { type: mimeOf(snapshot.path) })
  const adopted = await replaceAttachment(snapshot.path, blob)
  if (!adopted.ok) return Err({ at: "hledger", trouble: adopted.error })
  if (destination.value.content?.kind !== "binary" || destination.value.content.fingerprint === undefined) {
    return Err({ at: "unsupported", path: snapshot.path })
  }
  await agree(open.bookId, {
    path: snapshot.path,
    repoPath,
    sha: fetched.value.sha,
    baseText: "",
    baseBinary: { size: destination.value.content.size, fingerprint: destination.value.content.fingerprint },
    at: Date.now(),
  })
  return Ok(undefined)
}

/**
 * The files GitHub has moved on from since they were last agreed here — sent
 * from another device, or edited on GitHub — which taking would bring.
 *
 * Asked of the files agreed on and no others, by the blob each was agreed at,
 * so it is a question with an exact answer rather than a guess from dates. A
 * file gone from the repository has moved too. Reads only.
 */
export const behind = async (): Promise<Result<readonly string[], Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token: key, open } = reach.value
  const remote = reach.value.remote
  const agreed = await agreementsFor(open.bookId)
  const managedLatest = [
    ...Object.values(open.source.files).flatMap(companionsIn).filter(isHledgerLatestPath),
    ...hledgerLatestPaths(Object.keys(open.source.files)),
  ]
  const asked = await Promise.all(
    agreed.filter(({ path }) => !isHiddenPath(path, managedLatest)).map(async (one) => ({ one, now: await fetchFile(key, where(remote, one.repoPath)) })),
  )

  const unanswered = asked.flatMap(({ now }) => (!now.ok && now.error.kind !== "no-such-file" ? [now.error] : []))
  const [failure] = unanswered
  if (failure !== undefined) return Err({ at: "github", failure })

  return Ok(asked.filter(({ one, now }) => {
    const localExists = open.source.files[one.path] !== undefined
    return localExists ? !now.ok || now.value.sha !== one.sha : now.ok
  }).map(({ one }) => one.path))
}

/**
 * Send whatever has changed here.
 *
 * `message` is what each commit is called; left out, each is named after the
 * file it writes, which is what every push said before anyone could say more.
 */
export const push = async (message?: string): Promise<Result<Outcome, Snag>> => {
  const reach = await reachable()
  if (!reach.ok) return reach
  const { token: key, open } = reach.value
  const remote = reach.value.remote

  const changed = await changedFiles(open.bookId, open.source.files)
  const tree = await repositoryFiles(key, { owner: remote.owner, repo: remote.repo }, remote.branch || "HEAD")
  if (!tree.ok) return Err({ at: "github", failure: tree.error })
  const attachments = await pushAttachments(key, remote, open, tree.value, message)
  if (!attachments.ok) return attachments.error.at === "partial"
    ? Err({ ...attachments.error, remaining: [...attachments.error.remaining, ...changed.map(({ path }) => path)] })
    : attachments
  if (changed.length === 0 && attachments.value.length === 0) return Ok({ did: "nothing" })
  return sendChanged(key, open.bookId, remote, changed, attachments.value, message)
}

const pushAttachments = async (
  key: string,
  remote: GitHubRemote,
  open: OpenJournal,
  tree: readonly string[],
  message: string | undefined,
): Promise<Result<readonly string[], Snag>> => {
  const directory = directoryOf(remote.path)
  const pending = open.source.attachments.filter(({ path }) => !isHiddenPath(path) && !tree.includes(`${directory}${path}`))
  const sendNext = async (
    remaining: typeof pending,
    written: readonly string[],
  ): Promise<Result<readonly string[], Snag>> => {
    const [attachment, ...later] = remaining
    if (attachment === undefined) return Ok(written)
    const repoPath = `${directory}${attachment.path}`
    const blob = await loadAttachment(open.bookId, attachment.path)
    if (blob === undefined) {
      const cause: Cause = { at: "github", failure: { kind: "refused", status: 0, detail: `Missing companion ${attachment.path}` } }
      return Err(afterPartial(written, remaining.map(({ path }) => path), cause))
    }
    const saved = await putBinary(key, where(remote, repoPath), blob, undefined, message ?? `Add ${repoPath}`)
    if (!saved.ok) return Err(afterPartial(written, remaining.map(({ path }) => path), { at: "github", failure: saved.error }))
    return sendNext(later, [...written, attachment.path])
  }
  return sendNext(pending, [])
}

const afterPartial = (written: readonly string[], remaining: readonly string[], cause: Cause): Snag =>
  written.length === 0 ? cause : { at: "partial", written, remaining, cause }

const sendChanged = async (
  key: string,
  book: string,
  remote: GitHubRemote,
  changed: readonly { readonly path: string; readonly text: string; readonly agreed: Agreed | undefined }[],
  attachments: readonly string[],
  message: string | undefined,
  sent: readonly string[] = attachments,
): Promise<Result<Outcome, Snag>> => {
  const [file, ...later] = changed
  if (file === undefined) return Ok({ did: "pushed", files: sent.length })
  const result = await send(key, book, remote, file.path, file.text, file.agreed, message)
  if (!result.ok) return Err(afterPartial(sent, changed.map(({ path }) => path), result.error))
  return sendChanged(key, book, remote, later, attachments, message, [...sent, file.path])
}

/**
 * Write one file, and settle the refusal if there is one.
 *
 * Files sent one at a time rather than all at once: each is a commit of its own,
 * and stopping at the first refusal leaves a state that can be described.
 */
const send = async (
  key: string,
  book: string,
  remote: GitHubRemote,
  path: string,
  text: string,
  agreed: Agreed | undefined,
  message: string | undefined,
): Promise<Result<"pushed", Cause>> => {
  const repoPath = agreed?.repoPath ?? `${directoryOf(remote.path)}${path}`
  const written = await putFile(key, where(remote, repoPath), text, agreed?.sha, message ?? `Update ${repoPath}`)
  if (written.ok) {
    await agree(book, { path, repoPath, sha: written.value.sha, baseText: text, at: Date.now() })
    return Ok("pushed")
  }
  if (written.error.kind !== "conflict") return Err({ at: "github", failure: written.error })
  return settle(key, book, remote, path, text, repoPath, agreed)
}

/**
 * The repository has moved on. Lay what was added here after what was added
 * there, if that is honestly all that happened.
 *
 * It is only honest when both texts still begin with the text the two sides last
 * agreed on: then each side has appended and nothing has been rewritten, which
 * is what a journal mostly gets. Anything else is a divergence, and saying so is
 * better than picking a winner.
 *
 * The merged text goes through hledger before it is sent, so a merge that does
 * not read is not something the repository ever sees.
 */
const settle = async (
  key: string,
  book: string,
  remote: GitHubRemote,
  path: string,
  text: string,
  repoPath: string,
  agreed: Agreed | undefined,
): Promise<Result<never, Cause>> => {
  const theirs = await fetchFile(key, where(remote, repoPath))
  if (!theirs.ok && theirs.error.kind !== "no-such-file") return Err({ at: "github", failure: theirs.error })
  const snapshot = captureFile({
    bookId: book,
    path,
    base: agreed === undefined ? {} : {
      content: { kind: "text", text: agreed.baseText },
      identity: agreed.sha,
    },
    local: { content: { kind: "text", text } },
    destination: theirs.ok
      ? { content: { kind: "text", text: theirs.value.text }, identity: theirs.value.sha }
      : {},
    cause: agreed === undefined ? "missing-base" : "diverged",
    capturedAt: Date.now(),
  })
  const proposal = appendMergeProposal(snapshot)
  return Err({ at: "diverged", path, snapshot, ...(proposal === undefined ? {} : { proposal }) })
}

import { For, Show, createResource, createSignal, onMount, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TextField, TextFieldInput, TextFieldLabel } from "~/core/components/ui/text-field"
import { TroubleNote } from "~/core/components/trouble-note"
import { accessToken, behind as checkBehind, clientId, clientIdNow, forgetSession, getFileContent, getFileMetadata, keepClientId, listFilesInFolder, listSharedWithMe, listStarred, loadIdentity, pull, pullAsNewBook, push, unsent as listUnsent, type DriveFile, type Failure, type Outcome, type Snag } from "~/core/google-drive/index"
import { journal, setRemote as setBookRemote } from "~/core/journal/store"
import { putDown } from "~/core/journal/switching"
import type { GoogleDriveRemote } from "~/core/journal/remote"
import { Err, Ok, getOrUndefined, type Result } from "~/core/lib/monad"
import { includedBy } from "~/core/journal/layout"
import { t } from "~/core/i18n"
import { noteDriveChecked } from "~/core/google-drive/kept"

const SHARED_ROOT = "shared-with-me"
const STARRED_ROOT = "starred"
const NOWHERE: GoogleDriveRemote = { provider: "google-drive", folderId: "", folderName: "", path: "" }

export type GoogleDriveBound =
  | { readonly into: "this-book" }
  | { readonly into: "new-book"; readonly taken?: () => void }

export function GoogleDrivePanel(props: { readonly bound: GoogleDriveBound }): JSX.Element {
  const [savedClientId, { refetch }] = createResource(clientId)
  const [identityUnavailable, setIdentityUnavailable] = createSignal(false)
  const [typedClientId, setTypedClientId] = createSignal<string | undefined>()
  const [folderId, setFolderId] = createSignal<string | undefined>()
  const [folderName, setFolderName] = createSignal<string | undefined>()
  const [path, setPath] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [said, setSaid] = createSignal<string | undefined>()
  const [snag, setSnag] = createSignal<Snag | undefined>()
  const [behindFiles, setBehindFiles] = createSignal<readonly string[] | undefined>()
  const [folderBrowserOpen, setFolderBrowserOpen] = createSignal(false)
  const [folderTrail, setFolderTrail] = createSignal<readonly { readonly id: string; readonly name: string }[]>([])
  const [folders, setFolders] = createSignal<readonly DriveFile[]>([])
  const [journalFiles, setJournalFiles] = createSignal<readonly DriveFile[]>([])
  const [driveToken, setDriveToken] = createSignal<string | undefined>()

  const ensureIdentity = async (): Promise<boolean> => {
    const result = await loadIdentity()
    setIdentityUnavailable(!result.ok)
    return result.ok
  }

  onMount(() => {
    void ensureIdentity()
  })

  const forNewBook = (): boolean => props.bound.into === "new-book"
  const [waiting, { refetch: refetchWaiting }] = createResource(
    () => {
      const open = getOrUndefined(journal())
      return !forNewBook() && open?.remote?.provider === "google-drive" ? open : undefined
    },
    (open) => listUnsent(open),
  )
  const existing = (): GoogleDriveRemote | undefined => {
    const remote = getOrUndefined(journal())?.remote
    return remote?.provider === "google-drive" ? remote : undefined
  }
  const place = (): GoogleDriveRemote => ({
    ...NOWHERE,
    ...existing(),
    folderId: folderId() ?? existing()?.folderId ?? "",
    folderName: folderName() ?? existing()?.folderName ?? "",
    path: path() ?? existing()?.path ?? "",
  })
  const id = (): string => (typedClientId() ?? savedClientId() ?? clientIdNow()).trim()
  const valid = (): boolean => id() !== "" && place().folderId !== "" && place().path !== ""
  const loadDirectory = async (token: string, parentId: string): Promise<boolean> => {
    const result = parentId === SHARED_ROOT
      ? await listSharedWithMe(token)
      : parentId === STARRED_ROOT
        ? await listStarred(token)
        : await listFilesInFolder(token, parentId)
    if (!result.ok) {
      if (result.error.kind === "unauthorised") forgetSession()
      setSnag({ at: "drive", failure: result.error })
      return false
    }
    setFolders(result.value.filter((file) => file.mimeType === "application/vnd.google-apps.folder"))
    setJournalFiles(result.value.filter(isJournalFile))
    return true
  }
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setSaid(undefined)
    setSnag(undefined)
    await work()
    setBusy(false)
  }
  const report = (result: { readonly ok: true; readonly value: Outcome } | { readonly ok: false; readonly error: Snag }): void => {
    if (!result.ok) {
      if (result.error.at === "drive" && result.error.failure.kind === "unauthorised") forgetSession()
      if (!forNewBook() && (result.error.at === "conflict" || result.error.at === "local-changes")) {
        setSaid(t("syncResolution.providerUnavailable", { files: result.error.path }))
      } else setSnag(result.error)
    } else setSaid(outcomeWords(result.value))
  }
  const connect = (): Promise<void> => run(async () => {
    if (!(await ensureIdentity())) return
    const token = await accessToken(id())
    if (!token.ok) {
      setSnag({ at: "not-connected" })
      return
    }
    await keepClientId(id())
    noteDriveChecked()
    if (!forNewBook()) {
      await setBookRemote(place())
      setSaid(t("gdrive.connected"))
    } else {
      setSaid(t("gdrive.connected"))
    }
    await refetch()
    setTypedClientId(undefined)
  })
  const chooseJournal = (): Promise<void> => run(async () => {
    if (!(await ensureIdentity())) return
    const token = await accessToken(id())
    if (!token.ok) {
      setSnag({ at: "not-connected" })
      return
    }
    await keepClientId(id())
    setDriveToken(token.value)
    setFolderTrail([{ id: "root", name: t("gdrive.myDrive") }])
    setFolderBrowserOpen(true)
    await loadDirectory(token.value, "root")
    await refetch()
  })
  const changeLocation = (id: string, name: string): Promise<void> => run(async () => {
    const token = driveToken()
    if (token === undefined) return
    if (await loadDirectory(token, id)) setFolderTrail([{ id, name }])
  })
  const enterFolder = (folder: DriveFile): Promise<void> => run(async () => {
    const token = driveToken()
    if (token === undefined) {
      setSnag({ at: "not-connected" })
      return
    }
    if (await loadDirectory(token, folder.id)) setFolderTrail([...folderTrail(), { id: folder.id, name: folder.name }])
  })
  const goToFolder = (index: number): Promise<void> => run(async () => {
    const selected = folderTrail()[index]
    const token = driveToken()
    if (selected === undefined || token === undefined) return
    if (await loadDirectory(token, selected.id)) setFolderTrail(folderTrail().slice(0, index + 1))
  })
  const setJournalTarget = async (
    file: DriveFile,
    trail: readonly { readonly id: string; readonly name: string }[],
    token: string,
  ): Promise<boolean> => {
    const current = trail.at(-1)
    if (current === undefined) return false
    if (current.id === SHARED_ROOT || current.id === STARRED_ROOT) {
      const parentId = file.parents?.[0]
      if (parentId === undefined) {
        setSaid(t("gdrive.sharedFileNoParent"))
        return false
      }
      const parent = await getFileMetadata(token, parentId)
      if (!parent.ok) {
        if (parent.error.kind === "unauthorised") forgetSession()
        setSnag({ at: "drive", failure: parent.error })
        return false
      }
      setFolderId(parent.value.id)
      setFolderName(parent.value.name)
    } else {
      setFolderId(current.id)
      setFolderName(current.name)
    }
    setPath(file.name)
    setFolderBrowserOpen(false)
    return true
  }
  const takeAsNewBook = async (): Promise<void> => {
    const bound = props.bound
    if (bound.into !== "new-book") return
    putDown()
    const result = await pullAsNewBook(place())
    report(result)
    if (result.ok) bound.taken?.()
  }
  const selectJournal = (file: DriveFile): Promise<void> => run(async () => {
    const token = driveToken()
    if (token === undefined) {
      setSnag({ at: "not-connected" })
      return
    }
    if (!(await setJournalTarget(file, folderTrail(), token))) return
    await takeAsNewBook()
  })
  const selectFolder = (): Promise<void> => run(async () => {
    const token = driveToken()
    const folder = folderTrail().at(-1)
    if (token === undefined || folder === undefined || folder.id === SHARED_ROOT || folder.id === STARRED_ROOT) return
    const files = await filesBelow(token, folder.id)
    if (!files.ok) {
      if (files.error.kind === "unauthorised") forgetSession()
      setSnag({ at: "drive", failure: files.error })
      return
    }
    const journals = files.value.filter(({ path }) => /\.(journal|hledger|ledger)$/i.test(path))
    const contents = await Promise.all(journals.map(async ({ path, file }) => {
      const body = await getFileContent(token, file.id)
      return body.ok ? Ok({ path, text: body.value }) : Err(body.error)
    }))
    const failed = contents.find((content) => !content.ok)
    if (failed !== undefined && !failed.ok) {
      if (failed.error.kind === "unauthorised") forgetSession()
      setSnag({ at: "drive", failure: failed.error })
      return
    }
    const readable = contents.flatMap((content) => content.ok ? [content.value] : [])
    const included = new Set(readable.flatMap(({ text }) => includedBy(text)))
    const entry = readable.find(({ path }) => !included.has(path)) ?? readable[0]
    if (entry === undefined) {
      setSaid(t("gdrive.noJournalFiles"))
      return
    }
    setFolderId(folder.id)
    setFolderName(folder.name)
    setPath(entry.path)
    setFolderBrowserOpen(false)
    await takeAsNewBook()
  })
  const take = (): Promise<void> => run(async () => {
    await setBookRemote(place())
    report(await pull())
  })
  const recoverRemote = (): Promise<void> => run(async () => {
    putDown()
    setBehindFiles(undefined)
    report(await pullAsNewBook(place()))
  })
  const send = (): Promise<void> => run(async () => {
    report(await push())
    await refetchWaiting()
  })
  const checkRemote = (): Promise<void> => run(async () => {
    const result = await checkBehind()
    if (!result.ok) setSnag(result.error)
    else {
      noteDriveChecked()
      setBehindFiles(result.value)
    }
  })
  const disconnect = (): Promise<void> => run(async () => {
    forgetSession()
    setSaid(t("gdrive.disconnected"))
  })

  return (
    <form class="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (!busy()) void connect() }}>
      <h2 class="text-sm font-medium">{t("gdrive.title")}</h2>
      <p class="text-xs text-muted-foreground">{t("gdrive.lead")}</p>
      <Show when={identityUnavailable()}><p role="alert" class="text-xs text-error-foreground">{t("gdrive.oauthUnavailable")}</p></Show>
      <Show when={!forNewBook()}>
        <Field label={t("gdrive.clientId")} value={id()} onChange={setTypedClientId} />
        <p class="text-xs text-muted-foreground">{t("gdrive.clientIdHint")}</p>
        <p class="text-xs text-muted-foreground">{t("gdrive.targetJournal")}: {valid() ? `${place().folderName}/${place().path}` : t("gdrive.noTarget")}</p>
        <p class="text-xs text-muted-foreground">{t("gdrive.folderHelp")}</p>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Show when={forNewBook()} fallback={
          <>
            <Button type="submit" size="sm" disabled={busy()}>{t("gdrive.connect")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy()} onClick={() => folderBrowserOpen() ? setFolderBrowserOpen(false) : void chooseJournal()}>{folderBrowserOpen() ? t("gdrive.closePicker") : t("gdrive.pickJournal")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={!valid() || busy() || waiting.loading || (waiting() ?? []).length > 0} onClick={() => void take()}>{t("gdrive.pull")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={!valid() || busy() || waiting.loading || (waiting() ?? []).length === 0} onClick={() => void send()}>{t("gdrive.push")}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy()} onClick={() => void checkRemote()}>{t("gdrive.check")}</Button>
            <Show when={savedClientId() !== undefined}>
              <Button type="button" variant="ghost" size="sm" disabled={busy()} onClick={() => void disconnect()}>{t("gdrive.disconnect")}</Button>
            </Show>
          </>
        }>
          <Button type="button" size="sm" disabled={busy()} onClick={() => folderBrowserOpen() ? setFolderBrowserOpen(false) : void chooseJournal()}>
            {folderBrowserOpen() ? t("gdrive.closePicker") : t("books.fromGoogleDrive")}
          </Button>
        </Show>
      </div>
      <Show when={folderBrowserOpen()}>
        <section class="flex flex-col gap-2 rounded-md border p-2" aria-label={t("gdrive.pickJournal")}>
          <div class="flex flex-wrap gap-1">
            <Button type="button" variant="outline" size="sm" disabled={busy()} onClick={() => void changeLocation("root", t("gdrive.myDrive"))}>{t("gdrive.myDrive")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy()} onClick={() => void changeLocation(SHARED_ROOT, t("gdrive.sharedWithMe"))}>{t("gdrive.sharedWithMe")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy()} onClick={() => void changeLocation(STARRED_ROOT, t("gdrive.favorites"))}>{t("gdrive.favorites")}</Button>
          </div>
          <nav class="flex flex-wrap gap-1" aria-label={t("gdrive.browseLocation")}>
            <For each={folderTrail()}>{(folder, index) => <Button type="button" variant="ghost" size="sm" disabled={busy() || index() === folderTrail().length - 1} onClick={() => void goToFolder(index())}>{folder.name}</Button>}</For>
          </nav>
          <Button type="button" variant="outline" size="sm" disabled={busy() || folderTrail().at(-1)?.id === SHARED_ROOT || folderTrail().at(-1)?.id === STARRED_ROOT} onClick={() => void selectFolder()}>{t("gdrive.useFolder")}</Button>
          <Show when={folders().length > 0}>
            <ul class="flex flex-col gap-1">
              <For each={folders()}>{(folder) => <li><Button type="button" variant="ghost" size="sm" disabled={busy()} onClick={() => void enterFolder(folder)}>{folder.name}/</Button></li>}</For>
            </ul>
          </Show>
          <Show when={journalFiles().length > 0} fallback={<p class="text-xs text-muted-foreground">{t("gdrive.noJournalFiles")}</p>}>
            <ul class="flex flex-col gap-1">
              <For each={journalFiles()}>{(file) => <li><Button type="button" variant="outline" size="sm" disabled={busy()} onClick={() => void selectJournal(file)}>{file.name}</Button></li>}</For>
            </ul>
          </Show>
        </section>
      </Show>
      <Show when={!forNewBook()}>
        <p class="text-xs text-muted-foreground">{t("gdrive.revisions")}</p>
        <Show when={(waiting() ?? []).length > 0} fallback={<p class="text-xs text-muted-foreground">{t("gdrive.noChanges")}</p>}>
          <ul class="flex flex-col gap-1 text-xs">
            <For each={waiting()}>{(file) => <li class="font-mono text-muted-foreground">{file.path}</li>}</For>
          </ul>
        </Show>
        <Show when={(behindFiles() ?? []).length > 0}>
          <p class="text-xs text-foreground">{t("gdrive.behind", { files: (behindFiles() ?? []).join(", ") })}</p>
        </Show>
        <Show when={(waiting() ?? []).length > 0}>
          <p class="text-xs text-muted-foreground">{t("gdrive.pullAfterPush")}</p>
        </Show>
        <Show when={(behindFiles() ?? []).length > 0 || snag()?.at === "conflict" || snag()?.at === "local-changes"}>
          <div class="flex flex-col gap-1">
            <Button type="button" variant="outline" size="sm" disabled={!valid() || busy()} onClick={() => void recoverRemote()}>{t("gdrive.recoverRemote")}</Button>
            <p class="text-xs text-muted-foreground">{t("gdrive.recoverRemoteHelp")}</p>
          </div>
        </Show>
      </Show>
      <Show when={busy()}><p class="text-xs text-muted-foreground">{t("gdrive.working")}</p></Show>
      <Show when={said()}>{(words) => <p class="text-xs text-muted-foreground">{words()}</p>}</Show>
      <Show when={snag()}>{(cause) => <DriveSnag snag={cause()} />}</Show>
    </form>
  )
}

interface DriveLocatedFile {
  readonly path: string
  readonly file: DriveFile
}

const filesBelow = async (
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
    if (file.mimeType !== "application/vnd.google-apps.folder") return Ok([{ path, file }])
    return filesBelow(token, file.id, path, nextVisited)
  }))
  const failed = branches.find((branch) => !branch.ok)
  if (failed !== undefined && !failed.ok) return Err(failed.error)
  return Ok(branches.flatMap((branch) => branch.ok ? branch.value : []))
}

const isJournalFile = (file: DriveFile): boolean =>
  file.mimeType !== "application/vnd.google-apps.folder" &&
  (file.mimeType.startsWith("text/") || /\.(journal|hledger|ledger|txt)$/i.test(file.name))

function Field(props: { readonly label: string; readonly value: string; readonly placeholder?: string; readonly onChange: (value: string) => void }): JSX.Element {
  return (
    <TextField class="flex flex-col gap-1">
      <TextFieldLabel class="text-xs font-medium text-muted-foreground">{props.label}</TextFieldLabel>
      <TextFieldInput
        class="h-8 text-sm"
        autocomplete="off"
        spellcheck={false}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
    </TextField>
  )
}

const outcomeWords = (outcome: Outcome): string => {
  switch (outcome.did) {
    case "pulled": return t("gdrive.pulled", { files: outcome.files })
    case "pushed": return t("gdrive.pushed", { files: outcome.files })
    case "nothing": return t("gdrive.nothing")
  }
}

export function DriveSnag(props: { readonly snag: Snag }): JSX.Element {
  return (
    <Show when={props.snag.at === "hledger" ? props.snag.trouble : undefined} fallback={<p class="text-xs text-error-foreground">{snagWords(props.snag)}</p>}>
      {(trouble) => <TroubleNote trouble={trouble()} />}
    </Show>
  )
}

const snagWords = (snag: Snag): string => {
  switch (snag.at) {
    case "not-connected": return t("gdrive.notConnected")
    case "no-place": return t("gdrive.noPlace")
    case "no-journal": return t("report.needsJournal")
    case "conflict": return t("gdrive.conflict", { path: snag.path })
    case "local-changes": return t("gdrive.localChanges", { path: snag.path })
    case "hledger": return ""
    case "drive":
      switch (snag.failure.kind) {
        case "offline": return t("gdrive.offline")
        case "unauthorised": return t("gdrive.unauthorised")
        case "no-such-file": return t("gdrive.noSuchFile")
        case "conflict": return t("gdrive.conflict", { path: "" })
        case "protected-revision": return t("gdrive.revisionProtected")
        case "refused": return t("gdrive.refused", { status: snag.failure.status })
      }
  }
}

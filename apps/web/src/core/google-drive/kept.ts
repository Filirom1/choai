import { createSignal, type Accessor } from "solid-js"

import { STORE, within } from "~/core/lib/idb"
import type { DriveFile } from "./api"

const REMOTE = STORE.remote
const CLIENT_ID = "gdrive:client-id"
const DEFAULT_CLIENT_ID = "869320600994-2l2ahavcrd0tcm50qh3kummla72baiqp.apps.googleusercontent.com"
const [rememberedClientId, rememberClientId] = createSignal<string | undefined>()
const [agreements, changedAgreements] = createSignal(0)
const [checks, changedChecks] = createSignal(0)

/** A revision for screens that need to re-read Drive agreements held in IndexedDB. */
export const agreementRevision: Accessor<number> = agreements
export const checkRevision: Accessor<number> = checks

export const noteDriveChecked = (): void => {
  changedChecks((revision) => revision + 1)
}

interface Row {
  readonly id: string
  readonly clientId?: string
  readonly agreement?: DriveAgreement
}

export interface DriveAgreement {
  readonly path: string
  readonly fileId: string
  readonly md5Checksum?: string
  readonly version?: string
  readonly modifiedTime?: string
  readonly size?: string
  readonly headRevisionId?: string
  readonly baseText: string
  readonly baseBinary?: { readonly size: number; readonly fingerprint: string }
}

export interface DriveRecovery {
  readonly bookId: string
  readonly path: string
  readonly fileId: string
  readonly revisionId: string
  readonly keptAt: number
}

export const keepDriveRecovery = async (recovery: DriveRecovery): Promise<boolean> => {
  try {
    await within("readwrite", [REMOTE], (transaction) => {
      transaction.objectStore(REMOTE).put({ id: `gdrive:recovery:${recovery.bookId}:${recovery.path}:${recovery.revisionId}`, recovery })
    })
    return true
  } catch {
    return false
  }
}

const agreementKey = (book: string, path: string): string => `gdrive:agreed:${book}:${path}`

export const clientId = async (): Promise<string | undefined> => {
  const row = await within("readonly", [REMOTE], (transaction) =>
    transaction.objectStore(REMOTE).get(CLIENT_ID) as IDBRequest<Row | undefined>,
  )
  rememberClientId(row.result?.clientId)
  return rememberedClientId()
}

export const clientIdNow = (): string => rememberedClientId() ?? DEFAULT_CLIENT_ID

export const keepClientId = async (value: string): Promise<void> => {
  rememberClientId(value)
  await within("readwrite", [REMOTE], (transaction) => {
    transaction.objectStore(REMOTE).put({ id: CLIENT_ID, clientId: value })
  })
}

export const agreedOn = async (book: string, path: string): Promise<DriveAgreement | undefined> => {
  const row = await within("readonly", [REMOTE], (transaction) =>
    transaction.objectStore(REMOTE).get(agreementKey(book, path)) as IDBRequest<Row | undefined>,
  )
  return row.result?.agreement
}

export const agreementsFor = async (book: string): Promise<readonly DriveAgreement[]> => {
  const rows = await within("readonly", [REMOTE], (transaction) =>
    transaction.objectStore(REMOTE).getAll() as IDBRequest<Row[]>,
  )
  const prefix = `gdrive:agreed:${book}:`
  return (rows.result ?? []).flatMap((row) => row.id.startsWith(prefix) && row.agreement !== undefined ? [row.agreement] : [])
}

export const agree = async (book: string, agreement: DriveAgreement): Promise<void> => {
  await within("readwrite", [REMOTE], (transaction) => {
    transaction.objectStore(REMOTE).put({ id: agreementKey(book, agreement.path), agreement })
  })
  changedAgreements((revision) => revision + 1)
}

export const forgetAgreement = async (book: string, path: string): Promise<void> => {
  await within("readwrite", [REMOTE], (transaction) => {
    transaction.objectStore(REMOTE).delete(agreementKey(book, path))
  })
  changedAgreements((revision) => revision + 1)
}

export const changedFromAgreement = (remote: DriveFile, agreement: DriveAgreement): boolean => {
  if (remote.id !== agreement.fileId) return true
  if (agreement.md5Checksum !== undefined && remote.md5Checksum !== undefined) {
    return remote.md5Checksum !== agreement.md5Checksum
  }
  if (agreement.version !== undefined) return remote.version !== agreement.version
  return true
}

export const agreementOf = (
  path: string,
  file: DriveFile,
  baseText: string,
): DriveAgreement => ({
  path,
  fileId: file.id,
  md5Checksum: file.md5Checksum,
  version: file.version,
  modifiedTime: file.modifiedTime,
  size: file.size,
  headRevisionId: file.headRevisionId,
  baseText,
})

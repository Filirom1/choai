import { createSignal, type Accessor } from "solid-js"

import { STORE, within } from "~/core/lib/idb"
import type { DriveFile } from "./api"

const REMOTE = STORE.remote
const CLIENT_ID = "gdrive:client-id"
const [agreements, changedAgreements] = createSignal(0)

/** A revision for screens that need to re-read Drive agreements held in IndexedDB. */
export const agreementRevision: Accessor<number> = agreements

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
  readonly baseText: string
}

const agreementKey = (book: string, path: string): string => `gdrive:agreed:${book}:${path}`

export const clientId = async (): Promise<string | undefined> => {
  const row = await within("readonly", [REMOTE], (transaction) =>
    transaction.objectStore(REMOTE).get(CLIENT_ID) as IDBRequest<Row | undefined>,
  )
  return row.result?.clientId
}

export const keepClientId = async (value: string): Promise<void> => {
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

export const agree = async (book: string, agreement: DriveAgreement): Promise<void> => {
  await within("readwrite", [REMOTE], (transaction) => {
    transaction.objectStore(REMOTE).put({ id: agreementKey(book, agreement.path), agreement })
  })
  changedAgreements((revision) => revision + 1)
}

export const changedFromAgreement = (remote: DriveFile, agreement: DriveAgreement): boolean =>
  remote.id !== agreement.fileId ||
  (agreement.version === undefined && agreement.md5Checksum === undefined) ||
  (agreement.version !== undefined && remote.version !== agreement.version) ||
  (agreement.md5Checksum !== undefined && remote.md5Checksum !== agreement.md5Checksum)

export const agreementOf = (
  path: string,
  file: DriveFile,
  baseText: string,
): DriveAgreement => ({
  path,
  fileId: file.id,
  md5Checksum: file.md5Checksum,
  version: file.version,
  baseText,
})

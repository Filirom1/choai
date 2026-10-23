import { expect, test } from "bun:test"

import { captureFile } from "../src/core/sync/conflict"
import {
  noteRemoteChangePaths,
  noteRemoteChangeSnapshots,
  noteRemoteChangesUnavailable,
  remoteChangeFiles,
  remoteChangesNow,
} from "../src/core/sync/remote-changes"

test("remote paths are shown until detailed snapshots replace them", () => {
  const bookId = "book"
  const path = "transactions.journal"
  noteRemoteChangePaths(bookId, [path])
  expect(remoteChangeFiles(remoteChangesNow())).toEqual([{ path, isNew: false, status: "M" }])

  const snapshot = captureFile({
    bookId,
    path,
    role: "accounting",
    base: {},
    local: {},
    destination: { content: { kind: "text", text: "2026-10-23 New\n" } },
    cause: "missing-base",
    capturedAt: 1,
  })
  noteRemoteChangeSnapshots(bookId, [snapshot])
  noteRemoteChangesUnavailable(bookId)

  expect(remoteChangeFiles(remoteChangesNow())).toEqual([{ path, isNew: true, status: "A" }])
})

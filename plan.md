# Plan — Generic synchronization conflict resolution

## Goal

Let someone unfamiliar with Git understand and resolve differences between the open journal and its reference copy, whether that copy is on GitHub, Google Drive, or in a local folder. Show both versions and explain the differences. Never replace data silently. Decisions are made per file and applied only after explicit confirmation.

## Current implementation status

The provider-independent comparison model and GitHub, Google Drive, and local-folder resolution adapters are implemented in the working tree. Browser-level validation remains outstanding.

In this session:

- `cd apps/web && bunx tsc -b` passes.
- The full unit suite passes, including mocked adapter coverage for GitHub, Drive, local-folder resolution, and resolution-session persistence. The pre-existing local-folder safety tests cover partial-write baselines and retry.
- The journal-writer boundary now explicitly names `core/journal/local-resolution.ts` as a confirmed resolution writer.
- A GitHub stale-revalidation bug was fixed: recaptured snapshots retain the file role. Unknown remote file types are kept out of hledger text handling.
- Playwright could not launch because the installed Chromium headless executable is missing. GitHub, Drive, and local-folder browser scenarios are documented in `apps/web/e2e/SYNC-RESOLUTION.md` and remain unverified; they are the remaining work.
- The pre-existing uncommitted work has been preserved.

## Delivery status and guarantees

1. **GitHub** supports per-file comparison, local/destination/manual choices, hledger preview, separate confirmation, SHA revalidation, partial-push reporting, and session persistence. Mocked adapter coverage is in place; browser validation remains.
2. **Google Drive** and **local folders** now use the shared comparison panel and snapshot/session model. Provider panels and global sync actions inspect conflicts before taking either side.
3. Drive's and local-folder's different write guarantees remain explicit; neither adapter claims multi-file atomicity.

### Drive guarantees

Drive v3 does not provide a usable conditional write for this workflow. Best-effort application is acceptable only if each file's metadata (`md5Checksum`, `version`, `modifiedTime`) is reread immediately before its PATCH and compared with the reviewed snapshot. A mismatch skips that file and returns it to conflict. After PATCH, reread metadata and verify the written checksum; otherwise report the file's state as uncertain. Use the Drive revision history for recovery: pin the replaced revision when possible, or retain its revision ID. Before confirmation, warn that a simultaneous late edit can still be replaced and explain how to recover the old revision. If the pre-write reread fails, do not write.

### Local-folder guarantees

Ask for or revalidate `readwrite` permission in the user's confirmation gesture. Immediately before each write, reread the file and compare `lastModified`, size, and content/hash to the reviewed version. If it differs, skip it and return it to conflict. Write one file at a time with `createWritable()` and `close()`; report written, skipped, and failed files, and do not claim multi-file atomicity. Warn about the race window and offer export of the version being replaced as a recovery path.

### Unknown and binary files

Treat unknown remote files as binary by default. Never parse them as text or pass them to hledger unless they are recognized as a journal/include. Known companions and recognized binary types may be selected as whole files; they cannot be edited or merged. Unknown types are read/export only: show path, size, and available date information; offer export; do not import, overwrite, or delete them implicitly. Leave an unknown destination-only addition pending.

### Append-only merge

Never apply a merge automatically. An optional “Propose merge of additions” action may prefill the manual editor only when the common ancestor is an exact prefix of both versions. Preserve both captured additions byte-for-byte. Continue through hledger preview, separate confirmation, and GitHub SHA validation like any other manual result.

## Principles

- Journal text remains the accounting truth. Do not add conflict markers or Choai-only accounting state.
- No side wins implicitly. Destructive actions name the affected paths, the side being replaced, and what will be lost.
- A recheck is not an atomic write. State each provider's actual guarantee and stop when the reviewed version no longer matches.
- Keep shared classification/decision logic provider-independent; keep access, identity, fingerprints, and writes in provider adapters.
- Carry failures as structured `Result` values so the UI can say what happened and what can be done next.

## Shared conflict model

A captured file snapshot contains the book ID and relative path, optional agreed base, local and destination versions, version identities/fingerprints, file role/state, cause, and capture time. Text versions are compared by lines. Binary versions are compared by size and fingerprint, never rendered as a text diff. Missing base is explicit; do not invent a common ancestor. A snapshot is immutable: a later change requires a new capture.

The model in `apps/web/src/core/sync/conflict.ts` already defines text/binary versions, file states, choices, diff sections, a `blockedSync` direction guard, and an append-only proposal. Pure-model tests live in `apps/web/tests/sync-conflict.test.ts`.

## User flow

1. Detect changes on open and on return to the foreground. If permission or access is unavailable, say that verification could not be completed; do not present that as “no changes”.
2. Show a provider/path summary and state that no file is replaced before confirmation.
3. Compare text side by side with a readable diff; show binary files by size and identity, without a fake text diff.
4. Offer per-file keep-local, take-destination, manual-text, or defer choices where supported. Unknown files are export/defer only.
5. Preview accounting text through hledger, then ask for a separate, explicit confirmation naming the consequences.
6. Revalidate each provider version immediately before applying. Report success, skipped/conflicted, uncertain, and failed files separately. Allow safe retry; do not claim a multi-file transaction.

## Provider status and remaining work

### GitHub — first delivery target, still incomplete

Already present in the working tree: SHA-based text and binary fetch/write/delete paths; snapshots for known local files and additional repository paths; a comparison panel with choices, hledger preview, confirmation, persistence, partial-push reporting, and stale-snapshot detection. A stale apply now triggers a read-only recapture. Unknown remote files are classified as read-only/export-only in the current implementation work. The GitHub panel's direct pull is guarded against local pending changes.

Still required before calling GitHub complete:

- Run the comparison e2e scenarios in an environment with Playwright Chromium installed; they could not launch here.
- Browser-check every resolution choice, partial pushes/retries, reload recovery and persistence failures, including resolved-session cleanup and path reporting. Mocked adapter tests already cover stale SHA refusal, reviewed deletion, binary companions, unknown-file export-only behavior, and invalid manual text.

### Google Drive — resolution adapter implemented; browser coverage remains

`inspectResolution`, `resolveResolution`, and `exportUnknownResolution` capture file IDs, Drive metadata, text/binary content and agreed bases. The shared panel previews accounting text through hledger, confirms each file separately, and leaves unknown files export/defer only. Before updates, the adapter rereads metadata, pins the prior revision when possible or stores its revision ID, then rereads metadata immediately before PATCH. It verifies the written content afterward and reports an uncertain result if verification fails. Deletions move files to Drive trash rather than permanently deleting them.

Drive cannot make the metadata recheck and PATCH atomic. The confirmation panel warns about a late-edit race and points to revision-history recovery. Mocked adapter tests cover stale pre-write metadata, revision-recovery fallback, verified updates and uncertain outcomes. Browser-check a failed pre-write read, late edits, deletion and partial retry/recovery behavior.

### Local folder — resolution adapter implemented; browser coverage remains

`inspectLocalResolution`, `resolveLocalResolution`, and `exportLocalResolution` compare the open book with a recursively scanned folder. Captured disk identities include `lastModified`, size, and SHA-256 content fingerprints. These baselines are kept with the folder, including binary companions, so intentional in-app binary edits are distinguishable from external disk edits. The confirmation action requests/revalidates read-write permission, rereads the reviewed file before each write, and writes one file with `createWritable()`/`close()`. The panel offers export of the destination version as a recovery copy and warns that the recheck/write race remains and files are not a multi-file transaction.

Mocked adapter tests cover permission refusal, replacement after review, binary baselines, deletion and unknown-file export; the existing local-folder suite covers partial-write baselines and safe retry. Browser-check permission changes, destination replacement, recovery export, deletion and partial retries.

## Persistence and recovery

IndexedDB version 7 has a resolution-session store with Result-based reads, writes, and deletes. GitHub choices/manual text are restored when the same versions remain. On resolution, remove completed sessions; retry temporary storage failures and show persistence errors. When a snapshot becomes stale, visibly invalidate its decisions and recapture without writing. Extend the same recovery rules to later provider adapters.

## E2E execution notes

`apps/web/e2e/SYNC-RESOLUTION.md` lists the GitHub, Drive, and local-folder scenarios to run in a functioning Playwright environment. Tests must mock provider APIs and filesystem handles; never use a real token or repository. Playwright could not launch here because its Chromium executable is not installed; the browser scenarios remain unverified.

## Acceptance criteria

- A person can identify each affected path and see both versions without needing Git terminology.
- Supported files can be resolved per-file by choosing local, choosing destination, or editing and previewing a text result.
- No destructive operation runs before a clear confirmation.
- A version changed after comparison is never silently overwritten.
- Partial success names what was written, skipped, uncertain, and still pending.
- hledger validates every accounting-text result; binary files are never offered as mergeable text.
- Drive's non-conditional-write limitation and local-folder race/partial-write limitations are explicit.
- Unknown remote files remain outside the journal until an explicit supported action; ordinary journal files remain usable by hledger outside Choai.

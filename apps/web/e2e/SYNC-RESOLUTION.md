# Sync resolution e2e scenarios to run in a working Playwright environment

The current environment has no installed Playwright Chromium executable, so the browser tests could not launch. TypeScript and unit tests pass, but the scenarios below must be run before release.

Run from `apps/web`:

```sh
bun run e2e -- e2e/git.spec.ts
```

Stub GitHub requests with `page.route`; do not use a real token or repository.

## GitHub — compare, confirm, write

- A remote change is captured; opening the comparison does not change local files or the remote SHA.
- “Keep this copy”, “Take destination”, and a manual result are checked by hledger automatically when the person reviews the change, before the separate confirmation.
- When a selected text cannot be read by hledger, its error is shown and the editor opens with that text so it can be corrected; nothing changes until a readable result is confirmed.
- If the SHA changes after comparison, the write is refused; the UI marks the capture stale and offers a fresh comparison.
- A local deletion against an unchanged remote file deletes the remote blob only after an explicit choice and confirmation; the captured SHA is used.
- A remote deletion against an unchanged local file deletes the local file only after an explicit choice and confirmation; the resulting journal must pass hledger.
- Known binary companions show size/state, never a text diff; choosing either complete version requires confirmation and revalidation.
- A remote binary changed after comparison cannot be adopted locally.
- An unknown remote file is treated as binary, is not imported into hledger files, and is not overwritten/deleted; export downloads the captured bytes, while “decide later” leaves it pending.
- An interrupted multi-file push reports paths already written and paths remaining; retry does not rewrite completed paths.

## IndexedDB recovery

- Reloading with an unfinished session restores choices and manual text when all captured versions still match.
- Closing the comparison without applying changes neither copy and leaves the comparison recoverable.
- If a version differs after reload, the old choice is not applied; the UI visibly invalidates the capture and offers a fresh one.
- After full resolution, the session is removed. If IndexedDB fails temporarily, the persistence error is visible and a reload does not present an already-resolved conflict as active.

## Drive resolution — mocked browser scenarios, still unverified

- Before PATCH: metadata is reread; an external edit after review skips the write and leaves the conflict pending.
- Before PATCH: the reviewed old revision is pinned, or its revision ID is persisted for recovery when pinning is refused.
- After PATCH: metadata and content are reread; a mismatch or failed verification is reported as uncertain, not success.
- A failed pre-write metadata read causes no write. A late edit between the last recheck and PATCH is still a documented race.
- Deletion trashes only the file whose reviewed identity was rechecked; retry leaves unrelated files untouched.
- Partial application names completed and remaining paths, and a retry does not silently apply an old snapshot.

## Local-folder resolution — mocked browser scenarios, still unverified

- Read-write permission is requested in the confirmation action; a permission change or refusal writes nothing.
- Replacing a reviewed destination file between comparison and write is detected using time, size, and content identity.
- A known binary companion with an unchanged captured baseline can be replaced; an external binary edit is stale.
- Deleting a reviewed local or destination version affects only that path and leaves the other files unchanged.
- Unknown binary files export only the reviewed bytes and cannot be adopted or merged.
- If a write fails midway, the updated baseline permits a safe retry of only the files not yet written.

## Drive and local folder — interim safety guards

- Drive: a local unsent change (including a deletion or changed binary companion) blocks pull without changing the book.
- Drive: a remote change since the last agreement blocks push before the first PATCH; the same guard applies in the provider panel and the global action.
- Drive: a remote change to a different file from a local edit is also detected before push; no path is sent.
- Local folder: an in-memory local change blocks an ordinary reload; only the explicitly confirmed discard path may replace the open copy.
- Local folder: an external edit to text or a known companion, or a relevant addition/deletion, is reported before push/reload; guarded writes must not replace the external file.
- Drive/local paths explicitly say that no file was changed and comparison is not available yet when a divergence is detected.

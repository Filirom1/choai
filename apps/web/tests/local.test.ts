import { describe, expect, test } from "bun:test"
import { changedPaths, differences, localFileVersion, localVersionIdentity, safeLocalPath, saveLocalFolder, type LocalFolder } from "~/core/journal/local"
import { isHiddenPath } from "~/core/journal/hidden"

const folderWith = (
  contents: Readonly<Record<string, string | Blob>>,
  permission: PermissionState = "granted",
  failAt?: string,
  timestamps: Readonly<Record<string, number>> = {},
) => {
  const disk = new Map<string, string | Blob>(Object.entries(contents))
  const modified = new Map([...disk.keys()].map((path) => [path, timestamps[path] ?? 0]))
  const writes: string[] = []
  const directory = (prefix: string): FileSystemDirectoryHandle => ({
    kind: "directory",
    name: "books",
    requestPermission: async () => permission,
    getDirectoryHandle: async (name: string) => directory(`${prefix}${name}/`),
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      const path = prefix + name
      if (!disk.has(path) && !options?.create) return Promise.reject(new DOMException("Missing", "NotFoundError"))
      return {
        getFile: async () => new File([disk.get(path) ?? ""], name, { lastModified: modified.get(path) ?? 0 }),
        createWritable: async () => {
          if (path === failAt) return Promise.reject(new DOMException("Refused", "NotAllowedError"))
          const pending: { content: string | Blob } = { content: "" }
          return {
            write: async (content: string | Blob) => { pending.content = content },
            close: async () => { disk.set(path, pending.content); modified.set(path, 1); writes.push(path) },
          }
        },
      }
    },
  } as unknown as FileSystemDirectoryHandle)
  return { disk, writes, handle: directory("") }
}

describe("original folder", () => {
  test("captures lastModified, size and content in the reviewed file identity", async () => {
    const original = new File(["same"], "main.journal", { lastModified: 10 })
    const touched = new File(["same"], "main.journal", { lastModified: 11 })
    const rewritten = new File(["else"], "main.journal", { lastModified: 10 })
    const identity = await localVersionIdentity(original)
    expect(await localVersionIdentity(touched)).not.toBe(identity)
    expect(await localVersionIdentity(rewritten)).not.toBe(identity)
  })

  test("hidden path components are excluded consistently", () => {
    expect(isHiddenPath(".env")).toBe(true)
    expect(isHiddenPath("history/.cache/README.md")).toBe(true)
    expect(isHiddenPath("history/README.md")).toBe(false)
    expect(changedPaths({}, { ".env": "secret", "history/README.md": "docs" })).toEqual(["history/README.md"])
  })

  test("only changed files are selected and paths cannot escape the folder", () => {
    expect(changedPaths({ "main.journal": "a", "accounts.journal": "b" }, { "main.journal": "a", "accounts.journal": "c", "transactions.journal": "d" })).toEqual(["accounts.journal", "transactions.journal"])
    expect(differences({ "main.journal": "a", "deleted.journal": "b" }, { "main.journal": "changed", "new.journal": "c" })).toEqual(["main.journal", "deleted.journal", "new.journal"])
    expect(safeLocalPath("adjustments/2026-12-31.journal")).toBe(true)
    for (const path of ["", "/main.journal", "../main.journal", "a/../b", "a//b", "a/./b", "a\\b"]) expect(safeLocalPath(path)).toBe(false)
  })

  test("saves changed and new nested files, not untouched files", async () => {
    const folder = folderWith({ "main.journal": "a", "accounts.journal": "b" })
    const result = await saveLocalFolder({ handle: folder.handle, base: { "main.journal": "a", "accounts.journal": "b" } }, {
      "main.journal": "a", "accounts.journal": "c", "adjustments/2026.journal": "d",
    })
    expect(result.ok).toBe(true)
    expect(folder.writes).toEqual(["accounts.journal", "adjustments/2026.journal"])
    expect(folder.disk.get("adjustments/2026.journal")).toBe("d")
  })

  test("an external edit to even an untouched file blocks all writes", async () => {
    const folder = folderWith({ "main.journal": "external", "accounts.journal": "b" })
    const result = await saveLocalFolder({ handle: folder.handle, base: { "main.journal": "a", "accounts.journal": "b" } }, { "main.journal": "a", "accounts.journal": "c" })
    expect(result).toEqual({ ok: false, error: { at: "changed", path: "main.journal" } })
    expect(folder.writes).toEqual([])
  })

  test("a missing original or a colliding new file is not overwritten", async () => {
    for (const contents of [{} as Readonly<Record<string, string>>, { "main.journal": "other" }]) {
      const folder = folderWith(contents)
      const base: Readonly<Record<string, string>> = Object.keys(contents).length === 0 ? { "main.journal": "old" } : {}
      const result = await saveLocalFolder({ handle: folder.handle, base }, { "main.journal": "new" })
      expect(result).toEqual({ ok: false, error: { at: "changed", path: "main.journal" } })
      expect(folder.writes).toEqual([])
    }
  })

  test("saves companions under their relative paths and will not replace a different file", async () => {
    const folder = folderWith({ "main.journal": "a" })
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" })
    const result = await saveLocalFolder(
      { handle: folder.handle, base: { "main.journal": "a" } },
      { "main.journal": "a" },
      undefined,
      [{ path: "justificatifs/photo.jpg", blob }],
    )
    expect(result.ok).toBe(true)
    expect(folder.writes).toEqual(["justificatifs/photo.jpg"])
    const saved = folder.disk.get("justificatifs/photo.jpg")
    expect(saved instanceof Blob ? await saved.arrayBuffer() : undefined).toEqual(await blob.arrayBuffer())

    const conflict = folderWith({ "main.journal": "a", "justificatifs/photo.jpg": "different" })
    expect(await saveLocalFolder(
      { handle: conflict.handle, base: { "main.journal": "a" } },
      { "main.journal": "a" },
      undefined,
      [{ path: "justificatifs/photo.jpg", blob }],
    )).toEqual({ ok: false, error: { at: "changed", path: "justificatifs/photo.jpg" } })
    expect(conflict.writes).toEqual([])
  })

  test("does not rewrite a companion that still matches its baseline", async () => {
    const original = new Blob([Uint8Array.of(1, 2)], { type: "image/jpeg" })
    const folder = folderWith({ "receipt.jpg": original })
    const version = await localFileVersion(new File([original], "receipt.jpg", { lastModified: 0 }))
    const result = await saveLocalFolder({
      handle: folder.handle,
      base: {},
      versions: { "receipt.jpg": version },
    }, {}, undefined, [{ path: "receipt.jpg", blob: original }])
    expect(result.ok).toBe(true)
    expect(folder.writes).toEqual([])
  })

  test("writes an intentional binary edit when disk still matches its captured baseline", async () => {
    const original = new Blob([Uint8Array.of(1, 2)], { type: "image/jpeg" })
    const folder = folderWith({ "receipt.jpg": original })
    const version = await localFileVersion(new File([original], "receipt.jpg", { lastModified: 0 }))
    const result = await saveLocalFolder({
      handle: folder.handle,
      base: {},
      versions: { "receipt.jpg": version },
    }, {}, undefined, [{ path: "receipt.jpg", blob: new Blob([Uint8Array.of(3, 4)], { type: "image/jpeg" }) }])
    expect(result.ok).toBe(true)
    expect(folder.writes).toEqual(["receipt.jpg"])
  })

  test("permission refusal and unsafe paths write nothing", async () => {
    const folder = folderWith({ "main.journal": "a" }, "denied")
    expect(await saveLocalFolder({ handle: folder.handle, base: { "main.journal": "a" } }, { "main.journal": "b" })).toEqual({ ok: false, error: { at: "permission" } })
    expect(await saveLocalFolder({ handle: folder.handle, base: {} }, { "../escape": "b" })).toEqual({ ok: false, error: { at: "unsafe-path", path: "../escape" } })
    expect(folder.writes).toEqual([])
  })

  test("partial writes advance the persisted baseline for a safe retry", async () => {
    const folder = folderWith({ "main.journal": "a", "accounts.journal": "b" }, "granted", "accounts.journal")
    const kept: LocalFolder[] = []
    const result = await saveLocalFolder({ handle: folder.handle, base: { "main.journal": "a", "accounts.journal": "b" } }, { "main.journal": "new", "accounts.journal": "new" }, async (next) => { kept.push(next) })
    expect(result.ok).toBe(false)
    expect(folder.writes).toEqual(["main.journal"])
    expect(kept[0]?.base).toEqual({ "main.journal": "new", "accounts.journal": "b" })
    const retry = folderWith(
      Object.fromEntries([...folder.disk].filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      "granted",
      undefined,
      { "main.journal": 1 },
    )
    const retried = await saveLocalFolder({ ...kept[0]!, handle: retry.handle }, { "main.journal": "new", "accounts.journal": "new" })
    expect(retried.ok).toBe(true)
    expect(retry.writes).toEqual(["accounts.journal"])
  })
})

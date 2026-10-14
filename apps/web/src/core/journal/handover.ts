import { strToU8, zipSync } from "fflate"

import { loadAttachment, type Source } from "./store"

/** How the files left, which is what there is to tell the reader afterwards. */
export type Handover = "saved" | "shared" | "downloaded" | "cancelled" | "refused"

type FileContents = string | Blob

/** Hand the journal over with every declared companion, preserving relative paths. */
export const handOver = async (book: string, source: Source): Promise<Handover> => {
  const chooseFolder = folderPicker()
  if (chooseFolder !== undefined) return intoFolder(chooseFolder, book, source)

  const contents = await allContents(book, source)
  if (contents === undefined) return "refused"
  const zip = await asZip(source, contents)
  if (canShare([zip])) {
    try {
      await navigator.share({ files: [zip] })
      return "shared"
    } catch (cause) {
      if (wasCancelled(cause)) return "cancelled"
    }
  }
  save(zip)
  return "downloaded"
}

type FolderPicker = (options: { readonly mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>

/** Chromium's, on a desktop; absent from the lib because not every browser has it. */
const folderPicker = (): FolderPicker | undefined => {
  const picker = (window as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker
  return picker === undefined ? undefined : picker.bind(window)
}

const intoFolder = async (choose: FolderPicker, book: string, source: Source): Promise<Handover> => {
  try {
    const root = await choose({ mode: "readwrite" })
    const contents = await allContents(book, source)
    if (contents === undefined) return "refused"
    await Object.entries(contents).reduce(
      (before, [path, content]) => before.then(() => writeAt(root, path.split("/"), content)),
      Promise.resolve(),
    )
    return "saved"
  } catch (cause) {
    return wasCancelled(cause) ? "cancelled" : "refused"
  }
}

const allContents = async (book: string, source: Source): Promise<Readonly<Record<string, FileContents>> | undefined> => {
  const loaded = await Promise.all(source.attachments.map(async ({ path }) => {
    const blob = await loadAttachment(book, path)
    return blob === undefined ? undefined : [path, blob] as const
  }))
  return loaded.some((one) => one === undefined)
    ? undefined
    : { ...source.files, ...Object.fromEntries(loaded.flatMap((one) => one === undefined ? [] : [one])) }
}

/** A file at the end of a path, making each folder on the way if it is not there. */
const writeAt = async (folder: FileSystemDirectoryHandle, parts: readonly string[], content: FileContents): Promise<void> => {
  const [first, ...rest] = parts
  if (first === undefined) return
  if (rest.length > 0) return writeAt(await folder.getDirectoryHandle(first, { create: true }), rest, content)
  const writable = await (await folder.getFileHandle(first, { create: true })).createWritable()
  await writable.write(content)
  await writable.close()
}

/** The files as one zip that unpacks into the folders their names say, named after the book. */
const asZip = async (source: Source, contents: Readonly<Record<string, FileContents>>): Promise<File> => {
  const entries = await Promise.all(Object.entries(contents).map(async ([path, content]) =>
    [path, typeof content === "string" ? strToU8(content) : new Uint8Array(await content.arrayBuffer())] as const,
  ))
  const packed = zipSync(Object.fromEntries(entries))
  return new File([packed], `${source.label.replace(/[\\/:*?"<>|]/g, "_")}.zip`, { type: "application/zip" })
}

const canShare = (files: readonly File[]): boolean =>
  typeof navigator.canShare === "function" && navigator.canShare({ files: [...files] })

/** Dismissing the share sheet or the folder picker is not a failure. */
const wasCancelled = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError"

const save = (file: File): void => {
  const url = URL.createObjectURL(file)
  const link = document.createElement("a")
  link.href = url
  link.download = file.name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

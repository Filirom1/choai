const MAX_SIDE = 1280
const JPEG_QUALITY = 0.82

const jpegName = (name: string): string => `${name.replace(/\.[^.]+$/, "")}.jpg`

export const compactImage = async (file: File): Promise<File> => {
  if (!file.type.startsWith("image/")) return file
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => undefined)
  if (bitmap === undefined) return file

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext("2d")
  if (context === null) {
    bitmap.close()
    return file
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const blob = await new Promise<Blob | undefined>((resolve) =>
    canvas.toBlob((value) => resolve(value ?? undefined), "image/jpeg", JPEG_QUALITY),
  )
  return blob === undefined ? file : new File([blob], jpegName(file.name), { type: blob.type, lastModified: file.lastModified })
}
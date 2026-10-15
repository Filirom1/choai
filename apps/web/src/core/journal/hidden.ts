export const isHledgerLatestPath = (path: string): boolean =>
  /^\.latest\..+\.csv$/i.test(path.split("/").at(-1) ?? "")

export const hledgerLatestPaths = (paths: readonly string[]): readonly string[] =>
  paths.filter(isHledgerLatestPath)

export const isHiddenPath = (path: string, managedLatest: readonly string[] = []): boolean => {
  const parts = path.split("/")
  const hidden = parts.some((part) => part.startsWith("."))
  const visibleCheckpoint = isHledgerLatestPath(path) &&
    managedLatest.includes(path) &&
    parts.slice(0, -1).every((part) => !part.startsWith("."))
  return hidden && !visibleCheckpoint
}

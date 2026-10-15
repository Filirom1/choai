export const isHiddenPath = (path: string): boolean =>
  path.split("/").some((part) => part.startsWith("."))

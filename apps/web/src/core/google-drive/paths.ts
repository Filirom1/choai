export const safePath = (path: string): boolean =>
  path.length > 0 && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

export const parentPath = (path: string): string => {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? "" : path.slice(0, slash)
}
export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
export const relativePath = (prefix: string, name: string): string => prefix === "" ? name : `${prefix}/${name}`

export type SourceTreeNode =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "folder"; readonly path: string; readonly children: readonly SourceTreeNode[] }

const nameOf = (node: SourceTreeNode): string =>
  node.path.split("/").at(-1) ?? node.path

const compareNames = (left: SourceTreeNode, right: SourceTreeNode): number => {
  const leftName = nameOf(left)
  const rightName = nameOf(right)
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
}

const treeOf = (paths: readonly string[], parent: string): readonly SourceTreeNode[] => {
  const files = paths
    .filter((path) => !path.includes("/"))
    .map((path): SourceTreeNode => ({ kind: "file", path: `${parent}${path}` }))
  const folders = [...new Set(paths.flatMap((path) => {
    const slash = path.indexOf("/")
    return slash < 0 ? [] : [path.slice(0, slash)]
  }))].map((folder): SourceTreeNode => ({
    kind: "folder",
    path: `${parent}${folder}`,
    children: treeOf(
      paths
        .filter((path) => path.startsWith(`${folder}/`))
        .map((path) => path.slice(folder.length + 1)),
      `${parent}${folder}/`,
    ),
  }))
  return [...files, ...folders].sort(compareNames)
}

export const sourceTree = (paths: readonly string[]): readonly SourceTreeNode[] => treeOf(paths, "")

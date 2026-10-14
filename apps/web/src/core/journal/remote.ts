/** Where a book is kept away from this device. */
export interface GitHubRemote {
  readonly provider: "github"
  readonly owner: string
  readonly repo: string
  /** Empty means the repository's default branch. */
  readonly branch: string
  /** Path of the entry file in the repository. */
  readonly path: string
}

export interface GoogleDriveRemote {
  readonly provider: "google-drive"
  readonly folderId: string
  readonly folderName: string
  /** Entry file, relative to the selected folder. */
  readonly path: string
}

export type Remote = GitHubRemote | GoogleDriveRemote

/** Old records predate providers; their repository-shaped fields mean GitHub. */
export const normalizeRemote = (value: unknown): Remote | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const remote = value as Record<string, unknown>
  if (remote.provider === "google-drive" && typeof remote.folderId === "string" && typeof remote.path === "string") {
    return {
      provider: "google-drive",
      folderId: remote.folderId,
      folderName: typeof remote.folderName === "string" ? remote.folderName : "",
      path: remote.path,
    }
  }
  if (remote.provider === "github" || remote.provider === undefined) {
    if (typeof remote.owner !== "string" || typeof remote.repo !== "string" || typeof remote.path !== "string") return undefined
    return {
      provider: "github",
      owner: remote.owner,
      repo: remote.repo,
      branch: typeof remote.branch === "string" ? remote.branch : "",
      path: remote.path,
    }
  }
  return undefined
}

export const isGitHubRemote = (remote: Remote | undefined): remote is GitHubRemote => remote?.provider === "github"
export const isGoogleDriveRemote = (remote: Remote | undefined): remote is GoogleDriveRemote => remote?.provider === "google-drive"

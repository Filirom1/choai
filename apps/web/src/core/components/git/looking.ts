import { REMOTES } from "~/core/address/address"

/** What the sync section is showing, as the address says it. */
export type Looking =
  | { readonly at: "history"; readonly commit: string | undefined }
  | { readonly at: "drive-history"; readonly revision: string | undefined }
  | { readonly at: "change"; readonly path: string }
  | { readonly at: "connection" }
  | { readonly at: "drive" }
  | { readonly at: "local" }

const CHANGE = "#change="
const COMMIT = "#commit="
const REVISION = "#revision="
const DRIVE_HISTORY = "#drive-history"
const CONNECTION = "#connection"
const DRIVE = "#drive"
const LOCAL = "#local"

export const lookingAt = (hash: string): Looking =>
  hash === CONNECTION
    ? { at: "connection" }
    : hash === DRIVE
      ? { at: "drive" }
      : hash === DRIVE_HISTORY
        ? { at: "drive-history", revision: undefined }
        : hash.startsWith(REVISION)
          ? { at: "drive-history", revision: decodeURIComponent(hash.slice(REVISION.length)) }
          : hash === LOCAL
            ? { at: "local" }
            : hash.startsWith(CHANGE)
              ? { at: "change", path: decodeURIComponent(hash.slice(CHANGE.length)) }
              : { at: "history", commit: hash.startsWith(COMMIT) ? hash.slice(COMMIT.length) : undefined }

export const addressOf = (looking: Looking): string => {
  switch (looking.at) {
    case "connection":
      return `${REMOTES}${CONNECTION}`
    case "drive":
      return `${REMOTES}${DRIVE}`
    case "local":
      return `${REMOTES}${LOCAL}`
    case "change":
      return `${REMOTES}${CHANGE}${encodeURIComponent(looking.path)}`
    case "history":
      return looking.commit === undefined ? REMOTES : `${REMOTES}${COMMIT}${looking.commit}`
    case "drive-history":
      return looking.revision === undefined ? `${REMOTES}${DRIVE_HISTORY}` : `${REMOTES}${REVISION}${encodeURIComponent(looking.revision)}`
  }
}

import { REMOTES } from "~/core/address/address"

/** What the sync section is showing, as the address says it. */
export type Looking =
  | { readonly at: "history"; readonly commit: string | undefined }
  | { readonly at: "change"; readonly path: string }
  | { readonly at: "connection" }
  | { readonly at: "drive" }
  | { readonly at: "local" }

const CHANGE = "#change="
const COMMIT = "#commit="
const CONNECTION = "#connection"
const DRIVE = "#drive"
const LOCAL = "#local"

export const lookingAt = (hash: string): Looking =>
  hash === CONNECTION
    ? { at: "connection" }
    : hash === DRIVE
      ? { at: "drive" }
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
  }
}

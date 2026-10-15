import { Err, Ok, type Result } from "~/core/lib/monad"
import { STORE, within } from "~/core/lib/idb"
import type { ResolutionSession } from "./conflict"

export type Failure = { readonly at: "storage"; readonly cause: unknown }

const RESOLUTIONS = STORE.resolutions

export const resolutionsFor = async (bookId: string): Promise<Result<readonly ResolutionSession[], Failure>> => {
  try {
    const rows = await within("readonly", [RESOLUTIONS], (transaction) =>
      transaction.objectStore(RESOLUTIONS).getAll() as IDBRequest<ResolutionSession[]>,
    )
    return Ok((rows.result ?? []).filter((session) => session.bookId === bookId))
  } catch (cause) {
    return Err({ at: "storage", cause })
  }
}

export const keepResolution = async (session: ResolutionSession): Promise<Result<void, Failure>> => {
  try {
    await within("readwrite", [RESOLUTIONS], (transaction) => {
      transaction.objectStore(RESOLUTIONS).put(session)
    })
    return Ok(undefined)
  } catch (cause) {
    return Err({ at: "storage", cause })
  }
}

export const forgetResolution = async (id: string): Promise<Result<void, Failure>> => {
  const retry = async (attempt: number): Promise<Result<void, Failure>> => {
    try {
      await within("readwrite", [RESOLUTIONS], (transaction) => {
        transaction.objectStore(RESOLUTIONS).delete(id)
      })
      return Ok(undefined)
    } catch (cause) {
      return attempt < 2 ? retry(attempt + 1) : Err({ at: "storage", cause })
    }
  }
  return retry(0)
}

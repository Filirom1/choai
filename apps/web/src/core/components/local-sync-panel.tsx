import { Show, createResource, createSignal, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TroubleNote } from "~/core/components/trouble-note"
import { changedOnDisk, journal, localBusy, localFolderHasPending, reloadLocalFolder, saveToLocalFolder, type LocalTrouble } from "~/core/journal/store"
import { changedPaths } from "~/core/journal/local"
import { isHiddenPath } from "~/core/journal/hidden"
import { blockedSync } from "~/core/sync/conflict"
import { differsFrom, forgetUnsavedText } from "~/core/journal/unsaved-text"
import { putDown } from "~/core/journal/switching"
import { Err, getOrUndefined, type Result } from "~/core/lib/monad"
import { t } from "~/core/i18n"

export function LocalSyncPanel(): JSX.Element {
  const [result, setResult] = createSignal<Result<void, LocalTrouble> | undefined>()
  const open = () => getOrUndefined(journal())
  const [binaryPending] = createResource(() => open(), async (current) => current === undefined ? false : localFolderHasPending(current))
  const edited = (): boolean => Object.entries(open()?.source.files ?? {}).some(([path, text]) => !isHiddenPath(path) && differsFrom(path, text))
  const changed = (): boolean => {
    const current = open()
    return current !== undefined && (changedPaths(current.local?.base ?? {}, current.source.files).length > 0 || binaryPending() === true)
  }
  const failure = (): LocalTrouble | undefined => {
    const answer = result()
    return answer !== undefined && !answer.ok ? answer.error : undefined
  }
  const run = async (work: () => Promise<Result<void, LocalTrouble>>): Promise<void> => {
    setResult(undefined)
    setResult(await work())
  }
  const save = async (): Promise<Result<void, LocalTrouble>> => {
    const current = open()
    if (current === undefined) return saveToLocalFolder()
    const destination = await changedOnDisk(current)
    if (!destination.ok) return destination
    const blocked = blockedSync("push", [], destination.value)
    return blocked === undefined
      ? saveToLocalFolder()
      : Err({ at: "changed", path: blocked.paths[0] ?? "" })
  }
  const reload = async (): Promise<Result<void, LocalTrouble>> => {
    const current = open()
    const localChanges = current === undefined || current.local === undefined
      ? []
      : changedPaths(current.local.base, current.source.files)
    return blockedSync("pull", localChanges, []) === undefined
      ? reloadLocalFolder()
      : Err({ at: "unsaved" })
  }
  const restartFromDisk = async (): Promise<void> => {
    if (!window.confirm(t("local.discardConfirm"))) return
    const bookId = open()?.bookId
    if (bookId === undefined) return
    await run(async () => {
      const answer = await reloadLocalFolder("discard")
      if (answer.ok && open()?.bookId === bookId) {
        forgetUnsavedText()
        putDown()
      }
      return answer
    })
  }

  return (
    <section class="flex w-full flex-col gap-5">
      <header class="flex flex-col gap-1">
        <h2 class="text-lg font-semibold">{t("local.title")}</h2>
        <p class="font-mono text-sm text-muted-foreground">{open()?.local?.handle.name}</p>
        <p class="text-sm text-muted-foreground">{t("local.hint")}</p>
      </header>
      <div class="flex flex-wrap gap-2">
        <Button disabled={localBusy() || edited() || !changed()} onClick={() => void run(save)}>{t("local.save")}</Button>
        <Button variant="outline" disabled={localBusy() || edited() || changed()} onClick={() => void run(reload)}>{t("local.reload")}</Button>
        <Show when={changed() || edited() || failure()?.at === "changed"}>
          <Button variant="outline" disabled={localBusy()} onClick={() => void restartFromDisk()}>{t("local.discard")}</Button>
        </Show>
      </div>
      <Show when={edited()}><p class="text-sm text-muted-foreground">{t("local.editorPending")}</p></Show>
      <Show when={result()?.ok}><p role="status" class="text-sm">{t("local.done")}</p></Show>
      <Show when={failure()}>{(cause) => cause().at === "hledger"
        ? <TroubleNote trouble={(cause() as Extract<LocalTrouble, { at: "hledger" }>).trouble} />
        : <p role="alert" class="text-sm text-error-foreground">{localFailureWords(cause())}</p>}
      </Show>
    </section>
  )
}

export const localFailureWords = (failure: LocalTrouble): string => {
  switch (failure.at) {
    case "not-linked": return t("local.notLinked")
    case "permission": return t("local.permission")
    case "changed": return t("local.conflict", { path: failure.path })
    case "unsafe-path": return t("local.unsafe", { path: failure.path })
    case "filesystem": return t("local.failed")
    case "unsaved": return t("local.pending")
    case "hledger": return t("local.failed")
  }
}

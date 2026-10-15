import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { SnagNote } from "~/core/components/github-panel"
import { TroubleNote } from "~/core/components/trouble-note"
import { previewFile } from "~/core/journal/store"
import { t } from "~/core/i18n"
import { forgetResolution, keepResolution, resolutionsFor } from "~/core/sync/kept"
import { appendMergeProposal, choiceText, diffSections, diffText, sameVersions, type DiffLine, type FileSnapshot, type ResolutionChoice, type ResolutionSession } from "~/core/sync/conflict"
import type { Result } from "~/core/lib/monad"

export function SyncResolutionPanel<F>(props: {
  readonly bookId: string
  readonly snapshots: readonly FileSnapshot[]
  readonly onLater: () => void
  readonly onApplied: () => void
  readonly onRefresh: () => void
  readonly resolveFile: (snapshot: FileSnapshot, choice: ResolutionChoice) => Promise<Result<void, F>>
  readonly exportFile: (snapshot: FileSnapshot) => Promise<Result<Blob, F>>
  readonly exportRecovery?: (snapshot: FileSnapshot) => Promise<Result<Blob, F>>
  readonly renderFailure: (failure: F) => JSX.Element
  readonly isStale: (failure: F) => boolean
  readonly warning?: string
}): JSX.Element {
  const [session, setSession] = createSignal<ResolutionSession>()
  const [confirming, setConfirming] = createSignal<string>()
  const [busy, setBusy] = createSignal<string>()
  const [failure, setFailure] = createSignal<{ readonly path: string; readonly reason: F }>()
  const [storageFailed, setStorageFailed] = createSignal(false)
  const [previewing, setPreviewing] = createSignal<string>()
  const [previewed, setPreviewed] = createSignal<ReadonlySet<string>>(new Set())
  const [previewFailure, setPreviewFailure] = createSignal<{ readonly path: string; readonly trouble: import("~/core/hledger/wire").Trouble }>()

  createEffect(on(() => props.snapshots, (snapshots) => {
    const restore = async (): Promise<void> => {
      setFailure(undefined)
      const saved = await resolutionsFor(props.bookId)
      const prior = saved.ok
        ? saved.value.find((candidate) => candidate.snapshots.length === snapshots.length &&
          candidate.snapshots.every((snapshot, index) => sameVersions(snapshot, snapshots[index]!)))
        : undefined
      const next: ResolutionSession = prior ?? {
        id: crypto.randomUUID(),
        bookId: props.bookId,
        snapshots,
        choices: {},
        createdAt: Date.now(),
      }
      setSession(next)
      if (prior === undefined) {
        const obsolete = saved.ok ? await Promise.all(saved.value.map((session) => forgetResolution(session.id))) : []
        const kept = await keepResolution(next)
        setStorageFailed(!saved.ok || obsolete.some((result) => !result.ok) || !kept.ok)
      }
    }
    void restore()
  }, { defer: false }))

  const saveChoice = async (path: string, choice: ResolutionChoice): Promise<void> => {
    const current = session()
    if (current === undefined) return
    const next = { ...current, choices: { ...current.choices, [path]: choice } }
    setSession(next)
    setConfirming(undefined)
    setStorageFailed(!(await keepResolution(next)).ok)
  }

  const chooseAndReview = async (snapshot: FileSnapshot, choice: ResolutionChoice): Promise<void> => {
    setPreviewFailure(undefined)
    await saveChoice(snapshot.path, choice)
    await review(snapshot)
  }

  const apply = async (snapshot: FileSnapshot): Promise<void> => {
    const current = session()
    const choice = current?.choices[snapshot.path]
    if (current === undefined || choice === undefined) return
    setBusy(snapshot.path)
    setFailure(undefined)
    const result = await props.resolveFile(snapshot, choice)
    setBusy(undefined)
    if (!result.ok) {
      setFailure({ path: snapshot.path, reason: result.error })
      if (props.isStale(result.error)) await props.onRefresh()
      return
    }
    const remaining = current.snapshots.filter((item) => item.path !== snapshot.path)
    const choices = Object.fromEntries(Object.entries(current.choices).filter(([path]) => path !== snapshot.path))
    if (remaining.length === 0) {
      const forgotten = await forgetResolution(current.id)
      setStorageFailed(!forgotten.ok)
      setSession(undefined)
      props.onApplied()
      if (!forgotten.ok) await props.onRefresh()
      return
    }
    const next = { ...current, snapshots: remaining, choices }
    setSession(next)
    setStorageFailed(!(await keepResolution(next)).ok)
  }

  const exportFile = async (snapshot: FileSnapshot): Promise<void> => {
    setBusy(snapshot.path)
    setFailure(undefined)
    const result = await props.exportFile(snapshot)
    setBusy(undefined)
    if (!result.ok) {
      setFailure({ path: snapshot.path, reason: result.error })
      if (props.isStale(result.error)) await props.onRefresh()
      return
    }
    const address = URL.createObjectURL(result.value)
    const link = document.createElement("a")
    link.href = address
    link.download = snapshot.path.split("/").at(-1) ?? snapshot.path
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(address), 0)
  }

  const exportRecovery = async (snapshot: FileSnapshot): Promise<void> => {
    if (props.exportRecovery === undefined) return
    setBusy(snapshot.path)
    setFailure(undefined)
    const result = await props.exportRecovery(snapshot)
    setBusy(undefined)
    if (!result.ok) {
      setFailure({ path: snapshot.path, reason: result.error })
      if (props.isStale(result.error)) await props.onRefresh()
      return
    }
    const address = URL.createObjectURL(result.value)
    const link = document.createElement("a")
    link.href = address
    link.download = `${snapshot.path.split("/").at(-1) ?? snapshot.path}.recovery`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(address), 0)
  }

  const defer = async (snapshot: FileSnapshot): Promise<void> => {
    await saveChoice(snapshot.path, { take: "later" })
    await apply(snapshot)
  }

  const candidateText = (snapshot: FileSnapshot): string | undefined => {
    const selected = session()?.choices[snapshot.path]
    return selected === undefined || selected.take === "later" ? undefined : choiceText(snapshot, selected)
  }

  const previewKey = (snapshot: FileSnapshot): string => JSON.stringify([snapshot.path, candidateText(snapshot) ?? null])

  const review = async (snapshot: FileSnapshot): Promise<void> => {
    const text = candidateText(snapshot)
    if (snapshot.role !== "accounting" || [snapshot.local, snapshot.destination].some((version) => version.content?.kind === "binary")) {
      setConfirming(snapshot.path)
      return
    }
    setPreviewing(snapshot.path)
    setPreviewFailure(undefined)
    const result = await previewFile(snapshot.path, text)
    setPreviewing(undefined)
    if (!result.ok) {
      setPreviewFailure({ path: snapshot.path, trouble: result.error })
      const selected = session()?.choices[snapshot.path]
      if (text !== undefined && selected !== undefined && selected.take !== "manual") {
        await saveChoice(snapshot.path, { take: "manual", text })
      }
      return
    }
    setPreviewFailure(undefined)
    setPreviewed((before) => new Set([...before, previewKey(snapshot)]))
    setConfirming(snapshot.path)
  }

  return (
    <section class="flex flex-col gap-3 rounded-md border p-3" aria-label={t("syncResolution.title")}>
      <div>
        <h2 class="font-medium">{t("syncResolution.title")}</h2>
        <p class="text-xs text-muted-foreground">{t("syncResolution.lead")}</p>
        <Show when={props.warning}><p class="mt-1 text-xs text-amber-700 dark:text-amber-300">{props.warning}</p></Show>
      </div>
      <Show when={storageFailed()}><p class="text-sm text-error-foreground" role="alert">{t("syncResolution.storageFailed")}</p></Show>
      <Show when={session()} fallback={<p class="text-sm">{t("syncResolution.loading")}</p>}>
        {(current) => <For each={current().snapshots}>{(snapshot) => {
          const choice = (): ResolutionChoice | undefined => current().choices[snapshot.path]
          const localText = snapshot.local.content?.kind === "text" ? snapshot.local.content.text : ""
          const destinationText = snapshot.destination.content?.kind === "text" ? snapshot.destination.content.text : ""
          const differences = diffText(localText, destinationText)
          const binary = [snapshot.base, snapshot.local, snapshot.destination]
            .some((version) => version.content?.kind === "binary")
          const versionLabel = (version: FileSnapshot["local"]): string => {
            if (version.content === undefined) return t("syncResolution.absent")
            if (version.content.kind === "text") return version.content.text
            return t("syncResolution.binaryFile", { size: version.content.size })
          }
          const manual = (): string => {
            const selected = choice()
            return selected?.take === "manual"
              ? selected.text
              : appendMergeProposal(snapshot) ?? (snapshot.local.content?.kind === "text" ? localText : destinationText)
          }
          const summary = (): string => {
            const selected = choice()
            if (selected?.take === "destination") return snapshot.destination.content === undefined
              ? t("syncResolution.confirmDestinationDeletion", { path: snapshot.path })
              : t("syncResolution.confirmDestination", { path: snapshot.path })
            if (selected?.take === "local") return snapshot.local.content === undefined
              ? t("syncResolution.confirmLocalDeletion", { path: snapshot.path })
              : t("syncResolution.confirmLocal", { path: snapshot.path })
            if (selected?.take === "manual") return t("syncResolution.confirmManual", { path: snapshot.path })
            return ""
          }
          const problem = () => failure()?.path === snapshot.path ? failure() : undefined
          const previewProblem = () => previewFailure()?.path === snapshot.path ? previewFailure() : undefined
          return <article class="flex flex-col gap-2 rounded border p-2" aria-label={snapshot.path}>
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h3 class="font-medium">{snapshot.path}</h3>
              <span class="text-xs text-muted-foreground">{stateWord(snapshot.state)}</span>
            </div>
            <div class="grid gap-2 md:grid-cols-2">
              <section class="min-w-0"><h4 class="text-xs font-medium">{t("github.thisCopy")}</h4>
                <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{versionLabel(snapshot.local)}</pre>
              </section>
              <section class="min-w-0"><h4 class="text-xs font-medium">{t("github.destinationCopy")}</h4>
                <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{versionLabel(snapshot.destination)}</pre>
              </section>
            </div>
            <section class="min-w-0">
              <Show when={binary} fallback={<>
                <h4 class="mb-1 text-xs font-medium">{t("syncResolution.differences")}</h4>
                <div class="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs">
                  <For each={diffSections(differences)}>{(section) => section.kind === "folded"
                    ? <details class="my-1">
                      <summary class="cursor-pointer text-muted-foreground">{t("syncResolution.hiddenContext", { count: section.lines.length })}</summary>
                      <DiffLines lines={section.lines} />
                    </details>
                    : <DiffLines lines={section.lines} />}</For>
                </div>
              </>}>
                <p class="text-xs text-muted-foreground">{t("syncResolution.binaryDiff")}</p>
              </Show>
            </section>
            <Show when={props.exportRecovery !== undefined && snapshot.role !== "unknown"}>
              <Button size="sm" variant="ghost" class="self-start" disabled={busy() !== undefined} onClick={() => void exportRecovery(snapshot)}>
                {busy() === snapshot.path ? t("syncResolution.exporting") : t("syncResolution.exportRecovery")}
              </Button>
            </Show>
            <Show when={snapshot.role === "unknown"}>
              <div class="flex flex-col gap-2 rounded bg-muted p-2">
                <p class="text-sm">{t("syncResolution.unknownFile")}</p>
                <p class="text-xs text-muted-foreground">{t("syncResolution.capturedAt", { date: new Date(snapshot.capturedAt).toLocaleString() })}</p>
                <Button size="sm" variant="outline" class="self-start" disabled={busy() !== undefined} onClick={() => void exportFile(snapshot)}>
                  {busy() === snapshot.path ? t("syncResolution.exporting") : t("syncResolution.exportDestination")}
                </Button>
              </div>
            </Show>
            <div class="flex flex-wrap gap-2" role="group" aria-label={t("syncResolution.chooseFor", { path: snapshot.path })}>
              <Show when={snapshot.role !== "unknown"}>
                <Button size="sm" variant={choice()?.take === "local" ? "default" : "outline"} disabled={busy() !== undefined || previewing() !== undefined} onClick={() => void chooseAndReview(snapshot, { take: "local" })}>{t("syncResolution.local")}</Button>
                <Button size="sm" variant={choice()?.take === "destination" ? "default" : "outline"} disabled={busy() !== undefined || previewing() !== undefined} onClick={() => void chooseAndReview(snapshot, { take: "destination" })}>{t("syncResolution.destination")}</Button>
                <Button size="sm" variant={choice()?.take === "manual" ? "default" : "outline"} disabled={busy() !== undefined || previewing() !== undefined || snapshot.role !== "accounting" || (snapshot.local.content?.kind !== "text" && snapshot.destination.content?.kind !== "text")} onClick={() => void chooseAndReview(snapshot, { take: "manual", text: manual() })}>{t("syncResolution.manual")}</Button>
              </Show>
              <Button size="sm" variant="ghost" disabled={busy() !== undefined} onClick={() => void defer(snapshot)}>{t("syncResolution.later")}</Button>
            </div>
            <Show when={choice()?.take === "manual"}>
              <Show when={appendMergeProposal(snapshot)}><p class="text-xs text-muted-foreground">{t("syncResolution.mergeSuggestion")}</p></Show>
              <label class="flex flex-col gap-1 text-xs font-medium">
                {t("syncResolution.editResult")}
                <textarea class="min-h-40 w-full rounded-md border bg-background p-2 font-mono text-xs" value={manual()} onInput={(event) => void saveChoice(snapshot.path, { take: "manual", text: event.currentTarget.value })} />
              </label>
            </Show>
            <Show when={choice() !== undefined && choice()?.take !== "later"}>
              <div class="flex flex-col gap-2 rounded bg-muted p-2">
                <p class="text-sm">{summary()}</p>
                <Show when={confirming() !== snapshot.path}>
                  <Button class="self-start" size="sm" variant="outline" disabled={busy() !== undefined || previewing() !== undefined} onClick={() => void review(snapshot)}>
                    {previewing() === snapshot.path ? t("syncResolution.previewing") : t("syncResolution.review")}
                  </Button>
                </Show>
                <Show when={confirming() === snapshot.path && (snapshot.role !== "accounting" || binary || previewed().has(previewKey(snapshot)))}>
                  <Show when={previewed().has(previewKey(snapshot))}>
                    <p class="text-sm">{candidateText(snapshot) === undefined ? t("syncResolution.previewDeletion") : t("syncResolution.previewPassed")}</p>
                  </Show>
                  <p class="text-sm font-medium">{t("syncResolution.confirmPrompt")}</p>
                  <div class="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy() !== undefined} onClick={() => void apply(snapshot)}>{busy() === snapshot.path ? t("remotes.syncing") : t("syncResolution.confirmApply")}</Button>
                    <Button size="sm" variant="ghost" disabled={busy() !== undefined} onClick={() => setConfirming(undefined)}>{t("syncResolution.cancel")}</Button>
                  </div>
                </Show>
                <Show when={previewProblem()}>
                  {(problem) => <div role="alert"><p class="mb-1 text-sm text-error-foreground">{t("syncResolution.previewFailed")}</p><TroubleNote trouble={problem().trouble} /></div>}
                </Show>
              </div>
            </Show>
            <Show when={problem()}>
              {(problem) => <div class="flex flex-col gap-2" role="alert">
                {props.renderFailure(problem().reason)}
                <Show when={props.isStale(problem().reason)}>
                  <Button size="sm" variant="outline" class="self-start" onClick={props.onRefresh}>{t("syncResolution.compareAgain")}</Button>
                </Show>
              </div>}
            </Show>
          </article>
        }}</For>}
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={props.onLater}>{t("syncResolution.close")}</Button>
      </div>
    </section>
  )
}

function DiffLines(props: { readonly lines: readonly DiffLine[] }): JSX.Element {
  return <div>{props.lines.map((line) => <div classList={{ "text-error-foreground": line.kind === "removed", "text-success-foreground": line.kind === "added" }}>
    <span aria-hidden="true">{line.kind === "removed" ? "− " : line.kind === "added" ? "+ " : "  "}</span>{line.text || " "}
  </div>)}</div>
}

export const githubResolutionFailure = (reason: import("~/core/github/sync").ResolutionFailure): JSX.Element => {
  if (reason.at === "github" || reason.at === "diverged" || reason.at === "hledger" || reason.at === "not-connected" || reason.at === "no-place" || reason.at === "no-journal") {
    return <SnagNote snag={reason} />
  }
  if (reason.at === "local-kept") return <SnagNote snag={{ at: "github", failure: reason.failure }} />
  if (reason.at === "stale") return <p class="text-sm text-error-foreground">{t("syncResolution.stale", { path: reason.path })}</p>
  if (reason.at === "unsupported") return <p class="text-sm text-error-foreground">{t("syncResolution.unsupported", { path: reason.path })}</p>
  return <p class="text-sm text-error-foreground">{t("syncResolution.failed")}</p>
}

const stateWord = (state: FileSnapshot["state"]): string => {
  switch (state) {
    case "unchanged": return t("syncResolution.state.unchanged")
    case "added-local": return t("syncResolution.state.addedLocal")
    case "added-destination": return t("syncResolution.state.addedDestination")
    case "added-both": return t("syncResolution.state.addedBoth")
    case "added-both-same": return t("syncResolution.state.addedBothSame")
    case "deleted-both": return t("syncResolution.state.deletedBoth")
    case "deleted-local": return t("syncResolution.state.deletedLocal")
    case "deleted-destination": return t("syncResolution.state.deletedDestination")
    case "deleted-local-changed-destination": return t("syncResolution.state.deletedLocalChangedDestination")
    case "deleted-destination-changed-local": return t("syncResolution.state.deletedDestinationChangedLocal")
    case "changed-local": return t("syncResolution.state.changedLocal")
    case "changed-destination": return t("syncResolution.state.changedDestination")
    case "changed-both-same": return t("syncResolution.state.changedBothSame")
    case "changed-both": return t("syncResolution.state.changedBoth")
  }
}

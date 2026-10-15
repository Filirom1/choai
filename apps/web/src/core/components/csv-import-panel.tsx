import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"

import { Button } from "~/core/components/ui/button"
import { TroubleNote } from "~/core/components/trouble-note"
import { dock } from "~/core/dock"
import { journal } from "~/core/journal/store"
import { TRANSACTIONS } from "~/core/journal/layout"
import { bookSettings } from "~/core/journal/book-settings"
import { addressOfSourceFile } from "~/core/address/address"
import { useMoves } from "~/core/address/moves"
import { getOrUndefined } from "~/core/lib/monad"
import { readText } from "~/core/lib/text"
import { t } from "~/core/i18n"
import { propose } from "~/core/journal/proposals"
import { differsFrom, unsavedText } from "~/core/journal/unsaved-text"
import {
  csvPathsIn,
  keepImportFiles,
  readCsvWithRules,
  rulesCandidatesFor,
  rulesPathFor,
  rulesTemplate,
  type ImportPreview,
} from "~/core/statement/hledger-import"
import { selectedCsv, selectCsv } from "~/core/statement/import-selection"
import { SURE } from "~/core/journal/proposals"
import type { Trouble } from "~/core/hledger/wire"

export function CsvImportPanel(): JSX.Element {
  const moves = useMoves()
  const [rulesPath, setRulesPath] = createSignal<string | undefined>(undefined)
  const [preview, setPreview] = createSignal<ImportPreview | undefined>(undefined)
  const [trouble, setTrouble] = createSignal<Trouble | undefined>(undefined)
  const [working, setWorking] = createSignal(false)
  const [tab, setTab] = createSignal<"transactions" | "journal">("transactions")
  const [catchup, setCatchup] = createSignal(false)
  const open = () => getOrUndefined(journal())
  const settings = () => {
    const result = bookSettings()
    return result.ok ? result.value.imports : { csvFolder: "", rulesFolder: "" }
  }
  const files = () => open()?.source.files ?? {}
  const csvPaths = createMemo(() => csvPathsIn(files(), settings().csvFolder))
  const rulesPaths = createMemo(() => Object.keys(files()).filter((path) => path.toLowerCase().endsWith(".rules") &&
    (settings().rulesFolder === "" || path.startsWith(`${settings().rulesFolder}/`))).sort())
  const csvPath = selectedCsv
  const selectedRules = (): string | undefined => rulesPath() ?? (csvPath() === undefined ? undefined : rulesPathFor(csvPath()!, files(), settings().rulesFolder))
  const unsavedRules = (): string | undefined => {
    const path = selectedRules()
    return path === undefined ? undefined : unsavedText(path)
  }
  const rulesAreUnsaved = (): boolean => {
    const path = selectedRules()
    const current = open()?.source.files[path ?? ""]
    return path !== undefined && differsFrom(path, current ?? "")
  }

  createEffect(() => {
    const path = csvPath()
    setPreview(undefined)
    setTrouble(undefined)
    setCatchup(false)
    setRulesPath(path === undefined || open() === undefined ? undefined : rulesPathFor(path, files(), settings().rulesFolder))
  })

  const chooseCsv = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const folder = settings().csvFolder
    const path = `${folder === "" ? "" : `${folder}/`}${file.name}`
    const saved = await keepImportFiles({ [path]: await readText(file) }, [path])
    if (!saved.ok) {
      setTrouble({ kind: "read-failed", detail: saved.error.kind === "already-exists" ? `${path} already exists` : saved.error.path ?? saved.error.kind })
      return
    }
    selectCsv(path)
  }

  const chooseRules = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const folder = settings().rulesFolder
    const path = `${folder === "" ? "" : `${folder}/`}${file.name}`
    const saved = await keepImportFiles({ [path]: await readText(file) })
    if (!saved.ok) {
      setTrouble({ kind: "read-failed", detail: saved.error.kind === "already-exists" ? `${path} already exists` : saved.error.path ?? saved.error.kind })
      return
    }
    setRulesPath(path)
    setPreview(undefined)
  }

  const createRules = async (): Promise<void> => {
    const csv = csvPath()
    if (csv === undefined) return
    const path = rulesCandidatesFor(csv, settings().rulesFolder)[0]
    if (path === undefined) return
    const stored = await keepImportFiles({ [path]: rulesTemplate() })
    if (!stored.ok) {
      setTrouble({ kind: "read-failed", detail: stored.error.path ?? stored.error.kind })
      return
    }
    setRulesPath(path)
    selectCsv(csv)
    dock.close()
    moves.goTo(addressOfSourceFile(path))
  }

  const test = async (): Promise<void> => {
    const csv = csvPath()
    const rules = selectedRules()
    if (csv === undefined || rules === undefined) return
    setWorking(true)
    setTrouble(undefined)
    setPreview(undefined)
    const result = await readCsvWithRules(csv, rules, unsavedRules())
    setWorking(false)
    if (!result.ok) setTrouble(result.error)
    else setPreview(result.value)
  }

  const offer = async (): Promise<void> => {
    const made = preview()
    if (made === undefined || rulesAreUnsaved()) return
    setWorking(true)
    const result = await propose([{
      is: "hledger-import",
      csvPath: made.csvPath,
      rulesPath: made.rulesPath,
      checkpointPath: made.checkpointPath,
      checkpointText: made.checkpoint,
      transactionCount: catchup() ? 0 : made.transactions.length,
      ...(catchup() ? { catchupCount: made.transactions.length } : {}),
      text: catchup() ? "" : made.transactions.map(({ text }) => text).join(""),
      confidence: SURE,
      why: t("csvImport.origin", { csv: made.csvPath, rules: made.rulesPath }),
    }])
    setWorking(false)
    if (!result.ok) setTrouble({ kind: "unreachable", detail: result.error.at })
    else dock.show("reviewing")
  }

  return (
    <div class="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
      <p class="text-xs text-muted-foreground">{t("csvImport.lead")}</p>
      <Show when={!open()}><p class="text-xs text-amber-600">{t("receipts.noBook")}</p></Show>
      <div class="flex flex-wrap gap-2">
        <label class="inline-flex h-8 cursor-pointer items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent">
          {t("csvImport.chooseCsv")}
          <input class="hidden" type="file" accept=".csv,text/csv" disabled={!open()} onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            void chooseCsv(file)
          }} />
        </label>
        <label class="inline-flex h-8 cursor-pointer items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent">
          {t("csvImport.chooseRules")}
          <input class="hidden" type="file" accept=".rules,text/plain" disabled={!open()} onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            void chooseRules(file)
          }} />
        </label>
      </div>
      <Show when={csvPaths().length > 0}>
        <label class="flex flex-col gap-1 text-xs">
          {t("csvImport.csvFile")}
          <select class="h-8 rounded-md border border-input bg-background px-2" value={csvPath() ?? ""} onChange={(event) => selectCsv(event.currentTarget.value || undefined)}>
            <option value="">{t("csvImport.chooseExisting")}</option>
            <For each={csvPaths()}>{(path) => <option value={path}>{path}</option>}</For>
          </select>
        </label>
      </Show>
      <Show when={csvPath()}>
        {(path) => <>
          <p class="break-all font-mono text-xs">{path()}</p>
          <Show when={selectedRules()} fallback={
            <div class="flex flex-col gap-2 rounded-md border border-border p-2">
              <p class="text-xs">{t("csvImport.noRules", { csv: path() })}</p>
              <Button size="sm" variant="outline" onClick={() => void createRules()}>{t("csvImport.createRules")}</Button>
            </div>
          }>
            {(rules) => <>
              <label class="flex flex-col gap-1 text-xs">
                {t("csvImport.rulesFile")}
                <select class="h-8 rounded-md border border-input bg-background px-2" value={rules()} onChange={(event) => {
                  setRulesPath(event.currentTarget.value || undefined)
                  setPreview(undefined)
                }}>
                  <For each={rulesPaths()}>{(path) => <option value={path}>{path}</option>}</For>
                </select>
              </label>
              <p class="text-xs text-muted-foreground">{t("csvImport.destination", { path: TRANSACTIONS })}</p>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" disabled={working()} onClick={() => void test()}>{working() ? t("csvImport.testing") : t("csvImport.test")}</Button>
                <Button size="sm" variant="outline" onClick={() => {
                  dock.close()
                  moves.goTo(addressOfSourceFile(rules()))
                }}>{t("csvImport.editRules")}</Button>
              </div>
            </>}
          </Show>
        </>}
      </Show>
      <Show when={trouble()}>{(cause) => <TroubleNote trouble={cause()} />}</Show>
      <Show when={preview()}>
        {(result) => <>
          <p class="rounded-md border border-border p-2 text-xs">{result().previousCheckpoint === undefined
            ? t("csvImport.noCheckpoint", { count: result().transactions.length })
            : t("csvImport.checkpoint", { path: result().checkpointPath, state: result().previousCheckpoint?.trim() ?? "" })}</p>
          <label class="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={catchup()} onChange={(event) => setCatchup(event.currentTarget.checked)} />
            <span>{t("csvImport.catchup", { count: result().transactions.length })}</span>
          </label>
          <p class="text-xs text-muted-foreground">{t("csvImport.syncNote")}</p>
          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p class="text-xs">{t("csvImport.summary", { count: catchup() ? 0 : result().transactions.length, csv: result().csvPath, rules: result().rulesPath })}</p>
            <div class="inline-flex rounded-md border border-input p-0.5 text-xs">
              <button class="rounded px-2 py-1" classList={{ "bg-accent font-medium": tab() === "transactions" }} onClick={() => setTab("transactions")}>{t("csvImport.transactions")}</button>
              <button class="rounded px-2 py-1" classList={{ "bg-accent font-medium": tab() === "journal" }} onClick={() => setTab("journal")}>{t("csvImport.generatedJournal")}</button>
            </div>
          </div>
          <Show when={result().transactions.length === 0 || catchup()}>
            <p class="text-xs text-muted-foreground">{catchup() ? t("csvImport.willCatchup", { count: result().transactions.length }) : t("csvImport.empty")}</p>
          </Show>
          <Show when={tab() === "transactions" && !catchup()}>
            <For each={result().transactions}>{({ transaction, text }) => (
              <details class="rounded-md border border-border p-2">
                <summary class="cursor-pointer text-xs">{transaction.tdate} · {transaction.tdescription}</summary>
                <pre class="mt-2 overflow-x-auto whitespace-pre font-mono text-xs">{text}</pre>
              </details>
            )}</For>
          </Show>
          <Show when={tab() === "journal" && !catchup()}>
            <pre class="overflow-x-auto rounded-md bg-muted p-2 whitespace-pre font-mono text-xs">{result().transactions.map((one) => one.text).join("")}</pre>
          </Show>
          <Show when={rulesAreUnsaved()}>
            <p class="text-xs text-amber-600">{t("csvImport.saveRulesFirst")}</p>
          </Show>
          <Button disabled={working() || rulesAreUnsaved() || (result().transactions.length === 0 && result().checkpoint === (result().previousCheckpoint ?? ""))} onClick={() => void offer()}>
            {catchup() ? t("csvImport.proposeCatchup") : t("csvImport.propose", { count: result().transactions.length })}
          </Button>
        </>}
      </Show>
    </div>
  )
}

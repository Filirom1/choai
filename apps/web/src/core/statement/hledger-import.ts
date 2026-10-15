import { importWithHledger } from "~/core/hledger/client"
import type { HledgerImportAnswer, Transaction, Trouble } from "~/core/hledger/wire"
import { declaringCompanion, companionsIn } from "~/core/journal/companions"
import { putFiles, journal } from "~/core/journal/store"
import { safeDocumentPath } from "~/core/journal/documents"
import { getOrUndefined, Err, Ok, type Result } from "~/core/lib/monad"

export interface ImportedTransaction {
  readonly text: string
  readonly transaction: Transaction
}

export interface ImportPreview {
  readonly csvPath: string
  readonly rulesPath: string
  readonly checkpointPath: string
  readonly previousCheckpoint: string | undefined
  readonly checkpoint: string
  readonly transactions: readonly ImportedTransaction[]
}

export const csvPathsIn = (files: Readonly<Record<string, string>>, folder: string): readonly string[] =>
  Object.keys(files)
    .filter((path) => path.toLowerCase().endsWith(".csv"))
    .filter((path) => folder === "" || path.startsWith(`${folder}/`))
    .sort()

const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/") + 1))
const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

export const latestPathFor = (csvPath: string): string =>
  `${directoryOf(csvPath)}.latest.${basenameOf(csvPath)}`

export const rulesCandidatesFor = (csvPath: string, rulesFolder: string): readonly string[] => {
  const folder = rulesFolder || directoryOf(csvPath).replace(/\/$/, "")
  const basename = basenameOf(csvPath)
  const stem = basename.replace(/\.csv$/i, "")
  return [...new Set([
    `${folder === "" ? "" : `${folder}/`}${basename}.rules`,
    `${folder === "" ? "" : `${folder}/`}${stem}.rules`,
  ])]
}

export const rulesPathFor = (
  csvPath: string,
  files: Readonly<Record<string, string>>,
  rulesFolder: string,
): string | undefined => rulesCandidatesFor(csvPath, rulesFolder).find((path) => files[path] !== undefined)

export const csvPathForRules = (
  rulesPath: string,
  files: Readonly<Record<string, string>>,
  csvFolder: string,
  rulesFolder: string,
): string | undefined => csvPathsIn(files, csvFolder).find((csvPath) =>
  rulesCandidatesFor(csvPath, rulesFolder).includes(rulesPath),
)

export const rulesTemplate = (): string =>
  "# hledger CSV rules\nfields date, description, amount\ndate-format %Y-%m-%d\naccount1 assets:bank:checking\naccount2 expenses:unknown\n"

type KeepTrouble = { readonly kind: "no-book" | "unsafe-path" | "already-exists" | "journal"; readonly path?: string; readonly trouble?: Trouble }

export const keepImportFiles = async (
  additions: Readonly<Record<string, string>>,
  replacing: readonly string[] = [],
): Promise<Result<void, KeepTrouble>> => {
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ kind: "no-book" })
  const paths = Object.keys(additions)
  const unsafe = paths.find((path) => !safeDocumentPath(path))
  if (unsafe !== undefined) return Err({ kind: "unsafe-path", path: unsafe })
  const collision = paths.find((path) => open.source.files[path] !== undefined && open.source.files[path] !== additions[path] && !replacing.includes(path))
  if (collision !== undefined) return Err({ kind: "already-exists", path: collision })
  const entry = open.source.entry.replace(/^\//, "")
  const declared = companionsIn(open.source.files[entry] ?? "")
  const declarations = paths.filter((path) => !declared.includes(path))
  const text = declarations.reduce((current, path) => declaringCompanion(current, path), open.source.files[entry] ?? "")
  const written = await putFiles({ ...additions, ...(text === (open.source.files[entry] ?? "") ? {} : { [entry]: text }) })
  return written.ok ? Ok(undefined) : Err({ kind: "journal", trouble: written.error })
}

export const readCsvWithRules = async (
  csvPath: string,
  rulesPath: string,
  rulesText?: string,
): Promise<Result<ImportPreview, Trouble>> => {
  const open = getOrUndefined(journal())
  if (open === undefined) return Err({ kind: "no-journal" })
  const csvText = open.source.files[csvPath]
  const rules = rulesText ?? open.source.files[rulesPath]
  if (csvText === undefined) return Err({ kind: "file-missing", path: csvPath })
  if (rules === undefined) return Err({ kind: "file-missing", path: rulesPath })
  const files = { ...open.source.files, [rulesPath]: rules }
  const expandedRules = expandRules(files, rulesPath, [])
  if (expandedRules.kind === "unsafe") return Err({ kind: "read-failed", path: rulesPath, detail: expandedRules.reason })
  if (expandedRules.kind === "expanded" && /^\s*archive\s*(?:#.*)?$/im.test(expandedRules.text)) {
    return Err({ kind: "read-failed", path: rulesPath, detail: "Rules with an archive directive are not supported by the isolated preview; archive output would need its own explicit proposal." })
  }
  if (expandedRules.kind === "expanded" && /^\s*source\s+[^#\n]*\|/im.test(expandedRules.text)) {
    return Err({ kind: "read-failed", path: rulesPath, detail: "Rules with source shell commands are not supported; preview does not execute commands." })
  }
  const staged = await importWithHledger(files, csvPath, rulesPath)
  if (!staged.ok) return staged
  return Ok(previewOf(staged.value, csvPath, rulesPath, open.source.files))
}

type ExpandedRules = { readonly kind: "expanded"; readonly text: string } | { readonly kind: "unsafe"; readonly reason: string } | { readonly kind: "missing" }

const expandRules = (
  files: Readonly<Record<string, string>>,
  path: string,
  seen: readonly string[],
): ExpandedRules => {
  if (seen.includes(path)) return { kind: "unsafe", reason: `Rules include cycle at ${path}.` }
  const text = files[path]
  if (text === undefined) return { kind: "missing" }
  return text.split("\n").reduce<ExpandedRules>((before, line) => {
    if (before.kind !== "expanded") return before
    const include = /^include\s+(.+)$/.exec(line)?.[1]
    if (include === undefined) return { kind: "expanded", text: `${before.text}${line}\n` }
    const target = relativeRulesPath(path, include)
    if (target === undefined) return { kind: "unsafe", reason: `Rules include path is outside the book: ${include}.` }
    const nested = expandRules(files, target, [...seen, path])
    return nested.kind === "expanded"
      ? { kind: "expanded", text: `${before.text}${nested.text}` }
      : nested
  }, { kind: "expanded", text: "" })
}

const relativeRulesPath = (from: string, target: string): string | undefined => {
  if (target.startsWith("/") || target.includes("\\\\")) return undefined
  const parent = from.split("/").slice(0, -1)
  const parts = [...parent, ...target.split("/")].reduce<readonly string[] | undefined>((stack, part) => {
    if (stack === undefined) return undefined
    if (part === "" || part === ".") return stack
    if (part === "..") return stack.length === 0 ? undefined : stack.slice(0, -1)
    return [...stack, part]
  }, [])
  return parts?.join("/")
}

const previewOf = (
  answer: HledgerImportAnswer,
  csvPath: string,
  rulesPath: string,
  files: Readonly<Record<string, string>>,
): ImportPreview => ({
  csvPath,
  rulesPath,
  checkpointPath: answer.checkpointPath,
  previousCheckpoint: files[answer.checkpointPath],
  checkpoint: answer.checkpoint,
  transactions: answer.transactions,
})

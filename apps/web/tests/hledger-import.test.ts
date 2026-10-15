import { describe, expect, test } from "bun:test"

import { csvPathForRules, csvPathsIn, latestPathFor, rulesCandidatesFor, rulesPathFor, rulesTemplate } from "~/core/statement/hledger-import"
import { hledgerLatestPaths, isHledgerLatestPath, isHiddenPath } from "~/core/journal/hidden"
import { validImportSettings } from "~/core/journal/book-config"

describe("hledger CSV imports", () => {
  test("finds CSVs beneath the configured folder", () => {
    const files = { "bank/one.csv": "", "bank/nested/two.CSV": "", "other/three.csv": "" }
    expect(csvPathsIn(files, "bank")).toEqual(["bank/nested/two.CSV", "bank/one.csv"])
    expect(csvPathsIn(files, "")).toEqual(["bank/nested/two.CSV", "bank/one.csv", "other/three.csv"])
  })

  test("prefers the hledger sidecar name and accepts the shorter sibling name", () => {
    expect(rulesCandidatesFor("bank/statement.csv", "")).toEqual([
      "bank/statement.csv.rules",
      "bank/statement.rules",
    ])
    expect(rulesPathFor("bank/statement.csv", { "rules/statement.csv.rules": "" }, "rules")).toBe("rules/statement.csv.rules")
    expect(csvPathForRules("rules/statement.rules", { "bank/statement.csv": "" }, "", "rules")).toBe("bank/statement.csv")
  })

  test("names the native hledger checkpoint beside its CSV and keeps the exception narrow", () => {
    const checkpoint = latestPathFor("imports/csv/releve.csv")
    expect(checkpoint).toBe("imports/csv/.latest.releve.csv")
    expect(isHledgerLatestPath(checkpoint)).toBe(true)
    expect(isHledgerLatestPath(".latest.secret.json")).toBe(false)
    expect(hledgerLatestPaths([
      checkpoint,
      "imports/csv/releve.csv",
      "imports/csv/.latest.orphan.csv",
    ])).toEqual([checkpoint, "imports/csv/.latest.orphan.csv"])
    expect(isHiddenPath(checkpoint)).toBe(true)
    expect(isHiddenPath(checkpoint, hledgerLatestPaths([checkpoint, "imports/csv/releve.csv"]))).toBe(false)
    expect(isHiddenPath("imports/csv/.latest.orphan.csv", hledgerLatestPaths([
      "imports/csv/.latest.orphan.csv",
    ]))).toBe(false)
    expect(isHiddenPath(".env", hledgerLatestPaths([".env"]))).toBe(true)
    expect(isHiddenPath(".private/.latest.secret.csv", [".private/.latest.secret.csv"])).toBe(true)
  })

  test("starts a real editable hledger rules file", () => {
    expect(rulesTemplate()).toContain("fields date, description, amount")
    expect(rulesTemplate()).toContain("account1 assets:bank:checking")
  })

  test("keeps import folders relative to the book", () => {
    expect(validImportSettings({ csvFolder: "imports/csv", rulesFolder: "imports/rules" })).toBe(true)
    expect(validImportSettings({ csvFolder: "../outside", rulesFolder: "" })).toBe(false)
    expect(validImportSettings({ csvFolder: "/tmp", rulesFolder: "" })).toBe(false)
  })
})

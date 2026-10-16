import { describe, expect, test } from "bun:test"

import { en } from "../src/core/i18n/en"
import { fr } from "../src/core/i18n/fr"
import { ja } from "../src/core/i18n/ja"

type Leaf = string | number | boolean | undefined

const flatten = (value: unknown, prefix = ""): readonly (readonly [string, Leaf])[] =>
  typeof value === "object" && value !== null
    ? Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key))
    : [[prefix, value as Leaf]]

const english = Object.fromEntries(flatten(en))

const unchangedEnglish = (dictionary: unknown): readonly string[] => {
  const translated = Object.fromEntries(flatten(dictionary))
  return Object.keys(english).filter((key) => translated[key] === english[key]).sort()
}

const unchangedByDesign = {
  fr: [
    "compose.addNamedTag",
    "compose.code",
    "compose.date",
    "compose.note",
    "compose.takePhoto",
    "customReport.headers.budget",
    "customReport.headers.code",
    "customReport.headers.date",
    "customReport.headers.description",
    "customReport.headers.total",
    "github.destinationCopy",
    "gdrive.title",
    "git.message",
    "licenses.title",
    "nav.journal",
    "receipts.date",
    "receipts.tabs.csv",
    "receipts.total",
    "remotes.drive",
    "remotes.github",
    "report.total",
    "settings.application",
    "statement.from.jev",
    "statement.roles.date",
    "statement.roles.note",
  ],
  ja: ["gdrive.title", "receipts.tabs.csv", "remotes.drive", "remotes.github", "statement.from.jev"],
} as const

describe("translations", () => {
  test("French contains no accidental English fallbacks", () => {
    expect(unchangedEnglish(fr)).toEqual([...unchangedByDesign.fr].sort())
  })

  test("Japanese contains no accidental English fallbacks", () => {
    expect(unchangedEnglish(ja)).toEqual([...unchangedByDesign.ja].sort())
  })
})

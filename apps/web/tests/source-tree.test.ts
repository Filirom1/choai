import { expect, test } from "bun:test"

import { sourceTree } from "~/core/journal/source-tree"

test("materializes nested folders while keeping files in name order", () => {
  expect(sourceTree([
    "transactions.journal",
    "import/0002.csv.rules",
    "import/staging/0002.csv",
    "import/0001.csv.rules",
    "accounts.journal",
  ])).toEqual([
    { kind: "file", path: "accounts.journal" },
    { kind: "folder", path: "import", children: [
      { kind: "file", path: "import/0001.csv.rules" },
      { kind: "file", path: "import/0002.csv.rules" },
      { kind: "folder", path: "import/staging", children: [
        { kind: "file", path: "import/staging/0002.csv" },
      ] },
    ] },
    { kind: "file", path: "transactions.journal" },
  ])
})

test("returns an empty tree for an empty path list", () => {
  expect(sourceTree([])).toEqual([])
})

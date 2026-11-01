import { describe, expect, test } from "bun:test"

import type { Transaction } from "~/core/hledger/wire"
import { renameDocumentReferences } from "~/core/journal/documents"
import { spanOf } from "~/core/journal/lines"

const original = "justificatifs/ancienne facture.pdf"

const transaction = (
  path: string,
  from: number,
  through: number,
  ttags: Transaction["ttags"] = [["evidence", original]],
): Transaction => ({
  tindex: from,
  tstatus: "Unmarked",
  tcode: "",
  tsourcepos: [
    { sourceName: `/${path}`, sourceLine: from, sourceColumn: 1 },
    { sourceName: `/${path}`, sourceLine: through + 1, sourceColumn: 1 },
  ],
  tdate: "2026-01-01",
  tdescription: "A transaction",
  tcomment: "",
  ttags,
  tpostings: [],
})

describe("renaming a document", () => {
  test("updates every linked transaction and preserves the edited entry", () => {
    const files = {
      "transactions.journal": [
        `2026-01-01 First  ; evidence:${original}`,
        "    assets:cash  1 EUR",
        "",
        `2026-01-02 Second  ; evidence:${original}`,
        "    expenses:food  1 EUR",
        "",
      ].join("\n"),
      "other.journal": "2026-01-03 Unrelated\n    assets:cash  1 EUR\n",
    }
    const editedSpan = spanOf(transaction("transactions.journal", 1, 2).tsourcepos)
    const edited = [
      `2026-01-01 * First  ; evidence:justificatifs/nouvelle facture.pdf`,
      "    assets:cash  1 EUR",
    ].join("\n")

    const renamed = renameDocumentReferences(
      files,
      [
        transaction("transactions.journal", 1, 2),
        transaction("transactions.journal", 4, 5),
        transaction("other.journal", 1, 2, []),
      ],
      "evidence",
      original,
      "justificatifs/nouvelle facture.pdf",
      { span: editedSpan, text: edited },
    )

    expect(renamed).toMatchObject({ ok: true })
    if (!renamed.ok) return
    expect(renamed.value["transactions.journal"]).toContain(
      "2026-01-01 * First  ; evidence:justificatifs/nouvelle facture.pdf",
    )
    expect(renamed.value["transactions.journal"]).toContain(
      "2026-01-02 Second  ; evidence:justificatifs/nouvelle facture.pdf",
    )
    expect(renamed.value["other.journal"]).toBe(files["other.journal"])
  })
})

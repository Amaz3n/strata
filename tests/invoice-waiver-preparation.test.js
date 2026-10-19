"use strict"

/**
 * Preparing the builder's lien waiver: the amount typed into the form
 * (`lib/lien-waivers/preparation.ts`) and the editable waiver PDF rendered from
 * a company template (`lib/pdfs/editable-invoice-waiver.ts`).
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubModule } = require("./support/modules")

// The loader's dynamic import() compiles to require(), which cannot load
// MuPDF's ESM build; the stub keeps it a real dynamic import.
stubModule("lib/services/mupdf-loader.ts", { loadMupdf: () => import("mupdf") })

const { parseWaiverAmount, formatWaiverAmount, editableWaiverValues } = require("@/lib/lien-waivers/preparation")
const { renderEditableInvoiceWaiver } = require("@/lib/pdfs/editable-invoice-waiver")
const { waiverSignatureFields } = require("@/lib/pdfs/waiver-signature-fields")

const input = {
  project_name: "Actual project",
  property_description: "123 Actual Street",
  claimant_name: "Builder LLC",
  customer_name: "Client",
  owner_name: "Owner",
  amount_cents: 12345678,
  through_date: "2026-09-07",
  exceptions: "Retainage excluded",
  signer_name: "Signer",
}

test("a typed waiver amount is exact to the cent, and anything else is refused", () => {
  for (const [value, cents] of [
    ["170,000.00", 17000000],
    ["0.01", 1],
    ["1234.5", 123450],
  ]) {
    assert.equal(parseWaiverAmount(value), cents, value)
  }
  for (const value of ["", "-2", "1e4", "20.999", "abc"]) {
    assert.ok(Number.isNaN(parseWaiverAmount(value)), value)
  }
  assert.equal(formatWaiverAmount(17000000), "170,000.00")
})

test("a missing work-through date is left as a visible blank, never guessed", () => {
  assert.equal(editableWaiverValues({ ...input, through_date: "" }).through_date, "[Work through date]")
})

test("the editable waiver prints the invoice's real values and puts the signature on the last page", async () => {
  const template = {
    name: "Company waiver",
    title: "Conditional waiver",
    body:
      "Project {{project_name}}. Payment {{amount}}. Through {{through_date}}. Signed {{signed_date}}. Exceptions {{exceptions}}. " +
      "Preserved company wording. ".repeat(600),
    waiverType: "conditional_progress",
    status: "published",
    reviewed: true,
  }
  const bytes = await renderEditableInvoiceWaiver(template, input, "INV-TEST")
  const fields = await waiverSignatureFields(bytes, 1)

  const mupdf = await import("mupdf")
  const doc = mupdf.Document.openDocument(bytes, "application/pdf")
  try {
    const pages = doc.countPages()
    assert.ok(pages > 1)
    const first = doc.loadPage(0)
    try {
      assert.ok(first.search("Actual project").length)
      assert.ok(first.search("$123,456.78").length)
      assert.equal(first.search("TEMPLATE PREVIEW").length, 0)
    } finally {
      first.destroy()
    }

    assert.deepEqual(
      fields.map((field) => [field.field_type, field.page_index]).slice(1),
      [
        ["signature", pages - 1],
        ["date", pages - 1],
      ],
    )
    assert.equal(fields[0].page_index, 0)
    for (const field of fields) {
      assert.ok(field.x >= 0 && field.y >= 0 && field.x + field.w <= 1 && field.y + field.h <= 1)
    }
  } finally {
    doc.destroy()
  }
})

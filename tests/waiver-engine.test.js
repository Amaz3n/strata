const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const test = require("node:test")

const { renderToBuffer } = require("@react-pdf/renderer")
const { PDFDocument, StandardFonts } = require("pdf-lib")

const { freshRequire } = require("./support/modules")
const { stubMupdfLoader } = require("./support/drawings")

stubMupdfLoader()

const { waiverTemplateSchema } = require("@/lib/templates/waiver-template")
const { documentFromBody, newWaiverBlock } = require("@/lib/templates/waiver-document")
const {
  resolveWaiverValues,
  templateMatches,
  templatePriority,
  validateWaiverSigners,
  validateWaiverValues,
  visibleWaiverBlock,
} = require("@/lib/templates/waiver-engine")
const { renderOriginalWaiver } = require("@/lib/pdfs/waiver-original")
const { WaiverTemplateDocument } = require("@/lib/pdfs/waiver-template")
const { waiverSignatureFields } = freshRequire("lib/pdfs/waiver-signature-fields.ts")

/** The facts Arc supplies for every waiver. */
const facts = {
  project_name: "Actual project",
  amount: "$12,345.67",
  exceptions: "None",
  signed_date: "________________",
  invoice_number: "INV-42",
}

function template() {
  return {
    name: "Test form",
    title: "Waiver",
    body: "",
    waiverType: "conditional_progress",
    status: "published",
    reviewed: true,
    document: documentFromBody("Project {{project_name}}. Payment {{amount}}."),
  }
}

function field(key, type = "text", source = "manual", value = "") {
  return { key, label: key, type, source, value, required: true, options: [] }
}

async function pdfText(bytes) {
  const mupdf = await import("mupdf")
  const pdf = mupdf.Document.openDocument(bytes, "application/pdf")
  try {
    let text = ""
    for (let index = 0; index < pdf.countPages(); index++) {
      const page = pdf.loadPage(index)
      const structured = page.toStructuredText()
      try {
        text += structured.asText()
      } finally {
        structured.destroy()
        page.destroy()
      }
    }
    return text
  } finally {
    pdf.destroy()
  }
}

test("custom values never override Arc's facts, and required or typed fields fail closed", () => {
  const draft = template()
  draft.document.fields = [
    field("contract_ref"),
    field("retained", "currency", "constant", "1200.25"),
    field("payment_alias", "currency", "amount"),
  ]
  draft.document.blocks[0].text += " {{contract_ref}} {{retained}} {{payment_alias}}"
  assert.equal(waiverTemplateSchema.safeParse(draft).success, true)

  const values = resolveWaiverValues(draft, facts, { amount: "$0", contract_ref: "REF-91" })
  assert.equal(values.amount, facts.amount)
  assert.equal(values.retained, "$1,200.25")
  assert.equal(values.payment_alias, facts.amount)
  assert.doesNotThrow(() => validateWaiverValues(draft, values))
  assert.throws(() => validateWaiverValues(draft, resolveWaiverValues(draft, facts)), /contract_ref/)

  draft.document.fields = [field("deadline", "date")]
  assert.throws(() => resolveWaiverValues(draft, facts, { deadline: "2026-02-30" }), /valid date/)
  draft.document.fields = [{ ...field("scope", "choice"), options: ["Partial", "Final"] }]
  assert.throws(() => resolveWaiverValues(draft, facts, { scope: "Other" }), /valid option/)
})

test("a template cannot be published with unknown, duplicate or reserved fields or open issues", () => {
  for (const key of ["constructor", "prototype", "project_name"]) {
    const draft = template()
    draft.document.fields = [field(key)]
    assert.equal(waiverTemplateSchema.safeParse(draft).success, false, key)
  }
  const draft = template()
  draft.document.fields = [field("a"), field("a")]
  assert.equal(waiverTemplateSchema.safeParse(draft).success, false)
  draft.document.fields = [field("b", "text", "made_up")]
  assert.equal(waiverTemplateSchema.safeParse(draft).success, false)

  draft.document.fields = []
  draft.document.issues = [{ id: "1", message: "Uncertain clause", resolved: false }]
  assert.equal(waiverTemplateSchema.safeParse(draft).success, false)
  draft.status = "draft"
  assert.equal(waiverTemplateSchema.safeParse(draft).success, true)
})

test("a conditional section needs its data only when shown, and exceptions cannot be dropped", () => {
  const draft = template()
  draft.document.fields = [field("claim")]
  const section = newWaiverBlock("paragraph", "Excluded {{claim}}")
  section.condition = { field: "exceptions", operator: "present", value: "" }
  draft.document.blocks.push(section)

  assert.equal(visibleWaiverBlock(section, facts), false)
  assert.doesNotThrow(() => validateWaiverValues(draft, resolveWaiverValues(draft, facts)))
  const disputed = { ...facts, exceptions: "Disputed work" }
  assert.throws(() => validateWaiverValues(draft, resolveWaiverValues(draft, disputed)), /claim/)

  draft.document.blocks.pop()
  assert.throws(() => validateWaiverValues(draft, disputed), /no exceptions field/)
})

test("direction, property state, project and customer decide which template applies", () => {
  const project = randomUUID()
  const draft = {
    ...template(),
    applicability: "incoming",
    jurisdiction: "FL",
    defaults: { enabled: true, projectIds: [project], customerName: "Builder LLC", signerName: "", signerTitle: "" },
  }
  const context = { direction: "incoming", jurisdiction: "FL", projectId: project, customerName: "builder llc" }

  assert.equal(templateMatches(draft, context), true)
  for (const change of [
    { direction: "outgoing" },
    { jurisdiction: "CA" },
    { projectId: randomUUID() },
    { customerName: "Other" },
  ]) {
    assert.equal(templateMatches(draft, { ...context, ...change }), false, JSON.stringify(change))
  }
  assert.ok(templatePriority(draft) > templatePriority(template()))
})

test("covered items repeat across pages and every signer gets a field on the right page", async () => {
  const draft = template()
  draft.document.blocks.push(newWaiverBlock("page_break"))
  const table = newWaiverBlock("table")
  table.repeat = "covered_items"
  table.columns = ["Invoice", "Amount"]
  table.rows = [["{{item_number}}", "{{item_amount}}"]]
  draft.document.blocks.push(table, newWaiverBlock("signature"), { ...newWaiverBlock("signature"), signerRole: "witness" })
  const items = Array.from({ length: 45 }, (_, index) => ({ item_number: `BILL-${index + 1}`, item_amount: "$500.00" }))
  const values = { ...facts, covered_items: JSON.stringify(items) }

  assert.throws(() => validateWaiverSigners(draft), /witness/)
  assert.doesNotThrow(() =>
    validateWaiverSigners(draft, [{ role: "witness", name: "Test Witness", email: "witness@example.test" }]),
  )
  validateWaiverValues(draft, values)

  const bytes = await renderToBuffer(WaiverTemplateDocument({ draft, values, invoiceNumber: "INV-42" }))
  const text = await pdfText(bytes)
  assert.match(text, /BILL-45/)
  assert.match(text, /Actual project/)
  assert.doesNotMatch(text, /\{\{/)
  assert.ok((await PDFDocument.load(bytes)).getPageCount() > 1)

  const fields = await waiverSignatureFields(bytes, 0, draft)
  assert.equal(fields.filter((f) => f.field_type === "signature").length, 2)
  assert.ok(fields.some((f) => f.signer_role === "witness"))
  assert.ok(fields.every((f) => f.y >= 0 && f.y + f.h <= 1))
})

test("an original PDF keeps its clauses, gains the filled fields, and refuses clipping or missing pages", async () => {
  const source = await PDFDocument.create()
  const font = await source.embedFont(StandardFonts.Helvetica)
  source.addPage().drawText("Original terms must remain unchanged.", { x: 40, y: 700, font, size: 11 })
  const original = await source.save()
  const untouched = Buffer.from(original)
  const draft = template()
  draft.document.mode = "original"
  draft.document.placements = [
    { id: "a", key: "contract_ref", kind: "text", page: 0, x: 0.1, y: 0.3, width: 0.5, height: 0.05 },
    { id: "s", key: "signer_name", kind: "signature", page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.06 },
  ]

  const bytes = await renderOriginalWaiver(original, draft, { contract_ref: "CONTRACT-91" })
  const text = await pdfText(bytes)
  assert.match(text, /Original terms must remain unchanged/)
  assert.match(text, /CONTRACT-91/)
  assert.deepEqual(Buffer.from(original), untouched)
  const [signature] = await waiverSignatureFields(bytes, 0, draft)
  assert.equal(signature.x, 0.1)
  assert.equal(signature.y, 0.8)

  await assert.rejects(renderOriginalWaiver(original, draft, { contract_ref: "Overflow ".repeat(500) }), /does not fit/)
  draft.document.placements[0].page = 4
  await assert.rejects(renderOriginalWaiver(original, draft, { contract_ref: "X" }), /missing page/)
})

test("imported signature blanks activate, and only signing-date tokens become date fields", async () => {
  const draft = template()
  draft.document.blocks = [
    newWaiverBlock(
      "paragraph",
      "Claimant Signature: ________________________________ Date: {{signed_date}}\nOther blank: ________________________________",
    ),
    newWaiverBlock("signature"),
  ]
  assert.equal(waiverTemplateSchema.safeParse(draft).success, true)

  const bytes = await renderToBuffer(WaiverTemplateDocument({ draft, values: facts }))
  const fields = await waiverSignatureFields(bytes, 0, draft)

  assert.equal(fields.filter((f) => f.field_type === "signature").length, 1)
  // One inline date and one on the signature row; none on literal blanks.
  assert.equal(fields.filter((f) => f.field_type === "date").length, 2)
  const text = await pdfText(bytes)
  assert.match(text, /Claimant Signature/)
  assert.match(text, /Other blank/)
})

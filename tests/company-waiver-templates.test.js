const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const { describe, test } = require("node:test")

const { PDFDocument } = require("pdf-lib")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")
const { stubMupdfLoader } = require("./support/drawings")

stubMupdfLoader()

/** Generated PDFs land in the fake `files` table, as storeGeneratedPdf's row does. */
let current = null
let stamp = 0
stubModule("@/lib/services/generated-documents", {
  storeGeneratedPdf: async (input) => {
    assert.ok((await PDFDocument.load(input.pdf)).getPageCount() >= 1)
    const fileId = randomUUID()
    stamp += 1
    current.db.files.push({
      id: fileId,
      org_id: input.orgId,
      folder_path: input.folderPath,
      metadata: input.metadata ?? {},
      archived_at: null,
      created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, stamp)).toISOString(),
    })
    return { fileId, storagePath: `${input.orgId}/${fileId}.pdf` }
  },
})

/** The AI provider. Its structured-output contract is checked on every call. */
const extraction = { calls: 0 }
stubModule("@/lib/services/ai/gateway", {
  runAiObject: async (input) => {
    extraction.calls += 1
    assertStrictSchema(require("ai").zodSchema(input.schema).jsonSchema)
    const { documentFromBody } = require("@/lib/templates/waiver-document")
    const body = "Project: {{project_name}}. Exceptions remain unchanged."
    return {
      ok: true,
      object: {
        isWaiver: true,
        name: "Imported waiver",
        title: "Waiver",
        waiverType: "conditional_progress",
        body,
        // The model redefines a field Arc owns; Arc must drop it.
        document: {
          ...documentFromBody(body),
          fields: [
            { key: "project_name", label: "Project", type: "text", source: "manual", value: "", required: true, options: [] },
          ],
        },
        warnings: ["Review the notary wording."],
        pagesRead: [1],
      },
    }
  },
})

const background = []
stubModule("next/server", { after: (callback) => background.push(callback) })
stubModule("next/cache", { revalidatePath() {} })

const { COMPANY_WAIVER_TEMPLATE_FOLDER, listEditableWaiverTemplates } = freshRequire(
  "lib/services/company-waiver-templates.ts",
)
const {
  beginCompanyWaiverImport,
  getCompanyWaiverImport,
  importCompanyWaiverTemplate,
  listCompanyWaiverTemplates,
  listWaiverExampleInvoices,
  saveCompanyWaiverTemplate,
} = freshRequire("app/(app)/settings/templates/waiver-actions.ts")

/**
 * Strict structured output: every object lists all of its properties as
 * required, and the document version is a plain integer (no enum or const).
 */
function assertStrictSchema(schema) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return
    if (node.properties) {
      assert.deepEqual([...(node.required ?? [])].sort(), Object.keys(node.properties).sort())
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit)
      else visit(child)
    }
  }
  visit(schema)
  const version = schema.properties.document.properties.version
  assert.equal(version.type, "integer")
  assert.equal(version.enum, undefined)
  assert.equal(version.const, undefined)
}

const FOREIGN_ORG = id(1)
const PROJECT = id(2)

const draft = {
  name: "Company conditional",
  title: "Conditional waiver",
  waiverType: "conditional_progress",
  body: "Project: {{project_name}}. Amount: {{amount}}.",
  status: "draft",
  reviewed: false,
}
const published = { ...draft, status: "published", reviewed: true }

function harness({ files = [], permissions = ["org.admin"], ...tables } = {}) {
  current = createServiceHarness({ permissions, tables: { files, invoices: [], ...tables } })
  background.length = 0
  extraction.calls = 0
  return current
}

async function pdfForm(name = "waiver.pdf") {
  const pdf = await PDFDocument.create()
  pdf.addPage()
  const form = new FormData()
  form.append("file", new File([await pdf.save()], name, { type: "application/pdf" }))
  return form
}

/** One stored revision of a company template, as the library reads it. */
function templateFile(n, familyId, createdAt, waiver = {}, row = {}) {
  return {
    id: id(1000 + n),
    org_id: ORG,
    folder_path: COMPANY_WAIVER_TEMPLATE_FOLDER,
    archived_at: null,
    created_at: createdAt,
    metadata: {
      editable_waiver: { ...published, applicability: "outgoing", familyId, revision: 1, ...waiver },
    },
    ...row,
  }
}

describe("the company template library", () => {
  const list = (service, options) => listEditableWaiverTemplates({ supabase: service.client, orgId: ORG }, options)

  test("lists every family's current revision, past the response cap, and nothing else", async () => {
    const files = Array.from({ length: 700 }, (_, n) => templateFile(n, `family-${n}`, "2026-10-04T00:00:00Z"))
    files.push(templateFile(900, "old-family", "2020-01-01T00:00:00Z"))
    files.push(templateFile(901, "foreign", "2027-01-01T00:00:00Z", {}, { org_id: FOREIGN_ORG }))
    files.push(templateFile(902, "elsewhere", "2027-01-01T00:00:00Z", {}, { folder_path: "/Other" }))
    files.push(templateFile(903, "archived", "2027-01-01T00:00:00Z", {}, { archived_at: "2027-01-01T00:00:00Z" }))
    const service = createServiceHarness({ tables: { files }, maxRows: 37 })

    const templates = await list(service, { publishedOnly: true, direction: "outgoing" })

    assert.equal(templates.length, 701)
    assert.equal(new Set(templates.map((template) => template.familyId)).size, 701)
    assert.ok(templates.some((template) => template.familyId === "old-family"))
    assert.ok(!templates.some((template) => ["foreign", "elsewhere", "archived"].includes(template.familyId)))
  })

  test("a draft edit keeps the published revision active; a published change retires it", async () => {
    const service = createServiceHarness({
      maxRows: 1,
      tables: {
        files: [
          templateFile(0, "drafting", "2026-01-01T00:00:00Z"),
          templateFile(1, "drafting", "2026-10-01T00:00:00Z", { status: "draft", reviewed: false, revision: 2 }),
          templateFile(2, "redirected", "2026-01-01T00:00:00Z"),
          templateFile(3, "redirected", "2026-10-01T00:00:00Z", { applicability: "incoming", revision: 2 }),
          templateFile(4, "moved", "2026-01-01T00:00:00Z", { jurisdiction: "FL" }),
          templateFile(5, "moved", "2026-10-01T00:00:00Z", { jurisdiction: "TX", revision: 2 }),
        ],
      },
    })
    const ids = async (options) => (await list(service, options)).map((template) => template.id)

    // "drafting" still offers revision 1; "redirected" now only serves incoming bills.
    assert.deepEqual(await ids({ publishedOnly: true, direction: "outgoing" }), [id(1005), id(1000)])
    assert.deepEqual(await ids({ publishedOnly: true, direction: "incoming" }), [id(1003)])
    // "moved" left Florida: its FL revision is retired, not offered as a fallback.
    assert.deepEqual(await ids({ publishedOnly: true, jurisdiction: "FL" }), [id(1003), id(1000)])
    assert.deepEqual(await ids({ publishedOnly: true, jurisdiction: "TX" }), [id(1003), id(1005), id(1000)])
    // The editor sees the newest revision of every family, drafts included.
    assert.deepEqual(await ids(), [id(1001), id(1003), id(1005)])
  })

  test("an incomplete read refuses rather than returning part of the library", async () => {
    const files = Array.from({ length: 300 }, (_, n) => templateFile(n, `family-${n}`, "2026-01-01T00:00:00Z"))

    let reads = 0
    const failing = createServiceHarness({ tables: { files } })
    failing.tamper("files", (result) => (++reads > 2 ? replies.error("later page unavailable")(result) : result))
    await assert.rejects(list(failing), /Unable to load complete company waiver templates/)

    const empty = createServiceHarness({ tables: { files } })
    empty.tamper("files", replies.missing())
    await assert.rejects(list(empty), /Unable to load complete company waiver templates/)

    assert.deepEqual(await list(createServiceHarness({ tables: { files: [] } })), [])
  })
})

describe("saving a company template", () => {
  test("only an org admin can save, and a refused save writes nothing", async () => {
    const service = harness({ permissions: ["project.manage"] })
    await assert.rejects(service.run(() => saveCompanyWaiverTemplate(draft)), /Missing permission: org.admin/)
    assert.deepEqual(service.db.files, [])
  })

  test("publishing creates an immutable new revision in the same family", async () => {
    const service = harness()
    const first = await service.run(() => saveCompanyWaiverTemplate(draft))
    const second = await service.run(() => saveCompanyWaiverTemplate({ ...published, body: `${draft.body} More.` }, first.id))

    assert.equal(first.revision, 1)
    assert.equal(second.revision, 2)
    assert.notEqual(second.id, first.id)
    assert.equal(second.familyId, first.familyId)
    assert.equal(service.db.files.find((file) => file.id === first.id).metadata.editable_waiver.body, draft.body)
    assert.deepEqual(
      (await service.run(() => listCompanyWaiverTemplates())).map((template) => template.id),
      [second.id],
    )

    await assert.rejects(service.run(() => saveCompanyWaiverTemplate(draft, first.id)), /newer revision/)
    await assert.rejects(service.run(() => saveCompanyWaiverTemplate(draft, randomUUID())), /Template not found/)
    await assert.rejects(
      service.run(() => saveCompanyWaiverTemplate(draft, undefined, randomUUID())),
      /Source document not found/,
    )
  })

  test("a draft saves in place and refuses a stale or concurrent edit", async () => {
    const service = harness()
    const large = { ...draft, body: `${"Preserve this clause. ".repeat(900)}{{project_name}}` }
    const first = await service.run(() => saveCompanyWaiverTemplate(large))

    const second = await service.run(() =>
      saveCompanyWaiverTemplate({ ...large, name: "Renamed" }, first.id, undefined, first.editToken),
    )
    assert.equal(second.id, first.id)
    assert.notEqual(second.editToken, first.editToken)
    assert.equal(service.db.files[0].metadata.editable_waiver.name, "Renamed")

    await assert.rejects(
      service.run(() => saveCompanyWaiverTemplate(large, first.id, undefined, first.editToken)),
      /changed elsewhere/,
    )

    // Someone else saves between this read and this write.
    service.tamper(
      "files",
      (result) => {
        service.db.files[0].metadata.editable_waiver.editToken = randomUUID()
        return result
      },
      { on: "select", times: 1 },
    )
    await assert.rejects(
      service.run(() => saveCompanyWaiverTemplate(large, second.id, undefined, second.editToken)),
      /changed elsewhere/,
    )
  })

  test("a legacy draft gains an edit token; a failed write is not reported as a conflict", async (t) => {
    t.mock.method(console, "error", () => {})
    const service = harness()
    const first = await service.run(() => saveCompanyWaiverTemplate(draft))
    delete service.db.files[0].metadata.editable_waiver.editToken

    const saved = await service.run(() => saveCompanyWaiverTemplate(draft, first.id))
    assert.ok(saved.editToken)

    service.tamper("files", replies.error("permission denied"), { on: "update", times: 1 })
    await assert.rejects(
      service.run(() => saveCompanyWaiverTemplate(draft, saved.id, undefined, saved.editToken)),
      /Unable to save this draft/,
    )
  })
})

describe("importing a waiver PDF", () => {
  test("the original is preserved and the result is an unreviewed draft", async () => {
    const service = harness()

    const result = await service.run(async () => importCompanyWaiverTemplate(await pdfForm()))

    assert.equal(result.draft.status, "draft")
    assert.equal(result.draft.reviewed, false)
    assert.deepEqual(result.draft.document.fields, [])
    assert.deepEqual(result.warnings, ["Review the notary wording."])
    const original = service.db.files.find((file) => file.id === result.sourceFileId)
    assert.equal(original.folder_path, "/Templates/Originals")

    const saved = await service.run(() => saveCompanyWaiverTemplate(result.draft, undefined, result.sourceFileId))
    assert.equal(saved.sourceFileId, result.sourceFileId)
  })

  test("a file that is not a PDF is refused before the model reads it", async () => {
    const service = harness()
    const form = new FormData()
    form.append("file", new File(["not a pdf"], "fake.pdf"))

    await assert.rejects(service.run(() => importCompanyWaiverTemplate(form)))
    assert.equal(extraction.calls, 0)
    assert.deepEqual(service.db.files, [])
  })

  test("a background import is resumable, org-scoped, and reports an interrupted read", async () => {
    const service = harness()
    const { sourceFileId } = await service.run(async () => beginCompanyWaiverImport(await pdfForm()))
    assert.equal((await service.run(() => getCompanyWaiverImport(sourceFileId))).status, "reading")

    await service.run(() => background.shift()())
    const ready = await service.run(() => getCompanyWaiverImport(sourceFileId))
    assert.equal(ready.status, "ready")
    assert.equal(ready.draft.reviewed, false)

    const row = service.db.files.find((file) => file.id === sourceFileId)
    row.org_id = FOREIGN_ORG
    await assert.rejects(service.run(() => getCompanyWaiverImport(sourceFileId)), /unavailable/)
    row.org_id = ORG

    const stalled = new Date(Date.now() - 190_000).toISOString()
    row.metadata = { waiver_import: { status: "reading", startedAt: stalled } }
    assert.match((await service.run(() => getCompanyWaiverImport(sourceFileId))).message, /interrupted/)
  })
})

test("example invoices are an admin read, scoped to the organization and project", async () => {
  const invoices = [
    { id: id(10), org_id: ORG, project_id: PROJECT, invoice_number: "SAMPLE-1", created_at: "2026-09-01T00:00:00Z" },
    { id: id(11), org_id: FOREIGN_ORG, project_id: PROJECT, invoice_number: "OTHER-ORG", created_at: "2026-09-02T00:00:00Z" },
  ]
  const denied = harness({ permissions: ["project.read"], invoices })
  await assert.rejects(denied.run(() => listWaiverExampleInvoices(PROJECT)), /Missing permission: org.admin/)

  const admin = harness({ invoices })
  assert.deepEqual(await admin.run(() => listWaiverExampleInvoices(PROJECT)), [{ id: id(10), label: "SAMPLE-1" }])
  assert.deepEqual(await admin.run(() => listWaiverExampleInvoices(id(12))), [])
})

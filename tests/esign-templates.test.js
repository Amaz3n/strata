const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")

const { normalizeSingleSignerTemplate, reserveBulkTemplateDocument } = freshRequire("lib/services/esign-templates.ts")

const PROJECT = id(1)
const TEMPLATE = id(2)
const BATCH = id(3)

const field = { page_index: 0, field_type: "signature", signer_role: "buyer", x: 0.1, y: 0.2, w: 0.3, h: 0.1 }

test("a bulk template has exactly one signer, renamed to signer_1", () => {
  const [normalized] = normalizeSingleSignerTemplate([field], [{ role: "signer", signer_role: "buyer" }])
  assert.equal(normalized.signer_role, "signer_1")

  assert.throws(() => normalizeSingleSignerTemplate([field, { ...field, signer_role: "builder" }], []), /one signer/)
  assert.throws(() => normalizeSingleSignerTemplate([field], [{ role: "signer", signer_role: "other" }]), /one signer/)
  assert.throws(() => normalizeSingleSignerTemplate([], []), /signing fields/)
  // A CC recipient is not a second signer.
  assert.equal(normalizeSingleSignerTemplate([field], [{ role: "cc", signer_role: "lender" }]).length, 1)
})

describe("reserving a bulk document", () => {
  const input = {
    orgId: ORG,
    userId: ACTOR,
    projectId: PROJECT,
    templateId: TEMPLATE,
    batchId: BATCH,
    recipient: { email: "  Person@Example.com " },
  }

  function harness(permissions) {
    const reservations = []
    const service = createServiceHarness({
      tables: { projects: [{ id: PROJECT, org_id: ORG }] },
      permissions,
      rpc: {
        reserve_esign_bulk_document: (args) => {
          reservations.push(args)
          return { data: { id: "existing-document", status: "sent" }, error: null }
        },
      },
    })
    return { service, reservations }
  }

  test("reserves through the atomic RPC with the batch and the normalized email", async () => {
    const { service, reservations } = harness(["project.manage"])

    const document = await service.run(() => reserveBulkTemplateDocument(input))

    assert.deepEqual(document, { id: "existing-document", status: "sent" })
    assert.equal(reservations.length, 1)
    assert.equal(reservations[0].p_batch_id, BATCH)
    assert.equal(reservations[0].p_recipient.email, "person@example.com")
  })

  test("a member who cannot manage the project creates nothing", async () => {
    const { service, reservations } = harness(["project.read"])

    await assert.rejects(service.run(() => reserveBulkTemplateDocument(input)), /Missing permission: project.manage/)
    assert.deepEqual(reservations, [])
  })
})

test("reserve_esign_bulk_document creates one document per batch recipient and refuses bad templates", async (t) => {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const file = await insert(db, "files", { org_id: orgId, file_name: "template.pdf", storage_path: "template.pdf" })
  const template = await insert(db, "esign_templates", {
    org_id: orgId,
    project_id: project.id,
    name: "Purchase agreement",
    document_type: "contract",
    source_file_id: file.id,
    fields: JSON.stringify([field]),
    recipients: JSON.stringify([{ role: "signer", signer_role: "buyer" }]),
  })
  const reserve = (email) =>
    rpc(db, "reserve_esign_bulk_document", {
      p_org_id: orgId,
      p_user_id: userId,
      p_template_id: template.id,
      p_project_id: project.id,
      p_batch_id: BATCH,
      p_recipient: JSON.stringify({ email }),
    })
  const documents = async () => (await db.query("select count(*)::int as n from documents")).rows[0].n

  const first = await reserve("BUYER@example.test")
  const again = await reserve("buyer@example.test")
  assert.equal(again.id, first.id)
  assert.equal(first.status, "draft")
  const { rows: fields } = await db.query("select signer_role from document_fields where document_id = $1", [first.id])
  assert.deepEqual(fields, [{ signer_role: "signer_1" }])

  await db.query("update esign_templates set fields = $2 where id = $1", [
    template.id,
    JSON.stringify([field, { ...field, signer_role: "builder" }]),
  ])
  await assert.rejects(reserve("other@example.test"), /one signer role/)
  assert.equal(await documents(), 1)

  // Archiving stops new reservations; an existing one still resolves.
  await db.query("update esign_templates set archived_at = now() where id = $1", [template.id])
  assert.equal((await reserve("buyer@example.test")).id, first.id)
  await assert.rejects(reserve("new@example.test"), /Active template not found/)
})

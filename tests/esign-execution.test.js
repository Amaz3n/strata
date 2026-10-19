const assert = require("node:assert/strict")
const test = require("node:test")

const { PDFDocument } = require("pdf-lib")

const { stubModule, freshRequire } = require("./support/modules")
const { createDatabase, uuid } = require("./support/pglite")
const { createDatabaseClient, createObjectStore, seedSigningDocument } = require("./support/esign-database")

process.env.DOCUMENT_SIGNING_SECRET ??= "esign-execution-fixture-secret"

const storage = createObjectStore()
const invitations = []
stubModule("@/lib/storage/files-storage", storage.module)
stubModule("@/lib/services/signature-delivery", {
  deliverSigningInvitation: async ({ requestId }) => invitations.push(requestId),
})
stubModule("@/lib/services/estimate-portal", {
  submitEstimateBuilderSignatureBySigningToken: async () => {
    throw new Error("estimate signing is not part of this suite")
  },
})
stubModule("next/cache", { revalidatePath() {} })
stubModule("next/headers", {
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set() {} }),
})

const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")
const { hashSigningToken } = require("@/lib/esign/signing-tokens")
const { ELECTRONIC_SIGNATURE_CONSENT_TEXT } = require("@/lib/esign/consent")
const { finalizeDocumentSigning, ensureFrozenSigningSource, signingDigest } = freshRequire(
  "lib/services/esign-execution.ts",
)
const { submitDocumentSignatureAction } = freshRequire("app/d/[token]/actions.ts")

const TOKEN = "fixture-token"
const SIGNER = "José 张伟"

async function pdfBytes() {
  const pdf = await PDFDocument.create()
  pdf.addPage([600, 800])
  return pdf.save()
}

/**
 * A sent, one-signer agreement on a fresh database. `accepted` records the
 * signer's acceptance; `frozen: false` leaves a legacy document without the
 * frozen-source manifest; `legacyGroup` links the request by group only.
 */
async function signingFixture(t, { accepted = true, frozen = true, legacyGroup = false } = {}) {
  const db = await createDatabase(t)
  const client = createDatabaseClient(db)
  storage.objects.clear()
  storage.uploads = 0
  storage.failNextUpload = false
  invitations.length = 0

  const signing = await seedSigningDocument(db, { tokenHash: hashSigningToken(TOKEN), legacyGroup })
  const bytes = await pdfBytes()
  storage.objects.set(signing.sourcePath, bytes)
  const source = {
    file_id: signing.sourceFileId,
    storage_path: signing.sourcePath,
    sha256: signingDigest(bytes),
    size_bytes: bytes.length,
  }
  if (frozen && !legacyGroup) {
    const { error } = await client.rpc("start_esign_envelope", {
      p_org_id: signing.orgId,
      p_envelope_id: signing.envelopeId,
      p_source: source,
      p_metadata: {},
    })
    assert.equal(error, null)
  } else {
    const metadata = frozen ? JSON.stringify({ esign_source: source }) : "{}"
    await db.query("update documents set status = 'sent', metadata = $2 where id = $1", [signing.documentId, metadata])
    await db.query("update envelopes set status = 'sent', sent_at = now() where id = $1", [signing.envelopeId])
    await db.query("update document_signing_requests set status = 'sent', sent_at = now() where id = $1", [
      signing.requestId,
    ])
  }

  const service = (work) => runWithServiceSupabaseClient(client, work)
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
  const accept = () =>
    client.rpc("record_document_signature_atomic", {
      p_org_id: signing.orgId,
      p_signing_request_id: signing.requestId,
      p_document_id: signing.documentId,
      p_revision: 1,
      p_signer_name: SIGNER,
      p_signer_email: "owner@example.test",
      p_signer_ip: null,
      p_user_agent: null,
      p_consent_text: "Fixture disclosure",
      p_values: { [signing.fieldId]: SIGNER },
      p_audit_data: { consent_version: "fixture" },
      p_signed_at: new Date().toISOString(),
    })
  if (accepted) assert.equal((await accept()).error, null)

  const finalize = () => service(() => finalizeDocumentSigning(signing.orgId, signing.requestId))
  const submit = (input) =>
    service(() =>
      submitDocumentSignatureAction({
        token: TOKEN,
        signerName: SIGNER,
        signerEmail: "owner@example.test",
        consentText: ELECTRONIC_SIGNATURE_CONSENT_TEXT,
        values: { [signing.fieldId]: SIGNER },
        ...input,
      }),
    )
  const count = async (table, where = "true") => (await one(`select count(*)::int as n from ${table} where ${where}`)).n
  return { db, client, signing, source, one, count, finalize, submit, service }
}

test("an executed document is published once, however many times execution runs", async (t) => {
  const { signing, one, count, finalize } = await signingFixture(t)

  await finalize()
  const { executed_file_id: executed } = await one("select executed_file_id from documents where id = $1", [
    signing.documentId,
  ])
  assert.ok(executed)
  assert.equal((await one("select status from envelopes")).status, "executed")
  assert.equal(await count("outbox", "job_type = 'send_esign_executed_email'"), 1)

  const uploads = storage.uploads
  await finalize()
  assert.equal(storage.uploads, uploads)
  assert.equal((await one("select executed_file_id from documents")).executed_file_id, executed)
  assert.equal(await count("outbox", "job_type = 'send_esign_executed_email'"), 1)
})

test("a storage failure releases the execution lease so a retry can publish", async (t) => {
  const { one, finalize } = await signingFixture(t)
  storage.failNextUpload = true

  await assert.rejects(finalize(), /object-store failure/)
  assert.equal((await one("select status from esign_executions")).status, "pending")
  assert.equal((await one("select status from document_signing_requests")).status, "signed")
  assert.equal((await one("select executed_file_id from documents")).executed_file_id, null)

  await finalize()
  assert.ok((await one("select executed_file_id from documents")).executed_file_id)
})

test("a failed publication rolls back and the retry keeps the reserved file identity", async (t) => {
  const { db, one, count, finalize } = await signingFixture(t)
  const { file_id: reserved } = await one("select file_id from esign_executions")
  const files = await count("files")
  await db.exec(`
    create function test_fail_publication() returns trigger language plpgsql as $$
    begin
      if new.job_type = 'process_esign_execution_side_effects' then raise exception 'injected publication failure'; end if;
      return new;
    end $$;
    create trigger test_fail_publication before insert on outbox for each row execute function test_fail_publication();
  `)

  await assert.rejects(finalize(), /publication failure/)
  assert.equal((await one("select executed_file_id from documents")).executed_file_id, null)
  assert.equal(await count("files"), files)

  await db.exec("drop trigger test_fail_publication on outbox")
  await finalize()
  assert.equal((await one("select executed_file_id from documents")).executed_file_id, reserved)
  assert.equal(await count("doc_versions", `file_id = '${reserved}'`), 1)
})

test("a source that no longer matches its frozen digest is never executed", async (t) => {
  const { signing, one, finalize } = await signingFixture(t)
  storage.objects.set(signing.sourcePath, new Uint8Array([1, 2, 3]))

  await assert.rejects(finalize(), /integrity check/)
  assert.equal((await one("select status from esign_executions")).status, "pending")
  assert.equal((await one("select executed_file_id from documents")).executed_file_id, null)
})

test("a cancelled envelope is not published and its link stops accepting", async (t) => {
  const { client, signing, one, finalize, submit } = await signingFixture(t)
  const cancelled = await client.rpc("cancel_esign_envelope", {
    p_org_id: signing.orgId,
    p_envelope_id: signing.envelopeId,
    p_reason: "Cancelled",
    p_request_id: null,
    p_actor_id: null,
  })
  assert.equal(cancelled.error, null)

  await finalize()
  assert.equal((await one("select executed_file_id from documents")).executed_file_id, null)
  await assert.rejects(submit({ values: {} }), /no longer valid/)
})

test("a signer submits once: foreign fields are refused, a valid submission executes", async (t) => {
  const { one, count, submit } = await signingFixture(t, { accepted: false })

  await assert.rejects(submit({ values: { [uuid()]: "Another signer" } }), /not assigned|unassigned/)
  assert.equal(await count("document_signatures"), 0)

  const result = await submit({})
  assert.equal(result.success, true)
  assert.match(result.executedDocumentUrl, /\/api\/esign\/executed\//)
  assert.equal((await one("select status from envelopes")).status, "executed")
  assert.equal(await count("document_signatures"), 1)
})

test("re-opening an accepted legacy link returns its receipt and never records a second signature", async (t) => {
  const { count, finalize, submit } = await signingFixture(t, { legacyGroup: true })
  await finalize()

  const result = await submit({ signerName: "", signerEmail: "", consentText: "", values: { unexpected: "x" } })

  assert.equal(result.success, true)
  assert.match(result.executedDocumentUrl, /\/api\/esign\/executed\//)
  assert.equal(await count("document_signatures"), 1)
})

test("a legacy document freezes its source once, and never after a signature was accepted", async (t) => {
  const unsigned = await signingFixture(t, { accepted: false, frozen: false })
  const { orgId, documentId } = unsigned.signing
  const first = await unsigned.service(() => ensureFrozenSigningSource(orgId, documentId))
  const again = await unsigned.service(() => ensureFrozenSigningSource(orgId, documentId))
  assert.equal(again.storage_path, first.storage_path)
  assert.equal(storage.uploads, 1)

  const signed = await signingFixture(t, { frozen: false })
  await assert.rejects(
    signed.service(() => ensureFrozenSigningSource(signed.signing.orgId, signed.signing.documentId)),
    /new revision/,
  )
  assert.equal((await signed.one("select metadata from documents")).metadata.esign_source, undefined)
})

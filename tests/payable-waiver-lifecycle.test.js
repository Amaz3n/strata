require("../scripts/register-ts-node-test")
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module")
const original = Module._load
Module._load = function (request, parent, isMain) {
  if (
    [
      "@/lib/services/context",
      "@/lib/services/authorization",
      "@/lib/services/audit",
      "@/lib/services/events",
      "@/lib/services/company-waiver-templates",
      "@/lib/services/files",
    ].includes(request)
  )
    return {}
  if (request === "@/lib/storage/files-storage")
    return { downloadFilesObject: async () => Buffer.from("executed artifact") }
  return original.call(this, request, parent, isMain)
}
const {
  payableWaiverInputSchema,
  completePayableWaiverFromSigning,
} = require("../lib/services/payable-waivers")
Module._load = original
const id = "11111111-1111-4111-8111-111111111111"
const input = {
  request_id: id,
  allocations: [{ bill_id: id, amount_cents: 50000 }],
  source: "template",
  template_id: id,
  waiver_type: "conditional_progress",
  through_date: "2026-08-31",
  claimant_name: "Trade LLC",
  customer_name: "Builder LLC",
  owner_name: "Property Owner",
  property_description: "123 Property Street",
  project_name: "Lot 4",
  jurisdiction: "FL",
  signer_name: "Trade Signer",
  signer_title: "President",
  signer_email: "trade@example.com",
}
test("four explicit kinds with separate final and receipt attestations", () => {
  assert.equal(payableWaiverInputSchema.safeParse(input).success, true)
  for (const waiver_type of ["conditional", "unconditional", "final"])
    assert.equal(
      payableWaiverInputSchema.safeParse({ ...input, waiver_type }).success,
      false,
    )
  assert.equal(
    payableWaiverInputSchema.safeParse({
      ...input,
      waiver_type: "conditional_final",
    }).success,
    false,
  )
  assert.equal(
    payableWaiverInputSchema.safeParse({
      ...input,
      waiver_type: "unconditional_progress",
    }).success,
    false,
  )
  assert.equal(
    payableWaiverInputSchema.safeParse({
      ...input,
      waiver_type: "unconditional_final",
      final_confirmed: true,
      received_confirmed: true,
    }).success,
    true,
  )
})
test("duplicate allocations, missing actual upload date, and invalid monetary values are rejected", () => {
  for (const candidate of [
    { ...input, allocations: [input.allocations[0], input.allocations[0]] },
    { ...input, source: "upload" },
    ...[-1, 0, 0.1, NaN, 2147483648].map((amount_cents) => ({
      ...input,
      allocations: [{ bill_id: id, amount_cents }],
    })),
  ])
    assert.equal(payableWaiverInputSchema.safeParse(candidate).success, false)
})
function database({
  executed = "file",
  prior = null,
  document = "document",
  envelopeStatus = "executed",
} = {}) {
  let updates = []
  const db = {
    from(table) {
      const q = {
        select() {
          return q
        },
        eq() {
          return q
        },
        single: async () => ({
          data:
            table === "documents"
              ? {
                  status: "signed",
                  executed_file_id: executed,
                  metadata: { payable_waiver_request_id: id },
                }
              : table === "envelopes"
                ? { status: envelopeStatus, executed_at: "2026-09-01" }
                : { storage_path: "executed.pdf" },
          error: null,
        }),
        update(value) {
          updates.push(value)
          return q
        },
        maybeSingle: async () => ({ data: { id: "waiver" }, error: null }),
        then(resolve, reject) {
          return Promise.resolve({
            data: [
              {
                id: "waiver",
                updated_at: "2026-08-31",
                signed_file_id: prior,
                metadata: {
                  document_id: document,
                  review: { status: "accepted" },
                },
              },
            ],
            error: null,
          }).then(resolve, reject)
        },
      }
      return q
    },
  }
  return { db, updates }
}
const args = {
  orgId: "org",
  documentId: "document",
  envelopeId: "envelope",
  executedFileId: "file",
}
test("native completion binds the exact artifact and leaves review pending", async () => {
  const { db, updates } = database()
  await completePayableWaiverFromSigning({ ...args, supabase: db })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].signed_file_id, "file")
  assert.equal(updates[0].metadata.review.status, "pending")
  assert.equal(updates[0].metadata.sha256.length, 64)
})
test("duplicate completion cannot reset human review", async () => {
  const { db, updates } = database({ prior: "file" })
  await completePayableWaiverFromSigning({ ...args, supabase: db })
  assert.equal(updates.length, 0)
})
test("wrong artifact, document, unexecuted envelope, and overwrites fail closed", async () => {
  for (const options of [
    { executed: "other" },
    { document: "other" },
    { envelopeStatus: "sent" },
    { prior: "old-file" },
  ]) {
    const { db, updates } = database(options)
    await assert.rejects(
      completePayableWaiverFromSigning({ ...args, supabase: db }),
    )
    assert.equal(updates.length, 0)
  }
})

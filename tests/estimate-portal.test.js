const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

process.env.DOCUMENT_SIGNING_SECRET ??= "estimate-portal-fixture-secret"

const { hashSigningToken } = require("@/lib/esign/signing-tokens")
const { countersignEstimate, finalizeEstimateBuilderSignature, submitEstimateBuilderSignatureBySigningToken } =
  freshRequire("lib/services/estimate-portal.ts")

const ESTIMATE = id(1)
const DOCUMENT = id(2)
const REQUEST = id(3)
const ENVELOPE = id(4)
const EXECUTED_FILE = id(5)
const TOKEN = "builder-signing-token"
const SIGNED_AT = "2026-01-02T12:00:00+00:00"

/** A client-signed agreement whose builder signature was accepted (or not yet). */
function harness({ requestStatus = "signed", executedFileId = EXECUTED_FILE, claim = null } = {}) {
  const document = {
    id: DOCUMENT,
    org_id: ORG,
    source_entity_type: "estimate",
    source_entity_id: ESTIMATE,
    source_file_id: id(6),
    executed_file_id: executedFileId,
    metadata: {},
  }
  const service = createServiceHarness({
    tables: {
      estimates: [
        {
          id: ESTIMATE,
          org_id: ORG,
          status: "client_signed",
          is_current_version: true,
          signature_document_id: DOCUMENT,
          signature_data: { client: { signer_name: "Client" } },
          metadata: { commercial: { purpose: "construction_agreement" } },
        },
      ],
      document_signing_requests: [
        {
          id: REQUEST,
          org_id: ORG,
          document_id: DOCUMENT,
          envelope_id: ENVELOPE,
          revision: 1,
          status: requestStatus,
          token_hash: hashSigningToken(TOKEN),
          used_count: 0,
          max_uses: 1,
          document,
        },
      ],
      document_signatures:
        requestStatus === "signed"
          ? [
              {
                id: id(7),
                org_id: ORG,
                signing_request_id: REQUEST,
                created_at: SIGNED_AT,
                signer_name: "Recorded builder",
                signer_email: "builder@harbor-homes.us",
                consent_text: "Recorded consent",
                values: { estimate_builder_signature: "recorded-image" },
                audit_data: { source: "estimate_native_builder_signing" },
              },
            ]
          : [],
    },
    rpc: {
      claim_esign_execution: () => claim ?? { data: null, error: { message: "Execution already in progress" } },
      record_document_signature_atomic: () => ({ data: id(8), error: null }),
    },
  })
  const estimate = () => service.db.estimates[0]
  const rpcCalls = () => service.queries.filter((query) => query.action === "rpc").map((query) => query.table)
  return { service, estimate, rpcCalls }
}

/** Writes to tables (RPC calls are listed separately). */
const tableWrites = (service) => service.writes().filter((query) => query.action !== "rpc")

/** The next UPDATE of `table` fails and leaves the row as it was. */
function failNextUpdate(service, table) {
  const before = structuredClone(service.db[table])
  service.tamper(
    table,
    (result) => {
      service.db[table].splice(0, service.db[table].length, ...structuredClone(before))
      return { ...result, data: null, error: { message: "temporary write failure" } }
    },
    { on: "update", times: 1 },
  )
}

describe("finalizing a builder signature", () => {
  const input = { orgId: ORG, requestId: REQUEST }

  test("a retry resumes from the stored artifact and the recorded signer, not the browser", async () => {
    const { service, estimate, rpcCalls } = harness()
    failNextUpdate(service, "estimates")

    await assert.rejects(service.run(() => finalizeEstimateBuilderSignature(input)), /temporary write failure/)
    assert.equal(estimate().status, "client_signed")

    const result = await service.run(() => finalizeEstimateBuilderSignature(input))

    assert.equal(result.executedFileId, EXECUTED_FILE)
    assert.equal(estimate().status, "executed")
    assert.equal(estimate().executed_at, SIGNED_AT)
    assert.equal(estimate().signature_data.builder.signer_name, "Recorded builder")
    assert.equal(estimate().signature_data.builder.signature_image, "recorded-image")
    assert.equal(estimate().signature_data.client.signer_name, "Client")
    assert.deepEqual(rpcCalls(), [])
  })

  test("another worker's execution lease is respected and nothing is published", async () => {
    const { service, estimate, rpcCalls } = harness({ executedFileId: null })

    await assert.rejects(service.run(() => finalizeEstimateBuilderSignature(input)), /already in progress/)

    assert.deepEqual(rpcCalls(), ["rpc:claim_esign_execution"])
    assert.deepEqual(tableWrites(service), [])
    assert.equal(estimate().status, "client_signed")
  })
})

describe("submitting a builder signature", () => {
  test("an accepted signature resumes without re-validating the retried payload", async () => {
    const { service, rpcCalls } = harness()
    // Finalization fails this time: no stored artifact and no lease.
    service.db.document_signing_requests[0].document.executed_file_id = null

    const result = await service.run(() =>
      submitEstimateBuilderSignatureBySigningToken({ token: TOKEN, signerName: "", consentText: "" }),
    )

    assert.equal(result.success, true)
    assert.equal(result.processing, true)
    assert.ok(!rpcCalls().includes("rpc:record_document_signature_atomic"))
  })

  test("an invalid signature image is refused before acceptance", async () => {
    const { service, rpcCalls } = harness({ requestStatus: "sent" })

    await assert.rejects(
      service.run(() =>
        submitEstimateBuilderSignatureBySigningToken({
          token: TOKEN,
          signerName: "Builder",
          signerEmail: "builder@harbor-homes.us",
          signatureImage: "invalid",
          consentText: "I agree",
        }),
      ),
      /Signature must be a PNG/,
    )
    assert.deepEqual(rpcCalls(), [])
  })

  test("direct countersigning without signing consent is refused", async () => {
    const { service, estimate } = harness({ requestStatus: "sent" })
    await assert.rejects(countersignEstimate({ estimateId: ESTIMATE, signerName: "Builder" }), /Open builder signing/)
    assert.equal(estimate().status, "client_signed")
    assert.deepEqual(tableWrites(service), [])
  })
})

// ---------------------------------------------------------------------------
// The client's review link: deciding, sending and executing a deal document.
// ---------------------------------------------------------------------------

describe("the client's review of a deal document", () => {
  const { createHmac } = require("node:crypto")
  const { ACTOR } = require("./support/service")
  const { DEFAULT_ESTIMATE_COMMERCIAL } = require("@/lib/financials/estimate-commercial")
  const { executeEstimateFromEnvelopeExecution, sendEstimate, submitEstimateDecision } = require(
    "@/lib/services/estimate-portal",
  )

  process.env.ESTIMATE_SECRET ??= "estimate-review-fixture-secret"

  const DOC = id(101)
  const DEAL = id(102)
  const ENVELOPE_DOCUMENT = id(103)
  const REVIEW_TOKEN = "client-review-token"
  /** A review link stores only the HMAC of its token (the legacy single-link column). */
  const reviewHash = createHmac("sha256", process.env.ESTIMATE_SECRET).update(REVIEW_TOKEN).digest("hex")

  const services = (extra = {}) => ({
    precon: {
      ...DEFAULT_ESTIMATE_COMMERCIAL,
      purpose: "preconstruction_agreement",
      pricing_basis: "Defined planning services",
      payment_terms: "On completion",
    },
    recipient: { name: "Owner", email: "owner@example.test" },
    ...extra,
  })

  function review(document = {}, { dealStatus = "estimate_sent" } = {}) {
    return createServiceHarness({
      tables: {
        estimates: [
          {
            id: DOC,
            org_id: ORG,
            prospect_id: DEAL,
            title: "Kitchen",
            status: "sent",
            is_current_version: true,
            created_by: ACTOR,
            total_cents: 100000,
            token_hash: reviewHash,
            updated_at: "2026-10-01T00:00:00+00:00",
            metadata: {},
            items: [],
            ...document,
          },
        ],
        prospects: [{ id: DEAL, org_id: ORG, name: "Kitchen", status: dealStatus, owner_user_id: ACTOR }],
        projects: [],
        app_users: [{ id: ACTOR, email: "builder@example.test", full_name: "Builder" }],
        estimate_comments: [],
        estimate_review_links: [],
        notifications: [],
        org_settings: [],
      },
      permissions: ["org.member", "project.manage"],
      rpc: {
        // The database issues the link and marks a first issue sent.
        issue_estimate_review_link: ({ p_estimate_id }, store) => {
          const estimate = store.estimates.find((row) => row.id === p_estimate_id)
          if (estimate.status === "draft") estimate.status = "sent"
          return { data: { id: p_estimate_id }, error: null }
        },
      },
    })
  }

  const doc = (service) => service.db.estimates[0]
  const decide = (service, input) =>
    service.run(() => submitEstimateDecision({ token: REVIEW_TOKEN, ...input }))
  const sign = { signer_name: "Owner", consent_accepted: true }
  const execute = (service) =>
    service.run(() =>
      executeEstimateFromEnvelopeExecution({
        orgId: ORG,
        estimateId: DOC,
        documentId: ENVELOPE_DOCUMENT,
        envelopeId: id(104),
        executedFileId: id(105),
        signerName: "Builder",
        signerEmail: "builder@example.test",
      }),
    )

  test("approving a budget is nonbinding: it records the accepted options and asks for no signature", async () => {
    const service = review({
      metadata: { precon: { purpose: "budget" } },
      items: [{ id: "upgrade", unit_cost_cents: 5000, quantity: 1, metadata: { is_optional: true } }],
    })
    const result = await decide(service, { decision: "approved", selected_optional_ids: ["upgrade"] })

    assert.equal(result.status, "approved")
    assert.equal(doc(service).client_signed_at, undefined)
    assert.equal(doc(service).metadata.accepted_options.accepted_total_cents, 105000)
    assert.ok(service.events.some((event) => event.eventType === "estimate_budget_approved"))
    assert.deepEqual(
      service.writes().filter((write) => /sign|envelope/.test(write.table)),
      [],
    )
  })

  test("the client's signature stands even when countersigning and activity logging fail", async () => {
    const service = review()
    service.tamper("estimate_comments", (result) => ({ ...result, error: { message: "activity unavailable" } }), {
      on: "insert",
    })
    const result = await decide(service, { decision: "approved", signature: sign })

    assert.equal(result.status, "client_signed")
    assert.equal(doc(service).signature_data.client.signer_name, "Owner")
    assert.ok(doc(service).client_signed_at)
  })

  test("a signed or superseded document cannot be resent", async () => {
    for (const state of [{ status: "executed", executed_at: "2026-09-20" }, { status: "client_signed" }, { is_current_version: false }]) {
      const service = review(state)
      await assert.rejects(service.run(() => sendEstimate({ estimateId: DOC })), /current unsigned/)
      assert.deepEqual(service.writes(), [], JSON.stringify(state))
    }
  })

  test("a superseded envelope cannot execute the document", async () => {
    const service = review({ status: "client_signed", is_current_version: false, signature_document_id: ENVELOPE_DOCUMENT })
    await assert.rejects(execute(service), /current construction agreement/)
    assert.deepEqual(service.writes(), [])
  })

  test("a preconstruction services agreement goes out, is signed and executes without moving the deal", async () => {
    const sent = review({ status: "draft", metadata: services() }, { dealStatus: "pricing" })
    await sent.run(() => sendEstimate({ estimateId: DOC }))
    assert.equal(doc(sent).status, "sent")

    const signed = review({ metadata: services() })
    assert.equal((await decide(signed, { decision: "approved", signature: sign })).status, "client_signed")

    const executed = review({ status: "client_signed", signature_document_id: ENVELOPE_DOCUMENT, metadata: services() })
    await execute(executed)
    assert.equal(doc(executed).status, "executed")

    for (const service of [sent, signed, executed]) assert.deepEqual(service.writes("prospects"), [])
  })

  test("a change request moves the deal back, except on a services agreement", async () => {
    for (const purpose of ["preconstruction_agreement", "budget", "construction_agreement"]) {
      const service = review({ metadata: { precon: { purpose } } })
      await decide(service, { decision: "changes_requested", note: "Please revise the scope" })
      assert.equal(doc(service).status, "changes_requested")
      assert.equal(
        service.db.prospects[0].status,
        purpose === "preconstruction_agreement" ? "estimate_sent" : "changes_requested",
        purpose,
      )
    }
  })
})

"use strict"

/**
 * `lib/services/selection-approvals.ts` — a buyer approves a group's
 * selections exactly as they were sent. What the database enforces (the terms
 * hash, void-on-change, decline/expiry by trigger) is proven in
 * selection-approvals-db.test.js; here: what the service checks before it asks
 * the database, what it passes, how it words a refusal, how a signed envelope
 * ends the job, and who is told how a request ended.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const HOME = id(1)
const GROUP = id(2)
const SELECTION = id(3)
const OPTION = id(4)
const CATEGORY = id(5)
const BUYER = id(6)
const APPROVAL = id(7)
const SENDER = id(8)
const COORDINATOR = id(9)
const ENVELOPE = id(10)
const HASH = "a".repeat(64)

let catalog = {}
stubModule("@/lib/services/option-catalog", {
  resolveOptionPricing: async ({ items }) => items.map((item) => catalog[item.optionId] ?? { available: false, categoryIds: [] }),
})
let configurationFailure = null
stubModule("@/lib/services/configuration-rules", {
  assertProjectConfiguration: async () => {
    if (configurationFailure) throw new Error(configurationFailure)
  },
})
const emails = []
let emailDelivers = true
stubModule("@/lib/services/mailer", {
  getOrgSenderEmail: () => "builder@example.test",
  renderEmailTemplate: async () => "<html />",
  sendEmail: async (payload) => {
    emails.push(payload)
    return emailDelivers
  },
})
stubModule("@/lib/services/portal-links", {
  ensurePortalLink: async () => "https://arc.example/p/token",
})
const notifications = []
stubModule("@/lib/services/notifications", {
  NotificationService: class {
    async createAndQueue(input) {
      notifications.push(input)
      return id(500 + notifications.length)
    }
  },
})

const filedFiles = []
const uploads = []
stubModule("@/lib/services/files", {
  createFileRecord: async (input, orgId, options) => {
    filedFiles.push({ input, orgId, options })
    return { id: id(700 + filedFiles.length) }
  },
})
stubModule("@/lib/storage/files-storage", {
  buildOrgScopedPath: (...parts) => parts.join("/"),
  uploadFilesObject: async (payload) => { uploads.push(payload) },
})

const {
  approveSelectionsFromPortal,
  executeSelectionApprovalFromEnvelope,
  listHomeSelectionApprovals,
  notifySelectionApprovalOutcome,
  resendSelectionApprovalRequest,
  sendSelectionApproval,
  uploadSelectionSignedCopy,
} = freshRequire("lib/services/selection-approvals.ts")

const approvalRow = (overrides = {}) => ({
  id: APPROVAL, org_id: ORG, project_id: HOME, group_id: GROUP, channel: "portal", status: "sent", terms_hash: HASH, total_cents: 6_500_00,
  sent_at: "2026-10-10T12:00:00Z", expires_at: null, approved_at: null, decline_reason: null, void_reason: null, sent_by: SENDER, envelope_id: null,
  ...overrides,
})

function harness({ approvals = [], rpc = {}, buyerEmail = "dana@buyer.dev", permissions = ["selections.read", "selections.write", "project.read"] } = {}) {
  catalog = { [OPTION]: { available: true, optionId: OPTION, priceCents: 4_500_00, categoryIds: [CATEGORY] } }
  configurationFailure = null
  emails.length = 0
  emailDelivers = true
  notifications.length = 0
  const calls = []
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [{ id: HOME, org_id: ORG, name: "Lot 7", property_type: "production" }],
      orgs: [{ id: ORG, name: "Builder", product_tier: "production" }],
      lots: [],
      contacts: [{ id: BUYER, org_id: ORG, full_name: "Dana Buyer", email: buyerEmail }],
      selection_groups: [{ id: GROUP, org_id: ORG, name: "Interior" }],
      project_selection_groups: [{ org_id: ORG, project_id: HOME, group_id: GROUP, status: "open", cutoff_date: "2099-06-30", group: { name: "Interior", sort_order: 1 } }],
      project_selections: [{ id: SELECTION, org_id: ORG, project_id: HOME, group_id: GROUP, category_id: CATEGORY, selected_option_id: OPTION }],
      selection_approvals: approvals,
      selection_approval_lines: [{ approval_id: APPROVAL, org_id: ORG, selection_id: SELECTION }],
    },
    rpc: {
      selection_home_buyer: () => ({ data: BUYER, error: null }),
      ...Object.fromEntries(Object.entries(rpc).map(([name, handler]) => [name, (args, store) => {
        calls.push({ name, args })
        return handler(args, store)
      }])),
    },
  })
  return { service, calls }
}

describe("sendSelectionApproval", () => {
  test("a portal request goes out for the terms the coordinator reviewed, and the buyer gets a portal link", async () => {
    const { service, calls } = harness({ rpc: { send_selection_approval: () => ({ data: approvalRow(), error: null }) } })
    const result = await service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "portal", termsHash: HASH }))
    assert.deepEqual(result, { approvalId: APPROVAL, envelopeId: null, buyerEmail: "sent" })
    assert.equal(calls[0].args.p_expected_terms_hash, HASH)
    assert.equal(calls[0].args.p_actor_id, service.userId)
    assert.deepEqual(emails.map((email) => email.to), [["dana@buyer.dev"]])
    assert.match(emails[0].subject, /approve your interior selections/)
    assert.equal(service.audits.length, 1)
  })

  test("the request stands when the buyer's email fails or the buyer has none, and the coordinator is told which", async () => {
    const failing = harness({ rpc: { send_selection_approval: () => ({ data: approvalRow(), error: null }) } })
    emailDelivers = false
    const failed = await failing.service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "portal", termsHash: HASH }))
    assert.equal(failed.buyerEmail, "failed")
    assert.match(emails[0].idempotencyKey, /selection-approval-request/)

    const noEmail = harness({ buyerEmail: null, rpc: { send_selection_approval: () => ({ data: approvalRow(), error: null }) } })
    const missing = await noEmail.service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "portal", termsHash: HASH }))
    assert.equal(missing.buyerEmail, "no_email")

    const placeholder = harness({ buyerEmail: "dana@example.com", rpc: { send_selection_approval: () => ({ data: approvalRow(), error: null }) } })
    const unusable = await placeholder.service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "portal", termsHash: HASH }))
    assert.equal(unusable.buyerEmail, "no_email")
    assert.deepEqual(emails, [])
  })

  test("an option no longer sold for the home is refused before anything is sent", async () => {
    const { service, calls } = harness({ rpc: { send_selection_approval: () => ({ data: approvalRow(), error: null }) } })
    catalog = {}
    await assert.rejects(service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "esign", termsHash: HASH })), /no longer available/)
    assert.deepEqual(calls, [])
  })

  test("choices that are invalid together are refused before anything is sent", async () => {
    const { service, calls } = harness({ rpc: { send_selection_approval: () => ({ data: approvalRow(), error: null }) } })
    configurationFailure = "Chef kitchen requires Electrical upgrade."
    await assert.rejects(service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "portal", termsHash: HASH })), /requires Electrical upgrade/)
    assert.deepEqual(calls, [])
  })

  test("a review the selections moved past is refused in the coordinator's words", async () => {
    const { service } = harness({
      rpc: { send_selection_approval: () => ({ data: null, error: { message: "These selections changed since they were shown; review them and try again", details: "SELECTION_TERMS_CHANGED" } }) },
    })
    await assert.rejects(
      service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "portal", termsHash: HASH })),
      (error) => error.code === "SELECTION_TERMS_CHANGED" && /changed since they were shown/.test(error.message),
    )
    assert.deepEqual(emails, [])
  })

  test("without selections.write nothing is sent", async () => {
    const { service, calls } = harness({ permissions: ["selections.read", "project.read"], rpc: { send_selection_approval: () => ({ data: approvalRow(), error: null }) } })
    await assert.rejects(service.run(() => sendSelectionApproval({ projectId: HOME, groupId: GROUP, channel: "portal", termsHash: HASH })), /Missing permission/)
    assert.deepEqual(calls, [])
  })
})

describe("resendSelectionApprovalRequest", () => {
  test("mails the buyer again under a key of its own, so a failed send can be retried", async () => {
    const { service } = harness({ approvals: [approvalRow()] })
    emailDelivers = false
    assert.equal((await service.run(() => resendSelectionApprovalRequest({ approvalId: APPROVAL }))).buyerEmail, "failed")
    emailDelivers = true
    assert.equal((await service.run(() => resendSelectionApprovalRequest({ approvalId: APPROVAL }))).buyerEmail, "sent")
    assert.equal(new Set(emails.map((email) => email.idempotencyKey)).size, 2)
    assert.ok(emails.every((email) => email.idempotencyKey.startsWith(`selection-approval-request:${APPROVAL}:`)))
  })

  test("only a portal request still out is mailed, and only by someone who can write selections", async () => {
    const answered = harness({ approvals: [approvalRow({ status: "approved" })] })
    await assert.rejects(answered.service.run(() => resendSelectionApprovalRequest({ approvalId: APPROVAL })), /still waiting on the buyer/)
    const signing = harness({ approvals: [approvalRow({ channel: "esign" })] })
    await assert.rejects(signing.service.run(() => resendSelectionApprovalRequest({ approvalId: APPROVAL })), /still waiting on the buyer/)
    const reader = harness({ approvals: [approvalRow()], permissions: ["selections.read", "project.read"] })
    await assert.rejects(reader.service.run(() => resendSelectionApprovalRequest({ approvalId: APPROVAL })), /Missing permission/)
    assert.deepEqual(emails, [])
  })
})

describe("uploadSelectionSignedCopy", () => {
  const signedCopy = () => new File([new Uint8Array([37, 80, 68, 70])], "signed.pdf", { type: "application/pdf" })

  test("files the copy as a contracts upload on selections.write alone, without docs.upload", async () => {
    filedFiles.length = 0
    const { service } = harness()
    const { fileId } = await service.run(() => uploadSelectionSignedCopy({ projectId: HOME, file: signedCopy() }))
    assert.equal(fileId, id(701))
    assert.deepEqual([filedFiles[0].input.category, filedFiles[0].input.project_id, filedFiles[0].options.authorizationPermission], ["contracts", HOME, "selections.write"])
    assert.equal(uploads.at(-1).contentType, "application/pdf")
  })

  test("refuses a file that is not a PDF or a photo, and a caller who cannot write selections", async () => {
    const { service } = harness()
    await assert.rejects(service.run(() => uploadSelectionSignedCopy({ projectId: HOME, file: new File(["x"], "notes.txt", { type: "text/plain" }) })), /PDF or a photo/)
    const reader = harness({ permissions: ["selections.read", "project.read"] })
    await assert.rejects(reader.service.run(() => uploadSelectionSignedCopy({ projectId: HOME, file: signedCopy() })), /Missing permission/)
  })
})

test("the buyer's portal approval names the buyer and carries the hash the page showed", async () => {
  const { service, calls } = harness({ rpc: { approve_selection_terms: () => ({ data: approvalRow({ status: "approved", approved_at: "2026-10-11T12:00:00Z" }), error: null }) } })
  await service.run(() => approveSelectionsFromPortal({ orgId: ORG, projectId: HOME, contactId: BUYER, groupId: GROUP, termsHash: HASH }))
  assert.deepEqual(
    [calls[0].args.p_channel, calls[0].args.p_contact_id, calls[0].args.p_terms_hash, calls[0].args.p_user_id],
    ["portal", BUYER, HASH, null],
  )
})

describe("an answer to a request that is out", () => {
  const approve = { orgId: ORG, projectId: HOME, contactId: BUYER, groupId: GROUP, termsHash: HASH }
  const approved = { approve_selection_terms: () => ({ data: approvalRow({ status: "approved", approved_at: "2026-10-11T12:00:00Z" }), error: null }) }

  test("binds at the terms that were sent even when an option was withdrawn since", async () => {
    const { service, calls } = harness({ approvals: [approvalRow()], rpc: approved })
    catalog = {}
    await service.run(() => approveSelectionsFromPortal(approve))
    assert.equal(calls[0].args.p_terms_hash, HASH)
  })

  test("a buyer confirming without a request, or on terms other than the ones sent, still needs the options on sale", async () => {
    const own = harness({ rpc: approved })
    catalog = {}
    await assert.rejects(own.service.run(() => approveSelectionsFromPortal(approve)), /no longer available/)
    const other = harness({ approvals: [approvalRow({ terms_hash: "b".repeat(64) })], rpc: approved })
    catalog = {}
    await assert.rejects(other.service.run(() => approveSelectionsFromPortal(approve)), /no longer available/)
  })
})

describe("executeSelectionApprovalFromEnvelope", () => {
  const signed = { orgId: ORG, approvalId: APPROVAL, envelopeId: ENVELOPE, executedFileId: id(11), signerEmail: "dana@buyer.dev" }

  test("a signature on the terms that were sent approves them once", async () => {
    const outcome = { outcome: "approved", idempotent: false, project_id: HOME, group_id: GROUP }
    const { service, calls } = harness({ rpc: { approve_selection_approval_from_envelope: () => ({ data: outcome, error: null }) } })
    assert.deepEqual(await service.run(() => executeSelectionApprovalFromEnvelope(signed)), { outcome: "approved", idempotent: false })
    assert.equal(calls[0].args.p_evidence.executed_file_id, id(11))
    assert.equal(service.audits.length, 1)
  })

  test("a signature that met changed terms ends the job without an approval and without a retry", async () => {
    const outcome = { outcome: "voided", project_id: HOME, group_id: GROUP }
    const { service } = harness({ rpc: { approve_selection_approval_from_envelope: () => ({ data: outcome, error: null }) } })
    assert.deepEqual(await service.run(() => executeSelectionApprovalFromEnvelope(signed)), { outcome: "voided", idempotent: false })
    assert.equal(service.audits.length, 0)
  })
})

test("the sender and the people who run the home hear how a request ended, once each", async () => {
  const { service } = harness({
    approvals: [approvalRow({ status: "declined", decline_reason: "Wrong cabinets" })],
    rpc: { project_permission_holders: () => ({ data: [COORDINATOR, SENDER], error: null }) },
  })
  const result = await service.run(() => notifySelectionApprovalOutcome(ORG, { approval_id: APPROVAL, status: "declined" }))
  assert.equal(result.notified, 2)
  assert.deepEqual(notifications.map((notification) => notification.userId).sort(), [COORDINATOR, SENDER].sort())
  assert.ok(notifications.every((notification) => notification.type === "selection_approval_declined" && /Wrong cabinets/.test(notification.message)))
})

describe("listHomeSelectionApprovals", () => {
  const terms = (overrides = {}) => ({ group_id: GROUP, terms_hash: HASH, total_cents: 6_500_00, line_count: 2, complete: true, confirmed: false, ...overrides })

  test("a request voided by a change reads as not approved, with why, and can be sent again", async () => {
    const { service } = harness({
      approvals: [approvalRow({ status: "voided", void_reason: "The selections changed after they were sent" })],
      rpc: { selection_home_terms: () => ({ data: [terms()], error: null }) },
    })
    const [group] = await service.run(() => listHomeSelectionApprovals(HOME))
    assert.deepEqual([group.state, group.reason, group.blocker], ["unsigned", "The selections changed after they were sent", null])
  })

  test("a request past its deadline reads as expired before the sweep records it", async () => {
    const { service } = harness({
      approvals: [approvalRow({ expires_at: "2020-01-01T00:00:00Z" })],
      rpc: { selection_home_terms: () => ({ data: [terms()], error: null }) },
    })
    const [group] = await service.run(() => listHomeSelectionApprovals(HOME))
    assert.equal(group.state, "expired")
  })
})

"use strict"

/**
 * Payment notifications: which money events may email anyone, who a payment
 * decision reaches, and what it says.
 *
 * - The email allowlist (`EMAIL_NOTIFICATION_TYPES`, lib/types/notifications.ts)
 *   is the only way a notification ever becomes an email. A money event that is
 *   neither on it nor declared silent (`OPERATIONAL_ONLY_PAYMENT_EVENTS`,
 *   lib/services/events.ts) silently mails nobody — that has shipped before.
 *   Which events exist is only knowable from the code that emits them, so that
 *   one repository-wide check reads source; everything it compares against is
 *   the real export.
 * - Who may decide a run (lib/payments/payment-run-approval-policy.ts), who a
 *   payable decision reaches (lib/payments/payable-notification-audience.ts) and
 *   the copy (lib/payments/payment-run-notification-copy.ts) are pure.
 */

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("../scripts/register-ts-node-test")
const { EMAIL_NOTIFICATION_TYPES, NOTIFICATION_EMAIL_CATEGORIES } = require("@/lib/types/notifications")
const { OPERATIONAL_ONLY_PAYMENT_EVENTS } = require("@/lib/services/events")
const { isEmailEligibleNotificationType } = require("@/lib/services/notifications")
const { evaluateRunApprovability } = require("@/lib/payments/payment-run-approval-policy")
const { resolvePayableDecisionAudience } = require("@/lib/payments/payable-notification-audience")
const {
  approvedReleaseSentence,
  paymentRunNotificationCopy,
  readReleaseKind,
} = require("@/lib/payments/payment-run-notification-copy")

// ---------------------------------------------------------------------------
// The email allowlist
// ---------------------------------------------------------------------------

/** Event types in the payment / AP / vendor money domain, by name. */
const PAYMENT_DOMAIN = [
  "payment_",
  "vendor_bill_",
  "vendor_payment",
  "vendor_credit_",
  "vendor_recipient_",
  "vendor_transfer_",
  "vendor_payout_",
  "vendor_remittance_",
  "funding_source_",
  "disbursement_",
]
const isPaymentEvent = (type) => PAYMENT_DOMAIN.some((prefix) => type.startsWith(prefix))

const ROOT = path.resolve(__dirname, "..")

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/**
 * Every event type an `eventType:` property or an `…eventType = …` binding
 * names in lib/, app/ and components/ — the event types the product can emit.
 * A type built from a template literal (`funding_source_change_${decision}`)
 * cannot be enumerated from source; only its prefix is recorded.
 */
function emittedEventTypes() {
  const literals = new Set()
  const prefixes = new Set()
  const definitions = new Set(["lib/types/notifications.ts", "lib/services/events.ts"].map((file) => path.join(ROOT, file)))
  for (const file of ["lib", "app", "components"].flatMap((dir) => sourceFiles(path.join(ROOT, dir)))) {
    if (definitions.has(file)) continue
    const source = fs.readFileSync(file, "utf8")
    if (!source.includes("recordEvent(") && !source.includes("createAndQueue(")) continue
    const expressions = [
      ...[...source.matchAll(/\beventType:\s*([^,\n]*)/g)].map((match) => match[1]),
      ...[...source.matchAll(/\b(?:const|let)\s+\w*[eE]ventType\s*=\s*([^\n]*(?:\n\s*[?:][^\n]*)*)/g)].map((match) => match[1]),
    ]
    for (const expression of expressions) {
      for (const [, literal] of expression.matchAll(/"([a-z][a-z0-9_]*)"/g)) literals.add(literal)
      for (const [, prefix] of expression.matchAll(/`([a-z][a-z0-9_]*)\$\{/g)) prefixes.add(prefix)
    }
  }
  return { literals, prefixes }
}

const { literals: EMITTED, prefixes: TEMPLATED } = emittedEventTypes()
const isEmitted = (type) => EMITTED.has(type) || [...TEMPLATED].some((prefix) => type.startsWith(prefix))
const EMAIL_TYPES = new Set(EMAIL_NOTIFICATION_TYPES.map((type) => type.key))

test("the scan finds the payment events the product emits", () => {
  // A scan that silently found nothing would make every check below vacuous.
  assert.ok([...EMITTED].filter(isPaymentEvent).length >= 30)
})

test("every payment event the product emits either emails someone or is declared operational", () => {
  const unhandled = [...EMITTED]
    .filter(isPaymentEvent)
    .filter((type) => !EMAIL_TYPES.has(type) && !OPERATIONAL_ONLY_PAYMENT_EVENTS.has(type))
    .sort()
  assert.deepEqual(
    unhandled,
    [],
    "add these to EMAIL_NOTIFICATION_TYPES, or to OPERATIONAL_ONLY_PAYMENT_EVENTS with the reason silence is right",
  )
})

test("a money event cannot be both emailed and declared silent, and silence is only declared for real events", () => {
  assert.deepEqual([...OPERATIONAL_ONLY_PAYMENT_EVENTS].filter((type) => EMAIL_TYPES.has(type)), [])
  assert.deepEqual([...OPERATIONAL_ONLY_PAYMENT_EVENTS].filter((type) => !isEmitted(type)).sort(), [])
})

test("the money events people act on can always reach them by email", () => {
  const actionable = [
    "vendor_bill_submitted",
    "vendor_bill_approved",
    "vendor_bill_rejected",
    "payment_run_submitted",
    "payment_run_approved",
    "payment_run_approval_recorded",
    "payment_run_rejected",
    "payment_run_execution_failed",
    "vendor_payment_paid",
    "vendor_payment_returned",
    "vendor_bill_payment_reversed",
  ]
  assert.deepEqual(actionable.filter((type) => !isEmailEligibleNotificationType(type)), [])
  assert.equal(isEmailEligibleNotificationType("vendor_bill_updated"), false)
})

test("every email type sits in a settings group that exists, so it can be found and turned off", () => {
  const categories = new Set(NOTIFICATION_EMAIL_CATEGORIES.map((category) => category.key))
  assert.deepEqual(
    EMAIL_NOTIFICATION_TYPES.filter((type) => !categories.has(type.category)).map((type) => type.key),
    [],
  )
  assert.equal(EMAIL_TYPES.size, EMAIL_NOTIFICATION_TYPES.length, "no email type is listed twice")
})

// ---------------------------------------------------------------------------
// Who decides a payment run, and who hears about a payable decision
// ---------------------------------------------------------------------------

test("only an approver who could actually approve the run is paged, and never its preparer", () => {
  const roster = [
    { userId: "ceiling", approvalLimitCents: 100_000, divisionId: null },
    { userId: "orgwide", approvalLimitCents: null, divisionId: null },
    { userId: "westside", approvalLimitCents: null, divisionId: "west" },
  ]
  const mayDecide = (viewerId, overrides = {}) =>
    evaluateRunApprovability({
      viewerId,
      requestedBy: "preparer",
      totalDebitCents: 400_000,
      runDivisionIds: [],
      controlSnapshot: {},
      routing: { viewerMayApprove: true, approvers: roster },
      ...overrides,
    }).mayDecide

  assert.equal(mayDecide("ceiling"), false, "a run above the approver's ceiling")
  assert.equal(mayDecide("orgwide"), true)
  assert.equal(mayDecide("westside"), false, "a divisional approver on an undivisioned run")
  assert.equal(mayDecide("westside", { runDivisionIds: ["west"] }), true)
  assert.equal(mayDecide("westside", { runDivisionIds: ["west", "east"] }), false)
  assert.equal(mayDecide("preparer"), false, "the preparer is never their own approver")
  assert.equal(mayDecide("orgwide", { routing: { viewerMayApprove: false, approvers: roster } }), false)
  assert.equal(mayDecide("orgwide", { controlSnapshot: { preferred_approver_ids: ["ceiling"] } }), false, "a routed run pages the approvers it names")
})

test("each payable decision reaches only the person who submitted it", () => {
  const finance = ["controller", "bookkeeper", "sam", "riley", "jo"]
  const submitters = ["sam", "sam", "riley", "jo", "jo"]
  const delivered = submitters.map((submitter) =>
    resolvePayableDecisionAudience({ eligibleRecipients: finance, payloadSubmitterId: submitter }),
  )
  assert.deepEqual(delivered, submitters.map((submitter) => [submitter]))

  assert.deepEqual(
    resolvePayableDecisionAudience({ eligibleRecipients: ["controller"], payloadSubmitterId: "departed" }),
    [],
    "a submitter who lost access is not mailed a link",
  )
  assert.deepEqual(resolvePayableDecisionAudience({ eligibleRecipients: finance, submissionActorId: "riley" }), ["riley"])
  assert.deepEqual(resolvePayableDecisionAudience({ eligibleRecipients: finance }), finance, "silence is the worse failure")
})

// ---------------------------------------------------------------------------
// What an approval says happened
// ---------------------------------------------------------------------------

test("an approved run says whether money actually started moving", () => {
  const approved = (facts) => paymentRunNotificationCopy({ eventType: "payment_run_approved", totalDebitCents: 400_000, ...facts })

  const released = approved({ vendorName: "Acme Concrete", billNumber: "1042", release: "released" })
  assert.equal(released.title, "Payment approved: $4,000.00")
  assert.match(released.message, /funding started/)

  const scheduled = approved({ billCount: 6, release: "scheduled", releaseScheduledFor: "2026-09-14" })
  assert.match(scheduled.title, /approved and scheduled/)
  assert.match(scheduled.message, /September 14, 2026/)
  assert.doesNotMatch(scheduled.message, /funding started/)

  const blocked = approved({ release: "blocked", releaseReason: "Daily payment limit reached" })
  assert.match(blocked.title, /approved but held/)
  assert.match(blocked.message, /Daily payment limit reached/)

  const queued = approved({ release: "queued", releaseReason: "Arc sends it on the next release pass." })
  assert.match(queued.message, /next release pass/)
  assert.doesNotMatch(queued.message, /funding started/)
})

test("an approval from before release outcomes were recorded is never read as a release", () => {
  assert.equal(readReleaseKind(undefined), "none")
  assert.equal(readReleaseKind("nonsense"), "none")
  assert.equal(readReleaseKind("released"), "released")
  assert.doesNotMatch(approvedReleaseSentence({ eventType: "payment_run_approved" }), /funding started/)
})

test("a partial approval says another approval is still needed", () => {
  const recorded = paymentRunNotificationCopy({ eventType: "payment_run_approval_recorded", billCount: 3, totalDebitCents: 90_000 })
  assert.match(recorded.message, /still needs another approval/)
})

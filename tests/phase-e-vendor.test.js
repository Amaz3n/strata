require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  disbursementStage,
  vendorPaymentStage,
  VENDOR_PAYMENT_STAGES,
} = require("../lib/payments/disbursement-stage")

const ROOT = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8")

// ---------------------------------------------------------------------------
// Behavior: what a vendor is told about where their money is.
// ---------------------------------------------------------------------------

test("a vendor sees the disbursement's stage, not the payment row's status", () => {
  // The `payments` row says `succeeded` from the moment the payout is reported
  // and keeps saying it after a return. Every one of these is a `succeeded`
  // payment row.
  assert.equal(vendorPaymentStage({ disbursementStatus: "debit_pending" }).label, "Builder debited")
  assert.equal(vendorPaymentStage({ disbursementStatus: "funds_available" }).label, "In transit")
  assert.equal(vendorPaymentStage({ disbursementStatus: "transfer_pending" }).label, "In transit")
  assert.equal(vendorPaymentStage({ disbursementStatus: "payout_pending" }).label, "In transit")
  assert.equal(vendorPaymentStage({ disbursementStatus: "paid" }).label, "Paid to your bank")
  assert.equal(vendorPaymentStage({ disbursementStatus: "returned" }).label, "Returned")
  assert.equal(vendorPaymentStage({ disbursementStatus: "returned_after_transfer" }).label, "Returned")
  assert.equal(vendorPaymentStage({ disbursementStatus: "paid" }).settled, true)
  assert.equal(vendorPaymentStage({ disbursementStatus: "transfer_pending" }).settled, false)
})

test("a payment with no disbursement is named for how it was settled", () => {
  // A check the builder wrote and a credit they applied both land in `payments`
  // with no rail behind them, and they are not the same event: one sent money.
  assert.equal(vendorPaymentStage({ method: "check" }).label, "Paid")
  assert.equal(vendorPaymentStage({ method: "ach" }).label, "Paid")
  assert.equal(vendorPaymentStage({ method: "credit" }).label, "Credit applied")
})

test("the vendor vocabulary collapses the two waiting states and names the bank", () => {
  assert.deepEqual([...VENDOR_PAYMENT_STAGES], [
    "Submitted",
    "Builder debited",
    "In transit",
    "Paid to your bank",
  ])
})

test("a debit returned after the vendor transfer is not reported as Submitted", () => {
  // The builder-facing stepper defaulted this status to stage 0, which read as
  // "nothing has happened yet" for the one state where the money is furthest
  // from where the builder thinks it is.
  const stage = disbursementStage("returned_after_transfer")
  assert.equal(stage.label, "Returned")
  assert.equal(stage.terminal, true)
  assert.notEqual(stage.index, 0)
})

// ---------------------------------------------------------------------------
// WS-E1 — payout invitations are their own access record.
// ---------------------------------------------------------------------------

test("payout invitations mint a dedicated, account-gated, expiring token", () => {
  const invitations = read("lib/services/vendor-payment-invitations.ts")
  assert.match(invitations, /purpose: "vendor_payout"/)
  assert.match(invitations, /require_account: true/)
  assert.match(invitations, /max_access_count: null/)
  assert.match(invitations, /PAYOUT_INVITE_TTL_DAYS = 30/)
  // Company-scoped: payout authority is the (org, company) relationship, and a
  // payout link that rides a project is the bug this workstream closed.
  assert.match(invitations, /project_id: null/)
  // The old helper reused the contact's project sub link. It is gone, not left
  // beside its replacement.
  assert.doesNotMatch(invitations, /resolveContactPayoutLink/)
  assert.doesNotMatch(invitations, /portal_type: "sub",\s*\n\s*created_by/)
})

test("a re-invite replaces an unusable link, revokes it, and says so", () => {
  const invitations = read("lib/services/vendor-payment-invitations.ts")
  assert.match(invitations, /replaced: Boolean\(existing\)/)
  assert.match(invitations, /revoked_at: existing\.revoked_at \?\? nowIso/)
  assert.match(invitations, /replacedPreviousLink: link\.replaced/)
  const mailer = read("lib/services/mailer.ts")
  assert.match(mailer, /This link replaces the one we sent before/)
  assert.match(mailer, /replacedPreviousLink\?: boolean/)
})

test("only a payout invitation carries its lifecycle into payment authority", () => {
  const invitations = read("lib/services/vendor-payment-invitations.ts")
  // A PM pausing a project sharing row must not withdraw org-wide payout
  // access. The cascade reads the token's purpose and returns before it can.
  assert.match(invitations, /if \(token\?\.purpose !== "vendor_payout"\) return/)
})

test("an unusable payout link explains itself instead of 404ing", () => {
  const gate = read("lib/portal/gate.tsx")
  assert.match(gate, /describeUnusablePortalToken/)
  assert.match(gate, /unusable\?\.purpose === "vendor_payout"/)
  const expired = read("components/portal/portal-invitation-expired.tsx")
  assert.match(expired, /This invitation expired/)
  assert.match(expired, /Ask \$\{orgName\} to send a new one/)
  // Every other portal keeps failing silently: confirming a guessed project
  // link exists is a disclosure.
  assert.match(gate, /return \{ status: "invalid" \}/)
})

test("the payout account wall names getting paid and works on a phone", () => {
  const gateUi = read("components/portal/account/portal-account-gate.tsx")
  assert.match(gateUi, /Create your Arc account to get paid by \$\{orgName\}/)
  assert.match(gateUi, /Payment invitation/)

  const claim = read("components/portal/shell/portal-claim-account.tsx")
  // The trigger used to be `hidden sm:inline-flex` unconditionally, so the
  // vendor who opened the email on their phone had no way through.
  assert.match(claim, /isPayout \? "inline-flex" : "hidden sm:inline-flex"/)

  // The page answers the missing-session question itself rather than letting
  // the payout gate throw into the portal's generic error card.
  const page = read("app/s/[token]/payments/page.tsx")
  assert.match(page, /hasExternalPortalGrantForToken/)
  assert.match(page, /purpose="vendor_payout"/)
  assert.match(page, /layout="section"/)
})

// ---------------------------------------------------------------------------
// WS-E2 — restore restores the claim; readiness reflects Stripe review.
// ---------------------------------------------------------------------------

test("restoring payment access restores the claim behind it", () => {
  const invitations = read("lib/services/vendor-payment-invitations.ts")
  assert.match(invitations, /status: "verified", verified_at: now, revoked_at: null/)
  // Restore has to happen before the relationship moves, because the database
  // refuses an active relationship whose claim is not live.
  const restoreIndex = invitations.indexOf('status: "verified", verified_at: now, revoked_at: null')
  const updateIndex = invitations.indexOf("const { data: updatedRelationship")
  assert.ok(restoreIndex > 0 && restoreIndex < updateIndex, "claim restore must precede the relationship update")
  // A relationship with no claim can only legally be `invited`.
  assert.match(invitations, /nextStatus = !claim\s*\n\s*\? "invited"/)
})

test("a recipient under Stripe review is not asked to continue", () => {
  const setup = read("app/s/[token]/payments/vendor-payment-setup.tsx")
  assert.match(setup, /recipient\?\.status === "pending_review" && recipient\.requirementsCurrentlyDue\.length === 0/)
  assert.match(setup, /Submitted — Stripe is reviewing/)
  const identities = read("lib/services/vendor-payment-identities.ts")
  assert.match(identities, /requirementsCurrentlyDue: string\[\]/)
  assert.match(identities, /requirements_currently_due/)
})

// ---------------------------------------------------------------------------
// WS-E3 — remittance is deduplicated, correct for credits, honest on returns.
// ---------------------------------------------------------------------------

test("one settled thing produces one vendor email", () => {
  const remittance = read("lib/services/vendor-remittance.ts")
  assert.match(remittance, /idempotencyKey: `remittance-\$\{input\.entityType\}-\$\{input\.entityId\}`/)
  assert.match(remittance, /idempotencyKey: `payment-return-disbursement-\$\{disbursement\.id\}`/)

  const events = read("lib/services/payment-provider-events.ts")
  // The webhook stops before it announces anything when the RPC settled nothing.
  assert.match(events, /if \(result\.duplicate === true\) return/)
  const duplicateGuard = events.indexOf("if (result.duplicate === true) return")
  const remittanceCall = events.indexOf("await sendVendorRemittanceAdvice(")
  const paidEvent = events.indexOf('eventType: "vendor_payment_paid"')
  assert.ok(duplicateGuard > 0 && duplicateGuard < remittanceCall, "remittance must sit behind the duplicate guard")
  assert.ok(duplicateGuard < paidEvent, "vendor_payment_paid must sit behind the duplicate guard")
  // Incident repair is not an announcement, so a replay still heals it.
  const incident = events.indexOf('code: `post_transfer_return:${disbursementId}` })')
  assert.ok(incident > 0 && incident < duplicateGuard, "incident resolution must run ahead of the duplicate guard")
})

test("a credit says no money was sent", () => {
  const remittance = read("lib/services/vendor-remittance.ts")
  assert.match(remittance, /credit: "Credit applied"/)
  assert.match(remittance, /Credit applied: \$\{money\(input\.amountCents\)\}/)
  const email = read("lib/emails/remittance-advice-email.tsx")
  assert.match(email, /const isCredit = method === "credit"/)
  assert.match(email, /No money was sent/)
  assert.match(email, /isCredit \? "Credit applied" : "Payment sent"/)
  // The vendor-facing table label follows the same rule.
  const setup = read("app/s/[token]/payments/vendor-payment-setup.tsx")
  assert.match(setup, /credit: "Credit applied"/)
})

test("a returned payment reaches the vendor, once, and only after release", () => {
  const remittance = read("lib/services/vendor-remittance.ts")
  assert.match(remittance, /export async function sendVendorPaymentReturnNotice/)
  const email = read("lib/emails/payment-return-vendor-email.tsx")
  assert.match(email, /A payment to you was returned/)

  const events = read("lib/services/payment-provider-events.ts")
  // A pre-transfer return never reached the vendor; telling them would invent
  // a problem they do not have.
  assert.match(events, /if \(stage !== "pre_transfer"\) \{\s*\n\s*await sendVendorPaymentReturnNotice/)
})

// ---------------------------------------------------------------------------
// WS-E4 — directory doctrine.
// ---------------------------------------------------------------------------

test("payment services read contact_company_links, never primary_company_id", () => {
  // `contacts.primary_company_id` is a legacy column a gated migration drops,
  // and it names exactly one company — so a payout contact attached from the
  // company side was invisible to the invite and refused by the payout gate.
  // Comments are stripped first: naming the legacy column in a doc comment that
  // explains why it is not read is the opposite of the defect.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const offenders = []
  for (const file of fs.readdirSync(path.join(ROOT, "lib/services"))) {
    if (!/^(vendor-payment-|payment-).*\.ts$/.test(file)) continue
    if (stripComments(read(path.join("lib/services", file))).includes("primary_company_id")) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `these payment services still read primary_company_id: ${offenders.join(", ")}`)

  const invitations = read("lib/services/vendor-payment-invitations.ts")
  assert.match(invitations, /\.from\("contact_company_links"\)/)
  assert.match(invitations, /\.order\("is_primary", \{ ascending: false \}\)/)
  const identities = read("lib/services/vendor-payment-identities.ts")
  assert.match(identities, /\.from\("contact_company_links"\)/)
})

// ---------------------------------------------------------------------------
// WS-E6 / WS-E7 — the vendor-facing view and the payloads behind it.
// ---------------------------------------------------------------------------

test("the vendor payment view shows a stage per payment", () => {
  const identities = read("lib/services/vendor-payment-identities.ts")
  assert.match(identities, /stage: VendorPaymentStageLabel/)
  assert.match(identities, /disbursementStatusById/)
  const setup = read("app/s/[token]/payments/vendor-payment-setup.tsx")
  assert.match(setup, /<StageCell label=\{payment\.stage\} \/>/)
  // Empty, and theme-safe: no raw palette classes on a portal surface.
  assert.match(setup, /No payments recorded yet/)
  assert.match(setup, /Nothing on the way right now/)
  assert.doesNotMatch(setup, /bg-white|text-black|bg-black|text-white/)
})

test("recipient-ready emissions name the vendor company", () => {
  const railSetup = read("lib/services/payment-rail-setup.ts")
  const emissions = [...railSetup.matchAll(/eventType: "vendor_recipient_status_updated"[\s\S]{0,400}?\}\)/g)]
  assert.ok(emissions.length >= 2, `expected both recipient-ready emissions, found ${emissions.length}`)
  for (const [emission] of emissions) {
    assert.match(emission, /company_id/)
    assert.match(emission, /company_name/)
  }
})

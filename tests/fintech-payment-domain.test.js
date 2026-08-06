require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  assertApprovalQuorum,
  assertBalancedLedgerEntries,
  assertDisbursementTransition,
  assertPaymentRunTransition,
  createPaymentRunContentHash,
  planDisbursementAdvance,
  resolveRunItemStatus,
  resolveRunStatus,
} = require("../lib/payments/payment-domain")
const {
  DEFAULT_PAYMENT_FEE_POLICY,
  calculatePaymentFeeQuote,
  quoteApDisbursementFee,
} = require("../lib/payments/fee-engine")
const {
  DEFAULT_PAYMENT_HOLD_POLICY,
  evaluatePaymentHoldFacts,
} = require("../lib/payments/payment-hold-policy")
const {
  addBusinessDays,
  estimateSettlement,
  latestReleaseDateFor,
} = require("../lib/payments/settlement-estimate")

test("disbursement state transitions are monotonic with explicit return paths", () => {
  assert.doesNotThrow(() => assertDisbursementTransition("created", "submitted"))
  assert.doesNotThrow(() => assertDisbursementTransition("paid", "returned"))
  assert.throws(() => assertDisbursementTransition("paid", "submitted"), /Invalid disbursement transition/)
  assert.throws(() => assertDisbursementTransition("failed", "paid"), /Invalid disbursement transition/)
})

test("payment runs cannot skip approval or reopen terminal states", () => {
  assert.doesNotThrow(() => assertPaymentRunTransition("draft", "pending_approval"))
  assert.doesNotThrow(() => assertPaymentRunTransition("pending_approval", "approved"))
  assert.throws(() => assertPaymentRunTransition("draft", "processing"), /Invalid payment run transition/)
  assert.throws(() => assertPaymentRunTransition("paid", "draft"), /Invalid payment run transition/)
})

test("sole and dual modes preserve maker-checker separation", () => {
  assert.doesNotThrow(() => assertApprovalQuorum({
    mode: "sole",
    requesterId: "maker",
    approvals: [{ approverId: "checker-a", decision: "approved" }],
  }))
  assert.doesNotThrow(() => assertApprovalQuorum({
    mode: "dual",
    requesterId: "maker",
    approvals: [
      { approverId: "checker-a", decision: "approved" },
      { approverId: "checker-b", decision: "approved" },
    ],
  }))
  assert.throws(() => assertApprovalQuorum({
    mode: "sole",
    requesterId: "maker",
    approvals: [{ approverId: "maker", decision: "approved" }],
  }), /cannot approve their own run/)
  assert.throws(() => assertApprovalQuorum({
    mode: "dual",
    requesterId: "maker",
    approvals: [{ approverId: "checker-a", decision: "approved" }],
  }), /requires 2 distinct approvals/)
})

test("ledger postings must balance in one currency using integer cents", () => {
  assert.deepEqual(assertBalancedLedgerEntries([
    { accountCode: "vendor_payable", direction: "debit", amountCents: 10_000, currency: "usd" },
    { accountCode: "ach_clearing", direction: "credit", amountCents: 10_000, currency: "usd" },
  ]), { debits: 10_000, credits: 10_000, currency: "usd" })
  assert.throws(() => assertBalancedLedgerEntries([
    { accountCode: "vendor_payable", direction: "debit", amountCents: 10_000, currency: "usd" },
    { accountCode: "ach_clearing", direction: "credit", amountCents: 9_999, currency: "usd" },
  ]), /out of balance/)
})

test("payment-run content hashes are stable across object key order", () => {
  assert.equal(
    createPaymentRunContentHash({ items: [{ amount: 100, bill: "a" }], funding: "x" }),
    createPaymentRunContentHash({ funding: "x", items: [{ bill: "a", amount: 100 }] }),
  )
})

test("existing AR quotes remain unchanged and AP defaults to pass-through only", () => {
  const ach = calculatePaymentFeeQuote({ invoiceBalanceCents: 100_000, method: "ach", policy: DEFAULT_PAYMENT_FEE_POLICY })
  assert.equal(ach.feeCents, 500)
  assert.equal(ach.totalCents, 100_500)

  const card = calculatePaymentFeeQuote({ invoiceBalanceCents: 100_000, method: "card", policy: DEFAULT_PAYMENT_FEE_POLICY })
  assert.equal(card.feeCents, 3_018)
  assert.equal(card.totalCents, 103_018)

  assert.deepEqual(quoteApDisbursementFee({ vendorAmountCents: 100_000, estimatedProcessorFeeCents: 800 }), {
    kind: "ap_disbursement",
    payer: "org",
    vendorAmountCents: 100_000,
    processorFeeCents: 800,
    platformFeeCents: 0,
    debitAmountCents: 100_000,
    accruedFeeCents: 800,
    description: "Provider processing costs passed through at cost, collected once per run",
  })
})

test("payment writes and sensitive control decisions use service-role-only atomic functions", () => {
  const root = path.resolve(__dirname, "..")
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260731221030_fintech_payment_foundation.sql"), "utf8")
  const service = fs.readFileSync(path.join(root, "lib/services/payment-runs.ts"), "utf8")
  const controls = fs.readFileSync(path.join(root, "lib/services/payment-rail-setup.ts"), "utf8")
  for (const functionName of [
    "create_payment_run_atomic",
    "submit_payment_run_atomic",
    "cancel_payment_run_atomic",
    "decide_payment_run_atomic",
    "decide_payment_control_change_atomic",
    "create_funding_source_change_atomic",
    "activate_matured_funding_change_atomic",
    "record_ap_payment_atomic",
    "record_ap_payment_reversal_atomic",
    "post_payment_ledger_transaction_atomic",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${functionName}\\(`))
    assert.match(migration, new RegExp(`revoke all on function public\\.${functionName}\\(`))
    assert.match(migration, new RegExp(`grant execute on function public\\.${functionName}\\([^;]+to service_role;`))
  }
  assert.match(service, /rpc\("create_payment_run_atomic"/)
  assert.match(service, /rpc\("submit_payment_run_atomic"/)
  assert.match(service, /rpc\("cancel_payment_run_atomic"/)
  assert.match(controls, /rpc\("decide_payment_control_change_atomic"/)
  assert.match(controls, /rpc\("create_funding_source_change_atomic"/)
  assert.match(controls, /rpc\("activate_matured_funding_change_atomic"/)
})

test("fee administration versions pricing atomically and remains platform-only", () => {
  const root = path.resolve(__dirname, "..")
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260801013000_payment_fee_policy_admin.sql"), "utf8")
  const service = fs.readFileSync(path.join(root, "lib/services/payment-fee-policies.ts"), "utf8")
  const actions = fs.readFileSync(path.join(root, "app/(app)/admin/payment-fees/actions.ts"), "utf8")

  for (const functionName of [
    "replace_payment_fee_policy_atomic",
    "retire_org_payment_fee_policy_atomic",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${functionName}\\(`))
    assert.match(migration, new RegExp(`revoke all on function public\\.${functionName}\\(`))
    assert.match(migration, new RegExp(`grant execute on function public\\.${functionName}\\([^;]+to service_role;`))
    assert.match(service, new RegExp(`rpc\\("${functionName}"`))
  }

  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /set effective_to = v_effective_from/)
  assert.match(migration, /insert into public\.authorization_audit_log/)
  assert.match(actions, /requirePermission\("platform\.billing\.manage"/)
  assert.match(actions, /export async function replacePaymentFeePolicyAction/)
  assert.match(actions, /export async function retireOrganizationPaymentFeePolicyAction/)
})

test("migration enables RLS on every new table and enforces maker-checker separation", () => {
  const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260731221030_fintech_payment_foundation.sql"), "utf8")
  const tables = [...migration.matchAll(/^create table public\.([a-z_]+)/gm)].map((match) => match[1])
  assert.ok(tables.length >= 25)
  for (const table of tables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`))
  }
  assert.match(migration, /Payment run requester cannot approve their own run/)
  assert.match(migration, /Requester cannot approve their own payment control change/)
  assert.match(migration, /count\(distinct approver_id\)/)
  assert.match(migration, /count\(distinct actor_user_id\)/)
})

test("money movement remains protected by platform and organization feature gates", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  assert.match(service, /FINTECH_PAYMENTS_EXECUTION_ENABLED !== "true"/)
  assert.match(service, /flagKey: EXECUTION_FLAG, defaultEnabled: false/)
  assert.match(service, /assertBillReleasable\(item\.bill_id, context\.orgId, \{ excludePaymentRunId: parsedRunId \}\)/)
  assert.match(service, /requireRecentPaymentStepUp/)
})

test("vendor claims require portal authorization and do not merge by name or email alone", () => {
  const identityService = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-payment-identities.ts"), "utf8")
  const identityMigration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260801133239_align_vendor_claim_external_identity.sql"), "utf8")
  assert.match(identityService, /hasExternalPortalGrantForToken/)
  assert.match(identityService, /externalIdentityHasOrgAccess/)
  assert.match(identityService, /const invitationEmailMatches = !input\.invitationEmail/)
  assert.match(identityService, /external_identity_id: session\.identity\.id/)
  assert.doesNotMatch(identityService, /external_portal_account_id:/)
  assert.match(identityService, /You are not an active administrator of that vendor entity/)
  assert.doesNotMatch(identityService, /levenshtein|similarity\(|soundex|metaphone/i)
  assert.match(identityMigration, /external_identity_grants/)
  assert.match(identityMigration, /portal_access_token_id = new\.source_portal_token_id/)
  assert.match(identityMigration, /account_identity is distinct from new\.claimed_by_identity_id/)
})

test("portal tokens resolve by hash, never by a plaintext column that no longer exists", () => {
  const identityService = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-payment-identities.ts"), "utf8")
  assert.match(identityService, /\.eq\("token_hash", hashPortalToken\(portalToken\)\)/)
  assert.doesNotMatch(identityService, /\.eq\("token",/)
})

test("a vendor verified with one builder is adopted by the next, not re-onboarded", () => {
  const railSetup = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-rail-setup.ts"), "utf8")
  const actions = fs.readFileSync(path.resolve(__dirname, "../app/s/[token]/payments/actions.ts"), "utf8")
  const setupUi = fs.readFileSync(path.resolve(__dirname, "../app/s/[token]/payments/vendor-payment-setup.tsx"), "utf8")

  // The payout account belongs to the vendor entity, so joining a second builder
  // is a mapping. Adoption must be attempted before the provider flow, or the
  // bank-change guard below rejects the vendor for a change they never made.
  assert.match(railSetup, /async function adoptVerifiedRecipient/)
  assert.match(
    railSetup,
    /startVendorPayoutSetup[\s\S]{0,600}?await adoptVerifiedRecipient\([\s\S]{0,400}?await createVendorRecipientOnboarding\(/,
  )
  assert.match(railSetup, /\.update\(\{ recipient_account_id: recipient\.id, status: "active" \}\)/)

  // The gate is a *bank change* gate. An account that exists but cannot yet pay
  // out has to be able to finish onboarding.
  assert.match(railSetup, /entity\.recipient\?\.status === "ready" && entity\.recipient\.payoutsEnabled/)

  // Every relationship for an entity points at its one recipient account.
  // Linking only when the account was just created stranded later builders with
  // a null recipient that no webhook could heal — syncVendorRecipient finds
  // relationships *by* recipient_account_id.
  assert.match(railSetup, /const linkedRecipientId = recipient\.id/)
  assert.doesNotMatch(railSetup, /if \(!recipient\) \{[\s\S]*?recipient_account_id: data\.id/)

  // Adoption returns no provider url; the portal must not navigate to it.
  assert.match(actions, /url: string \| null/)
  assert.match(setupUi, /if \(result\.data\.url\)/)
})

test("payout setup is one vendor action and carries no second credential prompt", () => {
  const railSetup = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-rail-setup.ts"), "utf8")
  const identityService = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-payment-identities.ts"), "utf8")
  const validation = fs.readFileSync(path.resolve(__dirname, "../lib/validation/fintech-payments.ts"), "utf8")
  const actions = fs.readFileSync(path.resolve(__dirname, "../app/s/[token]/payments/actions.ts"), "utf8")

  // Claim and provider onboarding are one call; the vendor never confirms a
  // mapping the portal session already authorized.
  assert.match(railSetup, /export async function startVendorPayoutSetup/)
  assert.match(railSetup, /await claimVendorCompany\(/)
  assert.doesNotMatch(actions, /claimVendorCompanyAction/)

  // No password field anywhere in the claim path.
  assert.doesNotMatch(validation, /password:\s*z\./)
  assert.doesNotMatch(identityService, /bcryptjs|compare\(/)

  // Re-entering setup must not re-stamp the claim or re-notify the builder.
  assert.match(identityService, /claimed: false/)
})

test("Stripe onboarding return reconciles recipient state without trusting the redirect", () => {
  const railSetup = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-rail-setup.ts"), "utf8")
  const page = fs.readFileSync(path.resolve(__dirname, "../app/s/[token]/payments/page.tsx"), "utf8")

  assert.match(railSetup, /returnUrl\.searchParams\.set\("payments", "return"\)/)
  assert.match(railSetup, /export async function reconcileVendorRecipientAfterOnboarding/)
  assert.match(railSetup, /\["owner", "administrator"\]\.includes\(entity\.role\)/)
  assert.match(railSetup, /return syncVendorRecipient\(recipient\.provider_account_id, recipient\.provider, "stripe_return"\)/)
  assert.match(page, /query\.payments === "return"/)
  assert.match(page, /await reconcileVendorRecipientAfterOnboarding\(query\.entity\)/)
})

test("the vendor payout surface stays hidden until the builder enables the rail", () => {
  const railSetup = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-rail-setup.ts"), "utf8")
  const layout = fs.readFileSync(path.resolve(__dirname, "../app/s/[token]/layout.tsx"), "utf8")
  const page = fs.readFileSync(path.resolve(__dirname, "../app/s/[token]/payments/page.tsx"), "utf8")
  assert.match(railSetup, /export async function isVendorPayoutSetupOpen/)
  assert.match(railSetup, /if \(error\) return false/)
  // Keyed on the policy existing, never on `enabled` — `enabled` requires an
  // active funding source, so gating on it would stop vendors from onboarding
  // until after the builder is already armed to pay them.
  assert.match(railSetup, /isVendorPayoutSetupOpen[\s\S]{0,400}?\.select\("id"\)/)
  assert.match(layout, /isVendorPayoutSetupOpen\(access\.org_id\)/)
  assert.match(page, /if \(!\(await isVendorPayoutSetupOpen\(access\.org_id\)\)\) notFound\(\)/)
  // The claim surface must not swallow load failures into an empty context.
  assert.doesNotMatch(page, /catch \{/)
})

test("a vendor connecting a payout account reaches the builder as a real notification", () => {
  const types = fs.readFileSync(path.resolve(__dirname, "../lib/types/notifications.ts"), "utf8")
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/events.ts"), "utf8")
  assert.match(types, /key: "vendor_payment_relationship_claimed"/)
  assert.match(events, /paymentSecurityEvents = new Set\(\[[\s\S]*?"vendor_payment_relationship_claimed"/)
})

test("a bill only holds on a lien waiver when policy actually requires one", () => {
  const baseFacts = {
    projectId: "11111111-1111-1111-1111-111111111111",
    companyId: "22222222-2222-2222-2222-222222222222",
    complianceCurrent: true,
    insuranceCurrent: true,
    waiverSigned: false,
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: {},
    policy: DEFAULT_PAYMENT_HOLD_POLICY,
  }

  // require_lien_waiver off and no sub-tier rule: nothing to sign, nothing to hold.
  const notRequired = evaluatePaymentHoldFacts({ ...baseFacts, waiverRequired: false })
  assert.equal(notRequired.holds.some((hold) => hold.kind === "waiver_signed"), false)
  assert.equal(notRequired.releasable, true)

  // Turn the requirement on and the same unsigned bill blocks.
  const required = evaluatePaymentHoldFacts({ ...baseFacts, waiverRequired: true })
  const waiverHold = required.holds.find((hold) => hold.kind === "waiver_signed")
  assert.ok(waiverHold)
  assert.equal(waiverHold.level, "block")
  assert.equal(required.releasable, false)

  // Signing it clears the hold.
  assert.equal(
    evaluatePaymentHoldFacts({ ...baseFacts, waiverRequired: true, waiverSigned: true }).releasable,
    true,
  )
})

test("the waiver hold and the hard release gate read the same two flags", () => {
  const holds = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-holds.ts"), "utf8")
  // evaluateHolds must source waiverRequired from compliance rules + the project
  // sub-tier flag, the same inputs assertBillReleasable gates its throws on.
  assert.match(holds, /waiverRequired: Boolean\(rules\.require_lien_waiver\) \|\| Boolean\(projectControls\?\.require_subtier_waivers\)/)
  assert.match(holds, /getComplianceRulesWithClient\(supabase, resolvedOrgId\)/)
  // Auto-chase hangs off the hold, so an unrequired waiver must not email vendors.
  assert.match(holds, /waiverAutoChase && evaluation\.holds\.some\(\(hold\) => hold\.kind === "waiver_signed"/)
})

test("payment step-up reads the caller's session, never a passed-in client", () => {
  const stepUp = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-step-up.ts"), "utf8")
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const railSetup = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-rail-setup.ts"), "utf8")
  // requireOrgMembership swaps in a service-role client for platform admins, and
  // that client carries no session — so AAL must come from the cookie-bound
  // client this function resolves itself, not from a caller-supplied one.
  assert.match(stepUp, /export async function requireRecentPaymentStepUp\(\)/)
  assert.match(stepUp, /await createServerSupabaseClient\(\)/)
  assert.doesNotMatch(stepUp, /requireRecentPaymentStepUp\(supabase/)
  assert.doesNotMatch(runs, /requireRecentPaymentStepUp\(context\.supabase\)/)
  assert.doesNotMatch(railSetup, /requireRecentPaymentStepUp\(context\.supabase\)/)
})

test("the vendor debit creates no transfer, so Arc controls when money leaves", () => {
  const adapter = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/payments/stripe-ap.ts"), "utf8")
  const submit = adapter.slice(adapter.indexOf("async submitDisbursement"), adapter.indexOf("async createVendorTransfer"))

  // A destination charge fires the vendor transfer the instant the debit clears,
  // which hands away the only decision that matters for return risk: when the
  // money stops being recoverable. The debit lands on the platform balance and
  // the transfer is a separate, later call.
  assert.doesNotMatch(submit, /transfer_data:\s*\{/)
  // Stripe 400s when application_fee_amount accompanies a transfer amount, and
  // fees do not ride this charge at all now.
  assert.doesNotMatch(submit, /application_fee_amount\s*:/)
  assert.match(submit, /amount: input\.amountCents,/)
  // The transfer group still ties the debit to its run for reconciliation.
  assert.match(submit, /transfer_group: input\.transferGroup/)
})

test("the vendor transfer is bound to the charge that funded it", () => {
  const adapter = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/payments/stripe-ap.ts"), "utf8")
  const transfer = adapter.slice(adapter.indexOf("async createVendorTransfer"), adapter.indexOf("async submitPlatformCharge"))
  assert.match(transfer, /source_transaction: input\.providerChargeId/)
  // Deterministic key: on this rail a duplicate transfer is a vendor paid twice.
  assert.match(transfer, /idempotencyKey: input\.idempotencyKey/)
})

test("cleared funds are held before the vendor is paid, for the org's window", () => {
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  const payouts = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-payouts.ts"), "utf8")

  // The hold starts when the debit clears.
  assert.match(events, /transferReleaseAfter = await resolvePayoutHoldExpiry/)
  assert.match(events, /patch\.transfer_release_after = transferReleaseAfter/)
  // Zero is expressible — an org may accept the risk for speed, deliberately.
  assert.match(events, /payout_hold_hours/)

  // The sweep re-reads the destination rather than trusting its claim: an
  // account put under a security hold after clearing must not be paid.
  assert.match(payouts, /destination_locked_until/)
  assert.match(payouts, /payouts_enabled/)
  assert.match(payouts, /claim_matured_vendor_transfers/)
  // A blocked transfer leaves the disbursement retryable and tells a human: the
  // builder's money has cleared to Arc and the vendor has not been paid.
  assert.match(payouts, /vendor_transfer_needs_attention/)
})

test("an unrecovered ACH return is booked as a loss, not parked in suspense", () => {
  const ledger = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-ledger.ts"), "utf8")
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")

  const returnLedger = ledger.slice(
    ledger.indexOf("export function postDisbursementReturnLedger"),
    ledger.indexOf("export function postApReturnLossLedger"),
  )
  // The builder's side is simply true: their bank reversed the debit and the
  // obligation reopened. Suspense is not an answer to who paid for something.
  assert.doesNotMatch(returnLedger, /suspense/)
  assert.match(returnLedger, /accountCode: "org_cash", direction: "debit"/)
  assert.match(returnLedger, /accountCode: "vendor_payable", direction: "credit"/)

  // Arc's own loss lands in a named account so the number is knowable.
  assert.match(ledger, /accountCode: "ach_return_loss", direction: "debit"/)
  assert.match(events, /postApReturnLossLedger\(/)
  // And a cumulative ceiling trips this org's rail off rather than growing.
  assert.match(events, /enforceReturnLossCeiling\(/)
  assert.match(events, /return_loss_ceiling_cents/)
})

test("a risk block is a decision waiting for someone, not a wall", () => {
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const risk = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-risk.ts"), "utf8")

  // The automated check honours a standing manual allow.
  assert.match(runs, /findManualRiskOverride\(/)
  assert.match(runs, /const decision = blocked && !override \? "block" : "allow"/)
  // The error names the signals and says where to go, rather than being terminal.
  assert.match(runs, /risk queue/)

  // Overriding a fraud control is at least as sensitive as approving the payment
  // it stopped, so it carries the same controls — and never the preparer.
  assert.match(risk, /requirePermission\("payments\.approve_run"/)
  assert.match(risk, /requireRecentPaymentStepUp\(\)/)
  assert.match(risk, /run\.requested_by === context\.userId/)
  assert.match(risk, /review_type: "manual"/)
})

test("vendor-level and in-flight exposure are bounded, not just per-run", () => {
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const risk = runs.slice(runs.indexOf("async function assertRunRiskAllowed"), runs.indexOf("async function findManualRiskOverride"))

  // A newly claimed relationship now blocks rather than being observed: "change
  // the payee, pay immediately" is the vector the hold exists to interrupt.
  assert.match(risk, /code: "recently_claimed_vendor_relationship",\s*\n\s*severity: "block"/)
  // Per-vendor ceiling: the run limit does nothing to stop one compromised
  // destination taking all of it in a single payment.
  assert.match(risk, /code: "vendor_limit_exceeded", severity: "block"/)
  // In-flight exposure accumulates where per-payment and daily limits reset.
  assert.match(risk, /code: "inflight_exposure_exceeded", severity: "block"/)
  // Fraud controls read live policy, so tightening one binds runs already built.
  assert.match(risk, /Read live, not from the run's frozen control snapshot/)
})

test("a designated approver roster narrows who can decide a run, and never widens it", () => {
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const approvers = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-approvers.ts"), "utf8")
  const decide = runs.slice(runs.indexOf("export async function decidePaymentRun"), runs.indexOf("async function assertRunRiskAllowed"))

  // The roster is a second gate AFTER the permission, never a replacement for it.
  assert.match(decide, /requirePermission\("payments\.approve_run", context\)/)
  assert.match(decide, /assertUserMayApproveRun\(\{[\s\S]*?userId: context\.userId,[\s\S]*?divisionIds: runDivisionIds/)

  // An empty roster falls back to permission-only; a configured one is exclusive.
  const assertMay = approvers.slice(approvers.indexOf("export async function assertUserMayApproveRun"))
  assert.match(assertMay, /if \(rows\.length === 0\) return/)
  assert.match(assertMay, /not a designated payment-run approver/)
  assert.match(assertMay, /exceeds your approval limit/)

  // Designating someone who cannot approve would create a roster that blocks every run.
  const setRoster = approvers.slice(approvers.indexOf("export async function setPaymentRunApprovers"))
  assert.match(setRoster, /payments\.manage_rail/)
  assert.match(setRoster, /needs a role that grants payment-run approval/)
})

test("the approver roster migration is org-scoped, RLS-protected, and separates read from write", () => {
  const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260803193117_payment_run_approver_roster.sql"), "utf8")
  assert.match(migration, /create table public\.payment_run_approvers/)
  assert.match(migration, /org_id uuid not null references public\.orgs\(id\) on delete cascade/)
  assert.match(migration, /unique \(org_id, user_id\)/)
  assert.match(migration, /alter table public\.payment_run_approvers enable row level security;/)
  // Seeing who approves is part of the workflow; changing it is a control change.
  assert.match(migration, /payment_run_approvers_read[\s\S]*?has_org_permission\(org_id, 'payment\.release'\)/)
  assert.match(migration, /payment_run_approvers_write[\s\S]*?has_org_permission\(org_id, 'payments\.manage_rail'\)/)
})

test("preparing a payable for approval resolves the destination server-side and never releases money", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payable-approvals.ts"), "utf8")
  const prepare = service.slice(service.indexOf("export async function preparePayableApproval"), service.indexOf("export interface PayableApprovalDetail"))

  // A client may name the amount and the funding account it comes from; it may
  // never name the bank account the money lands in.
  assert.match(prepare, /from\("vendor_payment_relationships"\)[\s\S]*?recipient_account_id/)
  assert.match(prepare, /recipient_account_id: relationship\.recipient_account_id/)
  assert.doesNotMatch(prepare, /input\.recipient_account_id|parsed\.recipient_account_id/)

  // Preparing drafts a run; submission and approval stay separate acts.
  assert.match(prepare, /createPaymentRun\(/)
  assert.doesNotMatch(prepare, /submitPaymentRun\(|executePaymentRun\(/)

  // Overpaying a bill is caught before a run exists.
  assert.match(prepare, /amount_cents > outstandingCents/)
})

test("a fully approved payable releases immediately, and says so honestly when it cannot", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payable-approvals.ts"), "utf8")
  const decide = service.slice(service.indexOf("export async function decidePayableApproval"))

  // Release only follows a decision that actually reached quorum.
  assert.match(decide, /if \(status !== "approved"\)/)
  assert.match(decide, /executePaymentRun\(parsed\.run_id/)
  // The execution gates throw; that must surface as "not released", never as success.
  assert.match(decide, /approved_release_pending/)
  assert.doesNotMatch(decide, /catch[\s\S]{0,120}return \{ result: "released" \}/)
})

test("approval notifications reach the designated approvers and name the bill", () => {
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/events.ts"), "utf8")
  const outbox = fs.readFileSync(path.resolve(__dirname, "../app/api/jobs/process-outbox/route.ts"), "utf8")

  // A configured roster owns the decision, so it owns the email.
  assert.match(events, /from\("payment_run_approvers"\)[\s\S]{0,400}?if \(\(designated \?\? \[\]\)\.length > 0\)/)
  // The email has to state what is being approved without opening anything.
  assert.match(events, /case "payment_run_submitted":/)
  assert.match(events, /Payment needs your approval/)
  assert.match(events, /vendor_name/)
  // And it links to the payable, where the decision is actually made.
  assert.match(outbox, /entityType === "payment_run"[\s\S]{0,200}?\/payables\?bill=/)
})

test("settlement estimates skip weekends across both ACH legs", () => {
  // Fri 2026-08-07 + 1 business day is Mon 2026-08-10, not Sat the 8th.
  assert.equal(addBusinessDays("2026-08-07", 1), "2026-08-10")
  // Zero days from a Saturday still lands on the next banking day.
  assert.equal(addBusinessDays("2026-08-08", 0), "2026-08-10")
  assert.equal(addBusinessDays("2026-08-03", 0), "2026-08-03")

  const window = { debitBusinessDays: { min: 4, max: 5 }, payoutBusinessDays: { min: 1, max: 2 } }
  const estimate = estimateSettlement({ initiatedOn: "2026-08-03", window })
  // Mon + 5 business days = Mon the 10th; + 7 = Wed the 12th.
  assert.equal(estimate.vendorReceivesEarliest, "2026-08-10")
  assert.equal(estimate.vendorReceivesLatest, "2026-08-12")
  assert.equal(estimate.maxBusinessDays, 7)
  // The window is always a range, never a single promised date.
  assert.ok(estimate.vendorReceivesEarliest < estimate.vendorReceivesLatest)
})

test("the latest release date that still pays a bill on time is the estimate run backwards", () => {
  const window = { debitBusinessDays: { min: 4, max: 5 }, payoutBusinessDays: { min: 1, max: 2 } }
  const release = latestReleaseDateFor("2026-08-12", window)
  assert.equal(release, "2026-08-03")
  // Round-tripping must not slip past the due date.
  assert.ok(estimateSettlement({ initiatedOn: release, window }).vendorReceivesLatest <= "2026-08-12")
})

test("a scheduled release date is inside the approved content hash", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")

  // Moving the date has to invalidate approvals exactly like moving an amount.
  assert.match(service, /scheduled_for: run\.scheduled_for/)
  const submit = service.slice(service.indexOf("export async function submitPaymentRun"))
  assert.match(submit, /createPaymentRunContentHash\(/)
  assert.match(submit, /scheduled_for: parsed\.scheduled_for/)

  // A manual release must not jump the schedule the approvers signed off on.
  const execute = service.slice(service.indexOf("export async function executePaymentRun"))
  assert.match(execute, /isScheduledForLater\(material\.run\.scheduled_for\)/)
})

test("scheduled release is the same gated path as a manual one, run as the preparer", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const sweep = service.slice(
    service.indexOf("async function backfillMissingReleaseJobs"),
    service.indexOf("async function assertRunRiskAllowed"),
  )

  // The kill switch is checked before anything is even loaded.
  assert.match(sweep, /FINTECH_PAYMENTS_EXECUTION_ENABLED !== "true"/)
  // Only approved runs whose date has arrived, and no privileged release path.
  assert.match(sweep, /\.eq\("status", "approved"\)/)
  assert.match(sweep, /\.lte\("scheduled_for", todayIso\(\)\)/)
  assert.match(sweep, /executePaymentRun\(runId, job\.org_id\)/)
  // Attributed to the human who scheduled it, so their permission is re-checked.
  assert.match(sweep, /userId: run\.requested_by/)
  // One bad run must not strand the queue.
  assert.match(sweep, /catch \(cause\)/)
})

test("a scheduled release is a durable work item, not a column something must notice", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")

  // The approval that reaches quorum enqueues the release in the same request,
  // so a cron that never fires cannot lose a payment that was already owed.
  const decide = service.slice(
    service.indexOf("export async function decidePaymentRun"),
    service.indexOf("function todayIso"),
  )
  assert.match(decide, /decisionStatus === "approved" && typeof material\.run\.scheduled_for === "string"/)
  assert.match(decide, /enqueueScheduledRelease\(/)

  // Cancelling retracts the queued release rather than leaving it to fail three
  // times against a cancelled run and look like an incident.
  const cancel = service.slice(
    service.indexOf("export async function cancelPaymentRun"),
    service.indexOf("export async function decidePaymentRun"),
  )
  assert.match(cancel, /\.eq\("job_type", RELEASE_JOB_TYPE\)/)
  assert.match(cancel, /\.contains\("payload", \{ run_id: parsedRunId \}\)/)

  const sweep = service.slice(
    service.indexOf("export async function releaseScheduledPaymentRuns"),
    service.indexOf("async function assertRunRiskAllowed"),
  )
  // Claimed atomically, and expired leases are returned before claiming so a
  // release stranded by a dead worker is retried rather than lost.
  assert.match(sweep, /reap_stale_outbox_jobs/)
  assert.match(sweep, /claim_jobs/)
  assert.doesNotMatch(sweep, /\.eq\("status", "pending"\)/)

  // The revision is inside the dedupe key: invalidated approvals return a run to
  // draft, and the next approval is a different release to schedule.
  assert.match(service, /dedupeByPayloadKeys: \["run_id", "revision"\]/)
})

test("preparer and approver both see the Arc fee split out from provider cost", () => {
  const approvals = fs.readFileSync(path.resolve(__dirname, "../lib/services/payable-approvals.ts"), "utf8")
  // The lumped feeCents field is gone from both the prepared draft and the detail.
  assert.doesNotMatch(approvals, /feeCents/)
  assert.match(approvals, /processorFeeCents: Number\(item\.processor_fee_cents\)/)
  assert.match(approvals, /platformFeeCents: Number\(item\.platform_fee_cents\)/)

  for (const file of ["../components/payables/workspace/payable-pay-view.tsx", "../components/payables/workspace/payable-review-view.tsx"]) {
    const view = fs.readFileSync(path.resolve(__dirname, file), "utf8")
    assert.match(view, /Arc fee/, `${file} must name Arc's own fee`)
    assert.match(view, /Provider processing cost/, `${file} must name the provider cost separately`)
    // Zero is still shown — a fee line that vanishes teaches people not to look.
    assert.doesNotMatch(view, /platformFeeCents > 0 \?/)
  }
})

test("AP execution binds recipients server-side and reserves daily limits atomically", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260804005756_ap_payment_execution_hardening.sql"), "utf8")
  assert.match(service, /payee_kind === "primary_vendor" \? prepared\.recipient\.id/)
  assert.match(service, /claim_payment_run_execution_atomic/)
  assert.match(migration, /payment_execution_reservations/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /recipient_entity is distinct from relationship_entity/)
  assert.match(migration, /new\.recipient_account_id is distinct from relationship_recipient/)
})

test("ambiguous provider submission remains recoverable and accounting enqueue repairs after retry", () => {
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  const catchBlock = runs.slice(runs.indexOf("} catch (error) {", runs.indexOf("export async function executePaymentRun")))
  assert.match(catchBlock, /payment_submission_needs_recovery/)
  assert.match(catchBlock, /\.eq\("status", "created"\)/)
  assert.doesNotMatch(catchBlock.slice(0, 1_500), /from\("disbursements"\)\.update\(\{ status: "failed"/)
  assert.match(events, /if \(typeof result\.payment_id === "string"\) await enqueueBillPaymentSync/)
  assert.doesNotMatch(events, /payment_id === "string" && !result\.duplicate/)
})

test("provider failures reverse submission entries and actual fees are reconciled", () => {
  const ledger = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-ledger.ts"), "utf8")
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  assert.match(ledger, /postDisbursementSubmissionReversalLedger/)
  assert.match(ledger, /postApFeeAccrualLedger/)
  assert.match(events, /actual_processor_fee_cents: actualProcessorFeeCents/)
  assert.match(events, /targetStatus === "failed" \|\| targetStatus === "canceled"/)
  assert.match(events, /postDisbursementSubmissionReversalLedger/)
})

test("construction release evidence freezes authoritative waiver and retainage records", () => {
  const holds = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-holds.ts"), "utf8")
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  assert.match(holds, /\.from\("lien_waivers"\)/)
  assert.match(holds, /signedFileId/)
  assert.match(holds, /through-date does not cover this payable period/)
  assert.match(holds, /Commitment billing exceeds the approved commitment and change orders/)
  assert.match(holds, /approved field completion covering this purchase-order bill/)
  assert.match(runs, /evidence: prepared\.evidence\?\.waiverEvidence/)
  assert.match(runs, /retainage_held_cents: Number\(prepared\.bill\.retainage_cents/)
})

test("bulk payable approval is all-or-nothing and its projections are durable", () => {
  const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260804010200_payables_saved_views_and_atomic_approval.sql"), "utf8")
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  const worker = fs.readFileSync(path.resolve(__dirname, "../app/api/jobs/process-outbox/route.ts"), "utf8")
  assert.match(migration, /for update/)
  assert.match(migration, /v_locked <> v_requested/)
  assert.match(migration, /coding does not equal its total/)
  assert.match(migration, /project_vendor_bill_approval/)
  assert.match(migration, /revoke all on function public\.approve_vendor_bills_atomic.*authenticated/s)
  assert.match(service, /\.rpc\("approve_vendor_bills_atomic"/)
  assert.match(worker, /propagateApprovalToLedger\(\{ source: "vendor_bill"/)
  assert.match(worker, /enqueueVendorBillSync\(billId, job\.org_id\)/)
})

test("org and project payables use bounded server pagination with durable saved views", () => {
  const orgService = fs.readFileSync(path.resolve(__dirname, "../lib/services/org-payables.ts"), "utf8")
  const projectService = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  const views = fs.readFileSync(path.resolve(__dirname, "../lib/services/payable-views.ts"), "utf8")
  const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260804010200_payables_saved_views_and_atomic_approval.sql"), "utf8")
  assert.match(orgService, /\.range\(from, from \+ pageSize - 1\)/)
  assert.match(projectService, /listVendorBillsPageForProject/)
  assert.match(projectService, /\.range\(\(page - 1\) \* pageSize, page \* pageSize - 1\)/)
  assert.match(views, /user_id", userId/)
  assert.match(migration, /saved_payable_views_owner_access/)
  assert.match(migration, /user_id = \(select auth\.uid\(\)\)/)
})

// ---------------------------------------------------------------------------
// Provider-event behaviour.
//
// The QA list in the fintech gameplan (§8, Phase 4) is mostly about what happens
// when provider events arrive wrong: twice, out of order, or after the payment
// already ended. Those decisions are pure, so they are tested as decisions
// rather than mocked round-trips through Supabase and Stripe.
// ---------------------------------------------------------------------------

test("a duplicate provider event advances nothing", () => {
  // Stripe re-delivers on any non-2xx, and the handler is expected to be a no-op.
  assert.deepEqual(planDisbursementAdvance("paid", "paid"), [])
  assert.deepEqual(planDisbursementAdvance("funds_available", "funds_available"), [])
  assert.deepEqual(planDisbursementAdvance("returned", "returned"), [])
})

test("an out-of-order provider event never walks a disbursement backwards", () => {
  // transfer.created arriving after payout.paid is routine, not an error.
  assert.deepEqual(planDisbursementAdvance("paid", "transfer_pending"), [])
  assert.deepEqual(planDisbursementAdvance("payout_pending", "debit_pending"), [])
  assert.deepEqual(planDisbursementAdvance("funds_available", "submitted"), [])
})

test("a payout event fills in the legs its webhooks skipped, in order", () => {
  // Webhooks drop. Jumping submitted -> paid must still pass through every
  // intermediate state so no transition assertion is bypassed.
  assert.deepEqual(planDisbursementAdvance("submitted", "paid"), [
    "debit_pending",
    "funds_available",
    "transfer_pending",
    "payout_pending",
    "paid",
  ])
  for (const [index, next] of planDisbursementAdvance("submitted", "paid").entries()) {
    const from = index === 0 ? "submitted" : planDisbursementAdvance("submitted", "paid")[index - 1]
    assert.doesNotThrow(() => assertDisbursementTransition(from, next))
  }
})

test("a return that lands before the paid event makes the payment terminal", () => {
  // Money came back. A late payout.paid must not resurrect it.
  assert.deepEqual(planDisbursementAdvance("returned", "paid"), [])
  assert.deepEqual(planDisbursementAdvance("failed", "paid"), [])
  assert.deepEqual(planDisbursementAdvance("canceled", "funds_available"), [])
  assert.deepEqual(planDisbursementAdvance("reversed", "paid"), [])
})

test("a run item is never reported paid on an absence of payees", () => {
  // `[].every()` is true, so the natural phrasing concludes "paid" from no
  // evidence at all and closes a bill nobody paid.
  assert.equal(resolveRunItemStatus([], "failed"), "processing")
  assert.equal(resolveRunStatus([]), "processing")
})

test("run item status reflects what actually happened to each payee", () => {
  assert.equal(resolveRunItemStatus(["paid", "paid"], "failed"), "paid")
  assert.equal(resolveRunItemStatus(["paid", "failed"], "failed"), "partially_paid")
  assert.equal(resolveRunItemStatus(["failed", "returned"], "returned"), "returned")
  // Still in flight: one payee unresolved means the item is not terminal.
  assert.equal(resolveRunItemStatus(["paid", "processing"], "failed"), "partially_paid")
  assert.equal(resolveRunItemStatus(["processing", "failed"], "failed"), "processing")
})

test("a run that paid some bills and failed others is partially_failed, not paid", () => {
  assert.equal(resolveRunStatus(["paid", "paid"]), "paid")
  assert.equal(resolveRunStatus(["paid", "failed"]), "partially_failed")
  assert.equal(resolveRunStatus(["partially_paid", "returned"]), "partially_failed")
  assert.equal(resolveRunStatus(["failed", "canceled"]), "failed")
  assert.equal(resolveRunStatus(["paid", "processing"]), "partially_paid")
  assert.equal(resolveRunStatus(["processing", "processing"]), "processing")
})

test("every planned advance is a legal transition", () => {
  const statuses = [
    "created", "submitted", "debit_pending", "funds_available",
    "transfer_pending", "payout_pending", "paid", "failed", "returned", "reversed", "canceled",
  ]
  for (const from of statuses) {
    for (const to of statuses) {
      const path = planDisbursementAdvance(from, to)
      let cursor = from
      for (const next of path) {
        // A plan that produced an illegal hop would throw here rather than in
        // production, mid-webhook, with money already moved.
        assert.doesNotThrow(
          () => assertDisbursementTransition(cursor, next),
          `${from} -> ${to} planned an illegal hop ${cursor} -> ${next}`,
        )
        cursor = next
      }
      if (path.length > 0) assert.equal(cursor, to, `${from} -> ${to} did not land on its target`)
    }
  }
})

test("the webhook handler delegates its rollups rather than re-deriving them", () => {
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  assert.match(events, /resolveRunItemStatus\(/)
  assert.match(events, /resolveRunStatus\(/)
  assert.match(events, /planDisbursementAdvance\(/)
  // The inline ternaries these replaced are gone, so there is one rollup, tested.
  assert.doesNotMatch(events, /payeeStatuses\.every/)
  assert.doesNotMatch(events, /itemStatuses\.every/)
  assert.doesNotMatch(events, /FORWARD_PATH/)
})

test("a return arriving before settlement routes through funds_available on its own", () => {
  // The illegal hop this guards against — created -> returned — was previously
  // avoided only by a hand-written pre-walk in the webhook handler. The planner
  // owns it now, so no future call site has to remember.
  assert.deepEqual(planDisbursementAdvance("created", "returned"), [
    "submitted",
    "debit_pending",
    "funds_available",
    "returned",
  ])
  assert.deepEqual(planDisbursementAdvance("debit_pending", "returned"), ["funds_available", "returned"])
  assert.deepEqual(planDisbursementAdvance("paid", "returned"), ["returned"])

  // A failure before settlement is legal directly and must not be padded out.
  assert.deepEqual(planDisbursementAdvance("created", "failed"), ["failed"])

  // Cancelling once funds are available is not reachable without an illegal hop,
  // so the plan is empty rather than a forced transition.
  assert.deepEqual(planDisbursementAdvance("funds_available", "canceled"), [])
})

test("the return handler no longer pre-walks disbursement state by hand", () => {
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  const handler = events.slice(events.indexOf("async function processDisbursementReturn"))
  assert.doesNotMatch(handler, /\["created", "submitted", "debit_pending"\]\.includes/)
})

// ---------------------------------------------------------------------------
// Fees are accrued, never debited.
//
// The debit has to equal what the vendor receives, or the bank feed line and the
// accounting entry disagree on every single payment and a bookkeeper hand-codes
// the remainder forever.
// ---------------------------------------------------------------------------

test("an AP quote debits the vendor amount and accrues the fees separately", () => {
  const quote = quoteApDisbursementFee({ vendorAmountCents: 100_000, estimatedProcessorFeeCents: 800 })
  assert.equal(quote.vendorAmountCents, 100_000)
  assert.equal(quote.debitAmountCents, 100_000, "the debit must equal what the vendor receives")
  assert.equal(quote.processorFeeCents, 800)
  assert.equal(quote.platformFeeCents, 0)
  assert.equal(quote.accruedFeeCents, 800)
  // The lumped total that used to be added to the debit is gone entirely.
  assert.equal("totalDebitCents" in quote, false)
})

test("a platform markup accrues too, and still never reaches the debit", () => {
  const quote = quoteApDisbursementFee({
    vendorAmountCents: 100_000,
    estimatedProcessorFeeCents: 800,
    policy: { passThroughProcessorFees: true, platformFeeFlatCents: 150, platformFeeBps: 0 },
  })
  assert.equal(quote.debitAmountCents, 100_000)
  assert.equal(quote.accruedFeeCents, 950)
})

test("the run total, the provider call and the ledger all move the same number", () => {
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const ledger = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-ledger.ts"), "utf8")
  const provider = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/payments/payment-rail-provider.ts"), "utf8")

  // The run debit is the vendor total, with no fee arithmetic anywhere near it.
  assert.match(runs, /const totalDebitCents = vendorAmountCents\b/)
  assert.doesNotMatch(runs, /vendorAmountCents \+ processorFeeCents \+ platformFeeCents/)
  // One amount reaches the provider, so no call site can re-add a fee to it.
  assert.match(runs, /amountCents: Number\(payee\.amount_cents\),/)
  const disbursementInput = provider.slice(
    provider.indexOf("export interface ProviderDisbursementInput"),
    provider.indexOf("export interface ProviderDisbursementResult"),
  )
  assert.doesNotMatch(disbursementInput, /recipientAmountCents|debitAmountCents/)
  // The submitted entry debits clearing and credits cash for the vendor amount.
  const submitted = ledger.slice(
    ledger.indexOf("export function postDisbursementSubmittedLedger"),
    ledger.indexOf("export function postApFeeAccrualLedger"),
  )
  assert.doesNotMatch(submitted, /fee_expense/, "the bank debit entry must carry no fee lines")
  assert.match(submitted, /accountCode: "org_cash", direction: "credit", amountCents: input\.vendorAmountCents/)
  // Fees land on a liability to Arc, cleared by the monthly invoice.
  assert.match(ledger, /accountCode: "arc_fees_payable", direction: "credit"/)
})

test("fee variance no longer touches the builder's cash", () => {
  const ledger = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-ledger.ts"), "utf8")
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  // The estimate-to-actual adjustment posted against org_cash and drifted the
  // builder's cash from their bank on every payment. It is gone: the builder is
  // charged the amount their approver signed for, and the difference from the
  // provider's actual is Arc's margin, which never enters these books.
  assert.doesNotMatch(ledger, /postDisbursementProcessorFeeAdjustmentLedger/)
  assert.doesNotMatch(events, /postDisbursementProcessorFeeAdjustmentLedger/)
  // Recognition happens at execution against the frozen run, not on settlement.
  assert.match(runs, /postApFeeAccrualLedger\(/)
  assert.doesNotMatch(events, /postApFeeAccrualLedger\(/)
  // The provider's actual is recorded alongside the quote, never over it —
  // overwriting would erase the evidence of what was actually charged.
  const chargeUpdate = events.slice(events.indexOf('from("disbursements").update({\n        provider_charge_id'))
  const updateBlock = chargeUpdate.slice(0, chargeUpdate.indexOf("})"))
  assert.match(updateBlock, /actual_processor_fee_cents: actualProcessorFeeCents/)
  assert.doesNotMatch(updateBlock, /[^_]processor_fee_cents:/)
})

test("a run collects its fees once, in a debit of its own", () => {
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const adapter = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/payments/stripe-ap.ts"), "utf8")
  const collect = runs.slice(runs.indexOf("async function collectRunFees"))

  // Summed off the frozen run items, so what is collected is what was approved
  // rather than a figure recomputed against whatever pricing is in force now.
  assert.match(collect, /item\.processor_fee_cents/)
  assert.match(collect, /item\.platform_fee_cents/)
  // One charge per run, keyed by revision so a re-approved run is a new charge.
  assert.match(collect, /payment_run_fee:\$\{runId\}:v\$\{input\.run\.revision\}/)
  // The liability is recognised before the provider is contacted, so an
  // authoritative failure has something to reverse.
  assert.ok(
    collect.indexOf("postApFeeAccrualLedger") < collect.indexOf("submitPlatformCharge"),
    "the accrual must be posted before the provider call",
  )
  // A fee failure must never throw: the vendor payments are already away.
  assert.doesNotMatch(collect, /throw error/)

  // The platform charge carries no destination — that absence is what makes it
  // Arc collecting its own fee rather than a payment on the builder's behalf.
  const platformCharge = adapter.slice(adapter.indexOf("async submitPlatformCharge"), adapter.indexOf("async retrieveSettlement"))
  assert.doesNotMatch(platformCharge, /transfer_data:\s*\{/)
  assert.match(platformCharge, /charge_type: "platform_fee"/)
})

test("a failed fee collection leaves the liability standing", () => {
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  const ledger = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-ledger.ts"), "utf8")
  // Reversing the cash side re-opens arc_fees_payable. The fee was earned when
  // the vendors were paid, so a failed pull is a receivable, not forgiveness.
  const reversal = ledger.slice(ledger.indexOf("export function postApFeeChargeReversalLedger"))
  assert.match(reversal, /accountCode: "arc_fees_payable", direction: "credit"/)
  assert.match(reversal, /accountCode: "org_cash", direction: "debit"/)
  // Arc's fee debit reaches terminal state on its own webhook branch; without
  // it every fee charge would sit at `submitted` forever.
  assert.match(events, /charge_type === "platform_fee"/)
  assert.match(events, /processFeeChargeEvent\(/)
})

test("an Arc fee is capped, so a large progress payment cannot be charged without limit", () => {
  const uncapped = quoteApDisbursementFee({
    vendorAmountCents: 50_000_000,
    estimatedProcessorFeeCents: 500,
    policy: { passThroughProcessorFees: true, platformFeeFlatCents: 0, platformFeeBps: 80, platformFeeCapCents: null },
  })
  assert.equal(uncapped.platformFeeCents, 400_000)

  const capped = quoteApDisbursementFee({
    vendorAmountCents: 50_000_000,
    estimatedProcessorFeeCents: 500,
    policy: { passThroughProcessorFees: true, platformFeeFlatCents: 0, platformFeeBps: 80, platformFeeCapCents: 500 },
  })
  assert.equal(capped.platformFeeCents, 500, "an uncapped bps fee on an ACH rail is the bug the cap exists to prevent")
  assert.equal(capped.accruedFeeCents, 1_000)
  assert.equal(capped.debitAmountCents, 50_000_000)
})

test("an ACH return reverses the payment in the accounting system too", () => {
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  const sync = fs.readFileSync(path.resolve(__dirname, "../lib/services/accounting-sync.ts"), "utf8")
  const provider = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/accounting/provider.ts"), "utf8")
  // Arc reopens the bill; without this the GL keeps a payment for money that
  // came back and the two ledgers diverge permanently.
  assert.match(events, /voidBillPaymentInAccounting\(/)
  assert.match(provider, /voidBillPayment\?\(/)
  assert.match(provider, /supportsBillPaymentVoid: boolean/)
  // A target that cannot reverse still leaves a durable trace for a human.
  assert.match(sync, /supportsBillPaymentVoid \|\| !provider\.voidBillPayment/)
  assert.match(sync, /markAccountingSyncError\(/)
})

test("electronic payments are not recorded as checks", () => {
  const adapter = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/accounting/qbo/adapter.ts"), "utf8")
  const billPayment = adapter.slice(adapter.indexOf("export async function syncBillPaymentToQBO"))
  assert.match(billPayment, /const isCheck = String\(payment\.method \?\? "check"\) === "check"/)
  assert.doesNotMatch(billPayment.slice(0, billPayment.indexOf("upsertSyncRecord")), /PayType: "Check",/)
})

// ---------------------------------------------------------------------------
// Construction AP.
// ---------------------------------------------------------------------------

const {
  calculateEarlyPayDiscount,
  discountStillEarnable,
  readEarlyPayTerms,
} = require("../lib/payments/early-pay-discount")

test("an early-pay discount rounds down so a vendor is never underpaid", () => {
  // 2/10 net 30 on $1,000.05 — the discount must not round up, or the payment
  // lands a cent short, the bill stays open, and lien rights stay alive.
  const discount = calculateEarlyPayDiscount({
    billDate: "2026-08-04",
    outstandingCents: 100_005,
    terms: { discountPercent: 2, discountDays: 10 },
  })
  assert.equal(discount.discountCents, 2_000)
  assert.equal(discount.netAmountCents, 98_005)
  assert.equal(discount.discountCents + discount.netAmountCents, 100_005)
  assert.equal(discount.discountByDate, "2026-08-14")
})

test("the discount is earned by the date the vendor receives the money", () => {
  // Releasing on the last discount day misses it: the rail takes days. This is
  // the whole reason the deadline is checked against the settlement estimate
  // rather than against the release date alone.
  assert.equal(
    discountStillEarnable({ discountByDate: "2026-08-14", releaseDate: "2026-08-14", vendorReceivesLatest: "2026-08-20" }),
    false,
  )
  assert.equal(
    discountStillEarnable({ discountByDate: "2026-08-14", releaseDate: "2026-08-05", vendorReceivesLatest: "2026-08-12" }),
    true,
  )
})

test("half a discount term is a bug, not an absent discount", () => {
  assert.equal(readEarlyPayTerms({ early_pay_discount_percent: null, early_pay_discount_days: null }), null)
  assert.deepEqual(readEarlyPayTerms({ early_pay_discount_percent: 2, early_pay_discount_days: 10 }), {
    discountPercent: 2,
    discountDays: 10,
  })
  assert.throws(() => readEarlyPayTerms({ early_pay_discount_percent: 2, early_pay_discount_days: null }), /both a percentage and a number of days/)
})

test("recorded checks carry the controls an ACH payment carries", () => {
  const bills = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  const controls = bills.slice(bills.indexOf("async function assertExternalPaymentControls"), bills.indexOf("export async function updateVendorBillStatus"))

  // Separation of duties: the person releasing the money is not the person who
  // approved the obligation.
  assert.match(controls, /approval_mode === "dual" && input\.bill\.approved_by === input\.userId|approval_mode === "dual" && input\.bill\.approved_by && input\.bill\.approved_by === input\.userId/)
  // A check number is a real identifier with duplicate detection, not free text.
  assert.match(controls, /check_number/)
  assert.match(controls, /already recorded against another payment/)
  // Step-up on the same amounts that would trigger it electronically.
  assert.match(controls, /requireRecentPaymentStepUp\(\)/)
  // The evidence that was evaluated is frozen onto the payment, not discarded.
  assert.match(bills, /release_evidence:/)
  assert.match(bills, /externalReleaseEvidence/)
})

test("retainage release creates a payable instead of editing the original bill", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/ap-retainage.ts"), "utf8")
  // Editing retainage_cents down was mutating accounting evidence to achieve a
  // payment, in a system built to stop exactly that.
  assert.match(service, /source: "retainage_release"/)
  assert.match(service, /parent_bill_id: bill\.id/)
  assert.doesNotMatch(service, /retainage_cents: alreadyReleasedCents|update\(\{ retainage_cents/)
  // The guard against releasing the same held amount twice is a compare-and-set.
  assert.match(service, /\.eq\("retainage_released_cents", alreadyReleasedCents\)/)
  // Final waiver gate: retainage is the last leverage to close lien rights.
  assert.match(service, /waiver_type", "final"/)
})

test("the vendor is told what a deposit covers, and retainage is named", () => {
  const remittance = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-remittance.ts"), "utf8")
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  assert.match(remittance, /Retainage held/)
  assert.match(remittance, /vendor_entity_memberships/)
  // A bounced email must never fail a settlement that already moved money.
  assert.match(events, /sendVendorRemittanceAdvice\(\{ orgId, disbursementId \}\)\.catch/)
})

test("1099 totals subtract reversals and flag vendors Arc cannot file for", () => {
  // One implementation, not two. A second copy read `payments` directly with its
  // own threshold and its own idea of "paid", so the two could disagree about a
  // number that goes to the IRS. The governed report is the survivor.
  assert.equal(fs.existsSync(path.resolve(__dirname, "../lib/services/vendor-1099.ts")), false)
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/reports/vendor-1099.ts"), "utf8")
  // A returned payment was not income to the vendor; reporting it overstates
  // what they received on a form the IRS also receives.
  assert.match(service, /payment_reversals/)
  assert.match(service, /Math\.max\(0, \(paidByCompany\.get\(company\.id\) \?\? 0\) - reversedCents\)/)
  // Reportable-but-unfileable is what someone needs to see in December.
  assert.match(service, /blockingReasons/)
  assert.match(service, /No W-9 on file/)
  // The threshold is governed by an approved policy row, never a constant.
  assert.match(service, /tax_policy_versions/)
})

// ---------------------------------------------------------------------------
// Step-up policy and approval scope.
// ---------------------------------------------------------------------------

const { evaluatePaymentStepUp, PAYMENT_STEP_UP_MAX_AGE_SECONDS } = require("../lib/payments/step-up-policy")

test("step-up requires aal2 and a genuine second factor", () => {
  const now = 1_800_000_000
  assert.equal(evaluatePaymentStepUp({ assuranceLevel: "aal1", methods: [], nowSeconds: now }).reason, "not_aal2")

  // `otp` is Supabase's name for an emailed magic-link code — a primary factor.
  // Counting it would let mailbox access approve payments.
  assert.equal(
    evaluatePaymentStepUp({
      assuranceLevel: "aal2",
      methods: [{ method: "otp", timestamp: now - 5 }, { method: "password", timestamp: now - 5 }],
      nowSeconds: now,
    }).reason,
    "no_second_factor",
  )

  const good = evaluatePaymentStepUp({
    assuranceLevel: "aal2",
    methods: [{ method: "password", timestamp: now - 900 }, { method: "totp", timestamp: now - 60 }],
    nowSeconds: now,
  })
  assert.equal(good.satisfied, true)
  assert.equal(good.verifiedAt, new Date((now - 60) * 1000).toISOString())
})

test("step-up expires, and a future timestamp is not evidence of anything", () => {
  const now = 1_800_000_000
  assert.equal(
    evaluatePaymentStepUp({
      assuranceLevel: "aal2",
      methods: [{ method: "totp", timestamp: now - PAYMENT_STEP_UP_MAX_AGE_SECONDS - 1 }],
      nowSeconds: now,
    }).reason,
    "expired",
  )
  // Clock skew or a forged claim — either way, not proof of a recent challenge.
  assert.equal(
    evaluatePaymentStepUp({ assuranceLevel: "aal2", methods: [{ method: "totp", timestamp: now + 600 }], nowSeconds: now }).reason,
    "expired",
  )
})

test("mobile approval reuses the web decision rather than a weaker one", () => {
  const mobile = fs.readFileSync(path.resolve(__dirname, "../lib/mobile/payment-runs.ts"), "utf8")
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const stepUp = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-step-up.ts"), "utf8")

  // Same service, same controls — only the step-up transport differs.
  assert.match(mobile, /decidePaymentRun\(/)
  assert.match(mobile, /resolveStepUp: async \(\) => requireRecentMobilePaymentStepUp\(context\.token\)/)
  // The content hash is required on mobile too: an approver decides the run they
  // were shown, and a phone screen goes stale like any other.
  assert.match(mobile, /content_hash: z\.string\(\)\.min\(1\)/)
  // Step-up defaults inside the service, so no future call site can omit it.
  assert.match(runs, /options\.resolveStepUp \?\? requireRecentPaymentStepUp/)
  // Both transports route through one policy.
  assert.match(stepUp, /evaluatePaymentStepUp\(/)
  // Decoding an unverified JWT would be a hole; the safety rests on the token
  // having been validated upstream, so that reasoning is stated where it lives.
  assert.match(stepUp, /are authentic by then/)
  const decode = stepUp.slice(stepUp.indexOf("export function requireRecentMobilePaymentStepUp"))
  assert.match(decode, /decodeJwtPayload\(accessToken\)/)
})

test("a division-scoped approver cannot release work outside their division", () => {
  const approvers = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-approvers.ts"), "utf8")
  const assertion = approvers.slice(approvers.indexOf("export async function assertUserMayApproveRun"))

  // Approving the part you own is not approving the run.
  assert.match(assertion, /runDivisions\.every\(\(division\) => division === entry\.division_id\)/)
  assert.match(assertion, /organization-wide authority/)
  // The same person may hold a low org-wide ceiling and a higher divisional one,
  // so the ceiling is the best across covering entries, not the first row found.
  assert.match(assertion, /covering\.reduce/)

  // The list view's can_approve must agree with the server, or the UI offers a
  // button that fails.
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  assert.match(runs, /divisionsByRunId/)
  assert.match(runs, /divisionIds: runDivisionIds/)
})

test("the Viewpoint layout is header-only and says so", () => {
  const formats = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/accounting/file/formats.ts"), "utf8")
  const viewpoint = formats.slice(formats.indexOf("const VIEWPOINT"), formats.indexOf("const GENERIC"))
  // Documented APHB column names, not invented ones.
  for (const column of ["Co", "Mth", "Vendor", "APRef", "InvDate", "DueDate", "InvTotal"]) {
    assert.match(viewpoint, new RegExp(`header: "${column}"`), `APHB column ${column} missing`)
  }
  // Job costing is line-level in Vista; emitting it in a header file would look
  // like job distribution that the import will not produce.
  assert.doesNotMatch(viewpoint, /job_name|cost_code|cost_type/)
  assert.match(formats, /HEADER ONLY/)
})

// ---------------------------------------------------------------------------
// Fee model: the debit is the vendor amount, and the schema has to agree.
// ---------------------------------------------------------------------------

test("a non-zero fee policy still debits only the vendor amount", () => {
  // The bug this guards: `quoteApDisbursementFee` was changed to collect fees
  // once per run, so `debitAmountCents` became the vendor amount alone — but the
  // table CHECKs and `create_payment_run_atomic` kept asserting the old identity
  // `total_debit = vendor + processor + platform`. With the 80bps + 80bps policy
  // that shipped alongside, every real run raised "Payment run item totals do not
  // match the run totals" at creation. Nothing exercised the RPC, so CI was green.
  const quote = quoteApDisbursementFee({
    vendorAmountCents: 100_000,
    policy: {
      passThroughProcessorFees: true,
      processorFeeBps: 80,
      processorFeeFixedCents: 0,
      processorFeeCapCents: 500,
      platformFeeBps: 80,
      platformFeeFlatCents: 0,
      platformFeeCapCents: 500,
    },
  })
  assert.equal(quote.processorFeeCents, 500)
  assert.equal(quote.platformFeeCents, 500)
  assert.equal(quote.debitAmountCents, 100_000)
  assert.equal(quote.accruedFeeCents, 1_000)

  const root = path.resolve(__dirname, "..")
  const alignment = fs.readFileSync(
    path.join(root, "supabase/migrations/20260805090000_ap_fee_model_constraint_alignment.sql"),
    "utf8",
  )
  // Both levels, and the RPC, must express the same invariant the engine does.
  assert.match(alignment, /payment_runs_total_debit_is_vendor_amount[\s\S]*?check \(total_debit_cents = vendor_amount_cents\)/)
  assert.match(alignment, /payment_run_items_total_debit_is_vendor_amount[\s\S]*?check \(total_debit_cents = vendor_amount_cents\)/)
  assert.match(alignment, /p_total_debit_cents <> p_vendor_amount_cents then/)
  // The superseded identity must be gone, not merely joined by a new one.
  assert.doesNotMatch(
    alignment.replace(/^--.*$/gm, ""),
    /p_total_debit_cents <> p_vendor_amount_cents \+ p_processor_fee_cents/,
  )
})

// ---------------------------------------------------------------------------
// Payable lifecycle: rejection, and the controls around reversing an approval.
// ---------------------------------------------------------------------------

test("a payable can be rejected with a reason, and the vendor is told", () => {
  const root = path.resolve(__dirname, "..")
  const migration = fs.readFileSync(
    path.join(root, "supabase/migrations/20260805091000_vendor_bill_rejection_lifecycle.sql"),
    "utf8",
  )
  // Free-text status was how 'void' and 'disputed' ended up queried but
  // unwritable. The column is constrained to states that exist.
  assert.match(migration, /check \(status in \('pending', 'approved', 'partial', 'paid', 'rejected'\)\)/)
  // A rejection with no reason gets the same invoice back.
  assert.match(migration, /length\(coalesce\(btrim\(rejection_reason\), ''\)\) >= 8/)

  const service = fs.readFileSync(path.join(root, "lib/services/vendor-bills.ts"), "utf8")
  assert.match(service, /vendor_bill_rejected/)
  assert.match(service, /vendor_bill_approved/)
  // Reversing an approval is an approval decision, not an edit.
  assert.match(service, /const isUnapproval =/)
  assert.match(service, /parsed\.status === "rejected" \|\| isUnapproval/)
  // And it must not strand settled payments against a reopened bill.
  assert.match(service, /cannot be returned to pending\. Reverse the payment first/)

  const notices = fs.readFileSync(path.join(root, "lib/services/vendor-bill-notices.ts"), "utf8")
  assert.match(notices, /submitted_via_portal/)
})

test("auto-approval runs the same gates a person does", () => {
  const service = fs.readFileSync(
    path.resolve(__dirname, "../lib/services/invoice-auto-approval.ts"),
    "utf8",
  )
  // It used to be a bare status update: no ledger, no sync, no coding check.
  assert.match(service, /propagateApprovalToLedger/)
  assert.match(service, /enqueueVendorBillSync/)
  assert.match(service, /loadApprovalGateSettings/)
  assert.match(service, /codedTotal !== Number\(bill\.total_cents \?\? 0\)/)
  // A payable that cannot reach the cost ledger is not approved.
  assert.match(service, /Auto-approval was reverted because the project cost ledger/)
})

test("preparing a payment never approves the obligation as a side effect", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payable-approvals.ts"), "utf8")
  assert.match(service, /has to be approved before a payment can be prepared/)
  // The old behaviour made the preparer the approver of record without asking.
  assert.doesNotMatch(service, /updateVendorBillStatus/)
})

test("the vendor sees checks, not only rail payments", () => {
  const root = path.resolve(__dirname, "..")
  const remittance = fs.readFileSync(path.join(root, "lib/services/vendor-remittance.ts"), "utf8")
  // The rationale — an unexplained deposit and a phone call — applies to a
  // check at least as much as to an ACH.
  assert.match(remittance, /sendManualPaymentRemittanceAdvice/)
  const bills = fs.readFileSync(path.join(root, "lib/services/vendor-bills.ts"), "utf8")
  assert.match(bills, /sendManualPaymentRemittanceAdvice\(\{ orgId: resolvedOrgId, paymentId: recordedPaymentId \}\)\.catch/)

  const identities = fs.readFileSync(path.join(root, "lib/services/vendor-payment-identities.ts"), "utf8")
  // Sourced from `payments`, which both rails write to, rather than from
  // `disbursements`, which only the electronic one does.
  assert.match(identities, /from\("payments"\)/)
})

test("portal payables identify their vendor", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  // Without company_id the bill is unpayable electronically, invisible to 1099
  // totals, and skipped by the duplicate-invoice trigger.
  assert.match(service, /company_id: companyId,\n      bill_number: parsed\.bill_number/)
})

test("AP notifications are on the email allowlist, not just wired", () => {
  const root = path.resolve(__dirname, "..")
  const types = fs.readFileSync(path.join(root, "lib/types/notifications.ts"), "utf8")
  // Wiring a notification service is not enough; only types in this list send.
  for (const key of ["vendor_bill_submitted", "vendor_bill_approved", "vendor_bill_rejected", "vendor_payment_paid"]) {
    assert.match(types, new RegExp(`key: "${key}"`), `${key} must be email-eligible`)
  }
  const events = fs.readFileSync(path.join(root, "lib/services/events.ts"), "utf8")
  // And each needs a recipient set, or it resolves to [] and notifies nobody.
  assert.match(events, /vendor_bill_submitted: \["bill\.approve"\]/)
  assert.match(events, /event\.event_type === "vendor_payment_paid"/)
  assert.match(events, /"vpo\.request"/)
})

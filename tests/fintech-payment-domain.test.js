require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  addBusinessHours,
  assertBalancedLedgerEntries,
  assertDisbursementTransition,
  assertPaymentRunTransition,
  planDisbursementAdvance,
  requesterMayApprovePaymentRun,
  resolveRunItemStatus,
  resolveRunStatus,
} = require("../lib/payments/payment-domain")
const { createPaymentRunContentHash } = require("../lib/payments/payment-run-content-hash")
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
const {
  isPaymentReconciliationStale,
  paymentOperationsAlertDetails,
} = require("../lib/payments/operations-monitor")
const { stripeApProvider } = require("../lib/integrations/payments/stripe-ap")

function stripeWebhook(type, object, overrides = {}) {
  return {
    id: overrides.id ?? `evt_${type.replaceAll(".", "_")}`,
    type,
    created: 1_786_534_400,
    account: overrides.account,
    data: { object },
  }
}

test("Stripe adapter normalizes vendor debit events before domain processing", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_intent.succeeded",
    { id: "pi_vendor_1", metadata: { arc_product: "vendor_payments", charge_type: "vendor_disbursement", disbursement_id: "d1" } },
  ))
  assert.deepEqual(
    {
      kind: normalized.kind,
      provider: normalized.provider,
      providerPaymentId: normalized.providerPaymentId,
      disbursementId: normalized.disbursementId,
      status: normalized.status,
    },
    {
      kind: "disbursement.status",
      provider: "stripe",
      providerPaymentId: "pi_vendor_1",
      disbursementId: "d1",
      status: "funds_available",
    },
  )
})

test("Stripe adapter distinguishes the platform fee debit from vendor money", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_intent.payment_failed",
    { id: "pi_fee_1", metadata: { arc_product: "vendor_payments", charge_type: "platform_fee" } },
  ))
  assert.equal(normalized.kind, "fee_charge.status")
  assert.equal(normalized.status, "failed")
  assert.equal(normalized.providerPaymentId, "pi_fee_1")
})

test("Stripe adapter ignores unrelated receivables payment intents", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_intent.succeeded",
    { id: "pi_ar_1", metadata: { arc_product: "receivables" } },
  ))
  assert.equal(normalized, null)
})

test("Stripe ACH authorization warnings open inquiries without reversing the payable", async () => {
  const inquiry = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "charge.dispute.created",
    { id: "dui_warning_1", payment_intent: "pi_vendor_1", status: "warning_needs_response", reason: "bank_cannot_process" },
  ))
  assert.equal(inquiry.kind, "disbursement.authorization_inquiry")
  assert.equal(inquiry.providerPaymentId, "pi_vendor_1")

  const returned = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "charge.dispute.created",
    { id: "du_return_1", payment_intent: "pi_vendor_1", status: "needs_response", reason: "fraudulent" },
  ))
  assert.equal(returned.kind, "disbursement.returned")
  assert.equal(returned.providerReversalId, "du_return_1")
})

test("Stripe blocked-bank updates disable the funding source vocabulary", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_method.automatically_updated",
    { id: "pm_bank_1", us_bank_account: { status_details: { blocked: { network_code: "R02" } } } },
  ))
  assert.equal(normalized.kind, "funding_source.updated")
  assert.equal(normalized.providerPaymentMethodId, "pm_bank_1")
  assert.equal(normalized.blocked, true)
})

test("payout holds count US bank-business hours, including observed holidays", () => {
  assert.equal(addBusinessHours("2026-07-02T16:00:00.000Z", 48).toISOString(), "2026-07-07T16:00:00.000Z")
  assert.equal(addBusinessHours("2026-12-31T16:00:00.000Z", 24).toISOString(), "2027-01-04T16:00:00.000Z")
})

test("payment reconciliation monitoring waits 48 hours and alerts on incident transitions", () => {
  const now = new Date("2026-08-10T12:00:00.000Z")
  assert.equal(isPaymentReconciliationStale({
    last_reconciled_at: null,
    reconciliation_monitoring_started_at: "2026-08-09T12:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
  }, now), false)
  assert.equal(isPaymentReconciliationStale({
    last_reconciled_at: null,
    reconciliation_monitoring_started_at: "2026-08-08T11:59:59.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
  }, now), true)
  assert.equal(isPaymentReconciliationStale({
    last_reconciled_at: "2026-01-02T00:00:00.000Z",
    reconciliation_monitoring_started_at: "2026-08-10T11:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
  }, now), false)

  const watchdog = paymentSource("lib/services/ops-watchdog.ts")
  const migration = paymentSource("supabase/migrations/20260811120000_payment_operations_incident_alerting.sql")
  const reconciliationRoute = paymentSource("app/api/jobs/payment-reconciliation/route.ts")
  assert.match(watchdog, /sync_payment_operations_incidents/)
  assert.match(watchdog, /row\.should_notify/)
  assert.match(migration, /unique \(org_id, finding_code\)/)
  assert.match(migration, /v_status = 'resolved'/)
  assert.match(migration, /should_notify := false/)
  assert.match(reconciliationRoute, /Payment reconciliation is disabled while payment rails are enabled/)
  assert.match(reconciliationRoute, /status: 503/)
})

test("stale payment-operation emails include the state counts", () => {
  assert.deepEqual(paymentOperationsAlertDetails({
    reason: "stale_payment_state",
    stale_disbursements: 1,
    stale_runs: 2,
    threshold_hours: 96,
  }), ["1 disbursement and 2 payment runs have remained in a non-terminal state for more than 96 hours."])
})

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
  // Runs are immutable after creation: there is no return to draft. A material
  // change means cancel + rebuild, and the content hash rejects stale copies.
  assert.throws(() => assertPaymentRunTransition("pending_approval", "draft"), /Invalid payment run transition/)
})

test("owner self-approval is explicit and frozen into the payment run", () => {
  assert.equal(requesterMayApprovePaymentRun(null), false)
  assert.equal(requesterMayApprovePaymentRun({ policy: {} }), false)
  assert.equal(
    requesterMayApprovePaymentRun({ policy: { requester_may_approve: true } }),
    true,
  )

  const migration = fs.readFileSync(
    path.resolve(__dirname, "../supabase/migrations/20260810170000_owner_operated_payment_approval.sql"),
    "utf8",
  )
  assert.match(migration, /control_snapshot -> 'policy' ->> 'requester_may_approve'/)
  assert.match(migration, /requester_allowed = false/)
  assert.match(migration, /v_run\.required_approvals = 1/)
  assert.match(migration, /requester_may_approve = false or approval_mode = 'sole'/)
  assert.match(migration, /p_step_up_verified_at/)
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
  assert.match(service, /assertRunPayablesStillCurrent\(material\.run, material\.items, context\.orgId\)/)
  assert.match(service, /assertPaymentLaunchReady\(\)/)
  assert.match(service, /requireRecentPaymentStepUp/)
})

test("vendor claims require portal authorization and do not merge by name or email alone", () => {
  const identityService = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-payment-identities.ts"), "utf8")
  const identityMigration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260801133239_align_vendor_claim_external_identity.sql"), "utf8")
  assert.match(identityService, /hasExternalPortalGrantForToken/)
  assert.match(identityService, /externalIdentityHasOrgAccess/)
  // The bound invitation email is compared unconditionally. This used to read
  // `!input.invitationEmail || …`, which skipped the check entirely for a
  // company-wide link and made the URL a payout-destination bearer credential.
  assert.match(identityService, /input\.invitationEmail\.trim\(\)\.toLowerCase\(\) !== normalizedEmail/)
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
    /startVendorPayoutSetup[\s\S]{0,1200}?await adoptVerifiedRecipient\([\s\S]{0,400}?await createVendorRecipientOnboarding\(/,
  )
  // The same action re-checks the builder's own gate, because the page hiding
  // this flow is not what stops a direct server-action call.
  assert.match(railSetup, /startVendorPayoutSetup[\s\S]{0,600}?isVendorPayoutSetupOpen\(access\.orgId\)/)
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

  // The automated check honours a manual allow — but only over the signal codes
  // that allow was granted against, never as a standing waiver for the run.
  assert.match(runs, /findManualRiskOverride\(/)
  assert.match(runs, /const decision = uncleared\.length > 0 \? "block" : "allow"/)
  // The error names the signals and says where to go, rather than being terminal.
  assert.match(runs, /risk queue/)

  // Overriding a fraud control is at least as sensitive as approving the payment
  // it stopped, so it carries the same controls — and never the preparer.
  assert.match(risk, /requirePermission\("payment\.approve_run"/)
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
  const settings = fs.readFileSync(path.resolve(__dirname, "../components/settings/payment-approvers-group.tsx"), "utf8")
  const decide = runs.slice(runs.indexOf("export async function decidePaymentRun"), runs.indexOf("async function assertRunRiskAllowed"))

  // The roster is a second gate AFTER the permission, never a replacement for it.
  assert.match(decide, /requirePermission\("payment\.approve_run", context\)/)
  assert.match(decide, /assertUserMayApproveRun\(\{[\s\S]*?userId: context\.userId,[\s\S]*?divisionIds: runDivisionIds/)

  // An empty roster falls back to permission-only; a configured one is exclusive.
  const assertMay = approvers.slice(approvers.indexOf("export async function assertUserMayApproveRun"))
  assert.match(assertMay, /if \(rows\.length === 0\) return/)
  assert.match(assertMay, /not a designated payment-run approver/)
  assert.match(assertMay, /exceeds your approval limit/)

  // Designating someone who cannot approve would create a roster that blocks every run.
  const setRoster = approvers.slice(approvers.indexOf("export async function setPaymentRunApprovers"))
  assert.match(setRoster, /payment\.manage_rail/)
  assert.match(setRoster, /needs a role that grants payment-run approval/)

  // The preparer is not part of the designated approval roster. One required
  // signature needs one designated approver; the runtime skips the preparer.
  const rosterSizeCheck = settings.slice(
    settings.indexOf("const tooFewForMode"),
    settings.indexOf("const modeDirty"),
  )
  assert.match(rosterSizeCheck, /chain\.length < requiredSignatures/)
  assert.doesNotMatch(rosterSizeCheck, /requiredSignatures \+/)
})

test("the approver roster migration is org-scoped, RLS-protected, and separates read from write", () => {
  const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260803193117_payment_run_approver_roster.sql"), "utf8")
  const normalization = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260812124629_normalize_payment_permission_domain.sql"), "utf8")
  assert.match(migration, /create table public\.payment_run_approvers/)
  assert.match(migration, /org_id uuid not null references public\.orgs\(id\) on delete cascade/)
  assert.match(migration, /unique \(org_id, user_id\)/)
  assert.match(migration, /alter table public\.payment_run_approvers enable row level security;/)
  // Seeing who approves is part of the workflow; changing it is a control change.
  assert.match(migration, /payment_run_approvers_read[\s\S]*?has_org_permission\(org_id, 'payment\.release'\)/)
  assert.match(normalization, /payment_run_approvers_write[\s\S]*?has_org_permission\(org_id, 'payment\.manage_rail'\)/)
})

test("preparing a payable for approval resolves the destination server-side and never releases money", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payable-approvals.ts"), "utf8")
  const prepare = service.slice(service.indexOf("export async function preparePayableApproval"), service.indexOf("export interface PayableApprovalDetail"))

  // A client may name the amount and the funding account it comes from; it may
  // never name the bank account the money lands in. The destination is looked up
  // from the vendor's active relationship, keyed off the bill's own company.
  assert.match(prepare, /from\("vendor_payment_relationships"\)[\s\S]*?recipient_account_id/)
  // The preparation layer verifies readiness, but the payment-run service is
  // the one mutation home that freezes the trusted destination. Carrying a
  // destination through the action input would advertise it as caller-owned.
  assert.doesNotMatch(prepare, /recipient_account_id:/)
  assert.match(prepare, /recipientByCompany\.get\(bill\.company_id\)/)
  assert.doesNotMatch(prepare, /input\.recipient_account_id|parsed\.recipient_account_id/)

  // Preparing drafts a run; submission and approval stay separate acts.
  assert.match(prepare, /createPaymentRun\(/)
  assert.doesNotMatch(prepare, /submitPaymentRun\(|executePaymentRun\(/)

  // Overpaying a bill is caught before a run exists.
  assert.match(prepare, /amount_cents > outstandingCents/)

  // A batch is the normal case; the same code path serves one bill or two hundred,
  // and fees stay quoted per payable because each is its own ACH transfer.
  assert.match(prepare, /parsed\.bills\.map/)
  assert.match(prepare, /The same payable was selected twice/)
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
  const delivery = fs.readFileSync(path.resolve(__dirname, "../lib/services/notification-email-delivery.ts"), "utf8")

  // A configured roster owns the decision, so it owns the email.
  assert.match(events, /from\("payment_run_approvers"\)[\s\S]{0,400}?if \(\(designated \?\? \[\]\)\.length > 0\)/)
  // The email has to state what is being approved without opening anything.
  assert.match(events, /case "payment_run_submitted":/)
  assert.match(events, /Payment needs your approval/)
  assert.match(events, /vendor_name/)
  // And it links to the payable, where the decision is actually made.
  assert.match(delivery, /entityType === "payment_run"[\s\S]{0,200}?\/payables\?bill=/)
})

test("a submitted payable emails its selected approver immediately with durable retry", () => {
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/events.ts"), "utf8")
  const bills = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  const notifications = fs.readFileSync(path.resolve(__dirname, "../lib/services/notifications.ts"), "utf8")
  const delivery = fs.readFileSync(path.resolve(__dirname, "../lib/services/notification-email-delivery.ts"), "utf8")
  const mailer = fs.readFileSync(path.resolve(__dirname, "../lib/services/mailer.ts"), "utf8")

  // The requested route is carried on the event and only narrows the audience
  // that already passed project membership + bill.approve checks.
  assert.match(bills, /approver_ids: parsed\.preferred_approver_ids \?\? \[\]/)
  assert.match(events, /const routedApproverIds = Array\.isArray\(event\.payload\?\.approver_ids\)/)
  assert.match(events, /eligibleRecipients\.filter\(\(userId\) => routedSet\.has\(userId\)\)/)

  // Reserve a processing lease before the provider call. Success completes it;
  // failure returns it to pending for the normal outbox retry worker.
  assert.match(notifications, /input\.type === "vendor_bill_submitted"/)
  assert.match(notifications, /input\.type === "vendor_bill_approved"/)
  assert.match(notifications, /input\.type === "vendor_bill_rejected"/)
  assert.match(notifications, /status: "processing"/)
  assert.match(notifications, /await deliverNotificationEmail\(notificationId, supabase\)/)
  assert.match(notifications, /status: "completed", last_error: null/)
  assert.match(notifications, /status: "pending"/)

  // Immediate and fallback attempts share a stable provider idempotency key.
  assert.match(delivery, /idempotencyKey: `notification-\$\{notification\.id\}`/)
  assert.match(mailer, /"Idempotency-Key": payload\.idempotencyKey/)
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
  assert.match(service, /recipient_account_id: prepared\.recipient\.id/)
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
  assert.match(events, /actual_processor_fee_cents: (?:event\.)?actualProcessorFeeCents/)
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

test("approval learns coding from the canonical bill-line amount fields", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  assert.match(service, /select\("cost_code_id, budget_line_id, unit_cost_cents, quantity, description"\)/)
  assert.match(service, /Math\.round\(Number\(line\.quantity \?\? 1\) \* Number\(line\.unit_cost_cents \?\? 0\)\)/)
  assert.doesNotMatch(service, /select\("cost_code_id, budget_line_id, amount_cents, description"\)/)
})

test("org and project payables use bounded server pagination", () => {
  const orgService = fs.readFileSync(path.resolve(__dirname, "../lib/services/org-payables.ts"), "utf8")
  const projectService = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  assert.match(orgService, /\.range\(from, from \+ pageSize - 1\)/)
  assert.match(projectService, /listVendorBillsPageForProject/)
  assert.match(projectService, /\.range\(\(page - 1\) \* pageSize, page \* pageSize - 1\)/)
})

test("the payables desk tabs partition the pipeline and total real outstanding balances", () => {
  // Overlapping tabs make the figure beside each one unaddable: a pending bill
  // that counted under both "due" and "needs approval" is money reported twice.
  // Each working tab is one bucket, chosen once per payable.
  const orgService = fs.readFileSync(path.resolve(__dirname, "../lib/services/org-payables.ts"), "utf8")
  assert.match(orgService, /PAYABLE_TABS = \[\s*"drafts",\s*"approval",\s*"ready",\s*"inflight",\s*"paid",\s*"all",\s*\]/)
  // Sums are outstanding balances, so retainage and partial payments come off.
  assert.match(orgService, /payableOutstandingCents\(\{/)
  // "Ready to pay" excludes anything the rail already claims, and "in flight" is
  // exactly that set — otherwise a bill offers itself for a second payment.
  assert.match(orgService, /ready\.not\("id", "in", `\(\$\{inRunList\.join\(","\)\}\)`\)/)
  assert.match(orgService, /if \(key === "inflight"\)/)
  // A bounded scan must say so rather than quietly understating the totals.
  assert.match(orgService, /summaryTruncated: \(summaryResult\.count \?\? 0\) > SUMMARY_SCAN_LIMIT/)
})

test("a payable that money has touched cannot be deleted", () => {
  // The desk hides Delete on these rows, but UI visibility is not authorization:
  // deleting a bill an approved run is about to pay would strand the run's
  // frozen item, and deleting a paid one erases the record its payment answers to.
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  const deleteBody = service.slice(service.indexOf("export async function deleteVendorBill"))
  assert.match(deleteBody, /has recorded payments and cannot be deleted/)
  assert.match(deleteBody, /belongs to an active payment run/)
  assert.match(deleteBody, /from\("payment_run_items"\)/)
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
  assert.match(updateBlock, /actual_processor_fee_cents: (?:event\.)?actualProcessorFeeCents/)
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
  const stripe = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/payments/stripe-ap.ts"), "utf8")
  assert.match(stripe, /charge_type === "platform_fee"/)
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
  assert.match(controls, /approval_mode === "dual" && approvalActors\.has\(input\.userId\)/)
  assert.match(controls, /input\.bill\.approved_by, \.\.\.\(input\.separationActorIds \?\? \[\]\)/)
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
  assert.match(service, /Math\.max\(\s*0,\s*\(paidByCompany\.get\(company\.id\) \?\? 0\) - reversedCents,?\s*\)/)
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
  assert.doesNotMatch(notices, /metadata\.submitted_via_portal !== true/)
  assert.match(notices, /idempotencyKey: `vendor-bill-\$\{input\.kind\}-\$\{input\.eventId \?\? bill\.id\}`/)
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

// ---------------------------------------------------------------------------
// Payment runs have no desk: composition and release happen on the payables page.
// ---------------------------------------------------------------------------

test("the payment-runs route redirects instead of rendering a desk", () => {
  const root = path.resolve(__dirname, "..")
  const dir = path.join(root, "app/(app)/payables/payment-runs")
  // The composition table there was a second payables desk, and the approval
  // queue went unvisited because approvals arrive by email. Only the redirect
  // survives, because approval emails already sent point at the old URL.
  assert.deepEqual(fs.readdirSync(dir), ["page.tsx"])
  const page = fs.readFileSync(path.join(dir, "page.tsx"), "utf8")
  assert.match(page, /redirect\(run \? `\/payables\?run=\$\{run\}` : "\/payables"\)/)

  // Nothing else may point at a surface that no longer renders.
  for (const file of [
    "app/(app)/payables/payables-desk.tsx",
    "components/payables/payables-workspace.tsx",
    "lib/services/search-config.ts",
    "lib/services/ai-search/config.ts",
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, file), "utf8"),
      /payables\/payment-runs/,
      `${file} still links to the deleted payment-runs desk`,
    )
  }
})

test("an approver sees the whole frozen set, not just the payable they opened", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/payable-approvals.ts"), "utf8")
  const detail = service.slice(service.indexOf("export async function getPayableApprovalDetail"))
  // The signature binds to the run's content hash, so showing one line beside
  // the run's total asked someone to sign for money they could not see.
  assert.match(detail, /\.eq\("run_id", item\.run_id\)/)
  assert.match(detail, /items: \(runItems \?\? \[\]\)\.map/)

  const review = fs.readFileSync(
    path.resolve(__dirname, "../components/payables/workspace/payable-review-view.tsx"),
    "utf8",
  )
  assert.match(review, /payments in this run/)
  // Fees are per payment because each payable is its own ACH transfer.
  assert.match(review, /Priced per payment/)
})

test("reconciliation lives in ops, where a job whose silence is the alarm belongs", () => {
  const root = path.resolve(__dirname, "..")
  const ops = fs.readFileSync(path.join(root, "components/admin/ops-client.tsx"), "utf8")
  assert.match(ops, /Payment reconciliation/)
  assert.match(ops, /Reconcile last 24 hours/)
  // Closing an exception is audit evidence, so the note stays mandatory.
  assert.match(ops, /resolveReconciliationExceptionAction/)
  const actions = fs.readFileSync(path.join(root, "app/(app)/admin/ops/actions.ts"), "utf8")
  assert.match(actions, /resolvePaymentReconciliationItem/)
})

test("the second factor is asked for at the decision, not in front of it", () => {
  const root = path.resolve(__dirname, "..")
  // The old gate rendered a code box before the approver could read the run.
  assert.equal(fs.existsSync(path.join(root, "components/payments/payment-step-up-gate.tsx")), false)

  const hook = fs.readFileSync(path.join(root, "components/payments/payment-step-up.tsx"), "utf8")
  // Satisfied sessions never see a prompt; stale ones verify and the action runs.
  assert.match(hook, /if \(await isSatisfied\(\)\) \{\s*\n\s*action\(\)/)
  assert.match(hook, /challengeAndVerify/)
  assert.match(hook, /InputOTP/)
  // Shared pure policy, so client and server cannot disagree about freshness.
  assert.match(hook, /evaluatePaymentStepUp/)

  for (const file of [
    "components/payables/workspace/payable-review-view.tsx",
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8")
    assert.match(source, /requireStepUp\(\(\) =>/, `${file} must ask on the press`)
    assert.match(source, /\{stepUpPrompt\}/, `${file} must mount the prompt`)
  }

  // The server rule is untouched — this is convenience, never the control.
  const service = fs.readFileSync(path.join(root, "lib/services/payment-runs.ts"), "utf8")
  assert.match(service, /requireRecentPaymentStepUp/)
})

// ---------------------------------------------------------------------------
// Certificate-of-insurance reading
//
// The insurance hold blocks payment, so these tests are mostly about the
// degrade paths: every way a reading can be absent, stale or untrustworthy has
// to land back on the status-and-expiry rule that shipped before any model was
// involved. A model failure may not release a payment, and it may not stop one.
// ---------------------------------------------------------------------------

const {
  buildCoiExtractionInputKey,
  evaluateInsuranceCurrency,
  isCoiPolicyCurrent,
  isInsuranceDocumentTypeName,
} = require("../lib/payments/ap-verification")

const TODAY = "2026-08-08"

function reading(overrides = {}) {
  return {
    carrier_name: "Ironshore",
    policy_number: "GL-4417",
    policy_type: "general_liability",
    each_occurrence_cents: 100_000_000,
    aggregate_cents: 200_000_000,
    effective_date: "2026-01-01",
    expiry_date: "2026-12-31",
    additional_insured: true,
    certificate_holder: "Arc Builders",
    confidence: "high",
    notes: [],
    file_id: "file-1",
    model: "gemini-flash",
    extracted_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }
}

function document(overrides = {}) {
  return { status: "approved", storedExpiry: null, fileId: "file-1", extraction: null, ...overrides }
}

test("a vendor with no insurance document falls through to overall compliance", () => {
  assert.deepEqual(evaluateInsuranceCurrency({ documents: [], todayIso: TODAY, fallbackCompliant: true }), {
    current: true,
    contradiction: null,
    basis: "no_documents",
  })
  assert.equal(
    evaluateInsuranceCurrency({ documents: [], todayIso: TODAY, fallbackCompliant: false }).current,
    false,
  )
})

test("without a reading the insurance fact is exactly the pre-extraction rule", () => {
  const cases = [
    [document(), true, "approved with no recorded expiry passes, as it always has"],
    [document({ storedExpiry: "2026-12-31" }), true, "approved and unexpired passes"],
    [document({ storedExpiry: "2026-01-01" }), false, "approved but expired fails"],
    [document({ status: "pending_review" }), false, "an unapproved certificate is not coverage"],
    [document({ status: "rejected", storedExpiry: "2027-01-01" }), false, "a rejected certificate is not coverage"],
  ]
  for (const [doc, expected, message] of cases) {
    const verdict = evaluateInsuranceCurrency({ documents: [doc], todayIso: TODAY, fallbackCompliant: true })
    assert.equal(verdict.current, expected, message)
    assert.equal(verdict.basis, "stored")
  }
})

test("one current certificate is still enough", () => {
  const verdict = evaluateInsuranceCurrency({
    documents: [document({ storedExpiry: "2026-01-01" }), document({ storedExpiry: "2027-01-01" })],
    todayIso: TODAY,
    fallbackCompliant: false,
  })
  assert.equal(verdict.current, true)
})

test("a lapsed certificate is reported loudly but never blocks on the reading alone", () => {
  // The record says current because nobody typed a date in; the certificate
  // says otherwise. That disagreement is worth a human's attention, but a
  // model must not be able to stop a subcontractor being paid by itself.
  const verdict = evaluateInsuranceCurrency({
    documents: [document({ extraction: reading({ expiry_date: "2026-03-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(verdict.current, true, "the blocking fact still comes from the compliance record")
  assert.equal(verdict.basis, "extracted")
  assert.match(verdict.contradiction, /expired 2026-03-01/)
})

test("a certificate that has not taken effect yet is reported, not enforced", () => {
  const verdict = evaluateInsuranceCurrency({
    documents: [document({ extraction: reading({ effective_date: "2026-10-01", expiry_date: "2027-10-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(verdict.current, true)
  assert.match(verdict.contradiction, /not effective until 2026-10-01/)
})

test("the compliance record decides blocking and the reading is surfaced beside it", () => {
  // A person looked at the page and committed to a date. The model's date is
  // evidence for them to re-check, never an override in either direction.
  const stillCurrent = evaluateInsuranceCurrency({
    documents: [document({ storedExpiry: "2027-01-01", extraction: reading({ expiry_date: "2026-03-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(stillCurrent.current, true, "the stored expiry keeps the payment releasable")
  assert.match(stillCurrent.contradiction, /expires 2026-03-01, the recorded expiry is 2027-01-01/)

  const blocked = evaluateInsuranceCurrency({
    documents: [document({ storedExpiry: "2026-03-01", extraction: reading({ expiry_date: "2027-01-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(blocked.current, false, "the stored expiry blocks even when the model reads a later one")
  assert.match(blocked.contradiction, /expires 2027-01-01, the recorded expiry is 2026-03-01/)
})

test("a reading that cannot be trusted degrades to the stored rule and never blocks", () => {
  const degraded = [
    // The file was replaced; the reading describes a page nobody is looking at.
    document({ extraction: reading({ file_id: "file-2", expiry_date: "2026-03-01" }) }),
    // The model said it was guessing.
    document({ extraction: reading({ confidence: "low", expiry_date: "2026-03-01" }) }),
    // The certificate has no date on it that the model could find.
    document({ extraction: reading({ expiry_date: null }) }),
  ]
  for (const doc of degraded) {
    const verdict = evaluateInsuranceCurrency({ documents: [doc], todayIso: TODAY, fallbackCompliant: true })
    assert.equal(verdict.current, true, "an untrustworthy reading must not turn a passing bill into a blocked one")
  }
})

test("isCoiPolicyCurrent needs a date on both ends of the window", () => {
  assert.equal(isCoiPolicyCurrent({ effective_date: "2026-01-01", expiry_date: "2026-12-31" }, TODAY), true)
  assert.equal(isCoiPolicyCurrent({ effective_date: null, expiry_date: "2026-12-31" }, TODAY), true)
  assert.equal(isCoiPolicyCurrent({ effective_date: null, expiry_date: null }, TODAY), false)
  assert.equal(isCoiPolicyCurrent({ effective_date: null, expiry_date: TODAY }, TODAY), true, "expiring today is still today")
})

test("the extraction cache key moves only when the file does", () => {
  const base = buildCoiExtractionInputKey({ fileId: "file-1", fileUpdatedAt: "2026-08-01T00:00:00.000Z" })
  assert.equal(base, buildCoiExtractionInputKey({ fileId: "file-1", fileUpdatedAt: "2026-08-01T00:00:00.000Z" }))
  assert.notEqual(base, buildCoiExtractionInputKey({ fileId: "file-1", fileUpdatedAt: "2026-08-02T00:00:00.000Z" }))
  assert.notEqual(base, buildCoiExtractionInputKey({ fileId: "file-2", fileUpdatedAt: "2026-08-01T00:00:00.000Z" }))
})

test("the insurance document filter is the same one the hold always used", () => {
  for (const name of ["General Liability Insurance", "Certificate of Insurance", "COI", "workers comp certificate"]) {
    assert.equal(isInsuranceDocumentTypeName(name), true, name)
  }
  for (const name of ["W-9", "Business License", null, undefined, ""]) {
    assert.equal(isInsuranceDocumentTypeName(name), false, String(name))
  }
})

test("the insurance hold reads stored certificate claims and never writes them", () => {
  const holds = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-holds.ts"), "utf8")
  // The fact changed; the policy did not. insurance_current keeps its level.
  assert.match(holds, /insuranceCurrent: insurance\.current/)
  assert.match(holds, /insuranceContradiction: insurance\.contradiction/)
  assert.match(holds, /evaluateInsuranceCurrency\(\{/)
  // evaluateHolds is a read path: it must not extract, only read what a job wrote.
  assert.doesNotMatch(holds, /extractCoiFacts/)
  // Every failure of the metadata read returns an empty map, i.e. today's rule.
  assert.match(holds, /if \(error \|\| !data\) return readings/)
})

test("certificate extraction is a background job that only ever writes metadata", () => {
  const service = fs.readFileSync(path.resolve(__dirname, "../lib/services/ap-document-verification.ts"), "utf8")
  const worker = fs.readFileSync(path.resolve(__dirname, "../app/api/jobs/process-outbox/route.ts"), "utf8")
  const compliance = fs.readFileSync(path.resolve(__dirname, "../lib/services/compliance-documents.ts"), "utf8")

  // The job type is registered on both sides of the worker, or it never runs.
  assert.match(worker, /"extract_coi_facts",/)
  assert.match(worker, /job\.job_type === "extract_coi_facts"/)
  assert.match(worker, /await extractCoiFacts\(fileId, job\.org_id\)/)

  // Extraction touches metadata and nothing else — never status, never a date
  // column, never a lifecycle field on the compliance document.
  assert.match(service, /\.from\("compliance_documents"\)\s*\n\s*\.update\(\{ metadata \}\)/)
  assert.doesNotMatch(service, /update\(\{[^}]*status:/)
  assert.doesNotMatch(service, /update\(\{[^}]*expiry_date:/)
  // Failures are recorded and returned as data, so a bad scan is not a retry storm.
  assert.match(service, /compliance_document_coi_extraction_failed/)
  assert.match(service, /compliance_document_coi_extracted/)
  assert.match(service, /reason: "model_failed"/)

  // Enqueued opportunistically on upload and on approval, deduped by file.
  assert.match(compliance, /jobType: "extract_coi_facts"/)
  assert.match(compliance, /dedupeByPayloadKeys: \["file_id"\]/)
  assert.match(compliance, /if \(parsed\.decision === "approved"\) \{/)
})

test("a document-derived claim can raise its hand but never stop a payment", () => {
  // Both AI-backed hold kinds are clamped to warn regardless of policy. This is
  // the invariant that keeps a misread certificate or waiver from stranding a
  // subcontractor: the model reports, a human decides.
  const facts = {
    projectId: "p1",
    companyId: "c1",
    complianceCurrent: true,
    insuranceCurrent: true,
    insuranceContradiction: "The scanned certificate expired 2026-03-01 but the record shows insurance as current",
    waiverRequired: true,
    waiverSigned: true,
    waiverVerification: { matches: false, mismatchSummary: "Amount: expected $1,000, found $900", documentHref: null },
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: {},
    // Even asked directly to block, these two may not.
    policy: { insurance_verified: "block", waiver_verified: "block" },
  }

  const evaluation = evaluatePaymentHoldFacts(facts)
  const kinds = evaluation.holds.map((hold) => hold.kind)
  assert.ok(kinds.includes("insurance_verified"), "the certificate disagreement is visible")
  assert.ok(kinds.includes("waiver_verified"), "the waiver mismatch is visible")
  for (const kind of ["insurance_verified", "waiver_verified"]) {
    assert.equal(evaluation.holds.find((hold) => hold.kind === kind).level, "warn", `${kind} must never block`)
  }
  assert.equal(evaluation.blockingCount, 0)
  assert.equal(evaluation.releasable, true, "a payment with only document-derived claims still releases")
})

test("a genuinely lapsed compliance record still blocks, model or no model", () => {
  const evaluation = evaluatePaymentHoldFacts({
    projectId: "p1",
    companyId: "c1",
    complianceCurrent: true,
    insuranceCurrent: false,
    insuranceContradiction: null,
    waiverRequired: false,
    waiverSigned: false,
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: {},
    policy: {},
  })
  const insurance = evaluation.holds.find((hold) => hold.kind === "insurance_current")
  assert.equal(insurance.level, "block")
  assert.equal(evaluation.releasable, false)
})

// ---------------------------------------------------------------------------
// Controls that have to hold between approval and the money leaving
// ---------------------------------------------------------------------------

/** Source with comments stripped: a comment quoting a defect is not the defect. */
function paymentSource(relativePath) {
  const source = fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8")
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

test("execution pays the destination that was approved, not wherever the vendor now points", () => {
  const runs = paymentSource("lib/services/payment-runs.ts")

  // The content hash covers `recipient_account_id`, and execution now honours
  // it. It used to discard the frozen value for primary vendors and re-read the
  // live relationship — and a portal re-claim rewrites relationship and
  // recipient together, so an approved run could execute to a bank no approver
  // ever saw.
  assert.match(runs, /const trustedRecipientId = payee\.recipient_account_id/)
  assert.doesNotMatch(
    runs,
    /trustedRecipientId = payee\.payee_kind === "primary_vendor" \? relationship\?\.recipient_account_id/,
    "execution must not re-read the live destination",
  )
  // Changed since approval means fail closed with a re-approve instruction —
  // never a silent payment to the new destination.
  assert.match(runs, /relationship\?\.recipient_account_id !== trustedRecipientId/)
  assert.match(runs, /changed after this run was approved/)
  // And a client-supplied destination is still ignored at composition time.
  assert.match(runs, /recipient_account_id: prepared\.recipient\.id/)
  assert.doesNotMatch(runs, /recipient_account_id:\s*payee\.recipient_account_id/)
})

test("a changed payout destination is frozen and everyone affected is told", () => {
  const setup = paymentSource("lib/services/payment-rail-setup.ts")

  // Both columns were read in four places and written in none, so the fintech
  // plan's signature control did not exist. A provider-side bank swap — the
  // compromised-Stripe-login case — arrives through syncVendorRecipient.
  assert.match(setup, /destination_locked_until: lockedUntil, destination_version: input\.previousVersion \+ 1/)
  assert.match(setup, /const destinationChanged = Boolean\(previousBankLast4\)/)
  assert.match(setup, /applyDestinationChangeHold\(\{/)
  // Compare-and-swap on the version just read, so two racing webhooks cannot
  // both believe they applied the first change.
  assert.match(setup, /\.eq\("destination_version", input\.previousVersion\)/)
  // Out-of-band, to the builders and to the vendor.
  assert.match(setup, /eventType: "vendor_payout_destination_changed"/)
  assert.match(setup, /notifyVendorOfDestinationChange/)
  // Masked only — no full account or routing number in a notification.
  assert.doesNotMatch(setup, /routing_number|account_number/)

  // Wiring the notification service is not enough; only allowlisted types send.
  const notifications = fs.readFileSync(path.resolve(__dirname, "../lib/types/notifications.ts"), "utf8")
  assert.match(notifications, /key: "vendor_payout_destination_changed"/)
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/events.ts"), "utf8")
  assert.match(events, /case "vendor_payout_destination_changed"/)
})

test("the destination cooling period is configurable, with the documented default and bounds", () => {
  const setup = paymentSource("lib/services/payment-rail-setup.ts")
  assert.match(setup, /DEFAULT_DESTINATION_COOLING_HOURS = 72/)
  assert.match(setup, /MIN_DESTINATION_COOLING_HOURS = 24/)
  assert.match(setup, /MAX_DESTINATION_COOLING_HOURS = 168/)
  // The policy column the builder already sets is what drives it.
  assert.match(setup, /control_change_cooling_hours/)

  // And the lock is enforced everywhere it is read — these were live checks
  // guarding a column nothing ever wrote.
  const runs = paymentSource("lib/services/payment-runs.ts")
  const payouts = paymentSource("lib/services/payment-payouts.ts")
  assert.equal((runs.match(/destination_locked_until/g) ?? []).length >= 3, true)
  assert.match(payouts, /destination_locked_until/)
  assert.match(payouts, /security cooling period/)
})

test("a manual risk override clears the signals it reviewed and nothing else", () => {
  const runs = paymentSource("lib/services/payment-runs.ts")
  const risk = paymentSource("lib/services/payment-risk.ts")

  // It was a standing per-run "allow": clearing repeated_payment_failures at
  // submit also waived recently_claimed_vendor_relationship,
  // inflight_exposure_exceeded and daily_limit_exceeded at execution.
  assert.match(risk, /latestBlockingSignalCodes/)
  assert.match(risk, /cleared_codes: clearedCodes/)
  assert.match(runs, /blockingCodes\.filter\(\(code\) => !override\.clearedCodes\.includes\(code\)\)/)
  assert.match(runs, /const decision = uncleared\.length > 0 \? "block" : "allow"/)
  // A reviewer cannot pre-clear a run that is not currently blocked.
  assert.match(risk, /not currently blocked by any risk signal/)
})

test("the two spend limits bind live, so tightening one reaches runs already built", () => {
  const runs = paymentSource("lib/services/payment-runs.ts")

  // per_run and daily were read from the frozen control snapshot while
  // new_vendor_hold_hours and max_inflight_cents were deliberately read live —
  // the justification for live reads applies identically to all four.
  assert.match(runs, /select\("new_vendor_hold_hours,max_inflight_cents,per_run_limit_cents,daily_limit_cents"\)/)
  assert.match(runs, /const tighterLimit =/)
  assert.match(runs, /tighterLimit\(policy \? Reflect\.get\(policy, "per_run_limit_cents"\) : null, livePolicy\?\.per_run_limit_cents\)/)
  assert.match(runs, /tighterLimit\(policy \? Reflect\.get\(policy, "daily_limit_cents"\) : null, livePolicy\?\.daily_limit_cents\)/)
  // The frozen snapshot stays on the run as evidence of what the approver saw.
  assert.match(runs, /p_control_snapshot: \{ policy/)
})

test("disabling the rail stops payments that were already approved", () => {
  const runs = paymentSource("lib/services/payment-runs.ts")
  const payouts = paymentSource("lib/services/payment-payouts.ts")

  // The policy row was checked only in createPaymentRun, so an admin disabling
  // the rail did not stop approved runs — including scheduled releases that
  // fire days later with nobody present.
  const execution = runs.slice(runs.indexOf("export async function executePaymentRun"))
  assert.match(execution, /const executionPolicy = await loadPaymentPolicy\(context\.orgId\)/)
  assert.match(execution, /if \(!executionPolicy\.enabled\) throw new Error/)

  // The transfer sweep checked only the env switch. It now reads each org's
  // policy and holds — recoverably — rather than completing the irreversible leg.
  assert.match(payouts, /railEnabledByOrg/)
  assert.match(payouts, /if \(!railEnabledByOrg\.get\(row\.org_id\)\)/)
})

test("a payment that stops moving becomes a reconciliation exception, not silence", () => {
  const reconciliation = paymentSource("lib/services/payment-reconciliation.ts")

  // Production had a run `processing` and its disbursement `transfer_pending`
  // for six days with no sweep, alert or exception.
  assert.match(reconciliation, /STALE_PAYMENT_STATE_HOURS = 96/)
  assert.match(reconciliation, /flagStalePaymentStates/)
  assert.match(reconciliation, /NON_TERMINAL_DISBURSEMENT_STATUSES/)
  assert.match(reconciliation, /NON_TERMINAL_RUN_STATUSES/)
  // Reuses the existing exception machinery rather than a parallel one.
  assert.match(reconciliation, /from\("payment_reconciliation_items"\)\.insert\(/)
  // And it is reported loudly, not logged.
  assert.match(reconciliation, /eventType: "payment_operations_alert"/)
  assert.match(reconciliation, /reason: "stale_payment_state"/)
  assert.match(reconciliation, /exceptionCount \+= await flagStalePaymentStates/)
  assert.match(reconciliation, /RECONCILIATION_PAGE_SIZE = 500/)
  assert.doesNotMatch(reconciliation, /limit\(2_000\)/)
})

test("only platform owners can record the external payment launch approvals", () => {
  const readiness = paymentSource("lib/services/payment-launch-readiness.ts")

  assert.match(readiness, /access\.isEnvSuperadmin/)
  assert.match(readiness, /access\.roles\.includes\("platform_super_admin"\)/)
  assert.match(readiness, /const \{ user \} = await requirePaymentLaunchOwner\(\)/)
  assert.doesNotMatch(readiness, /requirePermission\("platform\.support\.write"/)
})

test("provider accounts are not created against live keys before live mode is approved", () => {
  const stripeAp = paymentSource("lib/integrations/payments/stripe-ap.ts")

  // The gate gets you nothing if the calls that mint vendor-facing Express
  // accounts and attach real bank details sit outside it.
  for (const call of ["createRecipient", "createRecipientOnboardingLink", "createFundingCustomer", "createFundingSetup"]) {
    const body = stripeAp.slice(stripeAp.indexOf(`async ${call}(`))
    assert.match(body.slice(0, 400), /assertStripeExecutionMode\(\)/, `${call} must assert execution mode`)
  }
  // Stripe idempotency keys expire after 24 hours, so the retry the next day
  // used to mint a second Express account for the same vendor.
  assert.match(stripeAp, /findRecipientByVendorEntity/)
  assert.match(stripeAp, /MAX_RECIPIENT_LOOKUP_ACCOUNTS/)
})

test("duplicate provider webhooks are settled by the unique index, not by a prior read", () => {
  const events = paymentSource("lib/services/payment-provider-events.ts")
  const route = paymentSource("app/api/webhooks/stripe/route.ts")

  // Two deliveries of one event both read "no row" and both inserted; the
  // loser's 23505 read as a processing failure and Stripe retried an event that
  // had in fact been stored.
  assert.match(events, /code !== "23505"/)
  assert.match(route, /code !== "23505"/)
  // And the service-role writes are org-scoped, unique provider id or not.
  assert.match(route, /await recordPayment\([\s\S]*?domainEvent\.org_id,\s*\)/)
  assert.match(route, /const chargeOrgId = orgId \?\?/)
  assert.match(route, /\.eq\("org_id", chargeOrgId\)/)
})

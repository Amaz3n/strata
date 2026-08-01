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
} = require("../lib/payments/payment-domain")
const {
  DEFAULT_PAYMENT_FEE_POLICY,
  calculatePaymentFeeQuote,
  quoteApDisbursementFee,
} = require("../lib/payments/fee-engine")

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
    totalDebitCents: 100_800,
    description: "Provider processing costs passed through at cost",
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

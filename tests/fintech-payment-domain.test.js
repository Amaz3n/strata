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
const {
  DEFAULT_PAYMENT_HOLD_POLICY,
  evaluatePaymentHoldFacts,
} = require("../lib/payments/payment-hold-policy")

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

test("a destination charge sends the vendor split without an application fee", () => {
  const adapter = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/payments/stripe-ap.ts"), "utf8")
  const submit = adapter.slice(adapter.indexOf("async submitDisbursement"), adapter.indexOf("async retrieveSettlement"))
  // Stripe 400s when both are present. The old code set application_fee_amount
  // only when fees were non-zero, so execution worked ONLY on zero-fee runs.
  assert.match(submit, /transfer_data:\s*\{[\s\S]*?amount: input\.recipientAmountCents/)
  assert.doesNotMatch(submit, /application_fee_amount\s*:/)
  // The debit still has to cover the vendor plus both fees, or the platform
  // silently eats the difference.
  assert.match(submit, /amount: input\.debitAmountCents/)
})

test("a designated approver roster narrows who can decide a run, and never widens it", () => {
  const runs = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-runs.ts"), "utf8")
  const approvers = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-approvers.ts"), "utf8")
  const decide = runs.slice(runs.indexOf("export async function decidePaymentRun"), runs.indexOf("async function assertRunRiskAllowed"))

  // The roster is a second gate AFTER the permission, never a replacement for it.
  assert.match(decide, /requirePermission\("payments\.approve_run", context\)/)
  assert.match(decide, /assertUserMayApproveRun\(\{ userId: context\.userId, orgId: context\.orgId, totalDebitCents/)

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

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { evaluatePaymentHoldFacts } = require("../lib/payments/payment-hold-policy")
const { paymentHoldKindSchema } = require("../lib/validation/payment-holds")
const { DEFAULT_COMPLIANCE_RULES } = require("../lib/services/compliance")

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8")
}

const COMPLIANCE = "lib/services/compliance-documents.ts"
const AUTOPILOT = "lib/services/compliance-autopilot.ts"
const MIGRATION = "supabase/migrations/20260819120000_compliance_system_hardening.sql"
const EXPLICIT_REQUIREMENTS_MIGRATION =
  "supabase/migrations/20260826143000_explicit_vendor_compliance.sql"
const MONITORING_MIGRATION =
  "supabase/migrations/20260827020317_company_compliance_monitoring.sql"

/* ================================================================
 * The gate between compliance and money
 * ============================================================== */

test("an override exists in the database for every hold the UI can raise", () => {
  const migration = source(MIGRATION)
  // The override CHECK listed five kinds while the policy and the override
  // button offered seven, so overriding either AI-claim hold raised a raw
  // Postgres constraint error instead of releasing the bill.
  for (const kind of paymentHoldKindSchema.options) {
    assert.match(
      migration,
      new RegExp(`'${kind}'`),
      `payment_hold_overrides must accept the ${kind} hold`,
    )
  }
})

test("a model's reading can never block a payment on its own", () => {
  const verdict = evaluatePaymentHoldFacts({
    projectId: "p1",
    companyId: "c1",
    complianceCurrent: true,
    insuranceCurrent: true,
    insuranceContradiction: "The certificate expired in March",
    waiverRequired: false,
    waiverSigned: false,
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: {},
    // Even asked to block, an AI claim stays a warning.
    policy: { insurance_verified: "block", waiver_verified: "block" },
  })

  const insuranceVerified = verdict.holds.find((hold) => hold.kind === "insurance_verified")
  assert.ok(insuranceVerified, "a contradiction must surface as a hold")
  assert.equal(insuranceVerified.level, "warn")
  assert.equal(verdict.releasable, true, "a warning alone cannot stop payment")
})

test("an umbrella policy is insurance to the payment hold", () => {
  const holds = source("lib/services/payment-holds.ts")

  // The hold selected insurance documents by matching the TYPE NAME against
  // /insurance|certificate|coi/. The seeded "Umbrella / Excess Liability" type
  // contains none of those words, so an expired umbrella policy was invisible
  // to the gate and never held a payment.
  assert.match(holds, /type\.kind === "insurance"/)
  assert.doesNotMatch(
    holds,
    /documents\.filter\(\(document\) => isInsuranceDocumentTypeName\(document\.document_type\?\.name\)\)/,
  )

  // Same story for the extraction trigger.
  const compliance = source(COMPLIANCE)
  const enqueue = compliance.slice(
    compliance.indexOf("async function enqueueCoiExtraction"),
    compliance.indexOf("// ============ Mappers ============"),
  )
  assert.match(enqueue, /kind === "insurance"/)
})

test("compliance rule fallbacks carry the whole shape", () => {
  // Callers used to inline partial copies of these defaults; a copy missing a
  // key silently answers false for it, which is a rule quietly switching off.
  for (const key of [
    "require_lien_waiver",
    "block_payment_on_missing_docs",
    "warn_subcontract_execution_on_missing_docs",
    "block_subcontract_execution_on_missing_docs",
    "block_commitment_on_prequal",
    "prequalification_validity_days",
  ]) {
    assert.ok(key in DEFAULT_COMPLIANCE_RULES, `${key} missing from the shared default`)
  }
  assert.equal(DEFAULT_COMPLIANCE_RULES.block_payment_on_missing_docs, true)

  const bills = source("lib/services/vendor-bills.ts")
  // A read failure must not stamp "not_required" onto a payable — that is a
  // weakening the release gate would then have to un-learn.
  assert.match(bills, /getComplianceRules\(resolvedOrgId\)\.catch\(\(\) => null\)/)
  assert.match(bills, /if \(rules\) \{/)
})

/* ================================================================
 * Requirements cannot silently vanish
 * ============================================================== */

test("setting vendor requirements is a diff, never delete-then-insert", () => {
  const compliance = source(COMPLIANCE)
  const fn = compliance.slice(
    compliance.indexOf("export async function setCompanyRequirements"),
    compliance.indexOf("// ============ Requirement Waivers ============"),
  )

  // The old shape emptied the table first: a failed insert, or a concurrent
  // edit landing in the gap, left the vendor with zero requirements — which
  // reads as "compliant" and releases every held payable.
  assert.doesNotMatch(
    fn,
    /\.delete\(\)\s*\.eq\("org_id", resolvedOrgId\)\s*\.eq\("company_id", companyId\)/,
    "requirements must never be cleared wholesale",
  )
  assert.match(fn, /const inserts =/)
  assert.match(fn, /const updates =/)
  assert.match(fn, /const removedIds =/)

  // Removals go last so the window where a requirement is absent only exists
  // after everything that must survive is already in place.
  assert.ok(
    fn.indexOf("if (inserts.length > 0)") < fn.indexOf("if (removedIds.length > 0)"),
    "inserts must land before removals",
  )
})

test("the compliance permissions survive a catalog regeneration", () => {
  const catalog = source("supabase/migrations/20260708120500_rbac_catalog_seed.sql")

  // That file is the catalog source of truth and ends with a DELETE pruning any
  // grant absent from its `desired` list, for exactly the roles the compliance
  // migration grants to. Declaring them only in the newer migration would work
  // until the next regeneration, then silently turn compliance read-only.
  for (const key of ["compliance.read", "compliance.manage", "compliance.review"]) {
    assert.match(catalog, new RegExp(`\\('${key.replace(".", "\\.")}'`), `${key} missing from the catalog`)
  }
  assert.match(catalog, /\('org_owner', 'compliance\.review'\)/)
  assert.match(catalog, /\('org_bookkeeper', 'compliance\.manage'\)/)
})

test("the autopilot only records persisted vendor requirements", () => {
  const autopilot = source(AUTOPILOT)

  assert.match(autopilot, /requirement_id: args\.requirement\.id/)
  assert.doesNotMatch(autopilot, /org-default:/)
})

test("new vendors are not automatically enrolled in compliance", () => {
  const companies = source("lib/services/companies.ts")
  const compliance = source(COMPLIANCE)
  const autopilot = source(AUTOPILOT)
  const migration = source(EXPLICIT_REQUIREMENTS_MIGRATION)

  assert.doesNotMatch(companies, /setCompanyRequirements\(/)
  assert.doesNotMatch(companies, /getDefaultComplianceRequirements/)
  assert.doesNotMatch(compliance, /orgDefaultToRequirement/)
  assert.doesNotMatch(autopilot, /default_compliance_requirements/)
  assert.match(migration, /on conflict \(company_id, document_type_id\) do nothing/)
})

test("the project overlay uses the same non-destructive shape", () => {
  const overlay = source("lib/services/project-compliance-requirements.ts")
  assert.match(overlay, /const inserts =/)
  assert.match(overlay, /const removedIds =/)
  assert.ok(
    overlay.indexOf("if (inserts.length > 0)") < overlay.indexOf("if (removedIds.length > 0)"),
  )
})

/* ================================================================
 * One resolver, so nothing can disagree about what a vendor owes
 * ============================================================== */

test("the autopilot chases only explicitly assigned vendor requirements", () => {
  const autopilot = source(AUTOPILOT)
  assert.match(autopilot, /resolveOrgRequirementRows/)
  const resolver = autopilot.slice(autopilot.indexOf("async function resolveOrgRequirementRows"))
  assert.match(resolver, /company_compliance_requirements/)
  assert.doesNotMatch(resolver, /default_compliance_requirements/)
  assert.match(resolver, /companies!inner/)
  assert.match(resolver, /companies\.compliance_monitoring_enabled/)
})

test("compliance monitoring is reversible, defaults off, and preserves existing enrollment", () => {
  const migration = source(MONITORING_MIGRATION)
  const compliance = source(COMPLIANCE)
  const actions = source("app/(app)/directory/[id]/compliance/actions.ts")
  const workspace = source("components/companies/account/compliance-workspace.tsx")

  assert.match(migration, /compliance_monitoring_enabled boolean not null default false/)
  assert.match(migration, /company_compliance_requirements requirement/)
  assert.match(compliance, /export async function setCompanyComplianceMonitoring/)
  assert.match(compliance, /directory\.compliance\.monitoring/)
  assert.match(compliance, /applyComplianceMonitoring/)
  assert.match(actions, /setCompanyComplianceMonitoringAction/)
  assert.match(workspace, /Compliance monitoring for/)
  assert.match(workspace, /Autopilot is paused/)
})

test("a vendor can waive every standing requirement in one audited action", () => {
  const compliance = source(COMPLIANCE)
  const actions = source("app/(app)/directory/[id]/compliance/actions.ts")
  const workspace = source("components/companies/account/compliance-workspace.tsx")

  assert.match(compliance, /export async function waiveAllCompanyRequirements/)
  assert.match(compliance, /directory\.compliance\.bulk_waiver/)
  assert.match(actions, /waiveAllCompanyRequirementsAction/)
  assert.match(workspace, /Waive all/)
})

test("the resolver is layered and exported for every consumer", () => {
  const compliance = source(COMPLIANCE)
  assert.match(compliance, /export function resolveEffectiveRequirements/)
  const resolver = compliance.slice(
    compliance.indexOf("export function resolveEffectiveRequirements"),
    compliance.indexOf("async function getProjectRequirementsWithClient"),
  )
  assert.match(resolver, /projectRequirements/)
  assert.match(resolver, /source: "company_override"/)
  assert.match(resolver, /source: "project_overlay"/)

  // A layer may raise terms; it must never drop one another layer set. `??`
  // would have let an overlay naming $1M replace a vendor rule of $5M, and with
  // several projects in scope whichever row sorted last would have won.
  assert.match(resolver, /requirement\.requires_additional_insured \|\| Boolean\(existing\?\./)
  assert.match(resolver, /Math\.max\(requirement\.min_coverage_cents/)
  assert.doesNotMatch(resolver, /min_coverage_cents: requirement\.min_coverage_cents \?\?/)
})

/* ================================================================
 * Reviewing is a permission, and reversible
 * ============================================================== */

test("approving a compliance document needs more than being a member", () => {
  const compliance = source(COMPLIANCE)

  // Approving a certificate releases held money; `org.member` was never the
  // right bar for it.
  const review = compliance.slice(
    compliance.indexOf("export async function reviewComplianceDocument"),
    compliance.indexOf("export async function revokeComplianceDecision"),
  )
  assert.match(review, /requirePermission\("compliance\.review"/)
  assert.doesNotMatch(review, /requirePermission\("org\.member"/)

  // Two reviewers opening the same certificate cannot both record a verdict.
  assert.match(review, /\.eq\("status", "pending_review"\)/)

  for (const [fnName, permission] of [
    ["setCompanyRequirements", "compliance.manage"],
    ["setCompanyComplianceMonitoring", "compliance.manage"],
    ["waiveCompanyRequirement", "compliance.manage"],
    ["revokeCompanyRequirementWaiver", "compliance.manage"],
    ["uploadComplianceDocument", "compliance.manage"],
  ]) {
    const start = compliance.indexOf(`export async function ${fnName}`)
    assert.ok(start > -1, `${fnName} not found`)
    const body = compliance.slice(start, start + 2000)
    assert.match(body, new RegExp(`requirePermission\\("${permission.replace(".", "\\.")}"`))
  }
})

test("a wrong approval can be withdrawn without pretending it never happened", () => {
  const compliance = source(COMPLIANCE)
  const revoke = compliance.slice(compliance.indexOf("export async function revokeComplianceDecision"))

  assert.match(revoke, /requirePermission\("compliance\.review"/)
  assert.match(revoke, /revoked_at: new Date\(\)\.toISOString\(\)/)
  // The status stays as the record of what was decided. Flipping it back to
  // pending would put a document already found wrong into the review queue.
  assert.doesNotMatch(revoke.slice(0, revoke.indexOf("recordAudit")), /status: "pending_review"/)
  assert.match(revoke, /recordAudit/)
})

test("waiving and re-scoping requirements land on the audit trail", () => {
  const compliance = source(COMPLIANCE)
  // A waiver releases the same payment hold an override would have, so it earns
  // the same permanent record. These emitted events only.
  for (const fnName of [
    "setCompanyRequirements",
    "waiveCompanyRequirement",
    "revokeCompanyRequirementWaiver",
    "uploadComplianceDocument",
  ]) {
    const start = compliance.indexOf(`export async function ${fnName}`)
    const nextExport = compliance.indexOf("\nexport async function", start + 10)
    const body = compliance.slice(start, nextExport === -1 ? undefined : nextExport)
    assert.match(body, /recordAudit\(/, `${fnName} must write an audit row`)
  }
})

/* ================================================================
 * The loop closes in both directions
 * ============================================================== */

test("a decision reaches the vendor and a submission reaches the builder", () => {
  const compliance = source(COMPLIANCE)

  // A rejection nobody is told about is a document that never gets fixed, and
  // the autopilot only ever chased missing and expiring items.
  assert.match(compliance, /notifyVendorOfComplianceDecision/)
  assert.match(compliance, /sendComplianceDecisionEmail/)

  // A vendor's submission used to land as an event row and nothing else.
  assert.match(compliance, /eventType: "compliance_document_submitted"/)

  const events = source("lib/services/events.ts")
  assert.match(events, /compliance_document_submitted/)
  assert.match(events, /permission_key", "compliance\.review"/)

  const notifications = source("lib/types/notifications.ts")
  // Wiring the notification service is not enough — only types in the allowlist
  // ever send mail.
  assert.match(notifications, /key: "compliance_document_submitted"/)
  assert.match(notifications, /key: "compliance_document_expiring"/)
  // The three declared-but-never-emitted types are gone.
  assert.doesNotMatch(notifications, /compliance_item_created/)
  assert.doesNotMatch(notifications, /compliance_item_overdue/)
})

test("the autopilot chases rejections and escalates past the last reminder", () => {
  const autopilot = source(AUTOPILOT)

  // A rejected document produced no chase at all, and a permanent per-bucket
  // idempotency key meant ignoring the run-up bought silence for good.
  assert.match(autopilot, /kind: "rejected"/)
  assert.match(autopilot, /OVERDUE_ESCALATION_DAYS/)

  // Withdrawn and superseded submissions are dropped before the newest is
  // picked. Taking the newest row regardless let a revoked certificate suppress
  // the chase for the requirement it had stopped satisfying.
  assert.match(autopilot, /if \(row\.revoked_at \|\| row\.superseded_by_id\) continue/)

  // The builder side of the same reminder — the type is on the email allowlist,
  // so it has to actually be emitted.
  assert.match(autopilot, /eventType: "compliance_document_expiring"/)

  const migration = source(MIGRATION)
  for (const kind of ["missing", "expiring", "expired", "rejected", "escalation"]) {
    assert.match(migration, new RegExp(`'${kind}'`), `reminder kind ${kind} must be allowed`)
  }
})

test("the expiry warning window a type declares is the one that is used", () => {
  const compliance = source(COMPLIANCE)
  const autopilot = source(AUTOPILOT)

  // `expiry_warning_days` was stored, validated, and described to the user in
  // settings — and read by nothing. Both readers hardcoded 30 days.
  assert.match(compliance, /function warningDaysFor/)
  assert.match(compliance, /expiry_warning_days/)
  assert.match(autopilot, /function expiryReminderDays/)
  assert.match(autopilot, /docType\.expiry_warning_days/)
  assert.doesNotMatch(autopilot, /EXPIRY_REMINDER_DAYS = new Set/)
})

/* ================================================================
 * A document that no longer answers anything
 * ============================================================== */

test("superseded and withdrawn documents stay in history but stop counting", () => {
  const compliance = source(COMPLIANCE)
  const live = compliance.slice(
    compliance.indexOf("function isLiveDocument"),
    compliance.indexOf("function buildComplianceStatus"),
  )
  assert.match(live, /!document\.revoked_at && !document\.superseded_by_id/)

  const build = compliance.slice(compliance.indexOf("function buildComplianceStatus"))
  // Two sets on purpose: verdicts read the live subset, the trail reads all.
  assert.match(build, /const liveDocuments = documents\.filter\(isLiveDocument\)/)
  assert.match(build, /const history = documents/)
  assert.match(build, /const answering = history\.filter\(isLiveDocument\)/)
})

/* ================================================================
 * Portability: the vendor consents, the builder still reviews
 * ============================================================== */

test("a shared document is scoped to a verified identity, not a contact row", () => {
  const portability = source("lib/services/compliance-portability.ts")
  const action = source("app/s/[token]/compliance/actions.ts")

  // The contact email on a portal token is a field the BUILDER controls. Keying
  // cross-org reads on it would let a builder type a competitor's sub into
  // their own directory, mint a token, and read that sub's certificates from
  // the other builder's org. Only a signed-in vendor account can move a document.
  assert.match(action, /getCurrentExternalPortalSession/)
  assert.match(action, /hasExternalPortalGrantForToken/)
  assert.match(action, /identityEmail: session\.identity\.email/)
  assert.doesNotMatch(action, /from\("contacts"\)/)
  assert.doesNotMatch(portability, /contactEmail: string$/m)

  // The document id alone must never be a capability.
  assert.match(portability, /findCompaniesForIdentity/)
  assert.match(portability, /does not belong to your company/)
  // Only an approved, unexpired document travels.
  assert.match(portability, /Only an approved document can be shared/)
  assert.match(portability, /\.eq\("status", "approved"\)/)
  // The receiving org reviews the copy on its own terms — approval never rides along.
  assert.match(portability, /status: "pending_review"/)
  // A real copy, so access ending in one org cannot pull a file from another.
  assert.match(portability, /downloadFilesObject/)
  assert.match(portability, /uploadFilesObject/)

  const migration = source(MIGRATION)
  // Writes are service-role only: the vendor acts through the portal, which has
  // no authenticated org member behind it.
  assert.match(migration, /create policy vendor_document_shares_read/)
  assert.doesNotMatch(migration, /create policy vendor_document_shares_write/)
})

/* ================================================================
 * Compliance is visible where work is awarded and where it is counted
 * ============================================================== */

test("compliance is checked before award, not only at the payable", () => {
  const compliance = source(COMPLIANCE)
  assert.match(compliance, /export async function getBidInviteComplianceWarnings/)

  const bids = source("lib/services/bids.ts")
  assert.match(bids, /getBidInviteComplianceWarnings/)
  assert.match(bids, /compliance_warning: complianceWarnings\.get\(invite\.company_id\)/)

  const award = source("components/bids/bid-award-panel.tsx")
  assert.match(award, /complianceWarning/)
})

/* ================================================================
 * The tab reports by exception
 * ============================================================== */

test("a satisfied requirement says its name and nothing else", () => {
  const { complianceRowSignal } = require("../components/companies/account/compliance-status")

  const met = complianceRowSignal({
    requirement: { document_type: { name: "General liability" } },
    state: "met",
    document: {
      expiry_date: "2027-03-14",
      carrier_name: "Travelers",
      policy_number: "GL-99",
      coverage_amount_cents: 500_000_00,
    },
    history: [],
    days_until_expiry: 300,
    deficiency: null,
  })
  // Carrier, policy number and limits live on the certificate. Printing them on
  // every row buried the two rows that actually needed attention.
  assert.equal(met.note, null, "a met requirement must carry no note")

  const expiring = complianceRowSignal({
    requirement: { document_type: { name: "Workers comp" } },
    state: "expiring",
    document: { expiry_date: "2027-03-14" },
    history: [],
    days_until_expiry: 9,
    deficiency: null,
  })
  assert.match(expiring.note, /Expires/)
  assert.match(expiring.note, /in 9 days/)
  assert.doesNotMatch(expiring.note ?? "", /Travelers|policy/i)

  // The one case where the document's own facts matter: it is on file and still
  // does not clear the bar, so the row has to say which bar.
  const deficient = complianceRowSignal({
    requirement: { document_type: { name: "Auto" } },
    state: "deficient",
    document: {},
    history: [],
    days_until_expiry: null,
    deficiency: { message: "Coverage below required minimum ($1,000,000)" },
  })
  assert.equal(deficient.note, "Coverage below required minimum ($1,000,000)")

  // Every state still announces itself to a screen reader; colour is never the
  // only carrier of the verdict.
  for (const state of ["met", "expiring", "expired", "deficient", "rejected", "pending", "waived", "missing"]) {
    const signal = complianceRowSignal({
      requirement: { document_type: { name: "X" }, waiver: null },
      state,
      document: null,
      history: [],
      days_until_expiry: null,
      deficiency: null,
    })
    assert.ok(signal.srLabel && signal.srLabel.length > 0, `${state} needs a spoken label`)
    assert.ok(signal.dotClassName.length > 0, `${state} needs a state mark`)
  }
})

test("the tab opens documents in the same viewer the rest of Arc uses", () => {
  const workspace = source("components/companies/account/compliance-workspace.tsx")

  assert.match(workspace, /from "@\/components\/files\/file-viewer"/)
  // Passing the whole set lets the reviewer page between certificates without
  // closing the viewer, and `onFileChange` keeps the parent in step.
  assert.match(workspace, /files=\{viewerFiles\}/)
  assert.match(workspace, /onFileChange=/)

  // The figures and the section header the tab used to carry are gone: four
  // tiles reporting three zeroes is noise, not information.
  assert.doesNotMatch(workspace, /<Figure/)
  assert.doesNotMatch(workspace, /must carry<\/h2>/)
})

test("the contacts roster says who can actually reach the portal", () => {
  const panel = source("components/companies/account/company-contacts-panel.tsx")
  const page = source("app/(app)/directory/[id]/contacts/page.tsx")
  const portal = source("lib/services/portal-access.ts")

  // A vendor with nobody able to sign in cannot send a certificate, sign a
  // waiver, or see a bill — and the roster used to say nothing about it.
  assert.match(page, /listCompanyContactAccess/)
  assert.match(portal, /export async function listCompanyContactAccess/)
  assert.match(panel, /accessByContactId/)

  // A roster read must never hand out bearer access.
  const service = portal.slice(
    portal.indexOf("export async function listCompanyContactAccess"),
    portal.indexOf("export async function listOrgExternalAccess"),
  )
  assert.doesNotMatch(service, /decryptPortalToken|token_encrypted|\btoken\b:/)

  // Reachability decorates the roster; it must never be why the roster fails.
  assert.match(page, /listCompanyContactAccess\(id\)\.catch/)

  // The old list called whichever contact sorted first "Primary", which was
  // true only by accident.
  assert.doesNotMatch(panel, /index === 0/)

  // Email and phone are the two things anyone does from a contact list, and
  // they used to sit in a column hidden below `sm`.
  assert.match(panel, /href=\{`mailto:/)
  assert.match(panel, /href=\{`tel:/)
})

test("held money is only what the hold provably stops", () => {
  const compliance = source(COMPLIANCE)
  const scan = compliance.slice(
    compliance.indexOf("export async function getComplianceHeldPayablesByCompanyWithClient"),
    compliance.indexOf("/** One vendor's held payables"),
  )
  assert.ok(scan.length > 0, "the batched money scan must exist")

  // The scan used to sum every outstanding approved payable owed to the vendor,
  // which turns an AP balance into a consequence it cannot back up. Three facts
  // now have to hold per payable: the vendor is short for THAT payable's own
  // job...
  assert.match(scan, /resolveStatusFromInputs\(inputs, bill\.companyId, bill\.projectId\)/)
  // ...nobody wrote an override on that bill...
  assert.match(scan, /overriddenBillIds\.has\(bill\.id\)/)
  // ...and the governing policy has the hold at block rather than warn.
  assert.match(scan, /policy\.compliance_docs_approved !== "block"/)

  // Both hold tables are gated on `payment.release`. Read under a reviewer's own
  // client they come back empty, every override goes invisible, and the
  // overstatement returns.
  assert.match(scan, /createServiceSupabaseClient\(\)/)

  const queue = compliance.slice(
    compliance.indexOf("export async function listPendingComplianceReviews"),
    compliance.indexOf("/** Every company with an outstanding review"),
  )
  // `blocksPayment` claimed a pending review stopped money without ever
  // establishing the vendor was non-compliant.
  assert.match(queue, /blocksPayment: \(vendorHeld\?\.billCount \?\? 0\) > 0/)
  assert.match(queue, /heldCents: held\.totalCents/)
})

test("a bounded money scan says its number is a floor", () => {
  const compliance = source(COMPLIANCE)

  // Vendor and project ids ride in the query string, so the scan is bounded —
  // and every bound reports itself. A money number may never shrink in silence.
  for (const cap of [
    "HELD_PAYABLES_COMPANY_CAP",
    "HELD_PAYABLES_PROJECT_CAP",
    "HELD_PAYABLES_BILL_CAP",
  ]) {
    assert.match(compliance, new RegExp(`const ${cap} = \\d+`))
  }
  assert.match(compliance, /heldCentsTruncated: boolean/)

  const stats = source("components/control-tower/control-tower-stats.tsx")
  assert.match(stats, /complianceHeldCentsTruncated/)
  // A scan that could not run must not render as the dash a reader reads as
  // zero.
  assert.match(stats, /"Not counted"/)
})

test("one definition of held, and one set of reads behind it", () => {
  const compliance = source(COMPLIANCE)

  // A page of vendors is resolved against every project in scope; a payable is
  // resolved against its own. Both come off the same loaded inputs, so asking
  // per payable costs no extra reads — and passing the union of a queue's
  // projects into one vendor's status, which judges them against somebody
  // else's job, is no longer possible.
  assert.match(compliance, /async function loadCompaniesComplianceInputs\(/)
  assert.match(compliance, /projectId === null \|\| overlay\.projectId === projectId/)
  assert.doesNotMatch(compliance, /getCompanyComplianceStatusByProjectWithClient/)

  // The Control Tower card ran its own version of this sum, with none of the
  // three tests applied.
  const dashboard = source("lib/services/dashboard.ts")
  assert.match(dashboard, /getComplianceHeldPayablesByCompanyWithClient/)
  assert.doesNotMatch(dashboard, /getCompaniesComplianceStatus/)
})

test("an unreviewed certificate is counted as open work", () => {
  const dashboard = source("lib/services/dashboard.ts")

  // To the payment gate an unopened queue is indistinguishable from a
  // non-compliant vendor, so it belongs with the other blockers.
  assert.match(dashboard, /complianceReviews: number/)
  assert.match(dashboard, /complianceHeldCents: number/)
  assert.match(dashboard, /exceptions\.openItems\.complianceReviews/)

  const stats = source("components/control-tower/control-tower-stats.tsx")
  assert.match(stats, /Compliance reviews/)
  assert.match(stats, /compliance=pending/)

  // The count has to land on the work it counted.
  const alert = source("components/directory/compliance-alert.tsx")
  assert.match(alert, /searchParams\.get\("compliance"\) === "pending"/)
})

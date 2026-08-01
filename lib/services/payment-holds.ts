import type { SupabaseClient } from "@supabase/supabase-js"

import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { getComplianceRules } from "@/lib/services/compliance"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ensurePortalLink } from "@/lib/services/portal-links"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { listMissingSubtierWaiversForBill } from "@/lib/services/lien-waivers"
import {
  paymentHoldOverrideSchema,
  type PaymentHoldKind,
  type PaymentHoldLevel,
  type PaymentHoldOverrideInput,
} from "@/lib/validation/payment-holds"

export interface PaymentHold {
  kind: PaymentHoldKind
  level: PaymentHoldLevel
  message: string
  cureHref: string | null
  overridden: boolean
  overrideReason: string | null
}

export interface PaymentHoldFacts {
  projectId: string
  companyId: string | null
  complianceCurrent: boolean
  insuranceCurrent: boolean
  waiverSigned: boolean
  retainageRulesMet: boolean
  fundingRequired: boolean
  fundingReceived: boolean
  overrides: Partial<Record<PaymentHoldKind, string>>
  policy: Partial<Record<PaymentHoldKind, PaymentHoldLevel>>
}

export interface PaymentHoldEvaluation {
  holds: PaymentHold[]
  releasable: boolean
  warningCount: number
  blockingCount: number
}

export interface PaymentReleaseEvidence {
  billId: string
  projectId: string
  companyId: string | null
  holdEvaluation: PaymentHoldEvaluation
  subtierWaiversRequired: boolean
  missingSubtierWaiverCount: number
  complianceRequired: boolean
  capturedAt: string
}

const DEFAULT_POLICY: Record<PaymentHoldKind, PaymentHoldLevel> = {
  insurance_current: "block",
  waiver_signed: "block",
  compliance_docs_approved: "block",
  retainage_rules_met: "warn",
  funding_received: "warn",
}

const HOLD_MESSAGES: Record<PaymentHoldKind, string> = {
  insurance_current: "Vendor insurance is missing, expired, or awaiting approval",
  waiver_signed: "A signed lien waiver is required before payment",
  compliance_docs_approved: "Required compliance documents are incomplete",
  retainage_rules_met: "Retainage release conditions have not been met",
  funding_received: "The linked owner invoice has not been paid",
}

export function evaluatePaymentHoldFacts(facts: PaymentHoldFacts): PaymentHoldEvaluation {
  const active: Array<{ kind: PaymentHoldKind; failed: boolean; cureHref: string | null }> = [
    { kind: "insurance_current", failed: !facts.insuranceCurrent, cureHref: facts.companyId ? `/companies/${facts.companyId}?tab=compliance` : null },
    { kind: "waiver_signed", failed: !facts.waiverSigned, cureHref: `/projects/${facts.projectId}/financials/payables` },
    { kind: "compliance_docs_approved", failed: !facts.complianceCurrent, cureHref: facts.companyId ? `/companies/${facts.companyId}?tab=compliance` : null },
    { kind: "retainage_rules_met", failed: !facts.retainageRulesMet, cureHref: `/projects/${facts.projectId}/financials/payables` },
    { kind: "funding_received", failed: facts.fundingRequired && !facts.fundingReceived, cureHref: `/projects/${facts.projectId}/financials/receivables` },
  ]
  const holds = active.filter((item) => item.failed).map((item) => {
    const overrideReason = facts.overrides[item.kind] ?? null
    return {
      kind: item.kind,
      level: facts.policy[item.kind] ?? DEFAULT_POLICY[item.kind],
      message: HOLD_MESSAGES[item.kind],
      cureHref: item.cureHref,
      overridden: overrideReason !== null,
      overrideReason,
    }
  })
  const blockingCount = holds.filter((hold) => hold.level === "block" && !hold.overridden).length
  return { holds, releasable: blockingCount === 0, warningCount: holds.filter((hold) => hold.level === "warn" && !hold.overridden).length, blockingCount }
}

function parsePolicy(value: unknown): Partial<Record<PaymentHoldKind, PaymentHoldLevel>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_POLICY
  const result: Partial<Record<PaymentHoldKind, PaymentHoldLevel>> = {}
  for (const kind of Object.keys(DEFAULT_POLICY) as PaymentHoldKind[]) {
    const level = (value as Record<string, unknown>)[kind]
    if (level === "block" || level === "warn") result[kind] = level
  }
  return { ...DEFAULT_POLICY, ...result }
}

async function resolveBillCompany(supabase: SupabaseClient, orgId: string, companyId: string | null, commitmentId: string | null) {
  if (companyId) return companyId
  if (!commitmentId) return null
  const { data } = await supabase.from("commitments").select("company_id").eq("org_id", orgId).eq("id", commitmentId).maybeSingle()
  return data?.company_id ?? null
}

export async function evaluateHolds(billId: string, orgId?: string): Promise<PaymentHoldEvaluation> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: bill, error } = await supabase.from("vendor_bills")
    .select("id,project_id,company_id,commitment_id,lien_waiver_status,retainage_cents,total_cents,funding_invoice_id")
    .eq("org_id", resolvedOrgId).eq("id", billId).maybeSingle()
  if (error || !bill) throw new Error("Vendor bill not found")
  await requireAuthorization({ permission: "payment.release", userId, orgId: resolvedOrgId, projectId: bill.project_id, supabase, resourceType: "vendor_bill", resourceId: billId })
  const companyId = await resolveBillCompany(supabase, resolvedOrgId, bill.company_id, bill.commitment_id)
  const [{ data: projectPolicy }, { data: orgPolicy }, { data: overrideRows }, compliance, funding] = await Promise.all([
    supabase.from("payment_hold_policies").select("conditions,waiver_auto_chase").eq("org_id", resolvedOrgId).eq("project_id", bill.project_id).maybeSingle(),
    supabase.from("payment_hold_policies").select("conditions,waiver_auto_chase").eq("org_id", resolvedOrgId).is("project_id", null).maybeSingle(),
    supabase.from("payment_hold_overrides").select("hold_kind,reason").eq("org_id", resolvedOrgId).eq("bill_id", billId).is("revoked_at", null),
    companyId ? getCompanyComplianceStatusWithClient(supabase, resolvedOrgId, companyId) : Promise.resolve(null),
    bill.funding_invoice_id
      ? supabase.from("invoices").select("status").eq("org_id", resolvedOrgId).eq("id", bill.funding_invoice_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const overrides = Object.fromEntries((overrideRows ?? []).map((row) => [row.hold_kind, row.reason])) as Partial<Record<PaymentHoldKind, string>>
  const insuranceDocuments = compliance?.documents.filter((document) => /insurance|certificate|coi/i.test(document.document_type?.name ?? "")) ?? []
  const insuranceCurrent = insuranceDocuments.length === 0
    ? compliance?.is_compliant ?? true
    : insuranceDocuments.some((document) => document.status === "approved" && (!document.expiry_date || document.expiry_date >= new Date().toISOString().slice(0, 10)))
  const evaluation = evaluatePaymentHoldFacts({
    projectId: bill.project_id,
    companyId,
    complianceCurrent: compliance?.is_compliant ?? true,
    insuranceCurrent,
    waiverSigned: bill.lien_waiver_status === "received" || bill.lien_waiver_status === "signed",
    retainageRulesMet: Number(bill.retainage_cents ?? 0) <= Number(bill.total_cents ?? 0),
    fundingRequired: Boolean(bill.funding_invoice_id),
    fundingReceived: !bill.funding_invoice_id || ["paid", "partial"].includes(funding.data?.status ?? ""),
    overrides,
    policy: parsePolicy(projectPolicy?.conditions ?? orgPolicy?.conditions),
  })
  const waiverAutoChase = projectPolicy?.waiver_auto_chase ?? orgPolicy?.waiver_auto_chase ?? true
  if (waiverAutoChase && evaluation.holds.some((hold) => hold.kind === "waiver_signed" && !hold.overridden)) {
    await enqueueOutboxJob({ orgId: resolvedOrgId, jobType: "chase_vendor_bill_waiver", payload: { bill_id: billId, project_id: bill.project_id }, dedupeByPayloadKeys: ["bill_id"] })
  }
  return evaluation
}

/**
 * Canonical electronic/manual AP release gate. Every path that can create an
 * outbound payment or mark a bill paid must call this function immediately
 * before committing the payment-side mutation.
 */
export async function assertBillReleasable(
  billId: string,
  orgId?: string,
  options: { excludePaymentRunId?: string } = {},
): Promise<PaymentReleaseEvidence> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select("id,project_id,company_id,commitment_id,bill_date,due_date,metadata,lien_waiver_status")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()
  if (error || !bill) throw new Error("Vendor bill not found")

  const holdEvaluation = await evaluateHolds(billId, resolvedOrgId)
  if (!holdEvaluation.releasable) {
    const reasons = holdEvaluation.holds
      .filter((hold) => hold.level === "block" && !hold.overridden)
      .map((hold) => hold.message)
    throw new Error(`Payment is on hold: ${reasons.join("; ")}`)
  }

  const companyId = await resolveBillCompany(
    supabase,
    resolvedOrgId,
    bill.company_id ?? null,
    bill.commitment_id ?? null,
  )
  let inFlightQuery = supabase
    .from("payment_run_items")
    .select("id,run_id,status")
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", billId)
    .in("status", ["draft", "pending_approval", "approved", "processing", "partially_paid"])
    .limit(1)
  if (options.excludePaymentRunId) inFlightQuery = inFlightQuery.neq("run_id", options.excludePaymentRunId)
  const [{ data: projectControls }, rules, { data: inFlightPaymentItems, error: inFlightError }] = await Promise.all([
    supabase
      .from("projects")
      .select("require_subtier_waivers")
      .eq("org_id", resolvedOrgId)
      .eq("id", bill.project_id)
      .maybeSingle(),
    getComplianceRules(resolvedOrgId).catch(() => ({
      require_lien_waiver: false,
      block_payment_on_missing_docs: true,
      warn_subcontract_execution_on_missing_docs: true,
      block_subcontract_execution_on_missing_docs: false,
    })),
    inFlightQuery,
  ])
  if (inFlightError) throw new Error(`Unable to validate in-flight bill payments: ${inFlightError.message}`)
  if ((inFlightPaymentItems ?? []).length > 0) throw new Error("This bill already belongs to an active payment run")

  let missingSubtierWaiverCount = 0
  if (projectControls?.require_subtier_waivers) {
    if (bill.lien_waiver_status !== "received") {
      throw new Error("First-tier lien waiver required before payment")
    }
    if (!bill.commitment_id) {
      throw new Error("A commitment is required to validate sub-tier lien waivers before payment")
    }
    const metadata = (bill.metadata as Record<string, unknown> | null) ?? {}
    const periodEnd = String(metadata.billing_period_end ?? bill.due_date ?? bill.bill_date ?? "")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      throw new Error("Set the payable period end before validating sub-tier lien waivers")
    }
    const missing = await listMissingSubtierWaiversForBill({
      orgId: resolvedOrgId,
      projectId: bill.project_id,
      commitmentId: bill.commitment_id,
      periodEnd,
    })
    missingSubtierWaiverCount = missing.length
    if (missing.length > 0) {
      throw new Error(`Sub-tier lien waivers required before payment: ${missing.map((row) => row.claimant_company_name).join(", ")}`)
    }
  }

  if (rules.block_payment_on_missing_docs) {
    if (rules.require_lien_waiver && bill.lien_waiver_status !== "received") {
      throw new Error("Lien waiver required before payment")
    }
    if (companyId) {
      const compliance = await getCompanyComplianceStatusWithClient(supabase, resolvedOrgId, companyId)
      if (!compliance.is_compliant) throw new Error("Compliance documents required before payment")
    }
  }

  return {
    billId,
    projectId: bill.project_id,
    companyId,
    holdEvaluation,
    subtierWaiversRequired: Boolean(projectControls?.require_subtier_waivers),
    missingSubtierWaiverCount,
    complianceRequired: Boolean(rules.block_payment_on_missing_docs),
    capturedAt: new Date().toISOString(),
  }
}

export async function overridePaymentHold(input: PaymentHoldOverrideInput, orgId?: string): Promise<PaymentHoldEvaluation> {
  const parsed = paymentHoldOverrideSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: bill } = await supabase.from("vendor_bills").select("project_id").eq("org_id", resolvedOrgId).eq("id", parsed.bill_id).maybeSingle()
  if (!bill) throw new Error("Vendor bill not found")
  await requireAuthorization({ permission: "payments.override_hold", userId, orgId: resolvedOrgId, projectId: bill.project_id, supabase, logDecision: true, resourceType: "vendor_bill", resourceId: parsed.bill_id })
  const payload = { org_id: resolvedOrgId, project_id: bill.project_id, bill_id: parsed.bill_id, hold_kind: parsed.hold_kind, overridden_by: userId, reason: parsed.reason }
  const { data, error } = await supabase.from("payment_hold_overrides").insert(payload).select("id").single()
  if (error || !data) throw new Error(`Failed to override payment hold: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "payment_hold_overridden", entityType: "vendor_bill", entityId: parsed.bill_id, payload: { project_id: bill.project_id, hold_kind: parsed.hold_kind, reason: parsed.reason } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "payment_hold_override", entityId: data.id, after: payload }),
  ])
  return evaluateHolds(parsed.bill_id, resolvedOrgId)
}

export async function sendVendorBillWaiverChase(orgId: string, billId: string) {
  const client = createServiceSupabaseClient()
  const { data: bill } = await client.from("vendor_bills").select("id,project_id,company_id,bill_number,commitment:commitments(company_id),company:companies(name,email),project:projects(name),org:orgs(name,slug)").eq("org_id", orgId).eq("id", billId).maybeSingle()
  if (!bill) throw new Error("Vendor bill not found for waiver chase")
  const commitment = Array.isArray(bill.commitment) ? bill.commitment[0] : bill.commitment
  const companyId = bill.company_id ?? commitment?.company_id
  let company: { name: string | null; email: string | null } | null = Array.isArray(bill.company) ? bill.company[0] : bill.company
  if ((!company?.email || !companyId) && companyId) {
    const result = await client.from("companies").select("name,email").eq("org_id", orgId).eq("id", companyId).maybeSingle()
    company = result.data
  }
  if (!companyId || !company?.email) throw new Error("Vendor has no email for waiver chase")
  const base = await ensurePortalLink({ supabase: client, orgId, projectId: bill.project_id, portalType: "sub", companyId, capabilities: { can_view_bills: true }, fallbackPath: `/projects/${bill.project_id}/financials/payables` })
  const url = `${base}/waivers/${bill.id}`
  const project = Array.isArray(bill.project) ? bill.project[0] : bill.project
  const org = Array.isArray(bill.org) ? bill.org[0] : bill.org
  const html = renderStandardEmailLayout({ title: "Lien waiver signature required", messageHtml: `<p>Sign the conditional lien waiver for invoice ${bill.bill_number ?? bill.id} on ${project?.name ?? "the project"} so payment can be released.</p>`, buttonText: "Review and sign waiver", buttonUrl: url, orgName: org?.name, showManageSettings: false })
  const sent = await sendEmail({ from: getOrgSenderEmail(org?.slug, org?.name), to: [company.email], subject: `Lien waiver required: ${bill.bill_number ?? "invoice"}`, html })
  if (!sent) throw new Error("Waiver chase email was not sent")
  await recordEvent({ orgId, eventType: "vendor_bill_waiver_chased", entityType: "vendor_bill", entityId: bill.id, payload: { project_id: bill.project_id, company_id: companyId } })
}

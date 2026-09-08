import { waiverCoverage } from "@/lib/lien-waivers/coverage"
import type { SupabaseClient } from "@supabase/supabase-js"

import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { getComplianceRules, getComplianceRulesWithClient } from "@/lib/services/compliance"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ensurePortalLink } from "@/lib/services/portal-links"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { listMissingSubtierWaiversForBill } from "@/lib/services/lien-waivers"
import {
  coiExtractionSchema,
  evaluateInsuranceCurrency,
  isInsuranceDocumentTypeName,
  summarizeWaiverMismatches,
  waiverVerificationSchema,
  type CoiExtraction,
} from "@/lib/payments/ap-verification"
import {
  evaluatePaymentHoldFacts,
  parsePaymentHoldPolicy,
  type PaymentHoldEvaluation,
} from "@/lib/payments/payment-hold-policy"
import {
  paymentHoldOverrideSchema,
  type PaymentHoldKind,
  type PaymentHoldOverrideInput,
} from "@/lib/validation/payment-holds"
import type { WaiverChaseKind } from "@/lib/payments/waiver-chase-policy"

export {
  evaluatePaymentHoldFacts,
  type PaymentHold,
  type PaymentHoldEvaluation,
  type PaymentHoldFacts,
} from "@/lib/payments/payment-hold-policy"

export interface PaymentReleaseEvidence {
  billId: string
  projectId: string | null
  companyId: string | null
  holdEvaluation: PaymentHoldEvaluation
  subtierWaiversRequired: boolean
  missingSubtierWaiverCount: number
  complianceRequired: boolean
  waiverEvidence: {
    id: string
    type: string
    status: string
    amountCents: number
    throughDate: string
    signedAt: string
    signedFileId: string | null
    signatureData: Record<string, unknown>
  } | null
  constructionEvidence: {
    commitmentId: string
    commitmentType: string
    commitmentStatus: string
    authorizedCents: number
    billedCents: number
    varianceCents: number
    poCompletionId: string | null
    poCompletionStatus: string | null
    poCompletionAmountCents: number | null
  } | null
  capturedAt: string
}

/**
 * The stored waiver-verification claim, shaped for the hold policy. Anything
 * unparseable is treated as absent: a malformed claim must not invent a hold.
 */
function readWaiverVerificationFact(metadata: Record<string, unknown>) {
  const parsed = waiverVerificationSchema.safeParse(metadata.waiver_verification)
  if (!parsed.success) return null
  return {
    matches: parsed.data.matches,
    mismatchSummary: parsed.data.matches ? null : summarizeWaiverMismatches(parsed.data.mismatches),
    documentHref: null,
  }
}

/**
 * The stored certificate readings for a set of compliance documents.
 *
 * This is a read path and it feeds a BLOCK-tier hold, so every failure mode is
 * the same failure mode: no reading. A missing column, an unparseable claim, a
 * query error — all return an empty map, which puts the insurance fact back on
 * the stored status-and-expiry rule that shipped before extraction existed.
 */
async function loadCoiExtractions(
  supabase: SupabaseClient,
  orgId: string,
  documentIds: string[],
): Promise<Map<string, CoiExtraction>> {
  const readings = new Map<string, CoiExtraction>()
  if (documentIds.length === 0) return readings
  const { data, error } = await supabase
    .from("compliance_documents")
    .select("id,metadata")
    .eq("org_id", orgId)
    .in("id", documentIds)
    .returns<Array<{ id: string; metadata: Record<string, unknown> | null }>>()
  if (error || !data) return readings
  for (const row of data) {
    const parsed = coiExtractionSchema.safeParse((row.metadata ?? {}).coi_extraction)
    if (parsed.success) readings.set(row.id, parsed.data)
  }
  return readings
}

async function resolveBillCompany(supabase: SupabaseClient, orgId: string, companyId: string | null, commitmentId: string | null) {
  if (companyId) return companyId
  if (!commitmentId) return null
  const { data } = await supabase.from("commitments").select("company_id").eq("org_id", orgId).eq("id", commitmentId).maybeSingle()
  return data?.company_id ?? null
}

export async function evaluateHolds(
  billId: string,
  orgId?: string,
  options: { enqueueWaiverChase?: boolean; skipAuthorization?: boolean; amountCents?: number } = {},
): Promise<PaymentHoldEvaluation> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: bill, error } = await supabase.from("vendor_bills")
    .select("id,project_id,company_id,commitment_id,lien_waiver_status,retainage_cents,retainage_released_cents,total_cents,paid_cents,status,funding_invoice_id,metadata")
    .eq("org_id", resolvedOrgId).eq("id", billId).maybeSingle()
  if (error || !bill) throw new Error("Vendor bill not found")
  if (!options.skipAuthorization) {
    await requireAuthorization({ permission: "bill.read", userId, orgId: resolvedOrgId, projectId: bill.project_id, supabase, resourceType: "vendor_bill", resourceId: billId })
  }
  const companyId = await resolveBillCompany(supabase, resolvedOrgId, bill.company_id, bill.commitment_id)
  const [{ data: projectPolicy }, { data: orgPolicy }, { data: overrideRows }, compliance, funding, rules, { data: projectControls }] = await Promise.all([
    bill.project_id
      ? supabase.from("payment_hold_policies").select("conditions,waiver_auto_chase").eq("org_id", resolvedOrgId).eq("project_id", bill.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("payment_hold_policies").select("conditions,waiver_auto_chase").eq("org_id", resolvedOrgId).is("project_id", null).maybeSingle(),
    supabase.from("payment_hold_overrides").select("hold_kind,reason").eq("org_id", resolvedOrgId).eq("bill_id", billId).is("revoked_at", null),
    // Scoped to this payable's project so a project overlay — an owner
    // mandating higher limits on one job — actually gates the money it was
    // written to gate.
    companyId && bill.project_id
      ? getCompanyComplianceStatusWithClient(supabase, resolvedOrgId, companyId, {
          projectIds: [bill.project_id],
        })
      : Promise.resolve(null),
    bill.funding_invoice_id
      ? supabase.from("invoices").select("status").eq("org_id", resolvedOrgId).eq("id", bill.funding_invoice_id).maybeSingle()
      : Promise.resolve({ data: null }),
    getComplianceRulesWithClient(supabase, resolvedOrgId),
    bill.project_id
      ? supabase.from("projects").select("require_subtier_waivers").eq("org_id", resolvedOrgId).eq("id", bill.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const overrides = Object.fromEntries((overrideRows ?? []).map((row) => [row.hold_kind, row.reason])) as Partial<Record<PaymentHoldKind, string>>
  // The type's own `kind` decides this. Matching on the name meant the seeded
  // "Umbrella / Excess Liability" type — which contains none of insurance,
  // certificate or coi — was invisible to the insurance hold entirely, so an
  // expired umbrella policy never held a payment. The name check remains only
  // for a legacy type whose kind was never classified.
  const insuranceDocuments =
    compliance?.documents.filter((document) => {
      const type = document.document_type
      if (type?.kind) return type.kind === "insurance"
      return isInsuranceDocumentTypeName(type?.name)
    }) ?? []
  // Read-only, exactly like the waiver claim below: the certificate is read
  // when it is uploaded or approved, never here. Bills whose certificates were
  // never read evaluate on the stored expiry, which is the pre-model behaviour.
  const coiExtractions = await loadCoiExtractions(supabase, resolvedOrgId, insuranceDocuments.map((document) => document.id))
  const insurance = evaluateInsuranceCurrency({
    documents: insuranceDocuments.map((document) => ({
      status: document.status,
      storedExpiry: document.expiry_date ?? null,
      fileId: document.file_id ?? null,
      extraction: coiExtractions.get(document.id) ?? null,
    })),
    todayIso: new Date().toISOString().slice(0, 10),
    fallbackCompliant: compliance?.is_compliant ?? true,
  })
  const { data: signedWaivers, error: evidenceError } = await supabase.from("lien_waivers")
    .select("id,waiver_type,status,amount_cents,through_date,signed_at,signed_file_id,document_file_id,metadata")
    .eq("org_id",resolvedOrgId).eq("bill_id",billId)
  if(evidenceError) throw new Error("Could not evaluate waiver evidence")
  const period = String(bill.metadata?.billing_period_end??bill.metadata?.through_date??"")
  const missingSubtiers = projectControls?.require_subtier_waivers && bill.commitment_id && period
    ? await listMissingSubtierWaiversForBill({orgId:resolvedOrgId,projectId:bill.project_id,commitmentId:bill.commitment_id,periodEnd:period}) : []
  const coverage = waiverCoverage({...bill,company_id:companyId},signedWaivers??[],Boolean(rules.require_lien_waiver || projectControls?.require_subtier_waivers),missingSubtiers.length,Boolean(projectControls?.require_subtier_waivers&&!bill.commitment_id),options.amountCents)
  const evaluation = evaluatePaymentHoldFacts({
    projectId: bill.project_id,
    companyId,
    complianceCurrent: compliance?.is_compliant ?? true,
    insuranceCurrent: insurance.current,
    insuranceContradiction: insurance.contradiction,
    // A waiver is only a hold when org policy or the project's sub-tier rule
    // actually asks for one. `assertBillReleasable` gates its hard waiver checks
    // on these same two flags — the hold must agree or it blocks payment for a
    // document nothing requires.
    waiverRequired: Boolean(bill.project_id) && (Boolean(rules.require_lien_waiver) || Boolean(projectControls?.require_subtier_waivers)),
    // "received" is the schema's only waiver-in-hand state. The legacy value
    // "signed" is normalized to "received" at the validation boundary
    // (lib/validation/vendor-bills.ts) and backfilled in the data.
    waiverSigned: coverage.reasons.length === 0,
    // Read-only: the claim is computed when the waiver is signed, never here.
    // A bill with no stored verification passes `null` and raises nothing.
    waiverVerification: readWaiverVerificationFact((bill.metadata ?? {}) as Record<string, unknown>),
    retainageRulesMet: Number(bill.retainage_cents ?? 0) <= Number(bill.total_cents ?? 0),
    fundingRequired: Boolean(bill.funding_invoice_id),
    fundingReceived: !bill.funding_invoice_id || ["paid", "partial"].includes(funding.data?.status ?? ""),
    overrides,
    policy: parsePaymentHoldPolicy(projectPolicy?.conditions ?? orgPolicy?.conditions),
  })
  for(const hold of evaluation.holds) if(hold.kind === "waiver_signed") hold.detail = coverage.reasons.join("; ")
  const waiverAutoChase = projectPolicy?.waiver_auto_chase ?? orgPolicy?.waiver_auto_chase ?? true
  if (bill.project_id && options.enqueueWaiverChase && waiverAutoChase && evaluation.holds.some((hold) => hold.kind === "waiver_signed" && !hold.overridden)) {
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
  options: { excludePaymentRunId?: string; amountCents?: number } = {},
): Promise<PaymentReleaseEvidence> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select("id,project_id,company_id,commitment_id,bill_date,due_date,total_cents,paid_cents,retainage_cents,retainage_released_cents,status,metadata,lien_waiver_status")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()
  if (error || !bill) throw new Error("Vendor bill not found")
  await requireAuthorization({
    permission: "payment.release",
    userId,
    orgId: resolvedOrgId,
    projectId: bill.project_id,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })

  const holdEvaluation = await evaluateHolds(billId, resolvedOrgId, { enqueueWaiverChase: true, skipAuthorization: true, amountCents: options.amountCents })
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
    bill.project_id
      ? supabase
          .from("projects")
          .select("require_subtier_waivers")
          .eq("org_id", resolvedOrgId)
          .eq("id", bill.project_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // No catch-and-default here. This is the release gate: defaulting
    // `require_lien_waiver` to false on a read failure meant a transient
    // database error silently dropped the waiver requirement and let the
    // payment through. If the rules cannot be read, the payment does not go.
    getComplianceRules(resolvedOrgId),
    inFlightQuery,
  ])
  if (inFlightError) throw new Error(`Unable to validate in-flight bill payments: ${inFlightError.message}`)
  if ((inFlightPaymentItems ?? []).length > 0) throw new Error("This bill already belongs to an active payment run")

  let missingSubtierWaiverCount = 0
  if (projectControls?.require_subtier_waivers) {

    if (!bill.commitment_id) {
      throw new Error("A commitment is required to validate sub-tier lien waivers before payment")
    }
    const metadata = (bill.metadata as Record<string, unknown> | null) ?? {}
    const periodEnd = String(metadata.billing_period_end ?? metadata.through_date ?? "")
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

  if (bill.project_id && rules.block_payment_on_missing_docs) {

    if (companyId) {
      const compliance = await getCompanyComplianceStatusWithClient(
        supabase,
        resolvedOrgId,
        companyId,
        { projectIds: [bill.project_id] },
      )
      if (!compliance.is_compliant) throw new Error("Compliance documents required before payment")
    }
  }

  const waiverRequired = Boolean(bill.project_id) && (Boolean(rules.require_lien_waiver) || Boolean(projectControls?.require_subtier_waivers))
  const { data: waiverRows, error: waiverError } = await supabase.from("lien_waivers")
    .select("id,waiver_type,status,amount_cents,through_date,signed_at,signed_file_id,document_file_id,signature_data,metadata")
    .eq("org_id", resolvedOrgId).eq("bill_id", billId).eq("status", "signed")
    .order("signed_at", { ascending: false })
  if (waiverError) throw new Error(`Unable to validate signed lien waiver evidence: ${waiverError.message}`)
  const coverage = waiverCoverage({...bill,company_id:companyId}, waiverRows ?? [], waiverRequired, missingSubtierWaiverCount, false, options.amountCents)
  if (coverage.reasons.length) throw new Error(coverage.reasons.join("; "))
  const waiverRow = waiverRows?.find(row => row.id === coverage.conditionalId) ?? null
  const metadata = (bill.metadata as Record<string, unknown> | null) ?? {}

  let constructionEvidence: PaymentReleaseEvidence["constructionEvidence"] = null
  if (bill.commitment_id) {
    const [{ data: commitment, error: commitmentError }, { data: changes }, { data: committedBills }, { data: completion }, { data: lot }] = await Promise.all([
      supabase.from("commitments").select("id,commitment_type,status,total_cents,currency").eq("org_id", resolvedOrgId).eq("id", bill.commitment_id).maybeSingle(),
      supabase.from("commitment_change_orders").select("total_cents").eq("org_id", resolvedOrgId).eq("commitment_id", bill.commitment_id).in("status", ["approved", "executed"]),
      supabase.from("vendor_bills").select("id,total_cents,status").eq("org_id", resolvedOrgId).eq("commitment_id", bill.commitment_id),
      supabase.from("po_completions").select("id,status,amount_cents").eq("org_id", resolvedOrgId).eq("vendor_bill_id", billId).in("status", ["approved", "billed"]).order("approved_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("lots").select("community:communities(pay_on_po_enabled)").eq("org_id", resolvedOrgId).eq("project_id", bill.project_id).limit(1).maybeSingle(),
    ])
    if (commitmentError || !commitment) throw new Error("The payable's commitment could not be validated")
    if (!["approved", "complete"].includes(commitment.status)) throw new Error("The payable commitment is not approved or complete")
    const authorizedCents = Number(commitment.total_cents ?? 0) + (changes ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0)
    // `vendor_bills.status` is CHECK-constrained to pending|approved|partial|
    // paid|rejected (migration 20260805091000) — void/cancelled variants cannot
    // exist. Rejected bills are not obligations and do not count.
    const billedCents = (committedBills ?? []).filter((row) => String(row.status) !== "rejected").reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0)
    if (billedCents > authorizedCents) throw new Error("Commitment billing exceeds the approved commitment and change orders")
    const community = Array.isArray(lot?.community) ? lot.community[0] : lot?.community
    const requirePoCompletion = commitment.commitment_type === "purchase_order" && community?.pay_on_po_enabled === true
    if (requirePoCompletion && (!completion || Number(completion.amount_cents ?? 0) < Number(bill.total_cents ?? 0))) {
      throw new Error("An approved field completion covering this purchase-order bill is required before payment")
    }
    constructionEvidence = {
      commitmentId: commitment.id,
      commitmentType: commitment.commitment_type,
      commitmentStatus: commitment.status,
      authorizedCents,
      billedCents,
      varianceCents: authorizedCents - billedCents,
      poCompletionId: completion?.id ?? null,
      poCompletionStatus: completion?.status ?? null,
      poCompletionAmountCents: completion?.amount_cents == null ? null : Number(completion.amount_cents),
    }
  }

  return {
    billId,
    projectId: bill.project_id,
    companyId,
    holdEvaluation,
    subtierWaiversRequired: Boolean(projectControls?.require_subtier_waivers),
    missingSubtierWaiverCount,
    complianceRequired: Boolean(bill.project_id && rules.block_payment_on_missing_docs),
    waiverEvidence: waiverRow ? {
      id: waiverRow.id,
      type: waiverRow.waiver_type,
      status: waiverRow.status,
      amountCents: Number(waiverRow.amount_cents),
      throughDate: waiverRow.through_date,
      signedAt: waiverRow.signed_at,
      signedFileId: waiverRow.signed_file_id,
      signatureData: (waiverRow.signature_data as Record<string, unknown> | null) ?? {},
    } : null,
    constructionEvidence,
    capturedAt: new Date().toISOString(),
  }
}

export async function overridePaymentHold(input: PaymentHoldOverrideInput, orgId?: string): Promise<PaymentHoldEvaluation> {
  const parsed = paymentHoldOverrideSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: bill } = await supabase.from("vendor_bills").select("project_id").eq("org_id", resolvedOrgId).eq("id", parsed.bill_id).maybeSingle()
  if (!bill) throw new Error("Vendor bill not found")
  await requireAuthorization({ permission: "payment.override_hold", userId, orgId: resolvedOrgId, projectId: bill.project_id, supabase, logDecision: true, resourceType: "vendor_bill", resourceId: parsed.bill_id })
  const payload = { org_id: resolvedOrgId, project_id: bill.project_id, bill_id: parsed.bill_id, hold_kind: parsed.hold_kind, overridden_by: userId, reason: parsed.reason }
  const { data, error } = await supabase.from("payment_hold_overrides").insert(payload).select("id").single()
  if (error || !data) throw new Error(`Failed to override payment hold: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "payment_hold_overridden", entityType: "vendor_bill", entityId: parsed.bill_id, payload: { project_id: bill.project_id, hold_kind: parsed.hold_kind, reason: parsed.reason } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "payment_hold_override", entityId: data.id, after: payload }),
  ])
  return evaluateHolds(parsed.bill_id, resolvedOrgId, { skipAuthorization: true })
}

/**
 * Ask a vendor for the waiver this payable still owes.
 *
 * Two documents, two conversations. The SIGNATURE chase is about money the sub
 * is waiting on, and says so. The UNCONDITIONAL chase happens after they have
 * been paid, blocks nothing, and asks for the record the builder owes the
 * owner and the lender. Which one, and how insistent, is decided by
 * `lib/payments/waiver-chase-policy.ts`; this only writes the email and
 * records that it went.
 */
export async function sendVendorBillWaiverChase(
  orgId: string,
  billId: string,
  options: { kind?: WaiverChaseKind; attempt?: number } = {},
) {
  const kind: WaiverChaseKind = options.kind === "unconditional" ? "unconditional" : "signature"
  const attempt = Number.isFinite(options.attempt) && Number(options.attempt) > 0 ? Math.floor(Number(options.attempt)) : 1
  const client = createServiceSupabaseClient()
  const { data: bill } = await client.from("vendor_bills").select("id,project_id,company_id,bill_number,metadata,commitment:commitments(company_id),company:companies(name,email),project:projects(name),org:orgs(name,slug)").eq("org_id", orgId).eq("id", billId).maybeSingle()
  if (!bill) throw new Error("Vendor bill not found for waiver chase")
  const commitment = Array.isArray(bill.commitment) ? bill.commitment[0] : bill.commitment
  const companyId = bill.company_id ?? commitment?.company_id
  let company: { name: string | null; email: string | null } | null = Array.isArray(bill.company) ? bill.company[0] : bill.company
  if ((!company?.email || !companyId) && companyId) {
    const result = await client.from("companies").select("name,email").eq("org_id", orgId).eq("id", companyId).maybeSingle()
    company = result.data
  }
  if (!companyId || !company?.email) throw new Error("Vendor has no email for waiver chase")
  const {data:prepared,error:preparedError}=await client.from("lien_waivers").select("id,status,metadata,waiver_type").eq("org_id",orgId).eq("bill_id",billId).order("created_at",{ascending:false})
  if(preparedError)throw new Error("Could not load waiver request")
  const native=prepared?.find(w=>w.metadata?.document_id && (kind === "unconditional" ? w.waiver_type.startsWith("unconditional") : w.waiver_type.startsWith("conditional")))
  if(native){
    if(native.status === "signed")return
    const {data:requests,error:requestError}=await client.from("document_signing_requests").select("id,status,sent_to_email,sequence,required,envelope_id").eq("org_id",orgId).eq("document_id",native.metadata.document_id).in("status",["sent","viewed"]).order("sequence")
    if(requestError)throw new Error("Could not load signing recipients")
    if(!requests?.length)throw new Error("Prepare and send the waiver from Payables before requesting a reminder")
    const {issueSigningLinkForRequest,sendSignerRequestEmail}=await import("@/lib/services/signature-delivery")
    const sequence=requests[0].sequence
    for(const request of requests.filter(r=>r.sequence===sequence)){
      if(!request.sent_to_email)throw new Error("Signer email missing")
      const link=await issueSigningLinkForRequest(client,{orgId,requestId:request.id,markSent:false})
      await sendSignerRequestEmail({orgId,toEmail:request.sent_to_email,documentTitle:`Waiver · ${bill.bill_number??"Payable"}`,signingUrl:link.url,isReminder:true})
    }
    const {error:recordError}=await client.from("vendor_bills").update({metadata:{...bill.metadata,waiver_chase:{kind,attempt,at:new Date().toISOString(),delivery:"sent"}}}).eq("org_id",orgId).eq("id",billId)
    if(recordError)throw new Error("Reminder delivered; could not record delivery")
    return
  }
  // No document has been prepared for this stage. Create internal follow-up,
  // not a misleading invitation to the retired generic signing form.
  const now=new Date().toISOString()
  const {error:followupError}=await client.from("vendor_bills").update({metadata:{...bill.metadata,waiver_chase:{kind,attempt,at:now,delivery:"needs_preparation"}}}).eq("org_id",orgId).eq("id",billId)
  if(followupError)throw new Error("Could not record waiver preparation follow-up")
  await recordEvent({orgId,eventType:"waiver_preparation_required",entityType:"vendor_bill",entityId:billId,payload:{project_id:bill.project_id,waiver_kind:kind,href:`/projects/${bill.project_id}/financials/payables/waivers`}})
}

import type { SupabaseClient } from "@supabase/supabase-js"

import { getComplianceRules } from "@/lib/services/compliance"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"

/**
 * The rules that govern executing a subcontract, in one place.
 *
 * Execution can arrive two ways — the counterparty signs an Arc envelope, or a
 * paper/countersigned agreement is recorded by hand — and both have to clear the
 * same gate. Keeping this beside the signature actions instead let the org's
 * `*_subcontract_execution_on_missing_docs` rules apply to only one of them.
 */

/** The signable entity types whose execution these rules cover. */
export type SubcontractExecutionEntityType = "subcontract" | "subcontract_change_order"

export interface SubcontractExecutionComplianceGate {
  /** False when the entity is not a subcontract, so no rule applies. */
  applies: boolean
  companyId: string | null
  warn: boolean
  block: boolean
  isCompliant: boolean
  missingDocumentNames: string[]
  expiredDocumentNames: string[]
  deficiencyMessages: string[]
  pendingReviewCount: number
}

export function isSubcontractExecutionEntityType(
  value?: string | null,
): value is SubcontractExecutionEntityType {
  return value === "subcontract" || value === "subcontract_change_order"
}

/** Compliance settings must never be the reason a signature flow hard-fails. */
export async function getSafeSubcontractComplianceRules(orgId: string) {
  return getComplianceRules(orgId).catch(() => ({
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
    warn_subcontract_execution_on_missing_docs: true,
    block_subcontract_execution_on_missing_docs: false,
  }))
}

/** The vendor whose compliance governs this entity's execution. */
export async function resolveSubcontractExecutionCompanyId({
  supabase,
  orgId,
  sourceEntityType,
  sourceEntityId,
}: {
  supabase: SupabaseClient
  orgId: string
  sourceEntityType?: string | null
  sourceEntityId?: string | null
}): Promise<string | null> {
  if (!sourceEntityId || !isSubcontractExecutionEntityType(sourceEntityType)) return null

  if (sourceEntityType === "subcontract") {
    const { data, error } = await supabase
      .from("commitments")
      .select("company_id")
      .eq("org_id", orgId)
      .eq("id", sourceEntityId)
      .maybeSingle()
    if (error) throw new Error(`Failed to validate subcontract compliance: ${error.message}`)
    return data?.company_id ?? null
  }

  const { data, error } = await supabase
    .from("commitment_change_orders")
    .select("company_id, commitment:commitments(company_id)")
    .eq("org_id", orgId)
    .eq("id", sourceEntityId)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to validate subcontract change order compliance: ${error.message}`)
  }
  const commitment = Array.isArray(data?.commitment) ? data?.commitment[0] : data?.commitment
  return data?.company_id ?? commitment?.company_id ?? null
}

export async function evaluateSubcontractExecutionCompliance({
  supabase,
  orgId,
  sourceEntityType,
  sourceEntityId,
}: {
  supabase: SupabaseClient
  orgId: string
  sourceEntityType?: string | null
  sourceEntityId?: string | null
}): Promise<SubcontractExecutionComplianceGate> {
  const applies = Boolean(sourceEntityId) && isSubcontractExecutionEntityType(sourceEntityType)
  const rules = await getSafeSubcontractComplianceRules(orgId)

  const base: SubcontractExecutionComplianceGate = {
    applies,
    companyId: null,
    warn: applies ? Boolean(rules.warn_subcontract_execution_on_missing_docs) : false,
    block: applies ? Boolean(rules.block_subcontract_execution_on_missing_docs) : false,
    isCompliant: true,
    missingDocumentNames: [],
    expiredDocumentNames: [],
    deficiencyMessages: [],
    pendingReviewCount: 0,
  }
  if (!applies) return base

  const companyId = await resolveSubcontractExecutionCompanyId({
    supabase,
    orgId,
    sourceEntityType,
    sourceEntityId,
  })
  if (!companyId) return base

  const status = await getCompanyComplianceStatusWithClient(supabase, orgId, companyId)
  return {
    ...base,
    companyId,
    isCompliant: status.is_compliant,
    missingDocumentNames: status.missing.map((type) => type.name),
    expiredDocumentNames: status.expired.map(
      (document) => document.document_type?.name ?? "Expired document",
    ),
    deficiencyMessages: status.deficiencies.map((deficiency) => deficiency.message),
    pendingReviewCount: status.pending_review.length,
  }
}

/**
 * Refuses execution when the org blocks it on missing vendor documents.
 * `action` completes the sentence "… required before <action>".
 */
export async function assertSubcontractExecutionCompliance({
  supabase,
  orgId,
  sourceEntityType,
  sourceEntityId,
  action,
}: {
  supabase: SupabaseClient
  orgId: string
  sourceEntityType?: string | null
  sourceEntityId?: string | null
  action: string
}) {
  if (!sourceEntityId || !isSubcontractExecutionEntityType(sourceEntityType)) return

  const rules = await getSafeSubcontractComplianceRules(orgId)
  if (!rules.block_subcontract_execution_on_missing_docs) return

  const companyId = await resolveSubcontractExecutionCompanyId({
    supabase,
    orgId,
    sourceEntityType,
    sourceEntityId,
  })
  if (!companyId) return

  const status = await getCompanyComplianceStatusWithClient(supabase, orgId, companyId)
  if (!status.is_compliant) {
    throw new Error(`Vendor compliance documents are required before ${action}.`)
  }
}

/**
 * A subcontract is only executable once the commitment has been approved
 * internally — otherwise a counterparty signature would turn an unreviewed
 * draft into a committed cost.
 */
export async function assertCommitmentExecutable({
  supabase,
  orgId,
  commitmentId,
  action,
}: {
  supabase: SupabaseClient
  orgId: string
  commitmentId: string
  action: string
}) {
  const { data: commitment, error } = await supabase
    .from("commitments")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (error || !commitment) {
    throw new Error(`Failed to validate commitment before ${action}: ${error?.message ?? "not found"}`)
  }
  if (commitment.status === "draft") {
    throw new Error(`Approve this commitment before ${action}.`)
  }
  if (commitment.status === "canceled") {
    throw new Error(`This commitment is canceled and cannot be ${action === "signing" ? "sent" : "executed"}.`)
  }
}

import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { FEATURE_FLAGS } from "@/lib/feature-flags/registry"
import { warrantyVisitCompleteWithCostSchema, type WarrantyVisitCompleteWithCostInput } from "@/lib/services/warranty/validation"

export class WarrantyCompletionRevisionError extends Error {
  readonly code = "WARRANTY_COMPLETION_REVISION_CHANGED"
  constructor() { super("This service visit changed. Refresh it before submitting completion.") }
}

export class WarrantyCompletionAlreadyRecordedError extends Error {
  readonly code = "WARRANTY_COMPLETION_ALREADY_RECORDED"
  constructor() { super("This visit already has a different recorded completion. Refresh it to review the recorded outcome.") }
}

const flagSchema = z.object({ enabled: z.boolean(), expires_at: z.string().nullable() })
const completionReceiptSchema = z.object({
  status: z.enum(["created", "existing"]), receipt_id: z.string().uuid(),
  visit_id: z.string().uuid(), request_id: z.string().uuid(), actor_id: z.string().uuid(),
})

/** Use a service client: receipt history is deliberately private to trusted services. */
export async function warrantyCompletionTransactionsEnabled(supabase: SupabaseClient, orgId: string) {
  z.string().uuid().parse(orgId)
  const flag = await supabase.from("feature_flags").select("enabled,expires_at")
    .eq("org_id", orgId).eq("flag_key", FEATURE_FLAGS.warrantyCompletionTransactions)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (flag.error) throw new Error(`Unable to verify warranty completion rollout: ${flag.error.message}`)
  const parsed = flag.data ? flagSchema.parse(flag.data) : null
  if (parsed?.enabled) {
    if (parsed.expires_at) throw new Error("Warranty completion transactions cannot use an expiring rollout")
    return true
  }
  const history = await supabase.from("warranty_visit_completion_receipts").select("id").eq("org_id", orgId).limit(1).maybeSingle()
  if (history.error && !["42P01", "PGRST205"].includes(history.error.code)) throw new Error(`Unable to verify warranty completion history: ${history.error.message}`)
  if (history.data) throw new Error("Restore warranty completion transactions before changing this organization's visits")
  return false
}

/** SQL owns the original event/audit; retries return its permanent receipt. */
export async function commitOfficeWarrantyCompletion(input: {
  supabase: SupabaseClient; orgId: string; actorId: string; visitId: string; requestId: string;
  expectedVisitAt: string; expectedRequestAt: string; completion: WarrantyVisitCompleteWithCostInput
}) {
  const identity = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), visitId: z.string().uuid(), requestId: z.string().uuid(), expectedVisitAt: z.string().min(1), expectedRequestAt: z.string().min(1) }).parse(input)
  const completion = warrantyVisitCompleteWithCostSchema.parse(input.completion)
  if (completion.visit_id !== identity.visitId) throw new Error("Warranty completion visit identity differs from the authorized visit")
  const { visit_id: visitId, ...payload } = completion
  const { data, error } = await input.supabase.rpc("complete_warranty_visit_atomic", {
    p_org_id: identity.orgId, p_visit_id: visitId, p_actor_id: identity.actorId,
    p_expected_visit_at: identity.expectedVisitAt, p_expected_request_at: identity.expectedRequestAt,
    p_input: { ...payload, photo_file_ids: [...new Set(payload.photo_file_ids ?? [])] },
  })
  if (error?.code === "P0001" && error.message === "Warranty completion retry differs from original receipt") throw new WarrantyCompletionAlreadyRecordedError()
  if (error?.code === "P0001" && error.message === "Warranty completion revision changed") throw new WarrantyCompletionRevisionError()
  if (error) throw new Error(`Unable to commit warranty completion: ${error.message}. Retry with the same completion details to recover its original receipt.`)
  const receipt = completionReceiptSchema.parse(data)
  if (receipt.visit_id !== identity.visitId || receipt.request_id !== identity.requestId) throw new Error("Warranty completion returned another visit or request; reconcile the original receipt")
  return receipt
}

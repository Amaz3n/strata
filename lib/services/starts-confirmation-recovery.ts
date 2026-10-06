import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { FEATURE_FLAGS } from "@/lib/feature-flags/registry"

export const confirmationRecoveryInputSchema = z.object({
  jobId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  reason: z.string().trim().min(10).max(1000),
})
const jobSchema = z.object({
  id: z.union([z.string(), z.number().int().safe()]).transform(String),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  last_error: z.string().nullable(), retry_count: z.number().int().nonnegative(),
})
export type StartConfirmationJobDTO = { id: string; status: "pending" | "processing" | "completed" | "failed"; error: string | null; retryCount: number }

export async function confirmationRecoveryEnabled(supabase: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await supabase.from("feature_flags").select("enabled,expires_at")
    .eq("org_id", orgId).eq("flag_key", FEATURE_FLAGS.startsConfirmationRecovery)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`Unable to verify confirmation recovery controls: ${error.message}`)
  if (data?.enabled && data.expires_at) throw new Error("Confirmation recovery cannot use an expiring flag")
  return data?.enabled === true
}

export async function loadStartConfirmationJobs(supabase: SupabaseClient, orgId: string, packageId: string): Promise<StartConfirmationJobDTO[]> {
  const { data, error } = await supabase.from("outbox").select("id,status,last_error,retry_count")
    .eq("org_id", orgId).eq("job_type", "start_release").eq("payload->>start_package_id", packageId)
    .order("id", { ascending: false }).limit(51)
  if (error) throw new Error(`Unable to load release confirmation: ${error.message}`)
  if ((data?.length ?? 0) > 50) throw new Error("Release confirmation history requires reconciliation")
  return z.array(jobSchema).parse(data ?? []).map(job => ({ id: job.id, status: job.status, error: job.last_error, retryCount: job.retry_count }))
}

const recoveryReceiptSchema = z.object({
  job_id: z.string(), event_id: z.string().uuid(), audit_id: z.string().regex(/^[1-9][0-9]*$/), status: z.literal("pending"),
})

export const notificationRecoveryInputSchema = z.object({
  receiptId: z.string().uuid(), requestId: z.string().uuid(), reason: z.string().trim().min(10).max(1000),
})
const notificationRecoveryReceiptSchema = z.object({
  request_id: z.string().uuid(), receipt_id: z.string().uuid(), job_id: z.string().regex(/^[1-9][0-9]*$/),
  event_id: z.string().uuid(), audit_id: z.string().regex(/^[1-9][0-9]*$/),
  status: z.enum(["pending", "processing", "completed", "failed"]), replayed: z.boolean(),
})
export async function queueStartNotificationRecovery(input: {
  supabase: SupabaseClient; orgId: string; packageId: string; actorId: string; receiptId: string; requestId: string; reason: string
}) {
  const parsed = notificationRecoveryInputSchema.parse(input)
  await assertNotificationRecoveryControls(input.supabase, input.orgId)
  const { data, error } = await input.supabase.rpc("retry_start_notification_delivery", {
    p_org_id: input.orgId, p_package_id: input.packageId, p_receipt_id: parsed.receiptId,
    p_actor_id: input.actorId, p_request_id: parsed.requestId, p_reason: parsed.reason,
  })
  if (error) throw new Error(`Unable to recover alert delivery: ${error.message}. Refresh delivery status before retrying with the same request.`)
  const receipt = notificationRecoveryReceiptSchema.parse(data)
  if (receipt.request_id !== parsed.requestId || receipt.receipt_id !== parsed.receiptId) throw new Error("Delivery recovery returned different request evidence")
  return receipt
}
async function assertNotificationRecoveryControls(supabase: SupabaseClient, orgId: string) {
  if (!await confirmationRecoveryEnabled(supabase, orgId)) throw new Error("Confirmation recovery is not enabled for this organization")
  const { data: flag, error: flagError } = await supabase.from("feature_flags").select("enabled,expires_at")
    .eq("org_id", orgId).eq("flag_key", FEATURE_FLAGS.notificationDeliveryReceipts)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (flagError) throw new Error(`Unable to verify notification delivery controls: ${flagError.message}`)
  if (flag?.enabled && flag.expires_at) throw new Error("Notification delivery rollout cannot use an expiring flag")
  if (flag?.enabled !== true) throw new Error("Notification delivery receipts are not enabled for this organization")
}

export const deliveryInspectionInputSchema = z.object({ after: z.string().uuid().nullable().default(null), failedOnly: z.boolean().default(true) })
const deliveryPageSchema = z.object({
  items: z.array(z.object({ receipt_id: z.string().uuid(), recipient_name: z.string(), channel: z.enum(["deliver_notification", "deliver_push"]),
    status: z.enum(["pending", "processing", "completed", "failed"]), job_id: z.string().nullable(), retry_count: z.number().int().nonnegative().nullable(),
    error: z.string().nullable(), completed_at: z.string().nullable(), source_available: z.boolean() })).max(20),
  next_cursor: z.string().uuid().nullable(), has_more: z.boolean(),
}).refine(page => page.has_more === (page.next_cursor !== null), "Invalid delivery page cursor")
export type StartDeliveryPageDTO = z.infer<typeof deliveryPageSchema> & { scope: { orgId: string; actorId: string; packageId: string } }
export async function readStartNotificationDeliveries(input: {
  supabase: SupabaseClient; orgId: string; packageId: string; actorId: string; after: string | null; failedOnly: boolean
}): Promise<StartDeliveryPageDTO> {
  const parsed = deliveryInspectionInputSchema.parse(input)
  await assertNotificationRecoveryControls(input.supabase, input.orgId)
  const { data, error } = await input.supabase.rpc("list_start_notification_deliveries", {
    p_org_id: input.orgId, p_package_id: input.packageId, p_actor_id: input.actorId, p_after: parsed.after, p_failed_only: parsed.failedOnly, p_limit: 20,
  })
  if (error) throw new Error(`Unable to inspect alert delivery: ${error.message}`)
  const page = deliveryPageSchema.parse(data)
  return { ...page, scope: { orgId: input.orgId, actorId: input.actorId, packageId: input.packageId } }
}
export async function queueStartConfirmationRecovery(input: {
  supabase: SupabaseClient; orgId: string; packageId: string; actorId: string; jobId: string; reason: string
}) {
  const parsed = confirmationRecoveryInputSchema.parse(input)
  if (!await confirmationRecoveryEnabled(input.supabase, input.orgId)) throw new Error("Confirmation recovery is not enabled for this organization")
  const { data, error } = await input.supabase.rpc("retry_start_confirmation", {
    p_org_id: input.orgId, p_package_id: input.packageId, p_job_id: parsed.jobId, p_actor_id: input.actorId, p_reason: parsed.reason,
  })
  if (error) throw new Error(`Unable to retry release confirmation: ${error.message}`)
  const receipt = recoveryReceiptSchema.parse(data)
  if (receipt.job_id !== parsed.jobId) throw new Error("Confirmation recovery returned a different job")
  return receipt
}

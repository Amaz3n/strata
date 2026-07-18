import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

import { INVOICE_WAIVER_TYPES, type InvoiceLienWaiver, type InvoiceLienWaiverType } from "@/lib/types"

/**
 * Receivable-side lien waivers: waivers the builder issues to the client on an
 * invoice. Conditional waivers are shown to the payer immediately (they are only
 * effective to the extent of payment); all pending waivers auto-release when the
 * invoice is paid in full. Distinct from `lien_waivers`, which collects waivers
 * FROM subs/vendors on the payables side.
 */

export type { InvoiceLienWaiver, InvoiceLienWaiverType }

const WAIVER_SELECT =
  "id, org_id, project_id, invoice_id, waiver_type, status, amount_cents, through_date, claimant_name, customer_name, property_description, released_at, created_at"

const createInvoiceLienWaiverSchema = z.object({
  invoice_id: z.string().uuid(),
  waiver_type: z.enum(INVOICE_WAIVER_TYPES),
  through_date: z.string().optional(),
})

function projectLocationText(location: unknown): string | null {
  if (!location) return null
  if (typeof location === "string") return location
  if (typeof location !== "object") return null

  const value = location as Record<string, unknown>
  if (typeof value.address === "string" && value.address.trim()) return value.address
  if (typeof value.formatted === "string" && value.formatted.trim()) return value.formatted

  const joined = [value.street1, value.city, value.state, value.postal_code]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(", ")
  return joined || null
}

export async function listInvoiceLienWaivers(invoiceId: string, orgId?: string): Promise<InvoiceLienWaiver[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()
  if (!invoice) return []
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId: resolvedOrgId,
    projectId: invoice.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "invoice_lien_waiver",
  })
  const { data, error } = await supabase
    .from("invoice_lien_waivers")
    .select(WAIVER_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("invoice_id", invoiceId)
    .neq("status", "void")
    .order("created_at", { ascending: false })
  if (error) {
    throw new Error(`Failed to list lien waivers: ${error.message}`)
  }
  return (data ?? []) as InvoiceLienWaiver[]
}

export async function createInvoiceLienWaiver(
  input: z.infer<typeof createInvoiceLienWaiverSchema>,
  orgId?: string,
): Promise<InvoiceLienWaiver> {
  const parsed = createInvoiceLienWaiverSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, status, total_cents, balance_due_cents, metadata, due_date, issue_date")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.invoice_id)
    .maybeSingle()
  if (invoiceError || !invoice) {
    throw new Error("Invoice not found")
  }
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: invoice.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "invoice_lien_waiver",
  })
  if (invoice.status === "void") {
    throw new Error("Cannot attach a waiver to a voided invoice")
  }

  // One live waiver per type per invoice.
  const { data: existing } = await supabase
    .from("invoice_lien_waivers")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("invoice_id", parsed.invoice_id)
    .eq("waiver_type", parsed.waiver_type)
    .neq("status", "void")
    .maybeSingle()
  if (existing) {
    throw new Error("A waiver of this type already exists on this invoice")
  }

  const [{ data: org }, projectResult] = await Promise.all([
    supabase.from("orgs").select("name").eq("id", resolvedOrgId).maybeSingle(),
    invoice.project_id
      ? supabase.from("projects").select("name, location").eq("org_id", resolvedOrgId).eq("id", invoice.project_id).maybeSingle()
      : Promise.resolve({ data: null as { name?: string | null; location?: unknown } | null, error: null }),
  ])
  if (projectResult.error) {
    throw new Error(`Failed to load waiver project: ${projectResult.error.message}`)
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const propertyDescription = projectLocationText(projectResult.data?.location) ?? projectResult.data?.name ?? null

  const amountCents = invoice.balance_due_cents ?? invoice.total_cents ?? 0

  const { data, error } = await supabase
    .from("invoice_lien_waivers")
    .insert({
      org_id: resolvedOrgId,
      project_id: invoice.project_id,
      invoice_id: invoice.id,
      waiver_type: parsed.waiver_type,
      status: "pending_payment",
      amount_cents: amountCents,
      through_date: parsed.through_date ?? invoice.due_date ?? invoice.issue_date ?? null,
      claimant_name: org?.name ?? null,
      customer_name: metadata.customer_name ?? null,
      property_description: propertyDescription,
      created_by: userId,
    })
    .select(WAIVER_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create lien waiver: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "invoice_lien_waiver",
    entityId: data.id,
    after: data,
  })
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_lien_waiver_created",
    entityType: "invoice",
    entityId: invoice.id,
    payload: { waiver_id: data.id, waiver_type: parsed.waiver_type, invoice_number: invoice.invoice_number },
  })

  return data as InvoiceLienWaiver
}

export async function voidInvoiceLienWaiver(waiverId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: waiver } = await supabase
    .from("invoice_lien_waivers")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", waiverId)
    .maybeSingle()
  if (!waiver) {
    throw new Error("Waiver not found or already released")
  }
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: waiver.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "invoice_lien_waiver",
    resourceId: waiverId,
  })
  const { data, error } = await supabase
    .from("invoice_lien_waivers")
    .update({ status: "void", updated_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", waiverId)
    .eq("status", "pending_payment")
    .select("id, invoice_id")
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to void lien waiver: ${error.message}`)
  }
  if (!data) {
    throw new Error("Waiver not found or already released")
  }
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "invoice_lien_waiver",
    entityId: waiverId,
    after: { status: "void" },
  })
}

/**
 * Release pending waivers once the invoice is fully paid. Runs on the service
 * client (called from the payment path, including public Stripe payments).
 * Non-fatal by design — payment recording must never fail because of a waiver.
 */
export async function releaseInvoiceLienWaiversIfPaid({
  supabase,
  orgId,
  invoiceId,
  paymentId,
}: {
  supabase?: SupabaseClient
  orgId: string
  invoiceId: string
  paymentId?: string | null
}): Promise<void> {
  const client = supabase ?? createServiceSupabaseClient()
  try {
    const { data: invoice } = await client
      .from("invoices")
      .select("id, status, balance_due_cents")
      .eq("org_id", orgId)
      .eq("id", invoiceId)
      .maybeSingle()
    if (!invoice) return
    const isPaid = invoice.status === "paid" || (invoice.balance_due_cents ?? 1) <= 0
    if (!isPaid) return

    const { data: released, error } = await client
      .from("invoice_lien_waivers")
      .update({
        status: "released",
        released_at: new Date().toISOString(),
        released_by_payment_id: paymentId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("org_id", orgId)
      .eq("invoice_id", invoiceId)
      .eq("status", "pending_payment")
      .select("id, waiver_type")
    if (error || !released || released.length === 0) return

    await recordEvent({
      orgId,
      eventType: "invoice_lien_waiver_released",
      entityType: "invoice",
      entityId: invoiceId,
      payload: { waiver_ids: released.map((w) => w.id), payment_id: paymentId ?? null },
    })
  } catch (error) {
    console.warn("Failed to release invoice lien waivers", error)
  }
}

/**
 * Public (token-scoped) fetch for the client portal. Conditional waivers are
 * visible before payment — they are only effective to the extent of payment —
 * while unconditional waivers only appear once released.
 */
export async function listPublicInvoiceLienWaivers({
  invoiceId,
  orgId,
}: {
  invoiceId: string
  orgId: string
}): Promise<InvoiceLienWaiver[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoice_lien_waivers")
    .select(WAIVER_SELECT)
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .neq("status", "void")
    .order("created_at", { ascending: false })
  if (error) {
    console.error("Failed to list public lien waivers", error)
    return []
  }
  return ((data ?? []) as InvoiceLienWaiver[]).filter(
    (waiver) => waiver.status === "released" || waiver.waiver_type.startsWith("conditional"),
  )
}

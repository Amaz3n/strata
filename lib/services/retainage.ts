import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { getNextInvoiceNumber, releaseInvoiceNumberReservation } from "@/lib/services/invoice-numbers"
import { createInvoiceLienWaiver } from "@/lib/services/invoice-lien-waivers"
import { chunk } from "@/lib/utils"
import { z } from "zod"

/**
 * Both loaders below page with `.range()`, so both impose a total order.
 * PostgREST resolves a range as `limit/offset` over whatever order the planner
 * chose; without an ordered key a second page can repeat a row it already
 * returned and skip another, which silently changes how much retainage an
 * invoice is recorded as withholding.
 */
const RETAINAGE_PAGE_SIZE = 1000

/**
 * AR retainage withheld per invoice, keyed by invoice id.
 *
 * `retainage` is the authoritative home for AR retainage. The other two
 * representations — `invoices.metadata.retainage_amount_cents` and the negative
 * `unit = 'retainage'` invoice line — are presentation artifacts and do not agree with
 * it or each other. Read retainage from here and nowhere else.
 *
 * **AR and AP store retainage in opposite directions.** `vendor_bills.total_cents` is
 * GROSS with retainage in its own column, but `invoices.total_cents` is already NET —
 * the hold is a negative line inside the invoice. A caller that needs the gross AR
 * billing must add this value back; a caller measuring what the customer still owes
 * must not subtract it again.
 *
 * Rows are counted whatever their status: releasing retainage is a separate economic
 * event with its own entry, so it does not change what the original invoice withheld.
 */
/**
 * Invoices that exist only to release retainage, mapped to the amount they release.
 *
 * A release invoice bills no new work: its total is retainage that was already billed
 * and withheld on an earlier invoice, now becoming collectible. Posting it as an
 * ordinary invoice would credit contract liabilities a second time for the same work
 * and leave `1110 Retainage receivable` never relieved.
 */
export async function loadRetainageReleaseInvoiceCents(args: {
  supabase: SupabaseClient
  orgId: string
  /** Only these invoices; the projector reads what it is about to post, not the ledger. */
  invoiceIds?: string[]
}): Promise<Map<string, number>> {
  return sumRetainageByInvoice(args, "release_invoice_id", "retainage release invoices")
}

export async function loadInvoiceRetainageCents(args: {
  supabase: SupabaseClient
  orgId: string
  invoiceIds?: string[]
}): Promise<Map<string, number>> {
  return sumRetainageByInvoice(args, "invoice_id", "invoice retainage")
}

// A URL carries about 200 uuids comfortably; larger selections are read in slices.
const RETAINAGE_ID_CHUNK = 200

async function sumRetainageByInvoice(
  args: { supabase: SupabaseClient; orgId: string; invoiceIds?: string[] },
  column: "invoice_id" | "release_invoice_id",
  label: string,
): Promise<Map<string, number>> {
  const byInvoice = new Map<string, number>()
  const slices: Array<string[] | null> = args.invoiceIds ? chunk(args.invoiceIds, RETAINAGE_ID_CHUNK) : [null]
  for (const slice of slices) {
    for (let page = 0; ; page += 1) {
      const from = page * RETAINAGE_PAGE_SIZE
      let query = args.supabase
        .from("retainage")
        .select(`${column}, amount_cents`)
        .eq("org_id", args.orgId)
        .not(column, "is", null)
      if (slice) query = query.in(column, slice)
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + RETAINAGE_PAGE_SIZE - 1)

      if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const invoiceId = String(row[column])
        byInvoice.set(invoiceId, (byInvoice.get(invoiceId) ?? 0) + Number(row.amount_cents ?? 0))
      }
      if ((data ?? []).length < RETAINAGE_PAGE_SIZE) break
    }
  }
  return byInvoice
}

export async function createRetainageRecord({
  project_id,
  contract_id,
  invoice_id,
  amount_cents,
  orgId,
}: {
  project_id: string
  contract_id: string
  invoice_id?: string | null
  amount_cents: number
  orgId?: string
}) {
  if (amount_cents <= 0) {
    throw new Error("Retainage amount must be positive")
  }

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: project_id,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: project_id,
  })

  const { data, error } = await supabase
    .from("retainage")
    .insert({
      org_id: resolvedOrgId,
      project_id,
      contract_id,
      invoice_id: invoice_id ?? null,
      amount_cents,
      status: "held",
    })
    .select("*")
    .single()

  if (error) {
    throw new Error(`Failed to create retainage record: ${error.message}`)
  }

  return data
}

export async function applyRetainageToInvoice({
  invoiceId,
  contract_id,
  amount_cents,
  project_id,
  orgId,
}: {
  invoiceId: string
  contract_id: string
  amount_cents: number
  project_id: string
  orgId?: string
}) {
  // Create a held retainage record linked to the invoice
  return createRetainageRecord({
    project_id,
    contract_id,
    invoice_id: invoiceId,
    amount_cents,
    orgId,
  })
}

/**
 * Release held retainage on a job billed without a schedule of values. The
 * release is its own invoice: it moves what was withheld from retainage
 * receivable into receivables, oldest holds first, without billing the work again.
 */
export async function releaseProjectRetainage(projectId: string, input: { amount_cents: number; title: string; notes?: string }, orgId?: string) {
  const parsed = z.object({
    amount_cents: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(5000).optional(),
  }).parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  for (const permission of ["invoice.write", "invoice.send"] as const)
    await requireAuthorization({ permission, userId, orgId: resolvedOrgId, projectId, supabase, logDecision: true, resourceType: "retainage", resourceId: projectId })

  const next = await getNextInvoiceNumber(resolvedOrgId, projectId)
  const { data, error } = await createServiceSupabaseClient().rpc("release_project_retainage_atomic", {
    p_org_id: resolvedOrgId,
    p_project_id: projectId,
    p_actor_id: userId,
    p_amount_cents: parsed.amount_cents,
    p_invoice_number: next.number,
    p_reservation_id: next.reservation_id ?? null,
    p_title: parsed.title,
    p_notes: parsed.notes ?? null,
    p_issue_date: new Date().toISOString().slice(0, 10),
    p_due_date: null,
  })
  const result = releaseResultSchema.safeParse(data)
  if (error || !result.success) {
    if (next.reservation_id) await releaseInvoiceNumberReservation(next.reservation_id, resolvedOrgId)
    throw new Error(`Failed to release retainage: ${error?.message ?? "No result returned"}`)
  }
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, eventType: "retainage_released", entityType: "invoice", entityId: result.data.invoice_id, payload: { project_id: projectId, amount_cents: result.data.released_cents } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "retainage_release", entityId: result.data.invoice_id,
      after: { project_id: projectId, invoice_id: result.data.invoice_id, amount_cents: result.data.released_cents } }),
  ])
  return result.data
}

const releaseResultSchema = z.object({ invoice_id: z.string().uuid(), released_cents: z.number().int() })

/**
 * The waiver that goes out with a retainage release, and which one is decided
 * by what the release leaves behind. A release that clears everything held on
 * the job is the builder's signed statement that nothing more is owed on it:
 * the unconditional final waiver. A partial release leaves retainage still
 * owing, so it carries the conditional progress waiver for that payment only.
 * It rides the release invoice (from either release path) and is filed pending
 * payment like every invoice waiver. Refuses an invoice that is not a release
 * on this project.
 */
export async function createRetainageReleaseWaiver(projectId: string, invoiceId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const [release, stillHeld] = await Promise.all([
    supabase
      .from("retainage")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .eq("release_invoice_id", invoiceId)
      .limit(1),
    supabase
      .from("retainage")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .eq("status", "held")
      .gt("amount_cents", 0)
      .limit(1),
  ])
  if (release.error) throw new Error(`Failed to check the retainage release: ${release.error.message}`)
  if (stillHeld.error) throw new Error(`Failed to check the retainage still held: ${stillHeld.error.message}`)
  if ((release.data ?? []).length === 0) throw new Error("That invoice is not a retainage release on this project")
  const waiver_type = (stillHeld.data ?? []).length === 0 ? "unconditional_final" : "conditional_progress"
  return createInvoiceLienWaiver({ invoice_id: invoiceId, waiver_type }, resolvedOrgId)
}

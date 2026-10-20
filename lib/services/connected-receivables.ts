import "server-only"

import { connectedReceivableOf, connectedStatusLabel, planConnectedSync } from "@/lib/receivables/connected"
import { normalizeProductTier } from "@/lib/product-tier"
import { runWithServiceOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { enqueueInvoiceSync } from "@/lib/services/accounting-sync"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createInvoice } from "@/lib/services/invoices"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { recordPayment } from "@/lib/services/payments"
import { receivablesWriter } from "@/lib/services/receivables-writer"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { invoiceInputSchema } from "@/lib/validation/invoices"
import { recordedPaymentMethodSchema } from "@/lib/validation/payments"

/**
 * The bridge between a builder's payables and a sub's receivables.
 *
 * A sub who bills a builder through the builder's Arc portal creates a
 * `vendor_bills` row in the BUILDER's org. When the sub has linked that job to
 * one of their own (`project_connections`), the same bill is also a receivable
 * on the sub's books. This module is the one place that reads the builder's
 * bill on the sub's behalf: the two orgs never read each other's tables
 * directly, and every read here is pinned to the connection's own source org,
 * project and company, and to bills the sub submitted through the portal.
 *
 * The builder owns the lifecycle. The mirror follows it: status and payments
 * are copied across, never decided on the sub's side, and the mirror is never
 * emailed to anyone — the builder already has the bill.
 */

export const CONNECTED_RECEIVABLE_JOB_TYPE = "sync_connected_receivable"

export type ConnectedReceivableSyncResult =
  | { status: "skipped"; reason: "invalid_payload" | "connection_inactive" | "access_lapsed" | "bill_not_found" | "rejected_before_mirror" }
  | { status: "synced"; invoiceId: string | null; changed: boolean; needsReview: boolean }

interface ConnectionRow {
  id: string
  org_id: string
  project_id: string
  source_org_id: string
  source_project_id: string
  source_company_id: string
  source_org_name: string
  portal_access_token_id: string
  customer_contact_id: string | null
  status: string
  linked_by: string | null
}

interface PortalTokenRow {
  revoked_at: string | null
  paused_at: string | null
  expires_at: string | null
}

interface SourceBillRow {
  id: string
  bill_number: string | null
  bill_date: string | null
  due_date: string | null
  total_cents: number | string | null
  paid_cents: number | string | null
  status: string
  payment_method: string | null
  metadata: Record<string, unknown> | null
  updated_at: string | null
}

interface MirrorRow {
  id: string
  invoice_number: string
  status: string
  total_cents: number | string | null
  metadata: Record<string, unknown> | null
}

const BILL_COLUMNS = "id, bill_number, bill_date, due_date, total_cents, paid_cents, status, payment_method, metadata, updated_at"
const MIRROR_COLUMNS = "id, invoice_number, status, total_cents, metadata"

function cents(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

function billText(bill: SourceBillRow, key: string): string | null {
  const value = bill.metadata?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

/**
 * Bring the sub's receivable in line with the builder's bill. Idempotent: the
 * mirror is keyed on the bill (unique index), payments on the paid amount they
 * bring the mirror to, so a retried or duplicated job changes nothing.
 */
export async function syncConnectedReceivable(
  orgId: string,
  payload: Record<string, unknown>,
): Promise<ConnectedReceivableSyncResult> {
  const connectionId = typeof payload.connection_id === "string" ? payload.connection_id : null
  const billId = typeof payload.source_bill_id === "string" ? payload.source_bill_id : null
  if (!connectionId || !billId) return { status: "skipped", reason: "invalid_payload" }

  const service = createServiceSupabaseClient()
  const { data: connection, error: connectionError } = await service
    .from("project_connections")
    .select("id, org_id, project_id, source_org_id, source_project_id, source_company_id, source_org_name, portal_access_token_id, customer_contact_id, status, linked_by")
    .eq("id", connectionId)
    .eq("org_id", orgId)
    .maybeSingle<ConnectionRow>()
  if (connectionError) throw new Error(`Failed to load the project connection: ${connectionError.message}`)
  if (!connection || connection.status !== "active") return { status: "skipped", reason: "connection_inactive" }
  if (!connection.linked_by) throw new Error("This connection has no linked member to act for; relink the job to resume syncing")

  // The link reads the builder's bill only while the access behind it is live.
  // A token's own expiry does not touch the connection row, so it is checked here.
  const { data: token, error: tokenError } = await service
    .from("portal_access_tokens")
    .select("revoked_at, paused_at, expires_at")
    .eq("id", connection.portal_access_token_id)
    .eq("org_id", connection.source_org_id)
    .maybeSingle<PortalTokenRow>()
  if (tokenError) throw new Error(`Failed to check the builder's portal access: ${tokenError.message}`)
  if (!token || token.revoked_at || token.paused_at) return { status: "skipped", reason: "access_lapsed" }
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) {
    await endLapsedConnection(orgId, connection)
    return { status: "skipped", reason: "access_lapsed" }
  }

  // The only read of the builder's side: this one bill, narrowed by the link.
  const { data: bill, error: billError } = await service
    .from("vendor_bills")
    .select(BILL_COLUMNS)
    .eq("id", billId)
    .eq("org_id", connection.source_org_id)
    .eq("project_id", connection.source_project_id)
    .eq("company_id", connection.source_company_id)
    .eq("metadata->>submitted_via_portal", "true")
    .maybeSingle<SourceBillRow>()
  if (billError) throw new Error(`Failed to read the builder's bill: ${billError.message}`)
  if (!bill) return { status: "skipped", reason: "bill_not_found" }

  const { data: org, error: orgError } = await service.from("orgs").select("product_tier").eq("id", orgId).maybeSingle()
  if (orgError || !org) throw new Error(`Failed to load the organization: ${orgError?.message ?? "not found"}`)

  const context: OrgServiceContext = {
    supabase: service,
    orgId,
    userId: connection.linked_by,
    productTier: normalizeProductTier(org.product_tier),
  }
  return runWithServiceOrgContext(context, () => reconcile(context, connection, bill))
}

/** The builder's access expired: end the link, keeping the job and every receivable already on it. */
async function endLapsedConnection(orgId: string, connection: ConnectionRow) {
  const { data, error } = await createServiceSupabaseClient()
    .from("project_connections")
    .update({ status: "ended", ended_at: new Date().toISOString(), ended_reason: "access_expired" })
    .eq("org_id", orgId)
    .eq("id", connection.id)
    .neq("status", "ended")
    .select("id")
    .maybeSingle()
  if (error) throw new Error(`Failed to end the lapsed connection: ${error.message}`)
  if (!data) return
  await Promise.all([
    recordAudit({
      orgId,
      action: "update",
      entityType: "project_connection",
      entityId: connection.id,
      before: { status: connection.status },
      after: { status: "ended", ended_reason: "access_expired" },
      source: "connected_receivable_sync",
    }),
    recordEvent({
      orgId,
      eventType: "project_connection_ended",
      entityType: "project",
      entityId: connection.project_id,
      payload: { connection_id: connection.id, reason: "access_expired" },
    }),
  ])
}

async function reconcile(
  context: OrgServiceContext,
  connection: ConnectionRow,
  bill: SourceBillRow,
): Promise<ConnectedReceivableSyncResult> {
  const { orgId } = context
  const service = createServiceSupabaseClient()
  const totalCents = cents(bill.total_cents)
  const paidCents = cents(bill.paid_cents)

  const { data: mirror, error: mirrorError } = await service
    .from("invoices")
    .select(MIRROR_COLUMNS)
    .eq("org_id", orgId)
    .eq("metadata->connected_receivable->>source_bill_id", bill.id)
    .neq("status", "void")
    .maybeSingle<MirrorRow>()
  if (mirrorError) throw new Error(`Failed to look up the mirrored invoice: ${mirrorError.message}`)

  const known = mirror ? connectedReceivableOf(mirror.metadata) : null
  const plan = planConnectedSync(
    { status: bill.status, totalCents, paidCents },
    mirror ? { totalCents: cents(mirror.total_cents), sourcePaidCents: known?.sourcePaidCents ?? 0 } : null,
  )
  if (!mirror && !plan.create) return { status: "skipped", reason: "rejected_before_mirror" }

  const before = mirror ? { invoice_id: mirror.id, status: mirror.status, source_status: known?.sourceStatus ?? null, source_paid_cents: known?.sourcePaidCents ?? 0 } : null
  let invoiceId = mirror?.id ?? null
  let changed = false

  if (plan.voidReason && mirror) {
    await voidMirror(context, mirror.id)
    changed = true
    if (!plan.create) {
      await stampMirror(orgId, mirror.id, connection, bill, {
        paidCents: known?.sourcePaidCents ?? 0,
        extra: { void_reason: plan.voidReason },
      })
      return finish(context, connection, bill, { invoiceId: mirror.id, changed, needsReview: false, before, action: "voided" })
    }
    invoiceId = null
  }

  if (plan.create) {
    invoiceId = await createMirror(context, connection, bill)
    changed = true
  }

  if (!invoiceId) return finish(context, connection, bill, { invoiceId, changed, needsReview: plan.needsReview, before, action: "synced" })

  let recordedPaidCents = plan.create || plan.voidReason ? 0 : known?.sourcePaidCents ?? 0
  if (plan.paymentDeltaCents > 0) {
    await recordPayment(
      {
        invoice_id: invoiceId,
        provider_payment_id: `connected:${bill.id}:${paidCents}`,
        amount_cents: plan.paymentDeltaCents,
        fee_cents: 0,
        currency: "usd",
        // How the builder paid, when it said; otherwise nothing is assumed.
        method: recordedPaymentMethodSchema.catch("other").parse(bill.payment_method),
        provider: "builder_portal",
        status: "succeeded",
        reference: `Paid by ${connection.source_org_name}`,
        received_at: new Date().toISOString(),
        metadata: { connected_receivable: { source_org_id: connection.source_org_id, source_bill_id: bill.id } },
      },
      orgId,
    )
    recordedPaidCents = paidCents
    changed = true
  }

  const stamped = await stampMirror(orgId, invoiceId, connection, bill, {
    paidCents: recordedPaidCents,
    extra: plan.needsReview ? { needs_review: true } : plan.paymentDeltaCents > 0 || plan.create ? { needs_review: false } : {},
  })
  if (stamped.statusChanged || plan.needsReview) changed = true

  return finish(context, connection, bill, {
    invoiceId,
    changed,
    needsReview: plan.needsReview,
    before,
    action: plan.create ? "created" : plan.paymentDeltaCents > 0 ? "paid" : "synced",
  })
}

/** Issue the receivable on the linked job without sending it to anyone. */
async function createMirror(context: OrgServiceContext, connection: ConnectionRow, bill: SourceBillRow): Promise<string> {
  const { orgId } = context
  const service = createServiceSupabaseClient()
  const totalCents = cents(bill.total_cents)
  const typedNumber = bill.bill_number?.trim() || null
  const today = new Date().toISOString().slice(0, 10)

  // The sub typed its number on the builder's form; if it already means
  // something here, take the next one. A void invoice keeps its number
  // (createInvoice refuses a reused one), so a reissued mirror moves on too.
  let invoiceNumber = typedNumber
  if (invoiceNumber) {
    const { data: clash, error } = await service
      .from("invoices")
      .select("id")
      .eq("org_id", orgId)
      .eq("invoice_number", invoiceNumber)
      .limit(1)
    if (error) throw new Error(`Failed to check the invoice number: ${error.message}`)
    if ((clash ?? []).length > 0) invoiceNumber = null
  }
  if (!invoiceNumber) invoiceNumber = (await getNextInvoiceNumber(orgId, connection.project_id)).number

  let customerName: string | undefined
  if (connection.customer_contact_id) {
    const { data: contact } = await service
      .from("contacts")
      .select("full_name")
      .eq("org_id", orgId)
      .eq("id", connection.customer_contact_id)
      .maybeSingle()
    customerName = typeof contact?.full_name === "string" ? contact.full_name : undefined
  }

  const description = billText(bill, "description") ?? `Invoice ${invoiceNumber}`
  const syncedAt = new Date().toISOString()
  const input = invoiceInputSchema.parse({
    project_id: connection.project_id,
    invoice_number: invoiceNumber,
    customer_id: connection.customer_contact_id ?? undefined,
    customer_name: customerName,
    title: `Invoice ${invoiceNumber}`,
    // Saved as a draft: issuing through createInvoice would queue the customer email.
    issue: false,
    issue_date: bill.bill_date ?? today,
    due_date: bill.due_date ?? undefined,
    tax_rate: 0,
    source_type: "manual",
    lines: [{ description, quantity: 1, unit: "ea", unit_cost: totalCents / 100, taxable: false }],
    metadata: {
      delivery: "builder_portal",
      connected_receivable: {
        connection_id: connection.id,
        source_org_id: connection.source_org_id,
        source_org_name: connection.source_org_name,
        source_bill_id: bill.id,
        source_status: bill.status,
        source_paid_cents: 0,
        synced_at: syncedAt,
      },
    },
  })
  const draft = await createInvoice({ input, orgId, context })

  // Issue it without delivery. `issueInvoiceWithContext` always queues the email
  // and demands a recipient, so the issued state is written here, with the same
  // immutable snapshot an issued invoice always carries.
  const { data: issued, error: issueError } = await receivablesWriter()
    .from("invoices")
    .update({
      status: "sent",
      sent_at: syncedAt,
      client_visible: false,
      approval_status: "not_required",
      delivery_status: "not_sent",
      issued_snapshot: {
        schema_version: 1,
        issued_at: syncedAt,
        product_posture: draft.product_posture ?? null,
        invoice_number: invoiceNumber,
        title: input.title,
        issue_date: input.issue_date ?? null,
        due_date: input.due_date ?? null,
        customer_id: connection.customer_contact_id,
        customer_name: customerName ?? null,
        recipients: [],
        source_type: "manual",
        lines: draft.metadata?.lines ?? [],
        totals: {
          subtotal_cents: draft.subtotal_cents ?? totalCents,
          tax_cents: draft.tax_cents ?? 0,
          total_cents: draft.total_cents ?? totalCents,
          balance_due_cents: draft.balance_due_cents ?? totalCents,
        },
      },
    })
    .eq("org_id", orgId)
    .eq("id", draft.id)
    .eq("status", "draft")
    .select("id")
    .maybeSingle()
  if (issueError || !issued) {
    throw new Error(`Failed to issue the connected receivable: ${issueError?.message ?? "invoice changed while issuing"}`)
  }

  await enqueueInvoiceSync(draft.id, orgId).catch((error: unknown) => {
    console.error("[connected-receivables] accounting sync enqueue failed", draft.id, error)
  })
  return draft.id
}

/** Void through the same atomic routine a person's void uses; the actor is the member who linked the job. */
async function voidMirror(context: OrgServiceContext, invoiceId: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("void_invoice_atomic", {
    p_org_id: context.orgId,
    p_invoice_id: invoiceId,
    p_actor_id: context.userId,
  })
  if (error || !data) throw new Error(`Failed to void the mirrored invoice: ${error?.message ?? "unknown error"}`)
}

/** Record what the builder's bill said on the mirror, merged into its freshest metadata. */
async function stampMirror(
  orgId: string,
  invoiceId: string,
  connection: ConnectionRow,
  bill: SourceBillRow,
  { paidCents, extra }: { paidCents: number; extra: Record<string, unknown> },
): Promise<{ statusChanged: boolean }> {
  const writer = receivablesWriter()
  const { data: row, error } = await writer
    .from("invoices")
    .select("metadata")
    .eq("org_id", orgId)
    .eq("id", invoiceId)
    .maybeSingle()
  if (error || !row) throw new Error(`Failed to reload the mirrored invoice: ${error?.message ?? "not found"}`)
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {}
  const previous = connectedReceivableOf(metadata)
  const source = (metadata.connected_receivable as Record<string, unknown> | undefined) ?? {}
  const next = {
    ...metadata,
    connected_receivable: {
      ...source,
      connection_id: connection.id,
      source_org_id: connection.source_org_id,
      source_org_name: connection.source_org_name,
      source_bill_id: bill.id,
      source_status: bill.status,
      source_paid_cents: paidCents,
      synced_at: new Date().toISOString(),
      ...extra,
    },
  }
  const { error: updateError } = await writer.from("invoices").update({ metadata: next }).eq("org_id", orgId).eq("id", invoiceId)
  if (updateError) throw new Error(`Failed to record the builder's status: ${updateError.message}`)
  return { statusChanged: previous?.sourceStatus !== bill.status }
}

async function finish(
  context: OrgServiceContext,
  connection: ConnectionRow,
  bill: SourceBillRow,
  result: {
    invoiceId: string | null
    changed: boolean
    needsReview: boolean
    before: Record<string, unknown> | null
    action: "created" | "paid" | "voided" | "synced"
  },
): Promise<ConnectedReceivableSyncResult> {
  const { orgId } = context
  const { error } = await createServiceSupabaseClient()
    .from("project_connections")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", connection.id)
  if (error) throw new Error(`Failed to record the sync time: ${error.message}`)

  if (result.invoiceId && result.changed) {
    const after = {
      invoice_id: result.invoiceId,
      source_status: bill.status,
      source_label: connectedStatusLabel(bill.status),
      source_paid_cents: cents(bill.paid_cents),
      total_cents: cents(bill.total_cents),
      needs_review: result.needsReview,
    }
    await Promise.all([
      recordAudit({
        orgId,
        action: result.action === "created" ? "insert" : "update",
        entityType: "invoice",
        entityId: result.invoiceId,
        before: result.before,
        after,
        source: "connected_receivable_sync",
      }),
      recordEvent({
        orgId,
        eventType: result.needsReview ? "connected_receivable_needs_review" : `connected_receivable_${result.action}`,
        entityType: "invoice",
        entityId: result.invoiceId,
        payload: { ...after, connection_id: connection.id, source_org_id: connection.source_org_id, source_bill_id: bill.id },
      }),
    ])
  }
  return { status: "synced", invoiceId: result.invoiceId, changed: result.changed, needsReview: result.needsReview }
}

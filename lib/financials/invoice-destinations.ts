/**
 * Where a billing record lives, in one place.
 *
 * These URLs were hand-assembled at roughly a dozen call sites — a report, a
 * retainage ledger, the search index, the AI answer builder, a party's activity
 * feed — and they had drifted into three different contracts: `?invoice=`,
 * `?open=`, and `/projects/:id/invoices`. Build destinations here or they will
 * drift again.
 */

export const PROJECT_BILLING_SEGMENT = "financials/billing"

/** Setup surfaces that open over the billing book. */
export type BillingManageKey = "draws" | "sov" | "retainage"

/** The kinds of document the composer can start with, where the posture has more than one. */
export type NewInvoiceKind = "standard" | "earnest_deposit" | "closing"

function projectBillingBase(projectId: string) {
  return `/projects/${projectId}/${PROJECT_BILLING_SEGMENT}`
}

/** The project's billing book, optionally with one of its setup surfaces open over it. */
export function projectBillingHref(projectId: string, manage?: BillingManageKey) {
  return manage ? `${projectBillingBase(projectId)}?manage=${manage}` : projectBillingBase(projectId)
}

/** The billing book with a billing period in focus. */
export function projectBillingPeriodHref(projectId: string, periodId?: string | null) {
  return periodId ? `${projectBillingBase(projectId)}?period=${encodeURIComponent(periodId)}` : projectBillingBase(projectId)
}

/**
 * One invoice, opened in place.
 *
 * A project-scoped invoice opens on its own book; an invoice with no project
 * (an org-level receivable) opens on the org AR desk, which is the only surface
 * that can show it.
 */
export function invoiceHref(invoiceId: string, projectId?: string | null) {
  if (!projectId) return `/billing?invoice=${invoiceId}`
  return `${projectBillingBase(projectId)}?invoice=${invoiceId}`
}

/**
 * The composer, opened over the billing book. It is a takeover on the page
 * rather than a route of its own, so it opens without a navigation; the URL
 * still names it so it can be linked, refreshed and closed with Back.
 */
export function newInvoiceHref(
  projectId: string,
  options?: { duplicateOf?: string; sourceChangeOrderId?: string; customerId?: string; kind?: NewInvoiceKind },
) {
  const params = new URLSearchParams({ compose: "new" })
  if (options?.duplicateOf) params.set("duplicate", options.duplicateOf)
  if (options?.sourceChangeOrderId) params.set("source", `change_order:${options.sourceChangeOrderId}`)
  if (options?.customerId) params.set("customer", options.customerId)
  if (options?.kind && options.kind !== "standard") params.set("kind", options.kind)
  return `${projectBillingBase(projectId)}?${params.toString()}`
}

/** Resume an autosaved draft in the composer. */
export function resumeInvoiceHref(projectId: string, invoiceId: string) {
  return `${projectBillingBase(projectId)}?compose=${invoiceId}`
}

/** A payment always resolves through the invoice it was applied to. */
export function invoicePaymentHref(invoiceId: string, projectId?: string | null) {
  return invoiceHref(invoiceId, projectId)
}

export function drawHref(projectId: string) {
  return projectBillingHref(projectId, "draws")
}

export function payApplicationHref(projectId: string, payApplicationId?: string | null) {
  return payApplicationId
    ? `${projectBillingBase(projectId)}?payapp=${encodeURIComponent(payApplicationId)}`
    : projectBillingBase(projectId)
}

export function retainageHref(projectId: string) {
  return projectBillingHref(projectId, "retainage")
}

/**
 * Template form for the config tables that substitute `{project_id}` and `{id}`
 * (search indexing, AI answer links). Same contract as `invoiceHref`; kept here
 * so a route change moves both together.
 */
export const INVOICE_HREF_TEMPLATE = `/projects/{project_id}/${PROJECT_BILLING_SEGMENT}?invoice={id}`

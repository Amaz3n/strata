/**
 * Where a billing record lives, in one place.
 *
 * These URLs were hand-assembled at roughly a dozen call sites — a report, a
 * retainage ledger, the search index, the AI answer builder, a party's activity
 * feed — and they had drifted into three different contracts: `?invoice=`,
 * `?open=`, and `/projects/:id/invoices`. The last two are both wrong now:
 * `/invoices` under a project is a redirect that DROPS the query string, so the
 * retainage ledger's "open invoice" link landed on the billing page with nothing
 * selected and no explanation. Build destinations here or they will drift again.
 */

export const PROJECT_BILLING_SEGMENT = "financials/billing"

export type BillingTabKey = "invoices" | "close" | "fee" | "draws" | "sov" | "payapps" | "retainage"

function projectBillingBase(projectId: string) {
  return `/projects/${projectId}/${PROJECT_BILLING_SEGMENT}`
}

/** The project's billing workbench, optionally on one of its artifact tabs. */
export function projectBillingHref(projectId: string, tab?: BillingTabKey) {
  return tab && tab !== "invoices" ? `${projectBillingBase(projectId)}?tab=${tab}` : projectBillingBase(projectId)
}

/**
 * One invoice, opened in place.
 *
 * A project-scoped invoice opens on its own workbench; an invoice with no project
 * (an org-level receivable) opens on the org AR desk, which is the only surface
 * that can show it.
 */
export function invoiceHref(invoiceId: string, projectId?: string | null) {
  if (!projectId) return `/invoices?invoice=${invoiceId}`
  return `${projectBillingBase(projectId)}?invoice=${invoiceId}`
}

/** The dedicated composer route. A new invoice is a task, not a transient overlay. */
export function newInvoiceHref(
  projectId: string,
  options?: { duplicateOf?: string; sourceChangeOrderId?: string; customerId?: string },
) {
  const params = new URLSearchParams()
  if (options?.duplicateOf) params.set("duplicate", options.duplicateOf)
  if (options?.sourceChangeOrderId) params.set("source", `change_order:${options.sourceChangeOrderId}`)
  if (options?.customerId) params.set("customer", options.customerId)
  const query = params.toString()
  return `${projectBillingBase(projectId)}/new${query ? `?${query}` : ""}`
}

/**
 * Resume an autosaved draft in the composer. Same route as creation on purpose:
 * a draft is an unfinished creation, not a different kind of thing, and giving it
 * a second surface is how the old sheet and the old workspace ended up disagreeing
 * about what an unsent invoice was.
 */
export function resumeInvoiceHref(projectId: string, invoiceId: string) {
  return `${projectBillingBase(projectId)}/new?draft=${invoiceId}`
}

/** A payment always resolves through the invoice it was applied to. */
export function invoicePaymentHref(invoiceId: string, projectId?: string | null) {
  return invoiceHref(invoiceId, projectId)
}

export function drawHref(projectId: string) {
  return projectBillingHref(projectId, "draws")
}

export function payApplicationHref(projectId: string) {
  return projectBillingHref(projectId, "payapps")
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

import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The only client that may write `invoices`, `invoice_lines`, `payments`, or
 * `payment_intents`.
 *
 * Those tables used to carry a single `FOR ALL` RLS policy whose whole test was
 * "is this person a member of the org (and the project)". That is a TENANCY
 * check, not an authorization one — so anybody who could load the app could,
 * with a request the UI never makes, insert an invoice, edit an issued one, or
 * write a payment row, without ever holding `invoice.write`, `invoice.send`, or
 * `payment.release`. The RBAC catalog only ever ran in application code.
 *
 * The policies are now read-only for members and every write goes through the
 * service role, which means the application permission check is no longer a
 * courtesy — it is the only door. So the contract for every caller of this
 * function is: `requireAuthorization()` (or a service that already did) FIRST,
 * on the invoice's own project, and only then write.
 *
 * `receivablesWriter` exists rather than a bare `createServiceSupabaseClient()`
 * so that "who is allowed to write money rows, and did they check?" is one grep
 * away instead of scattered across twenty files.
 */
export function receivablesWriter(): SupabaseClient {
  return createServiceSupabaseClient()
}

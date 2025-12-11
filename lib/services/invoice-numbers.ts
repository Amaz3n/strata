import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { getQBOConnection } from "@/lib/services/qbo-connection"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"

interface QBOSettings {
  invoice_number_pattern?: "numeric" | "prefix" | "custom"
  invoice_number_prefix?: string | null
}

export interface NextInvoiceNumber {
  number: string
  source: "qbo" | "local"
  reservation_id?: string
}

export async function getNextInvoiceNumber(orgId?: string): Promise<NextInvoiceNumber> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const serviceSupabase = createServiceSupabaseClient()

  await cleanupExpiredReservations(resolvedOrgId)

  const connection = await getQBOConnection(resolvedOrgId)

  if (connection?.settings?.invoice_number_sync !== false) {
    const client = await QBOClient.forOrg(resolvedOrgId)
    if (client) {
      try {
        const lastNumber =
          connection.settings.last_known_invoice_number ?? (await client.getLastInvoiceNumber()) ?? "0"
        const nextNumber = incrementInvoiceNumber(lastNumber, connection.settings)

        const { data, error } = await serviceSupabase
          .from("qbo_invoice_reservations")
          .insert({
            org_id: resolvedOrgId,
            reserved_number: nextNumber,
            reserved_by: userId,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          })
          .select("id")
          .single()

        if (error) {
          throw error
        }

        return {
          number: nextNumber,
          source: "qbo",
          reservation_id: data?.id,
        }
      } catch (err) {
        console.warn("Failed to reserve QBO invoice number, falling back to local sequence", err)
      }
    }
  }

  const { data: lastInvoice } = await supabase
    .from("invoices")
    .select("invoice_number")
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const lastNumber = lastInvoice?.invoice_number ?? "0"
  const nextNumber = incrementInvoiceNumber(lastNumber, connection?.settings)

  return {
    number: nextNumber,
    source: "local",
  }
}

export async function releaseInvoiceNumberReservation(reservationId: string, orgId?: string) {
  if (!reservationId) return
  const supabase = createServiceSupabaseClient()
  const query = supabase
    .from("qbo_invoice_reservations")
    .update({ status: "released" })
    .eq("id", reservationId)
    .eq("status", "reserved")

  if (orgId) {
    query.eq("org_id", orgId)
  }

  await query
}

export async function markReservationUsed(reservationId: string, invoiceId: string, orgId?: string) {
  if (!reservationId || !invoiceId) return
  const supabase = createServiceSupabaseClient()
  const query = supabase
    .from("qbo_invoice_reservations")
    .update({
      status: "used",
      used_by_invoice_id: invoiceId,
    })
    .eq("id", reservationId)

  if (orgId) {
    query.eq("org_id", orgId)
  }

  await query
}

export function incrementInvoiceNumber(
  current: string,
  settings?: QBOSettings | null,
): string {
  const pattern = settings?.invoice_number_pattern
  const prefix = settings?.invoice_number_prefix ?? ""

  // Explicit prefix or year-based prefix patterns
  if (pattern === "prefix" && prefix) {
    const numericPortion = current.replace(prefix, "")
    const paddedLength = numericPortion.length > 0 ? numericPortion.length : 4
    const next = parseInt(numericPortion || "0", 10) + 1
    return `${prefix}${String(next).padStart(paddedLength, "0")}`
  }

  // Numeric only (default)
  const numericMatch = current.match(/^(\d+)$/)
  if (numericMatch) {
    return String(parseInt(numericMatch[1], 10) + 1)
  }

  // Prefix + digits (generic)
  const prefixMatch = current.match(/^([A-Za-z-]+)(\d+)$/)
  if (prefixMatch) {
    const foundPrefix = prefixMatch[1]
    const num = parseInt(prefixMatch[2], 10) + 1
    const padLength = prefixMatch[2].length
    return `${foundPrefix}${String(num).padStart(padLength, "0")}`
  }

  // Year prefix
  const yearMatch = current.match(/^(\d{4}-)(\d+)$/)
  if (yearMatch) {
    const year = yearMatch[1]
    const num = parseInt(yearMatch[2], 10) + 1
    const padLength = yearMatch[2].length
    return `${year}${String(num).padStart(padLength, "0")}`
  }

  // Fallback: strip non-digits and increment
  const numericPortion = current.replace(/\D/g, "")
  if (numericPortion) {
    return String(parseInt(numericPortion, 10) + 1)
  }

  return "1001"
}

export async function cleanupExpiredReservations(orgId?: string) {
  const supabase = createServiceSupabaseClient()
  const query = supabase
    .from("qbo_invoice_reservations")
    .update({ status: "expired" })
    .eq("status", "reserved")
    .lt("expires_at", new Date().toISOString())

  if (orgId) {
    query.eq("org_id", orgId)
  }

  await query
}

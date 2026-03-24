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

function extractInvoiceSequenceValue(current: string, settings?: QBOSettings | null): number {
  const normalized = String(current ?? "").trim()
  if (!normalized) return 0

  const explicitPrefix = settings?.invoice_number_pattern === "prefix" ? settings.invoice_number_prefix ?? "" : ""
  if (explicitPrefix && normalized.startsWith(explicitPrefix)) {
    const numericPortion = normalized.slice(explicitPrefix.length).replace(/\D/g, "")
    if (numericPortion) return Number.parseInt(numericPortion, 10)
  }

  const yearMatch = normalized.match(/^(\d{4}-)(\d+)$/)
  if (yearMatch) {
    return Number.parseInt(yearMatch[2], 10)
  }

  const suffixMatch = normalized.match(/(\d+)(?!.*\d)/)
  if (suffixMatch) {
    return Number.parseInt(suffixMatch[1], 10)
  }

  return 0
}

export function compareInvoiceNumbers(a: string, b: string, settings?: QBOSettings | null): number {
  const aSeq = extractInvoiceSequenceValue(a, settings)
  const bSeq = extractInvoiceSequenceValue(b, settings)
  if (aSeq !== bSeq) return aSeq - bSeq
  return String(a ?? "").localeCompare(String(b ?? ""))
}

function pickLatestInvoiceNumber(candidates: Array<string | null | undefined>, settings?: QBOSettings | null) {
  return candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .reduce<string | null>((latest, candidate) => {
      if (!latest) return candidate.trim()
      return compareInvoiceNumbers(candidate, latest, settings) > 0 ? candidate.trim() : latest
    }, null)
}

export async function getNextInvoiceNumber(orgId?: string): Promise<NextInvoiceNumber> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const serviceSupabase = createServiceSupabaseClient()

  await cleanupExpiredReservations(resolvedOrgId)

  const connection = await getQBOConnection(resolvedOrgId)

  if (connection && connection.settings?.invoice_number_sync !== false) {
    const client = await QBOClient.forOrg(resolvedOrgId)
    if (client) {
      try {
        const [qboLastNumber, lastInvoice, latestReservation] = await Promise.all([
          client.getLastInvoiceNumber().catch(() => null),
          supabase
            .from("invoices")
            .select("invoice_number")
            .eq("org_id", resolvedOrgId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          serviceSupabase
            .from("qbo_invoice_reservations")
            .select("reserved_number")
            .eq("org_id", resolvedOrgId)
            .order("reserved_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ])

        let cursor =
          pickLatestInvoiceNumber(
            [
              connection.settings.last_known_invoice_number ?? null,
              qboLastNumber,
              lastInvoice.data?.invoice_number ?? null,
              latestReservation.data?.reserved_number ?? null,
            ],
            connection.settings,
          ) ?? "0"

        for (let attempt = 0; attempt < 25; attempt += 1) {
          const nextNumber = incrementInvoiceNumber(cursor, connection.settings)
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

          if (!error && data?.id) {
            await rememberQBOInvoiceNumberCursor(resolvedOrgId, nextNumber)
            return {
              number: nextNumber,
              source: "qbo",
              reservation_id: data.id,
            }
          }

          const errorText = String(error?.message ?? "").toLowerCase()
          const duplicateReservation =
            error?.code === "23505" ||
            errorText.includes("duplicate") ||
            errorText.includes("unique")

          if (!duplicateReservation) {
            throw error
          }

          cursor = nextNumber
        }
        throw new Error("Unable to reserve a unique QuickBooks invoice number.")
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

export async function rememberQBOInvoiceNumberCursor(orgId: string, invoiceNumber: string) {
  if (!orgId || !invoiceNumber) return
  const supabase = createServiceSupabaseClient()
  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("id, settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  if (!connection) return

  const settings = (connection.settings as QBOSettings & { last_known_invoice_number?: string | null }) ?? {}
  const current = settings.last_known_invoice_number
  if (current && compareInvoiceNumbers(invoiceNumber, current, settings) < 0) {
    return
  }

  await supabase
    .from("qbo_connections")
    .update({
      settings: {
        ...settings,
        last_known_invoice_number: invoiceNumber,
      },
    })
    .eq("id", connection.id)
    .eq("status", "active")
}

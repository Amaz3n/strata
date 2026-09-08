import { compareInvoiceNumbers, incrementInvoiceNumber, pickLatestInvoiceNumber, type AccountingNumberSettings } from "@/lib/invoices/invoice-number-format"
export { compareInvoiceNumbers, incrementInvoiceNumber } from "@/lib/invoices/invoice-number-format"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { resolveLedgerAuthority } from "@/lib/services/books/authority"
import { getProvider } from "@/lib/integrations/accounting/registry"

export interface NextInvoiceNumber {
  number: string
  source: "accounting" | "local"
  reservation_id?: string
  warning?: string
}

// Coalesce concurrent external reads, and reuse a fresh provider cursor briefly.
// Uniqueness always comes from database reservations, never from this cache.
const providerCursors = new Map<string, { expires: number; value: Promise<string | null> }>()

async function readProviderCursor(connectionId: string, read: () => Promise<string | null>) {
  let cached = providerCursors.get(connectionId)
  if (!cached || cached.expires <= Date.now()) {
    for (const [key, entry] of providerCursors) if (entry.expires <= Date.now()) providerCursors.delete(key)
    const entry = { expires: Date.now() + 120_000, value: Promise.resolve(null) as Promise<string | null> }
    entry.value = read().then((value) => {
      entry.expires = Date.now() + 60_000
      return value
    }).catch((error) => {
      if (providerCursors.get(connectionId) === entry) providerCursors.delete(connectionId)
      throw error
    })
    providerCursors.set(connectionId, entry)
    cached = entry
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      cached.value,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Accounting number lookup timed out")), 5000) }),
    ])
  } finally { clearTimeout(timer) }
}

export async function getNextInvoiceNumber(orgId?: string, projectId?: string | null): Promise<NextInvoiceNumber> {
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const db = createServiceSupabaseClient()
  const nativeBooks = (await resolveLedgerAuthority(resolvedOrgId, db)) === "arc"
  const target = nativeBooks ? null : await resolveAccountingTarget({ orgId: resolvedOrgId, projectId })
  const connection = target?.connection ?? null
  const settings = connection?.settings
  let warning: string | undefined
  let source: NextInvoiceNumber["source"] = "local"

  const externalCursor = async () => {
    if (!connection || connection.settings?.invoice_number_sync === false) return null
    const provider = getProvider(connection.provider)
    if (!provider.getLastInvoiceNumber) return null
    try {
      const cursor = await readProviderCursor(connection.id, () => provider.getLastInvoiceNumber!({ connectionId: connection.id }))
      source = "accounting"
      return cursor
    } catch {
      warning = "Accounting couldn't confirm its latest number. This number is reserved in Arc; check it against your accounting system before sending."
      const remembered = connection.settings?.last_known_invoice_number
      return typeof remembered === "string" ? remembered : null
    }
  }

  // Read every page: creation order is not sequence order (imports, backdated
  // invoices, custom numbers). Used reservations also keep the cursor monotonic.
  const readLocalCursor = async () => {
    await cleanupExpiredReservations(resolvedOrgId)
    let latest: string | null = null
    for (const table of ["invoices", "qbo_invoice_reservations"] as const) {
      const field = table === "invoices" ? "invoice_number" : "reserved_number"
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db.from(table).select(field).eq("org_id", resolvedOrgId)
          .order("id").range(offset, offset + 999)
        if (error) throw new Error(`Unable to read invoice numbering: ${error.message}`)
        latest = pickLatestInvoiceNumber([latest, ...(data ?? []).map((row) => (row as unknown as Record<string, string>)[field])], settings)
        if (!data || data.length < 1000) break
      }
    }
    return latest
  }
  const [external, local] = await Promise.all([externalCursor(), readLocalCursor()])
  const remembered = connection?.settings?.invoice_number_sync !== false && typeof connection?.settings?.last_known_invoice_number === "string" ? connection.settings.last_known_invoice_number : null
  let cursor = pickLatestInvoiceNumber([external, local, remembered], settings) ?? "0"
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const number = incrementInvoiceNumber(cursor, settings)
    cursor = number
    const { data: existing, error: existingError } = await db.from("invoices").select("id")
      .eq("org_id", resolvedOrgId).eq("invoice_number", number).limit(1)
    if (existingError) throw new Error(`Unable to check invoice number: ${existingError.message}`)
    if (existing?.length) continue
    // One reservation per composer, including multiple tabs belonging to one user.
    // The legacy table name is retained for compatibility with invoice-save RPCs.
    const { data, error } = await db.from("qbo_invoice_reservations").insert({
      org_id: resolvedOrgId, reserved_number: number, reserved_by: userId,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }).select("id").single()
    if (error?.code === "23505") continue
    if (error || !data) throw new Error(`Unable to reserve invoice number: ${error?.message ?? "No reservation returned"}`)
    // A concurrent invoice save may have consumed a reservation between our
    // existence check and insert. Recheck before offering the number to a user.
    const { data: collision, error: collisionError } = await db.from("invoices").select("id")
      .eq("org_id", resolvedOrgId).eq("invoice_number", number).limit(1)
    if (collisionError || collision?.length) {
      await releaseInvoiceNumberReservation(data.id, resolvedOrgId)
      if (collisionError) throw new Error(`Unable to verify reserved number: ${collisionError.message}`)
      continue
    }
    return { number, source, reservation_id: data.id, warning }
  }
  throw new Error("Unable to reserve a unique invoice number. Please retry.")
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

  const { error } = await query
  if (error) throw new Error(`Unable to expire invoice reservations: ${error.message}`)
}

export async function rememberAccountingInvoiceNumberCursor(connectionId: string, orgId: string, invoiceNumber: string) {
  if (!connectionId || !orgId || !invoiceNumber) return
  const supabase = createServiceSupabaseClient()
  const { data: connection } = await supabase
    .from("accounting_connections")
    .select("id, settings")
    .eq("id", connectionId)
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  if (!connection) return

  const settings = (connection.settings as AccountingNumberSettings & { last_known_invoice_number?: string | null }) ?? {}
  const current = settings.last_known_invoice_number
  if (current && compareInvoiceNumbers(invoiceNumber, current, settings) < 0) {
    return
  }

  await supabase
    .from("accounting_connections")
    .update({
      settings: {
        ...settings,
        last_known_invoice_number: invoiceNumber,
      },
    })
    .eq("org_id", orgId)
    .eq("id", connection.id)
    .eq("status", "active")
}

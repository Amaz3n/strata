import type { SupabaseClient } from "@supabase/supabase-js"

import type { Receipt } from "@/lib/types"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function listReceiptsForInvoice({
  supabase,
  orgId,
  invoiceId,
}: {
  supabase?: SupabaseClient
  orgId: string
  invoiceId: string
}): Promise<Receipt[]> {
  const client = supabase ?? createServiceSupabaseClient()
  const { data, error } = await client
    .from("receipts")
    .select("id, org_id, payment_id, project_id, invoice_id, amount_cents, issued_to_email, issued_at, file_id, metadata, created_at")
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .order("issued_at", { ascending: false })

  if (error) {
    console.warn("Failed to list receipts", error)
    return []
  }

  return (data as Receipt[]) ?? []
}


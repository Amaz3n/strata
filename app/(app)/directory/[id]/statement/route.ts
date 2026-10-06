import { NextResponse } from "next/server"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { getDirectoryEntry } from "@/lib/services/directory"
import { getFinancialPartyReceivables } from "@/lib/services/financial-parties"
import { renderCustomerStatementPdf } from "@/lib/pdfs/customer-statement"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Customer not found" }, { status: 404 })
  const context = await requireOrgContext()
  const party = await getDirectoryEntry(id, context)
  if (!party) return NextResponse.json({ error: "Customer not found" }, { status: 404 })
  const [summary, org] = await Promise.all([
    getFinancialPartyReceivables({ partyType: party.kind, partyId: id, orgId: context.orgId }),
    context.supabase.from("orgs").select("name").eq("id", context.orgId).single(),
  ])
  if (!summary.can_view_invoices) return NextResponse.json({ error: "Complete invoice access is required to generate this statement" }, { status: 403 })
  const pdf = await renderCustomerStatementPdf({ company: org.data?.name ?? "", customer: party.name, asOf: new Date().toISOString().slice(0, 10), invoices: summary.open_invoices })
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="customer-statement-${id}.pdf"`, "Cache-Control": "private, no-store" } })
}

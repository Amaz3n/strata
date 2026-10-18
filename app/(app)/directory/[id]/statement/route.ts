import { NextResponse } from "next/server"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { getDirectoryEntry } from "@/lib/services/directory"
import { getCustomerStatement } from "@/lib/services/financial-parties"
import { renderCustomerStatementPdf } from "@/lib/pdfs/customer-statement"
import { dateOnlyToUtcMs, isoDateOnlyFromUtcMs, todayIsoDateOnly } from "@/lib/services/reports/dates"

// A real calendar day: 2026-02-31 does not round-trip.
const asOfSchema = z.string().refine((value) => {
  const ms = dateOnlyToUtcMs(value)
  return ms !== null && isoDateOnlyFromUtcMs(ms) === value
})

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Customer not found" }, { status: 404 })
  const requested = new URL(request.url).searchParams.get("as_of")
  const asOf = requested ?? todayIsoDateOnly()
  if (!asOfSchema.safeParse(asOf).success) return NextResponse.json({ error: "Choose a statement date as YYYY-MM-DD" }, { status: 400 })
  const context = await requireOrgContext()
  const party = await getDirectoryEntry(id, context)
  if (!party) return NextResponse.json({ error: "Customer not found" }, { status: 404 })
  const [statement, org] = await Promise.all([
    getCustomerStatement({ partyType: party.kind, partyId: id, asOf, orgId: context.orgId }),
    context.supabase.from("orgs").select("name").eq("id", context.orgId).single(),
  ])
  if (!statement.can_view_invoices) return NextResponse.json({ error: "Complete invoice access is required to generate this statement" }, { status: 403 })
  const pdf = await renderCustomerStatementPdf({ company: org.data?.name ?? "", customer: party.name, statement })
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="customer-statement-${id}-${asOf}.pdf"`, "Cache-Control": "private, no-store" } })
}

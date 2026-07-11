import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { toCsv } from "@/lib/services/reports/csv"

export async function GET() {
  try {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("directory.read", { supabase, orgId, userId })
    const { data, error } = await supabase
      .from("prequalifications")
      .select("company_id, status, submitted_at, reviewed_at, expires_at, single_project_limit_cents, aggregate_limit_cents, emr, bonding_single_cents, bonding_aggregate_cents, trades, company:companies!inner(name)")
      .eq("org_id", orgId).order("created_at", { ascending: false })
    if (error) throw new Error(`Failed to export prequalifications: ${error.message}`)
    const seen = new Set<string>()
    const rows = (data ?? []).filter((row) => seen.has(row.company_id) ? false : (seen.add(row.company_id), true)).map((row: any) => ({
      company: (Array.isArray(row.company) ? row.company[0] : row.company)?.name ?? "",
      status: row.status, submitted_at: row.submitted_at, reviewed_at: row.reviewed_at, expires_at: row.expires_at,
      single_project_limit_cents: row.single_project_limit_cents, aggregate_limit_cents: row.aggregate_limit_cents,
      emr: row.emr, bonding_single_cents: row.bonding_single_cents, bonding_aggregate_cents: row.bonding_aggregate_cents,
      trades: (row.trades ?? []).join("; "),
    }))
    return new NextResponse(toCsv(rows, [
      { key: "company", header: "company" }, { key: "status", header: "status" }, { key: "submitted_at", header: "submitted_at" },
      { key: "reviewed_at", header: "reviewed_at" }, { key: "expires_at", header: "expires_at" },
      { key: "single_project_limit_cents", header: "single_project_limit_cents" }, { key: "aggregate_limit_cents", header: "aggregate_limit_cents" },
      { key: "emr", header: "emr" }, { key: "bonding_single_cents", header: "bonding_single_cents" },
      { key: "bonding_aggregate_cents", header: "bonding_aggregate_cents" }, { key: "trades", header: "trades" },
    ]), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="prequalifications-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "private, no-store" } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to export prequalifications" }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from "next/server"

import { listInspections } from "@/lib/services/inspections"
import { listMeetings } from "@/lib/services/meetings"
import { listPayApplications } from "@/lib/services/pay-applications"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"
import { listSafetyIncidents } from "@/lib/services/safety"
import { listTransmittals } from "@/lib/services/transmittals"

type Row = Record<string, any>

const columns: Record<string, CsvColumn<Row>[]> = {
  "pay-applications": [
    { key: "application_number", header: "application_number" }, { key: "period_start", header: "period_start" },
    { key: "period_end", header: "period_end" }, { key: "status", header: "status" },
    { key: "contract_sum_to_date_cents", header: "contract_sum_to_date_cents" },
    { key: "total_completed_stored_cents", header: "total_completed_stored_cents" },
    { key: "retainage_cents", header: "retainage_cents" }, { key: "current_payment_due_cents", header: "current_payment_due_cents" },
    { key: "balance_to_finish_cents", header: "balance_to_finish_cents" }, { key: "submitted_at", header: "submitted_at" },
  ],
  meetings: [
    { key: "display_number", header: "meeting_number" }, { key: "series", header: "series" }, { key: "title", header: "title" },
    { key: "held_at", header: "held_at" }, { key: "location", header: "location" }, { key: "status", header: "status" },
    { key: "finalized_at", header: "finalized_at" },
  ],
  transmittals: [
    { key: "display_number", header: "transmittal_number" }, { key: "subject", header: "subject" }, { key: "purpose", header: "purpose" },
    { key: "sent_at", header: "sent_at" }, { key: "recipients", header: "recipients", format: (_value, row) => row.recipients.map((recipient: Row) => recipient.email).join("; ") },
    { key: "items", header: "enclosures", format: (_value, row) => row.items.map((item: Row) => item.description).join("; ") },
  ],
  inspections: [
    { key: "inspection_number", header: "inspection_number" }, { key: "kind", header: "kind" }, { key: "title", header: "title" },
    { key: "status", header: "status" }, { key: "result", header: "result" }, { key: "inspected_at", header: "inspected_at" },
    { key: "inspector_name", header: "inspector" }, { key: "location", header: "location" }, { key: "company_name", header: "company" },
    { key: "deficient_count", header: "deficient_count" },
  ],
  incidents: [
    { key: "incident_number", header: "incident_number" }, { key: "occurred_at", header: "occurred_at" }, { key: "severity", header: "severity" },
    { key: "classification", header: "classification" }, { key: "location", header: "location" }, { key: "description", header: "description" },
    { key: "involved_company_name", header: "involved_company" }, { key: "involved_person_name", header: "involved_person" },
    { key: "is_osha_recordable", header: "osha_recordable" }, { key: "status", header: "status" }, { key: "closed_at", header: "closed_at" },
  ],
  delays: [
    { key: "report_date", header: "report_date" }, { key: "delay_type", header: "delay_type" }, { key: "description", header: "description" },
    { key: "hours_lost", header: "hours_lost" }, { key: "affected_trades", header: "affected_trades" },
    { key: "potential_claim", header: "potential_claim" }, { key: "schedule_item_id", header: "schedule_item_id" },
  ],
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; kind: string }> }) {
  try {
    const { id: projectId, kind } = await params
    if (!columns[kind]) return NextResponse.json({ error: "Unknown register" }, { status: 404 })
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "report.read")
    let rows: Row[]
    if (kind === "pay-applications") rows = await listPayApplications(projectId, orgId)
    else if (kind === "meetings") rows = await listMeetings(projectId, orgId)
    else if (kind === "transmittals") rows = await listTransmittals(projectId, orgId)
    else if (kind === "inspections") rows = await listInspections(projectId, orgId)
    else if (kind === "incidents") rows = await listSafetyIncidents(projectId, orgId)
    else {
      const { data, error } = await supabase
        .from("daily_report_delays")
        .select("id, delay_type, description, hours_lost, affected_trades, schedule_item_id, potential_claim, report:daily_reports!inner(report_date)")
        .eq("org_id", orgId).eq("project_id", projectId).order("created_at", { ascending: false })
      if (error) throw new Error(`Failed to export delay register: ${error.message}`)
      rows = (data ?? []).map((row: Row) => ({ ...row, report_date: (Array.isArray(row.report) ? row.report[0] : row.report)?.report_date ?? null }))
    }
    return new NextResponse(toCsv(rows, columns[kind]), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${kind}-${projectId}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to export register" }, { status: 500 })
  }
}

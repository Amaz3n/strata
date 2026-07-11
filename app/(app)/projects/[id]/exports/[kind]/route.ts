import { NextRequest, NextResponse } from "next/server"
import { PDFDocument } from "pdf-lib"
import { formatDocNumber, type DocumentNumberingSettings } from "@/lib/document-number"
import { renderDailyReportPdf } from "@/lib/pdfs/daily-report-pdf"
import { renderIncidentPdf } from "@/lib/pdfs/incident-pdf"
import { renderInspectionPdf } from "@/lib/pdfs/inspection-pdf"
import { renderPunchListPdf } from "@/lib/pdfs/punch-list-pdf"
import { renderRfiPdf } from "@/lib/pdfs/rfi-pdf"
import { renderSubmittalPdf } from "@/lib/pdfs/submittal-pdf"
import { renderSubmittalRegisterPdf } from "@/lib/pdfs/submittal-register-pdf"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { listPunchItems } from "@/lib/services/punch-lists"
import { getInspection } from "@/lib/services/inspections"
import { listSafetyIncidents } from "@/lib/services/safety"
import { listRfiResponses, listRfis } from "@/lib/services/rfis"
import { listSubmittalItems, listSubmittalReviewSteps, listSubmittals } from "@/lib/services/submittals"
import { downloadFilesObject } from "@/lib/storage/files-storage"

function pdfResponse(pdf: Buffer, fileName: string) {
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"`, "Cache-Control": "private, no-store" } })
}

function weatherText(value: unknown) {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return null
  const weather = value as Record<string, unknown>
  return [weather.conditions, weather.temperature, weather.notes].filter(Boolean).join(" • ")
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; kind: string }> }) {
  try {
    const { id: projectId, kind } = await params
    const entityId = request.nextUrl.searchParams.get("id")
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "report.read")
    const [{ data: project }, { data: org }] = await Promise.all([
      supabase.from("projects").select("name").eq("org_id", orgId).eq("id", projectId).single(),
      supabase.from("orgs").select("name, address, document_numbering").eq("id", orgId).single(),
    ])
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    const numbering = (org?.document_numbering ?? {}) as DocumentNumberingSettings
    const baseHeader = { orgName: org?.name ?? "Arc", orgAddress: typeof org?.address === "string" ? org.address : null, projectName: project.name }

    if (kind === "rfi") {
      if (!entityId) return NextResponse.json({ error: "RFI id is required" }, { status: 400 })
      const rfis = await listRfis(orgId, projectId)
      const rfi = rfis.find((item) => item.id === entityId)
      if (!rfi) return NextResponse.json({ error: "RFI not found" }, { status: 404 })
      const responses = await listRfiResponses({ orgId, rfiId: rfi.id })
      const displayNumber = formatDocNumber("rfi", rfi.rfi_number, numbering)
      const pdf = await renderRfiPdf({
        header: { ...baseHeader, title: "Request for Information", documentNumber: displayNumber, date: new Date(rfi.created_at).toLocaleDateString() },
        subject: rfi.subject, status: rfi.status, priority: rfi.priority, dueDate: rfi.due_date, drawingReference: rfi.drawing_reference,
        specReference: rfi.spec_reference, location: rfi.location, costImpactCents: rfi.cost_impact_cents, scheduleImpactDays: rfi.schedule_impact_days,
        question: rfi.question, decisionStatus: rfi.decision_status, decisionNote: rfi.decision_note,
        responses: responses.map((response) => ({ author: response.responder_name, date: new Date(response.created_at).toLocaleDateString(), type: response.response_type, body: response.body })),
      })
      return pdfResponse(pdf, `rfi-${displayNumber}.pdf`)
    }

    if (kind === "submittal-register") {
      const rows = await listSubmittals(orgId, projectId)
      const pdf = await renderSubmittalRegisterPdf({ header: { ...baseHeader, title: "Submittal Register", date: new Date().toLocaleDateString() }, rows: rows.map((item) => ({ number: formatDocNumber("submittal", item.submittal_number, numbering), revision: item.revision, title: item.title, specSection: item.spec_section, status: item.status, ballInCourt: item.ball_in_court, dueDate: item.due_date })) })
      return pdfResponse(pdf, "submittal-register.pdf")
    }

    if (kind === "submittal") {
      if (!entityId) return NextResponse.json({ error: "Submittal id is required" }, { status: 400 })
      const submittals = await listSubmittals(orgId, projectId)
      const submittal = submittals.find((item) => item.id === entityId)
      if (!submittal) return NextResponse.json({ error: "Submittal not found" }, { status: 404 })
      const [items, steps] = await Promise.all([listSubmittalItems({ orgId, submittalId: entityId }), listSubmittalReviewSteps({ orgId, submittalId: entityId })])
      const displayNumber = formatDocNumber("submittal", submittal.submittal_number, numbering)
      const pdf = await renderSubmittalPdf({
        header: { ...baseHeader, title: "Submittal", documentNumber: displayNumber, date: new Date(submittal.created_at).toLocaleDateString() },
        title: submittal.title, description: submittal.description, status: submittal.status, revision: submittal.revision,
        specSection: submittal.spec_section, dueDate: submittal.due_date, requiredOnSite: submittal.required_on_site, ballInCourt: submittal.ball_in_court,
        decisionStatus: submittal.decision_status, decisionNote: submittal.decision_note,
        items: items.map((item) => ({ number: item.item_number, description: item.description, manufacturer: item.manufacturer, model: item.model_number })),
        reviewSteps: steps.map((step) => ({ order: step.step_order, reviewer: step.reviewer_name ?? step.role_label ?? "Reviewer", status: step.status, decision: step.decision, decidedAt: step.decided_at })),
      })
      return pdfResponse(pdf, `submittal-${displayNumber}-rev-${submittal.revision}.pdf`)
    }

    if (kind === "daily-report") {
      if (!entityId) return NextResponse.json({ error: "Daily report id is required" }, { status: 400 })
      const [{ data: report }, { data: manpower }, { data: logs }, { data: delays }, { data: equipment }, { data: deliveries }, { data: visitors }] = await Promise.all([
        supabase.from("daily_reports").select("id, report_date, status, weather, weather_auto, day_type, submitted_at, submitted_by_user:app_users!daily_reports_submitted_by_fkey(full_name, email)").eq("org_id", orgId).eq("project_id", projectId).eq("id", entityId).single(),
        supabase.from("daily_report_manpower").select("company, trade, workers, hours").eq("org_id", orgId).eq("project_id", projectId).eq("daily_report_id", entityId),
        supabase.from("daily_logs").select("id, summary, daily_log_entries(entry_type, description, quantity, hours, location)").eq("org_id", orgId).eq("project_id", projectId).eq("daily_report_id", entityId),
        supabase.from("daily_report_delays").select("delay_type, description, hours_lost, affected_trades, potential_claim").eq("org_id", orgId).eq("project_id", projectId).eq("daily_report_id", entityId),
        supabase.from("daily_report_equipment").select("description, company, count, hours_used, idle").eq("org_id", orgId).eq("project_id", projectId).eq("daily_report_id", entityId),
        supabase.from("daily_report_deliveries").select("description, supplier, quantity, ticket_number").eq("org_id", orgId).eq("project_id", projectId).eq("daily_report_id", entityId),
        supabase.from("daily_report_visitors").select("name, company, purpose, time_in, time_out").eq("org_id", orgId).eq("project_id", projectId).eq("daily_report_id", entityId),
      ])
      if (!report) return NextResponse.json({ error: "Daily report not found" }, { status: 404 })
      const submitter = Array.isArray(report.submitted_by_user) ? report.submitted_by_user[0] : report.submitted_by_user
      const logIds = (logs ?? []).map((log) => log.id)
      const { data: photoRows } = logIds.length > 0
        ? await supabase.from("files").select("storage_path, mime_type, file_name").eq("org_id", orgId).eq("project_id", projectId).in("daily_log_id", logIds).like("mime_type", "image/%").limit(12)
        : { data: [] }
      const photos = (await Promise.all((photoRows ?? []).map(async (photo) => {
        if (!photo.storage_path || !["image/jpeg", "image/png"].includes(photo.mime_type ?? "")) return null
        try {
          const bytes = await downloadFilesObject({ supabase, orgId, path: photo.storage_path })
          return { bytes, mimeType: photo.mime_type as string, caption: photo.file_name }
        } catch { return null }
      }))).filter((photo): photo is { bytes: Buffer; mimeType: string; caption: string | null } => photo !== null)
      const pdf = await renderDailyReportPdf({
        header: { ...baseHeader, title: "Daily Report", documentNumber: report.report_date, date: new Date(`${report.report_date}T12:00:00`).toLocaleDateString() },
        weather: weatherText(report.weather), dayType: report.day_type, summary: (logs ?? []).map((log) => log.summary).filter(Boolean).join("\n"),
        manpower: (manpower ?? []).map((row) => ({ company: row.company ?? "Unspecified", trade: row.trade, workers: row.workers ?? 0, hours: row.hours == null ? null : Number(row.hours) })),
        entries: (logs ?? []).flatMap((log) => (log.daily_log_entries ?? []).map((entry) => ({ type: entry.entry_type, description: entry.description ?? "—", quantity: entry.quantity == null ? null : Number(entry.quantity), hours: entry.hours == null ? null : Number(entry.hours), location: entry.location }))),
        delays: (delays ?? []).map((row) => ({ type: row.delay_type, description: row.description, hoursLost: row.hours_lost == null ? null : Number(row.hours_lost), affectedTrades: row.affected_trades, potentialClaim: row.potential_claim })),
        equipment: (equipment ?? []).map((row) => ({ description: row.description, company: row.company, count: row.count, hoursUsed: row.hours_used == null ? null : Number(row.hours_used), idle: row.idle })),
        deliveries: (deliveries ?? []).map((row) => ({ description: row.description, supplier: row.supplier, quantity: row.quantity, ticketNumber: row.ticket_number })),
        visitors: (visitors ?? []).map((row) => ({ name: row.name, company: row.company, purpose: row.purpose, timeIn: row.time_in, timeOut: row.time_out })),
        submittedBy: submitter?.full_name ?? submitter?.email ?? null,
        submittedAt: report.submitted_at ? new Date(report.submitted_at).toLocaleString() : null,
        photos,
      })
      return pdfResponse(pdf, `daily-report-${report.report_date}.pdf`)
    }

    if (kind === "daily-report-bulk") {
      const from = request.nextUrl.searchParams.get("from")
      const to = request.nextUrl.searchParams.get("to")
      if (!from || !to) return NextResponse.json({ error: "From and to dates are required" }, { status: 400 })
      const days = Math.floor((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000) + 1
      if (days < 1 || days > 31) return NextResponse.json({ error: "Date range must be between 1 and 31 days" }, { status: 400 })
      const { data: reports } = await supabase.from("daily_reports").select("id").eq("org_id", orgId).eq("project_id", projectId).gte("report_date", from).lte("report_date", to).order("report_date")
      const merged = await PDFDocument.create()
      for (const report of reports ?? []) {
        const reportUrl = new URL(request.url)
        reportUrl.pathname = `/projects/${projectId}/exports/daily-report`
        reportUrl.search = `?id=${report.id}`
        const response = await GET(new NextRequest(reportUrl), { params: Promise.resolve({ id: projectId, kind: "daily-report" }) })
        if (!response.ok) continue
        const source = await PDFDocument.load(await response.arrayBuffer())
        const pages = await merged.copyPages(source, source.getPageIndices())
        pages.forEach((page) => merged.addPage(page))
      }
      return pdfResponse(Buffer.from(await merged.save()), `daily-reports-${from}-${to}.pdf`)
    }

    if (kind === "inspection") {
      if (!entityId) return NextResponse.json({ error: "Inspection id is required" }, { status: 400 })
      const inspection = await getInspection(entityId, orgId)
      if (inspection.project_id !== projectId) return NextResponse.json({ error: "Inspection not found" }, { status: 404 })
      const pdf = await renderInspectionPdf({
        header: {
          ...baseHeader,
          title: inspection.kind === "safety" ? "Safety Inspection" : "Quality Inspection",
          documentNumber: String(inspection.inspection_number),
          date: inspection.inspected_at ? new Date(inspection.inspected_at).toLocaleDateString() : new Date(inspection.created_at).toLocaleDateString(),
        },
        kind: inspection.kind,
        status: inspection.status,
        result: inspection.result,
        inspectorName: inspection.inspector_name,
        inspectedAt: inspection.inspected_at ? new Date(inspection.inspected_at).toLocaleDateString() : null,
        location: inspection.location,
        companyName: inspection.company_name ?? null,
        notes: inspection.notes,
        items: inspection.items.map((item) => ({ section: item.section, prompt: item.prompt, response: item.response, isDeficient: item.is_deficient, note: item.note })),
      })
      return pdfResponse(pdf, `inspection-${inspection.inspection_number}.pdf`)
    }

    if (kind === "incident") {
      if (!entityId) return NextResponse.json({ error: "Incident id is required" }, { status: 400 })
      const incidents = await listSafetyIncidents(projectId, orgId)
      const incident = incidents.find((item) => item.id === entityId)
      if (!incident) return NextResponse.json({ error: "Incident not found" }, { status: 404 })
      const pdf = await renderIncidentPdf({
        header: {
          ...baseHeader,
          title: "Incident Report",
          documentNumber: String(incident.incident_number),
          date: new Date(incident.occurred_at).toLocaleDateString(),
        },
        occurredAt: new Date(incident.occurred_at).toLocaleString(),
        severity: incident.severity,
        classification: incident.classification,
        status: incident.status,
        location: incident.location,
        involvedCompanyName: incident.involved_company_name ?? null,
        involvedPersonName: incident.involved_person_name,
        witnessNames: incident.witness_names,
        isOshaRecordable: incident.is_osha_recordable,
        description: incident.description,
        immediateAction: incident.immediate_action,
        rootCause: incident.root_cause,
      })
      return pdfResponse(pdf, `incident-${incident.incident_number}.pdf`)
    }

    if (kind === "punch-list") {
      const items = await listPunchItems(orgId, projectId)
      const status = request.nextUrl.searchParams.get("status")
      const companyId = request.nextUrl.searchParams.get("company")
      // Per-company packet defaults to open work — that's the list a super hands the sub.
      const filtered = items
        .filter((item) => (status ? item.status === status : !companyId || item.status !== "closed"))
        .filter((item) => !companyId || item.assigned_company_id === companyId)
      const companyName = companyId ? filtered[0]?.assigned_company_name ?? null : null
      const pdf = await renderPunchListPdf({
        header: { ...baseHeader, title: companyName ? `Punch List — ${companyName}` : "Punch List", date: new Date().toLocaleDateString() },
        items: filtered.map((item, index) => ({ number: index + 1, title: item.title, description: item.description, location: item.location, status: item.status, company: item.assigned_company_name, dueDate: item.due_date })),
      })
      return pdfResponse(pdf, companyName ? `punch-list-${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf` : "punch-list.pdf")
    }

    return NextResponse.json({ error: "Unknown export type" }, { status: 404 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate PDF"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

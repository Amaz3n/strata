import { NextRequest, NextResponse } from "next/server"
import { format } from "date-fns"

import { listScheduleItemsByProject } from "@/lib/services/schedule"
import { renderScheduleGanttPdf, type ScheduleItemData } from "@/lib/pdfs/schedule-gantt"
import { renderScheduleGanttVisualPdf } from "@/lib/pdfs/schedule-gantt-visual"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"
import { requireOrgContext } from "@/lib/services/context"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const outputFormat = request.nextUrl.searchParams.get("format") ?? "json"

  try {
    const { supabase } = await requireOrgContext()

    // Fetch schedule items
    const items = await listScheduleItemsByProject(projectId)

    // Fetch project info
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, name, org_id, orgs(name)")
      .eq("id", projectId)
      .single()

    if (projectError || !project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const orgsData = project.orgs as unknown as { name: string } | null
    const orgName = orgsData?.name

    // Calculate date range from items
    let minDate: Date | null = null
    let maxDate: Date | null = null
    for (const item of items) {
      if (item.start_date) {
        const start = new Date(item.start_date)
        if (!minDate || start < minDate) minDate = start
      }
      if (item.end_date) {
        const end = new Date(item.end_date)
        if (!maxDate || end > maxDate) maxDate = end
      }
    }

    // Map items to PDF format
    const pdfItems: ScheduleItemData[] = items.map((item) => ({
      id: item.id,
      name: item.name,
      item_type: item.item_type,
      status: item.status,
      start_date: item.start_date ?? null,
      end_date: item.end_date ?? null,
      progress: item.progress ?? 0,
      is_critical_path: item.is_critical_path ?? false,
      phase: item.phase ?? null,
      trade: item.trade ?? null,
    }))

    const pdfData = {
      projectName: project.name,
      orgName: orgName || undefined,
      items: pdfItems,
      generatedAt: format(new Date(), "MMMM d, yyyy 'at' h:mm a"),
      dateRange: minDate && maxDate
        ? { start: minDate.toISOString(), end: maxDate.toISOString() }
        : undefined,
    }

    // Handle PDF table export
    if (outputFormat === "pdf") {
      const pdfBuffer = await renderScheduleGanttPdf(pdfData)
      const filename = `schedule-table-${project.name.toLowerCase().replace(/\s+/g, "-")}-${format(new Date(), "yyyy-MM-dd")}.pdf`

      return new NextResponse(new Uint8Array(pdfBuffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      })
    }

    // Handle visual Gantt PDF export
    if (outputFormat === "gantt-pdf") {
      const pdfBuffer = await renderScheduleGanttVisualPdf(pdfData)
      const filename = `schedule-gantt-${project.name.toLowerCase().replace(/\s+/g, "-")}-${format(new Date(), "yyyy-MM-dd")}.pdf`

      return new NextResponse(new Uint8Array(pdfBuffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      })
    }

    // Handle CSV export
    if (outputFormat === "csv") {
      type ScheduleItemForCsv = typeof items[number]
      const columns: CsvColumn<ScheduleItemForCsv>[] = [
        { key: "id", header: "id" },
        { key: "name", header: "name" },
        { key: "item_type", header: "type" },
        { key: "status", header: "status" },
        { key: "phase", header: "phase" },
        { key: "trade", header: "trade" },
        { key: "start_date", header: "start_date" },
        { key: "end_date", header: "end_date" },
        { key: "progress", header: "progress" },
        { key: "is_critical_path", header: "critical_path" },
        { key: "location", header: "location" },
      ]

      const csv = toCsv(items, columns)
      const filename = `schedule-${project.name.toLowerCase().replace(/\s+/g, "-")}-${format(new Date(), "yyyy-MM-dd")}.csv`

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      })
    }

    // Default: JSON response
    return NextResponse.json({
      project_id: projectId,
      project_name: project.name,
      generated_at: new Date().toISOString(),
      date_range: minDate && maxDate
        ? { start: minDate.toISOString(), end: maxDate.toISOString() }
        : null,
      total_items: items.length,
      items,
    })
  } catch (error: unknown) {
    console.error("Schedule report error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate schedule report" },
      { status: 500 },
    )
  }
}

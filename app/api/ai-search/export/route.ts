import { PDFDocument, StandardFonts } from "pdf-lib"
import { NextRequest, NextResponse } from "next/server"
import { Buffer } from "node:buffer"

import { getAiSearchArtifactDataset } from "@/lib/services/ai-search"
import { requireOrgContext } from "@/lib/services/context"

export const runtime = "nodejs"

type ExportFormat = "csv" | "pdf"

function toSafeFilenamePart(input: string) {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized.length > 0 ? normalized.slice(0, 80) : "ai-export"
}

function toCsvCell(value: unknown) {
  if (value === null || value === undefined) return ""
  const raw = String(value)
  if (raw.includes('"') || raw.includes(",") || raw.includes("\n") || raw.includes("\r")) {
    return `"${raw.replaceAll('"', '""')}"`
  }
  return raw
}

function buildCsv(columns: string[], rows: Array<Array<string | number | null>>) {
  const header = columns.map(toCsvCell).join(",")
  const body = rows.map((row) => columns.map((_, index) => toCsvCell(row[index])).join(","))
  return [header, ...body].join("\n")
}

function wrapLine(input: string, maxChars: number) {
  if (input.length <= maxChars) return [input]

  const wrapped: string[] = []
  let remaining = input

  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars)
    const breakAt = candidate.lastIndexOf(" ")
    const splitIndex = breakAt > 32 ? breakAt : maxChars
    wrapped.push(remaining.slice(0, splitIndex).trimEnd())
    remaining = remaining.slice(splitIndex).trimStart()
  }

  if (remaining.length > 0) wrapped.push(remaining)
  return wrapped
}

async function buildPdf({
  title,
  columns,
  rows,
  createdAt,
}: {
  title: string
  columns: string[]
  rows: Array<Array<string | number | null>>
  createdAt: string
}) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Courier)
  const pageWidth = 792
  const pageHeight = 612
  const margin = 40
  const fontSize = 10
  const lineHeight = 13
  const maxChars = 118

  let page = pdf.addPage([pageWidth, pageHeight])
  let cursorY = pageHeight - margin

  const pushLine = (line: string) => {
    if (cursorY < margin) {
      page = pdf.addPage([pageWidth, pageHeight])
      cursorY = pageHeight - margin
    }

    page.drawText(line, {
      x: margin,
      y: cursorY,
      font,
      size: fontSize,
    })
    cursorY -= lineHeight
  }

  const lines: string[] = []
  lines.push(`AI Export: ${title}`)
  lines.push(`Generated: ${new Date(createdAt).toISOString()}`)
  lines.push(`Rows: ${rows.length}`)
  lines.push("")
  lines.push(columns.join(" | "))
  lines.push("-".repeat(Math.min(maxChars, Math.max(24, columns.join(" | ").length))))

  for (const row of rows) {
    const serialized = columns.map((_, index) => String(row[index] ?? "")).join(" | ")
    lines.push(serialized)
  }

  for (const line of lines) {
    for (const wrapped of wrapLine(line, maxChars)) {
      pushLine(wrapped)
    }
  }

  return pdf.save()
}

export async function GET(request: NextRequest) {
  const formatParam = request.nextUrl.searchParams.get("format")
  const datasetId = request.nextUrl.searchParams.get("datasetId")?.trim()
  return handleExport({
    datasetId,
    format: formatParam === "pdf" ? "pdf" : "csv",
  })
}

async function handleExport({
  datasetId,
  format,
}: {
  datasetId?: string
  format: ExportFormat
}) {
  if (!datasetId) {
    return NextResponse.json({ error: "datasetId is required." }, { status: 400 })
  }

  try {
    const context = await requireOrgContext()
    const dataset = await getAiSearchArtifactDataset(datasetId, context.orgId)
    if (!dataset) {
      return NextResponse.json({ error: "Export not found or expired." }, { status: 404 })
    }

    const fileBase = `${toSafeFilenamePart(dataset.title)}-${dataset.id.slice(0, 8)}`
    if (format === "pdf") {
      const pdf = await buildPdf({
        title: dataset.title,
        columns: dataset.columns,
        rows: dataset.rows,
        createdAt: dataset.createdAt,
      })
      return new NextResponse(Buffer.from(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileBase}.pdf"`,
          "Cache-Control": "no-store",
        },
      })
    }

    const csv = buildCsv(dataset.columns, dataset.rows)
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileBase}.csv"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unable to export AI dataset." },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    datasetId?: unknown
    format?: unknown
  }

  const datasetId = typeof body.datasetId === "string" ? body.datasetId.trim() : undefined
  const format: ExportFormat = body.format === "pdf" ? "pdf" : "csv"
  return handleExport({ datasetId, format })
}

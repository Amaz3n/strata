import "server-only"

/**
 * As-built PDF export: extracts the original PDF page(s) behind sheet
 * versions and flattens the on-screen markups (shared + the caller's own
 * private ones) into the page so the result matches what the viewer shows.
 *
 * Markup geometry mirrors components/drawings/viewer/svg-overlay.tsx exactly:
 * points are normalized (0..1, y down) against the rendered image, stroke
 * widths and font sizes are in rendered-image pixels.
 */

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage"
import type { MarkupData } from "@/lib/validation/drawings"
import { formatFeetInches } from "@/lib/validation/drawings"

const SET_EXPORT_MAX_SHEETS = 500
// Fallback when a version predates image dimension tracking (96 DPI era).
const FALLBACK_RENDER_DPI = 96

interface ExportVersionRow {
  id: string
  drawing_sheet_id: string
  file_id: string
  page_index: number
  image_width: number | null
  calibration: { feet_per_image_px?: number } | null
}

function normalizeCalibration(value: unknown): ExportVersionRow["calibration"] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as { feet_per_image_px?: number }
  }
  return null
}

interface ExportSheetRow {
  id: string
  sheet_number: string
  sheet_title: string
  discipline: string
  current_revision_id: string | null
}

export async function exportSheetPdf(
  input: { sheetId: string; versionId?: string; includeMarkups?: boolean },
  orgId?: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

  const { data: sheet, error: sheetError } = await supabase
    .from("drawing_sheets")
    .select("id, sheet_number, sheet_title, discipline, current_revision_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", input.sheetId)
    .maybeSingle()
  if (sheetError || !sheet) {
    throw new Error("Sheet not found")
  }

  const version = await resolveExportVersion(resolvedOrgId, sheet, input.versionId)
  if (!version) {
    throw new Error("Sheet has no published version to export")
  }

  const outDoc = await PDFDocument.create()
  const font = await outDoc.embedFont(StandardFonts.Helvetica)
  const sourceCache = new Map<string, PDFDocument>()

  await appendSheetPage(outDoc, font, {
    orgId: resolvedOrgId,
    userId,
    version,
    includeMarkups: input.includeMarkups ?? true,
    sourceCache,
  })

  const bytes = await outDoc.save()
  const safeName = `${sheet.sheet_number} ${sheet.sheet_title}`.replace(/[^\w .-]+/g, "").trim()
  return { bytes, fileName: `${safeName || "sheet"}.pdf` }
}

export async function exportProjectSetPdf(
  input: { projectId: string; discipline?: string; includeMarkups?: boolean },
  orgId?: string,
): Promise<{ bytes: Uint8Array; fileName: string; sheetCount: number }> {
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", resolvedOrgId)
    .eq("id", input.projectId)
    .maybeSingle()
  if (projectError || !project) {
    throw new Error("Project not found")
  }

  let sheetsQuery = supabase
    .from("drawing_sheets")
    .select("id, sheet_number, sheet_title, discipline, current_revision_id")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", input.projectId)
    .not("current_revision_id", "is", null)
    .order("discipline")
    .order("sheet_number")
    .limit(SET_EXPORT_MAX_SHEETS)
  if (input.discipline) {
    sheetsQuery = sheetsQuery.eq("discipline", input.discipline)
  }
  const { data: sheets, error: sheetsError } = await sheetsQuery
  if (sheetsError) {
    throw new Error(`Failed to load sheets: ${sheetsError.message}`)
  }
  if (!sheets || sheets.length === 0) {
    throw new Error("No published sheets to export")
  }

  // One query for every sheet's current version, keyed back to register order.
  const service = createServiceSupabaseClient()
  const { data: versionRows, error: versionsError } = await service
    .from("drawing_sheet_versions")
    .select("id, drawing_sheet_id, drawing_revision_id, file_id, page_index, image_width, calibration:extracted_metadata->calibration")
    .eq("org_id", resolvedOrgId)
    .in("drawing_sheet_id", sheets.map((s) => s.id))
  if (versionsError) {
    throw new Error(`Failed to load versions: ${versionsError.message}`)
  }
  const currentVersionBySheet = new Map<string, ExportVersionRow>()
  for (const row of versionRows ?? []) {
    const owner = sheets.find((s) => s.id === row.drawing_sheet_id)
    if (owner?.current_revision_id && row.drawing_revision_id === owner.current_revision_id) {
      currentVersionBySheet.set(row.drawing_sheet_id, {
        ...row,
        calibration: normalizeCalibration(row.calibration),
      })
    }
  }

  const outDoc = await PDFDocument.create()
  const font = await outDoc.embedFont(StandardFonts.Helvetica)
  const sourceCache = new Map<string, PDFDocument>()
  let sheetCount = 0

  for (const sheet of sheets) {
    const version = currentVersionBySheet.get(sheet.id)
    if (!version) continue
    await appendSheetPage(outDoc, font, {
      orgId: resolvedOrgId,
      userId,
      version,
      includeMarkups: input.includeMarkups ?? true,
      sourceCache,
    })
    sheetCount += 1
  }

  if (sheetCount === 0) {
    throw new Error("No published sheets to export")
  }

  const bytes = await outDoc.save()
  const safeName = `${project.name} drawings`.replace(/[^\w .-]+/g, "").trim()
  return { bytes, fileName: `${safeName || "drawings"}.pdf`, sheetCount }
}

async function resolveExportVersion(
  orgId: string,
  sheet: ExportSheetRow,
  versionId?: string,
): Promise<ExportVersionRow | null> {
  const service = createServiceSupabaseClient()
  let query = service
    .from("drawing_sheet_versions")
    .select("id, drawing_sheet_id, file_id, page_index, image_width, calibration:extracted_metadata->calibration")
    .eq("org_id", orgId)
    .eq("drawing_sheet_id", sheet.id)
  if (versionId) {
    query = query.eq("id", versionId)
  } else if (sheet.current_revision_id) {
    query = query.eq("drawing_revision_id", sheet.current_revision_id)
  } else {
    return null
  }
  const { data } = await query.maybeSingle()
  if (!data) return null
  return { ...data, calibration: normalizeCalibration(data.calibration) }
}

async function appendSheetPage(
  outDoc: PDFDocument,
  font: PDFFont,
  input: {
    orgId: string
    userId: string
    version: ExportVersionRow
    includeMarkups: boolean
    sourceCache: Map<string, PDFDocument>
  },
) {
  const { orgId, userId, version, includeMarkups, sourceCache } = input
  const service = createServiceSupabaseClient()

  let sourceDoc = sourceCache.get(version.file_id)
  if (!sourceDoc) {
    const { data: file, error: fileError } = await service
      .from("files")
      .select("storage_path")
      .eq("org_id", orgId)
      .eq("id", version.file_id)
      .maybeSingle()
    if (fileError || !file?.storage_path) {
      throw new Error("Source PDF not found for sheet version")
    }
    const pdfBytes = await downloadDrawingPdfObject({
      supabase: service,
      orgId,
      path: file.storage_path,
    })
    sourceDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true })
    sourceCache.set(version.file_id, sourceDoc)
  }

  const pageIndex = Math.min(Math.max(0, version.page_index), sourceDoc.getPageCount() - 1)
  const [page] = await outDoc.copyPages(sourceDoc, [pageIndex])
  outDoc.addPage(page)

  if (!includeMarkups) return

  const { data: markups } = await service
    .from("drawing_markups")
    .select("data, is_private, created_by")
    .eq("org_id", orgId)
    .eq("sheet_version_id", version.id)
    .limit(500)

  const visible = (markups ?? []).filter(
    (m) => !m.is_private || m.created_by === userId,
  )
  if (visible.length === 0) return

  const feetPerImagePx =
    typeof version.calibration?.feet_per_image_px === "number" &&
    version.calibration.feet_per_image_px > 0
      ? version.calibration.feet_per_image_px
      : null
  drawMarkupsOnPage(
    page,
    font,
    visible.map((m) => m.data as MarkupData),
    version.image_width,
    feetPerImagePx,
  )
}

// ---------------------------------------------------------------------------
// Geometry: normalized viewer coordinates -> PDF page coordinates
// ---------------------------------------------------------------------------

interface PageMap {
  toPage: (u: number, vDown: number) => { x: number; y: number }
  /** points per rendered-image pixel, for stroke widths and font sizes */
  scale: number
  /** counterclockwise degrees that make text upright under the page's /Rotate */
  textRotation: number
}

function buildPageMap(page: PDFPage, imageWidth: number | null): PageMap {
  const W = page.getWidth()
  const H = page.getHeight()
  const rotation = ((page.getRotation().angle % 360) + 360) % 360

  const displayedWidth = rotation % 180 === 0 ? W : H
  const imagePxWidth =
    imageWidth && imageWidth > 0 ? imageWidth : (displayedWidth / 72) * FALLBACK_RENDER_DPI
  const scale = displayedWidth / imagePxWidth

  let toPage: PageMap["toPage"]
  switch (rotation) {
    case 90:
      toPage = (u, vDown) => ({ x: vDown * W, y: u * H })
      break
    case 180:
      toPage = (u, vDown) => ({ x: (1 - u) * W, y: vDown * H })
      break
    case 270:
      toPage = (u, vDown) => ({ x: (1 - vDown) * W, y: (1 - u) * H })
      break
    default:
      toPage = (u, vDown) => ({ x: u * W, y: (1 - vDown) * H })
  }

  return { toPage, scale, textRotation: rotation }
}

function hexToRgb(hex: string | undefined) {
  const match = typeof hex === "string" ? hex.match(/^#([0-9a-f]{6})$/i) : null
  if (!match) return rgb(0.94, 0.27, 0.27) // viewer fallback #EF4444
  const value = Number.parseInt(match[1], 16)
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255)
}

function drawMarkupsOnPage(
  page: PDFPage,
  font: PDFFont,
  markups: MarkupData[],
  imageWidth: number | null,
  feetPerImagePx: number | null,
) {
  const map = buildPageMap(page, imageWidth)

  for (const data of markups) {
    if (!data || !Array.isArray(data.points)) continue
    const pts = data.points.map(([u, v]) => map.toPage(u, v))
    const color = hexToRgb(data.color)
    const strokeWidth = (typeof data.strokeWidth === "number" ? data.strokeWidth : 2) * map.scale

    switch (data.type) {
      case "arrow": {
        if (pts.length < 2) break
        page.drawLine({ start: pts[0], end: pts[1], thickness: strokeWidth, color })
        drawArrowHead(page, pts[0], pts[1], strokeWidth, color)
        break
      }
      case "circle": {
        if (pts.length < 2) break
        const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
        page.drawEllipse({
          x: pts[0].x,
          y: pts[0].y,
          xScale: r,
          yScale: r,
          borderWidth: strokeWidth,
          borderColor: color,
          opacity: 0,
        })
        break
      }
      case "rectangle":
      case "cloud": {
        if (pts.length < 2) break
        page.drawRectangle({
          x: Math.min(pts[0].x, pts[1].x),
          y: Math.min(pts[0].y, pts[1].y),
          width: Math.abs(pts[1].x - pts[0].x),
          height: Math.abs(pts[1].y - pts[0].y),
          borderWidth: strokeWidth,
          borderColor: color,
          opacity: 0,
          ...(data.type === "cloud"
            ? { borderDashArray: [6 * map.scale, 4 * map.scale] }
            : {}),
        })
        break
      }
      case "highlight": {
        if (pts.length < 2) break
        page.drawRectangle({
          x: Math.min(pts[0].x, pts[1].x),
          y: Math.min(pts[0].y, pts[1].y),
          width: Math.abs(pts[1].x - pts[0].x),
          height: Math.abs(pts[1].y - pts[0].y),
          color,
          opacity: 0.25,
        })
        break
      }
      case "freehand": {
        if (pts.length < 2) break
        for (let i = 1; i < pts.length; i++) {
          page.drawLine({
            start: pts[i - 1],
            end: pts[i],
            thickness: strokeWidth,
            color,
            lineCap: 1,
          })
        }
        break
      }
      case "text":
      case "callout": {
        if (pts.length < 1 || !data.text) break
        page.drawText(data.text, {
          x: pts[0].x,
          y: pts[0].y,
          size: 14 * map.scale,
          font,
          color,
          rotate: degrees(map.textRotation),
        })
        break
      }
      case "dimension": {
        if (pts.length < 2) break
        page.drawLine({ start: pts[0], end: pts[1], thickness: strokeWidth, color })
        // Same label the viewer renders: calibrated feet-inches when the
        // version carries a scale, raw rendered-image pixels otherwise.
        const distImagePx = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / map.scale
        const dimensionLabel = feetPerImagePx
          ? formatFeetInches(distImagePx * feetPerImagePx)
          : `${Math.round(distImagePx)}px`
        page.drawText(data.text || dimensionLabel, {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2 + 6 * map.scale,
          size: 12 * map.scale,
          font,
          color,
          rotate: degrees(map.textRotation),
        })
        break
      }
      default:
        break
    }
  }
}

function drawArrowHead(
  page: PDFPage,
  from: { x: number; y: number },
  to: { x: number; y: number },
  strokeWidth: number,
  color: ReturnType<typeof rgb>,
) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const size = Math.max(strokeWidth * 4, strokeWidth + 6)
  const spread = Math.PI / 7
  for (const side of [-1, 1]) {
    page.drawLine({
      start: to,
      end: {
        x: to.x - size * Math.cos(angle + side * spread),
        y: to.y - size * Math.sin(angle + side * spread),
      },
      thickness: strokeWidth,
      color,
    })
  }
}

import { NextRequest, NextResponse } from "next/server"

import { assertPortalActionAccess, recordPortalAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { buildDrawingsImageUrl, buildDrawingsTilesBaseUrl } from "@/lib/storage/drawings-urls"

export const runtime = "nodejs"

interface PortalDrawingMarkup {
  id: string
  org_id: string
  drawing_sheet_id: string
  sheet_version_id?: string
  data: Record<string, unknown>
  label?: string
  is_private: boolean
  share_with_clients: boolean
  share_with_subs: boolean
  created_at: string
  updated_at: string
}

interface PortalDrawingPin {
  id: string
  org_id: string
  project_id: string
  drawing_sheet_id: string
  sheet_version_id?: string
  x_position: number
  y_position: number
  entity_type: string
  entity_id: string
  label?: string
  style: Record<string, unknown>
  status?: string
  share_with_clients: boolean
  share_with_subs: boolean
  created_at: string
  updated_at: string
}

interface PortalDrawingSheet {
  id: string
  sheet_number: string
  sheet_title: string | null
  discipline: string | null
  revision_label: string | null
  tile_base_url: string | null
  tile_manifest: Record<string, unknown> | null
  thumbnail_url: string | null
  image_full_url: string | null
  image_width: number | null
  image_height: number | null
  pdf_url: string
  markups: PortalDrawingMarkup[]
  pins: PortalDrawingPin[]
}

interface PortalDrawingsResponse {
  sheets: PortalDrawingSheet[]
}

/**
 * Shared drawing sheets for a portal token, with the current version's tile
 * source and the markups/pins shared to that portal audience. Sheets, markups,
 * and pins all respect their share_with_clients/share_with_subs flags;
 * private markups never leave the server.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params

  let access
  try {
    access = await assertPortalActionAccess(token, { permission: "can_view_documents" })
  } catch {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 401 })
  }

  // Viewing shared drawings is a portal access — bumps last_accessed_at, which
  // revision-distribution emails read as their delivery receipt.
  try {
    await recordPortalAccess(access.id)
  } catch {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 401 })
  }

  const shareColumn =
    access.portal_type === "sub" ? "share_with_subs" : "share_with_clients"

  const supabase = createServiceSupabaseClient()
  const { data: sheetRows, error: sheetsError } = await supabase
    .from("drawing_sheets")
    .select("id, sheet_number, sheet_title, discipline, sort_order, current_revision_id")
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .eq(shareColumn, true)
    .not("current_revision_id", "is", null)
    .order("sheet_number", { ascending: true })
    .limit(500)

  if (sheetsError) {
    console.error("[portal drawings] Failed to load shared sheets:", sheetsError)
    return NextResponse.json({ error: "Failed to load drawings" }, { status: 500 })
  }

  const sheets = sheetRows ?? []
  if (sheets.length === 0) {
    return NextResponse.json(
      { sheets: [] } satisfies PortalDrawingsResponse,
      { headers: { "cache-control": "no-store" } },
    )
  }

  const sheetIds = sheets.map((s) => s.id)
  const currentRevisionBySheet = new Map<string, string>(
    sheets.map((s) => [s.id as string, s.current_revision_id as string]),
  )

  const [versionsResult, markupsResult, pinsResult] = await Promise.all([
    supabase
      .from("drawing_sheet_versions")
      .select(`
        id, drawing_sheet_id, drawing_revision_id, created_at,
        tile_manifest, tile_base_url, tiles_base_path,
        thumb_path, full_path, thumbnail_url, full_url,
        image_width, image_height,
        drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey(revision_label)
      `)
      .eq("org_id", access.org_id)
      .in("drawing_sheet_id", sheetIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("drawing_markups")
      .select(
        "id, org_id, drawing_sheet_id, sheet_version_id, data, label, created_at, updated_at",
      )
      .eq("org_id", access.org_id)
      .in("drawing_sheet_id", sheetIds)
      .eq("is_private", false)
      .eq(shareColumn, true)
      .limit(2000),
    supabase
      .from("drawing_pins")
      .select(
        "id, org_id, project_id, drawing_sheet_id, sheet_version_id, x_position, y_position, entity_type, entity_id, label, style, status, created_at, updated_at",
      )
      .eq("org_id", access.org_id)
      .eq("project_id", access.project_id)
      .in("drawing_sheet_id", sheetIds)
      .eq(shareColumn, true)
      .limit(2000),
  ])

  if (versionsResult.error) {
    console.error("[portal drawings] Failed to load sheet versions:", versionsResult.error)
    return NextResponse.json({ error: "Failed to load drawings" }, { status: 500 })
  }
  if (markupsResult.error) {
    console.error("[portal drawings] Failed to load shared markups:", markupsResult.error)
  }
  if (pinsResult.error) {
    console.error("[portal drawings] Failed to load shared pins:", pinsResult.error)
  }

  // Pick each sheet's version belonging to its CURRENT revision (never a
  // draft/processing revision's newer row).
  const versionBySheet = new Map<string, any>()
  for (const version of versionsResult.data ?? []) {
    const sheetId = version.drawing_sheet_id as string
    if (versionBySheet.has(sheetId)) continue
    if (version.drawing_revision_id === currentRevisionBySheet.get(sheetId)) {
      versionBySheet.set(sheetId, version)
    }
  }

  const currentVersionIds = new Set(
    Array.from(versionBySheet.values()).map((v) => v.id as string),
  )

  const mapMarkup = (row: any): PortalDrawingMarkup => ({
    id: row.id,
    org_id: row.org_id,
    drawing_sheet_id: row.drawing_sheet_id,
    sheet_version_id: row.sheet_version_id ?? undefined,
    data: row.data ?? {},
    label: row.label ?? undefined,
    is_private: false,
    share_with_clients: shareColumn === "share_with_clients",
    share_with_subs: shareColumn === "share_with_subs",
    created_at: row.created_at,
    updated_at: row.updated_at,
  })

  const mapPin = (row: any): PortalDrawingPin => ({
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    drawing_sheet_id: row.drawing_sheet_id,
    sheet_version_id: row.sheet_version_id ?? undefined,
    x_position: parseFloat(row.x_position),
    y_position: parseFloat(row.y_position),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    label: row.label ?? undefined,
    style: row.style ?? {},
    status: row.status ?? undefined,
    share_with_clients: shareColumn === "share_with_clients",
    share_with_subs: shareColumn === "share_with_subs",
    created_at: row.created_at,
    updated_at: row.updated_at,
  })

  // Only annotations pinned to the sheet's current version (or version-less
  // sheet-level ones) are relevant to what the portal renders.
  const isCurrent = (row: any) =>
    !row.sheet_version_id || currentVersionIds.has(row.sheet_version_id)

  const markupsBySheet = new Map<string, PortalDrawingMarkup[]>()
  for (const row of markupsResult.data ?? []) {
    if (!isCurrent(row)) continue
    const list = markupsBySheet.get(row.drawing_sheet_id) ?? []
    list.push(mapMarkup(row))
    markupsBySheet.set(row.drawing_sheet_id, list)
  }

  const pinsBySheet = new Map<string, PortalDrawingPin[]>()
  for (const row of pinsResult.data ?? []) {
    if (!isCurrent(row)) continue
    const list = pinsBySheet.get(row.drawing_sheet_id) ?? []
    list.push(mapPin(row))
    pinsBySheet.set(row.drawing_sheet_id, list)
  }

  const responseSheets: PortalDrawingSheet[] = sheets.map((sheet: any) => {
    const version = versionBySheet.get(sheet.id)
    const manifest = (version?.tile_manifest as Record<string, any> | null) ?? null
    const tileBaseUrl =
      (version?.tile_base_url as string | null) ??
      (version?.tiles_base_path ? buildDrawingsTilesBaseUrl(version.tiles_base_path) : null)

    return {
      id: sheet.id,
      sheet_number: sheet.sheet_number,
      sheet_title: sheet.sheet_title ?? null,
      discipline: sheet.discipline ?? null,
      revision_label: (version?.drawing_revisions as any)?.revision_label ?? null,
      tile_base_url: tileBaseUrl,
      tile_manifest: manifest,
      thumbnail_url:
        buildDrawingsImageUrl(version?.thumb_path) ?? version?.thumbnail_url ?? null,
      image_full_url:
        buildDrawingsImageUrl(version?.full_path) ?? version?.full_url ?? null,
      image_width: version?.image_width ?? manifest?.Image?.Size?.Width ?? null,
      image_height: version?.image_height ?? manifest?.Image?.Size?.Height ?? null,
      pdf_url: `/api/portal/drawings/${token}/${sheet.id}`,
      markups: markupsBySheet.get(sheet.id) ?? [],
      pins: pinsBySheet.get(sheet.id) ?? [],
    }
  })

  return NextResponse.json(
    { sheets: responseSheets } satisfies PortalDrawingsResponse,
    { headers: { "cache-control": "no-store" } },
  )
}

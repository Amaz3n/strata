"use server"

import { requireOrgContext } from "@/lib/services/context"
import { revalidatePath } from "next/cache"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

/**
 * Update a sheet version with generated image URLs
 */
export async function updateSheetVersionImages(
  sheetVersionId: string,
  images: {
    thumbnailPath: string
    mediumPath: string
    fullPath: string
    width: number
    height: number
    tileManifestPath?: string | null
    tilesBasePath?: string | null
  }
) {
  const { supabase, orgId } = await requireOrgContext()

  const toPublicUrl = (path: string | null | undefined) => {
    if (!path || !SUPABASE_URL) return null
    const normalized = path.startsWith("/") ? path.slice(1) : path
    return `${SUPABASE_URL}/storage/v1/object/public/drawings-images/${encodeURI(normalized)}`
  }

  const { error } = await supabase
    .from("drawing_sheet_versions")
    .update({
      thumb_path: images.thumbnailPath,
      medium_path: images.mediumPath,
      full_path: images.fullPath,
      tile_manifest_path: images.tileManifestPath ?? null,
      tiles_base_path: images.tilesBasePath ?? null,
      // Populate legacy URL columns for backward compatibility.
      thumbnail_url: toPublicUrl(images.thumbnailPath),
      medium_url: toPublicUrl(images.mediumPath),
      full_url: toPublicUrl(images.fullPath),
      image_width: images.width,
      image_height: images.height,
      images_generated_at: new Date().toISOString(),
    })
    .eq("id", sheetVersionId)
    .eq("org_id", orgId)

  if (error) {
    throw new Error(`Failed to update sheet version: ${error.message}`)
  }

  revalidatePath("/drawings")
}

/**
 * Get sheet versions for a drawing set (for image generation)
 */
export async function getSheetVersionsForImageGeneration(drawingSetId: string) {
  const { supabase, orgId } = await requireOrgContext()

  // Note: Image columns were added in a migration, so they should exist
  // If they don't exist, the update operation will fail gracefully

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select(`
      id,
      page_index,
      drawing_sheet_id,
      thumb_path,
      drawing_sheets!inner(
        drawing_set_id,
        org_id
      )
    `)
    .eq("drawing_sheets.drawing_set_id", drawingSetId)
    .eq("drawing_sheets.org_id", orgId)
    .is("thumb_path", null)
    .order("page_index")

  if (error) {
    throw new Error(`Failed to fetch sheet versions: ${error.message}`)
  }

  return data.map((v) => ({
    id: v.id,
    pageIndex: v.page_index ?? 0,
  }))
}

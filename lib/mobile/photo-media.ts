import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { ProjectPhoto } from "@/lib/services/photos"
import { createFilesDownloadUrl } from "@/lib/storage/files-storage"

export function photoThumbnailPath(metadata: unknown): string | null {
  const preview = (metadata as { preview?: { sizes?: unknown[]; thumbnail_path?: string } } | null)?.preview
  const sizes = (Array.isArray(preview?.sizes) ? preview.sizes : []).filter((value): value is { path: string; width: number; content_type?: string } => {
    if (!value || typeof value !== "object") return false
    const candidate = value as Record<string, unknown>
    return typeof candidate.path === "string" && candidate.path.length > 0 && typeof candidate.width === "number" && Number.isFinite(candidate.width) && candidate.width > 0
  })
  const webp = sizes.filter(size => size.content_type === "image/webp")
  const choices = (webp.length ? webp : sizes).sort((a, b) => a.width - b.width)
  return (choices.find(size => size.width >= 480) ?? choices.at(-1))?.path ?? (typeof preview?.thumbnail_path === "string" ? preview.thumbnail_path : null)
}

/** Browser file routes use cookies. Native clients need org-scoped, expiring media URLs. */
export async function signMobilePhotos(context: MobileOrgContext, photos: ProjectPhoto[]) {
  if (!photos.length) return []
  const { data, error } = await context.serviceSupabase.from("files").select("id,metadata")
    .eq("org_id", context.orgId).in("id", photos.map(photo => photo.id))
  if (error) throw error
  const metadata = new Map((data ?? []).map(row => [row.id, row.metadata]))
  return Promise.all(photos.map(async photo => {
    const sign = async (path: string) => (await createFilesDownloadUrl({ supabase: context.serviceSupabase, orgId: context.orgId, path, fileName: photo.file_name, expiresIn: 3600 })).downloadUrl
    const downloadUrl = await sign(photo.storage_path)
    const thumbnailPath = photoThumbnailPath(metadata.get(photo.id))
    const thumbnailUrl = thumbnailPath ? await sign(thumbnailPath) : downloadUrl
    const { storage_path: _storagePath, ...result } = photo
    return { ...result, download_url: downloadUrl, thumbnail_url: thumbnailUrl }
  }))
}

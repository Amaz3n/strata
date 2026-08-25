import type { FileVersion } from "@/app/(app)/documents/types"

/** The version shape the viewer, properties panel and version dialog render. */
export interface FileVersionInfo {
  id: string
  version_number: number
  label?: string
  notes?: string
  file_name?: string
  mime_type?: string
  size_bytes?: number
  creator_name?: string
  created_at: string
  is_current: boolean
}

export function mapVersion(version: FileVersion): FileVersionInfo {
  return {
    id: version.id,
    version_number: version.version_number,
    label: version.label ?? undefined,
    notes: version.notes ?? undefined,
    file_name: version.file_name ?? undefined,
    mime_type: version.mime_type ?? undefined,
    size_bytes: version.size_bytes ?? undefined,
    creator_name: version.creator_name ?? undefined,
    created_at: version.created_at,
    is_current: version.is_current,
  }
}

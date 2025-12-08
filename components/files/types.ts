// File management types

export type FileCategory =
  | "plans"
  | "contracts"
  | "permits"
  | "submittals"
  | "photos"
  | "rfis"
  | "safety"
  | "financials"
  | "other"

export interface FileWithDetails {
  id: string
  org_id: string
  project_id?: string
  file_name: string
  storage_path: string
  mime_type?: string
  size_bytes?: number
  visibility: string
  category?: FileCategory
  tags?: string[]
  description?: string
  folder_path?: string
  uploaded_by?: string
  uploader_name?: string
  uploader_avatar?: string
  created_at: string
  updated_at?: string
  thumbnail_url?: string
  download_url?: string
  version_number?: number
  has_versions?: boolean
}

export interface FileVersion {
  id: string
  file_id: string
  version_number: number
  label?: string
  notes?: string
  created_by?: string
  creator_name?: string
  created_at: string
  storage_path: string
  size_bytes?: number
}

export interface FileFolder {
  id: string
  name: string
  path: string
  category?: FileCategory
  parent_id?: string
  file_count: number
  created_at: string
}

export interface FileUploadProgress {
  id: string
  file: File
  progress: number
  status: "pending" | "uploading" | "processing" | "complete" | "error"
  error?: string
  result?: FileWithDetails
}

export const FILE_CATEGORIES: Record<FileCategory, { label: string; icon: string; color: string }> = {
  plans: {
    label: "Plans & Drawings",
    icon: "📐",
    color: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  },
  contracts: {
    label: "Contracts & Legal",
    icon: "📋",
    color: "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  },
  permits: {
    label: "Permits & Approvals",
    icon: "🏛️",
    color: "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
  },
  submittals: {
    label: "Submittals & Specs",
    icon: "📑",
    color: "bg-purple-500/20 text-purple-600 dark:text-purple-400",
  },
  photos: {
    label: "Photos",
    icon: "📷",
    color: "bg-pink-500/20 text-pink-600 dark:text-pink-400",
  },
  rfis: {
    label: "RFIs & Correspondence",
    icon: "💬",
    color: "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  },
  safety: {
    label: "Safety Documents",
    icon: "⚠️",
    color: "bg-orange-500/20 text-orange-600 dark:text-orange-400",
  },
  financials: {
    label: "Financial Documents",
    icon: "💰",
    color: "bg-green-500/20 text-green-600 dark:text-green-400",
  },
  other: {
    label: "Other",
    icon: "📁",
    color: "bg-gray-500/20 text-gray-600 dark:text-gray-400",
  },
}

export function getMimeIcon(mimeType?: string): string {
  if (!mimeType) return "📄"
  if (mimeType.startsWith("image/")) return "🖼️"
  if (mimeType.includes("pdf")) return "📕"
  if (mimeType.includes("word") || mimeType.includes("document")) return "📘"
  if (mimeType.includes("sheet") || mimeType.includes("excel")) return "📗"
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "📙"
  if (mimeType.includes("zip") || mimeType.includes("archive")) return "📦"
  if (mimeType.includes("video")) return "🎬"
  if (mimeType.includes("audio")) return "🎵"
  if (mimeType.includes("dwg") || mimeType.includes("autocad")) return "📐"
  return "📄"
}

export function formatFileSize(bytes?: number): string {
  if (!bytes) return "—"
  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

export function isImageFile(mimeType?: string): boolean {
  return mimeType?.startsWith("image/") ?? false
}

export function isPdfFile(mimeType?: string): boolean {
  return mimeType?.includes("pdf") ?? false
}

export function isPreviewable(mimeType?: string): boolean {
  return isImageFile(mimeType) || isPdfFile(mimeType)
}







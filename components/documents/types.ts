import type { FileWithUrls, ProjectFolderPermissions } from "@/app/(app)/documents/types"

export type QuickFilter =
  | "all"
  | "plans"
  | "photos"
  | "contracts"
  | "permits"
  | "submittals"
  | "rfis"
  | "safety"
  | "financials"
  | "other"
  | "expiring"
  | "trash"

export interface RefreshFilesOptions {
  includeMetadata?: boolean
  /** Clear every cached folder/filter view — use after a mutation changes server data. */
  invalidateCache?: boolean
}

export interface FolderNode {
  name: string
  path: string
  itemCount: number
  children: FolderNode[]
}

export interface DocumentsContextValue {
  // Project
  projectId: string
  projectName: string

  // Data
  files: FileWithUrls[]
  folders: string[]
  folderItemCounts: Record<string, number>
  folderPermissions: ProjectFolderPermissions[]
  counts: Record<string, number>
  totalCount: number
  hasMore: boolean

  // Filters
  currentPath: string
  /** The committed search query. Live input state belongs to the search box itself. */
  searchQuery: string
  quickFilter: QuickFilter
  sort: "name" | "workflow" | "updated_at" | "created_at" | "size"
  direction: "asc" | "desc"
  /** Set when the file list failed to load; null while healthy. */
  error: string | null

  // Navigation
  setCurrentPath: (path: string) => void
  setQuickFilter: (filter: QuickFilter) => void
  setSearchQuery: (query: string) => void
  setSort: (sort: "name" | "workflow" | "updated_at" | "created_at" | "size") => void
  setDirection: (direction: "asc" | "desc") => void
  toggleSort: (sort: "name" | "workflow" | "updated_at" | "created_at" | "size") => void
  navigateToRoot: () => void
  navigateToFolder: (path: string) => void
  loadFolderChildren: (path?: string) => Promise<void>

  // Actions
  refreshFiles: (options?: RefreshFilesOptions) => Promise<void>
  loadMore: () => Promise<void>
  refreshFolderPermissions: () => Promise<void>

  // Loading states
  isLoading: boolean
  isLoadingMore: boolean

  // Expanded state for sidebar
  expandedFolders: Set<string>
  toggleFolderExpanded: (path: string) => void
}

export interface UnifiedDocumentsLayoutProps {
  project: { id: string; name: string }
  initialFiles: FileWithUrls[]
  initialCounts: Record<string, number>
  initialFolders: string[]
  initialFolderCounts?: Record<string, number>
  initialFolderPermissions?: ProjectFolderPermissions[]
  initialPath?: string
  initialTotalCount?: number
  initialHasMore?: boolean
}

export const QUICK_FILTER_CONFIG: Record<
  QuickFilter,
  { label: string; icon: string }
> = {
  all: { label: "All", icon: "FileText" },
  plans: { label: "Plans", icon: "Map" },
  photos: { label: "Photos", icon: "Image" },
  contracts: { label: "Contracts", icon: "FileSignature" },
  permits: { label: "Permits", icon: "ClipboardCheck" },
  submittals: { label: "Submittals", icon: "FileCheck" },
  rfis: { label: "RFIs", icon: "MessageSquare" },
  safety: { label: "Safety", icon: "ShieldCheck" },
  financials: { label: "Financials", icon: "DollarSign" },
  other: { label: "Other", icon: "File" },
  expiring: { label: "Expiring", icon: "Clock" },
  trash: { label: "Trash", icon: "Trash2" },
}

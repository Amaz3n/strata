import type { FileWithUrls } from "@/app/(app)/files/actions"
import type { DrawingSet, DrawingSheet } from "@/app/(app)/drawings/actions"

export type ViewMode = "grid" | "list"

export type QuickFilter =
  | "all"
  | "drawings"
  | "plans"
  | "photos"
  | "contracts"
  | "permits"
  | "submittals"
  | "rfis"
  | "safety"
  | "financials"
  | "other"

export type DocumentItem =
  | { type: "file"; data: FileWithUrls }
  | { type: "sheet"; data: DrawingSheet; setTitle: string }
  | { type: "folder"; path: string; name: string; itemCount: number }
  | { type: "drawing-set"; data: DrawingSet }

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
  drawingSets: DrawingSet[]
  folders: string[]
  counts: Record<string, number>

  // Filters
  currentPath: string
  quickFilter: QuickFilter
  searchQuery: string
  viewMode: ViewMode

  // Navigation
  setCurrentPath: (path: string) => void
  setQuickFilter: (filter: QuickFilter) => void
  setSearchQuery: (query: string) => void
  setViewMode: (mode: ViewMode) => void
  setSelectedDrawingSet: (id: string | null, title?: string | null) => void
  navigateToRoot: () => void
  navigateToFolder: (path: string) => void
  navigateToDrawingSet: (id: string, title: string) => void

  // Actions
  refreshFiles: () => Promise<void>
  refreshDrawingSets: () => Promise<void>

  // Loading states
  isLoading: boolean
  isUploading: boolean

  // Expanded state for sidebar
  expandedFolders: Set<string>
  toggleFolderExpanded: (path: string) => void
  expandedDrawingSets: Set<string>
  toggleDrawingSetExpanded: (setId: string) => void

  // Drawing set sheets
  sheetsBySetId: Record<string, DrawingSheet[]>
  loadSheetsForSet: (setId: string) => Promise<void>
  selectedDrawingSetId: string | null
  selectedDrawingSetTitle: string | null
}

export interface UnifiedDocumentsLayoutProps {
  project: { id: string; name: string }
  initialFiles: FileWithUrls[]
  initialCounts: Record<string, number>
  initialFolders: string[]
  initialSets: DrawingSet[]
  initialPath?: string
  initialSetId?: string
}

export const QUICK_FILTER_CONFIG: Record<
  QuickFilter,
  { label: string; icon: string }
> = {
  all: { label: "All", icon: "FileText" },
  drawings: { label: "Drawings", icon: "Layers" },
  plans: { label: "Plans", icon: "Map" },
  photos: { label: "Photos", icon: "Image" },
  contracts: { label: "Contracts", icon: "FileSignature" },
  permits: { label: "Permits", icon: "ClipboardCheck" },
  submittals: { label: "Submittals", icon: "FileCheck" },
  rfis: { label: "RFIs", icon: "MessageSquare" },
  safety: { label: "Safety", icon: "ShieldCheck" },
  financials: { label: "Financials", icon: "DollarSign" },
  other: { label: "Other", icon: "File" },
}

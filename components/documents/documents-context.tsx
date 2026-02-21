"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { listFilesAction, getFileCountsAction, listFoldersAction } from "@/app/(app)/files/actions"
import { listDrawingSetsAction, listDrawingSheetsWithUrlsAction } from "@/app/(app)/drawings/actions"
import type { FileWithUrls } from "@/app/(app)/files/actions"
import type { DrawingSet, DrawingSheet } from "@/app/(app)/drawings/actions"
import type { DocumentsContextValue, QuickFilter, ViewMode, FolderNode } from "./types"

const DocumentsContext = createContext<DocumentsContextValue | null>(null)

export function useDocuments() {
  const context = useContext(DocumentsContext)
  if (!context) {
    throw new Error("useDocuments must be used within a DocumentsProvider")
  }
  return context
}

interface DocumentsProviderProps {
  children: ReactNode
  project: { id: string; name: string }
  initialFiles: FileWithUrls[]
  initialCounts: Record<string, number>
  initialFolders: string[]
  initialSets: DrawingSet[]
  initialPath?: string
  initialSetId?: string
}

const EXPANDED_FOLDERS_KEY = "documents-expanded-folders"
const VIEW_MODE_KEY = "documents-view-mode"
const DOCS_DEBUG_FLAG = "__ARC_DOCS_DEBUG__"

function isDocsDebugEnabled(): boolean {
  if (typeof window === "undefined") return false
  return Boolean((window as any)[DOCS_DEBUG_FLAG])
}

function docsDebugLog(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production" && isDocsDebugEnabled()) {
    console.debug("[documents-debug]", ...args)
  }
}

function normalizeDocsPath(value?: string | null): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "")
  return normalized === "/" ? "" : normalized
}

export function DocumentsProvider({
  children,
  project,
  initialFiles,
  initialCounts,
  initialFolders,
  initialSets,
  initialPath = "",
  initialSetId,
}: DocumentsProviderProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const basePath = useMemo(() => {
    const match = pathname.match(/^(\/projects\/[^/]+\/files)/)
    return match?.[1] ?? pathname
  }, [pathname])
  const initialNormalizedPath = useMemo(() => normalizeDocsPath(initialPath), [initialPath])

  // Data state
  const [files, setFiles] = useState<FileWithUrls[]>(initialFiles)
  const [drawingSets, setDrawingSets] = useState<DrawingSet[]>(initialSets)
  const [folders, setFolders] = useState<string[]>(initialFolders)
  const [counts, setCounts] = useState<Record<string, number>>(initialCounts)
  const [sheetsBySetId, setSheetsBySetId] = useState<Record<string, DrawingSheet[]>>({})

  // Filter state
  const [currentPath, setCurrentPathState] = useState<string>(initialNormalizedPath)
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [selectedDrawingSetId, setSelectedDrawingSetId] = useState<string | null>(initialSetId ?? null)
  const [selectedDrawingSetTitle, setSelectedDrawingSetTitle] = useState<string | null>(() => {
    if (initialSetId) {
      const set = initialSets.find((s) => s.id === initialSetId)
      return set?.title ?? null
    }
    return null
  })
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "list"
    return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || "list"
  })

  // UI state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set<string>()
    try {
      const saved = localStorage.getItem(`${EXPANDED_FOLDERS_KEY}-${project.id}`)
      return saved ? new Set(JSON.parse(saved)) : new Set<string>()
    } catch {
      return new Set<string>()
    }
  })

  const [expandedDrawingSets, setExpandedDrawingSets] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const loadingSheetsSetIdsRef = useRef<Set<string>>(new Set())
  const syncedUrlStateRef = useRef(`${initialSetId ?? ""}|${initialNormalizedPath}`)

  const setSelectedDrawingSet = useCallback((id: string | null, title?: string | null) => {
    setSelectedDrawingSetId(id)
    setSelectedDrawingSetTitle(title ?? null)
  }, [])

  const pushDocsState = useCallback(
    (nextPath: string | null, nextSetId: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      params.delete("path")
      params.delete("set")
      if (nextPath) {
        params.set("path", normalizeDocsPath(nextPath))
      }
      if (nextSetId) {
        params.set("set", nextSetId)
      }
      const nextQuery = params.toString()
      const nextUrl = nextQuery ? `${basePath}?${nextQuery}` : basePath
      const currentQuery = searchParams.toString()
      const currentUrl = currentQuery ? `${basePath}?${currentQuery}` : basePath
      if (nextUrl !== currentUrl) {
        router.push(nextUrl)
      }
    },
    [basePath, router, searchParams]
  )

  const navigateToRoot = useCallback(() => {
    pushDocsState(null, null)
    setCurrentPathState("")
    setSelectedDrawingSet(null, null)
    setQuickFilter("all")
  }, [pushDocsState, setSelectedDrawingSet])

  const navigateToFolder = useCallback((path: string) => {
    const normalizedPath = normalizeDocsPath(path)
    pushDocsState(normalizedPath || null, null)
    setCurrentPathState(normalizedPath)
    setSelectedDrawingSet(null, null)
    setQuickFilter("all")
  }, [pushDocsState, setSelectedDrawingSet])

  const navigateToDrawingSet = useCallback((id: string, title: string) => {
    pushDocsState(null, id)
    setSelectedDrawingSet(id, title)
    setCurrentPathState("")
    setQuickFilter("drawings")
  }, [pushDocsState, setSelectedDrawingSet])

  const setCurrentPath = useCallback(
    (path: string) => {
      const normalizedPath = normalizeDocsPath(path)
      if (!normalizedPath) {
        navigateToRoot()
        return
      }
      navigateToFolder(normalizedPath)
    },
    [navigateToFolder, navigateToRoot]
  )

  // Folder expansion
  const toggleFolderExpanded = useCallback(
    (path: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        if (typeof window !== "undefined") {
          localStorage.setItem(
            `${EXPANDED_FOLDERS_KEY}-${project.id}`,
            JSON.stringify(Array.from(next))
          )
        }
        return next
      })
    },
    [project.id]
  )

  // Drawing set expansion
  const toggleDrawingSetExpanded = useCallback((setId: string) => {
    setExpandedDrawingSets((prev) => {
      const next = new Set(prev)
      if (next.has(setId)) {
        next.delete(setId)
      } else {
        next.add(setId)
      }
      return next
    })
  }, [])

  // Load sheets for a drawing set
  const loadSheetsForSet = useCallback(
    async (setId: string) => {
      if (sheetsBySetId[setId]) return
      if (loadingSheetsSetIdsRef.current.has(setId)) return

      loadingSheetsSetIdsRef.current.add(setId)

      try {
        const sheets = await listDrawingSheetsWithUrlsAction({
          project_id: project.id,
          drawing_set_id: setId,
          limit: 500,
        })
        setSheetsBySetId((prev) => ({ ...prev, [setId]: sheets }))
      } catch (error) {
        console.error("Failed to load sheets for set:", error)
        // Avoid infinite loading state in the accordion row.
        setSheetsBySetId((prev) => ({ ...prev, [setId]: [] }))
      } finally {
        loadingSheetsSetIdsRef.current.delete(setId)
      }
    },
    [project.id, sheetsBySetId]
  )

  // Refresh functions
  const refreshFiles = useCallback(async () => {
    if (quickFilter === "drawings") return
    const startedAt = performance.now()
    docsDebugLog("refreshFiles:start", {
      projectId: project.id,
      quickFilter,
      searchQuery,
    })
    setIsLoading(true)
    try {
      const [filesData, countsData, foldersData] = await Promise.all([
        listFilesAction({
          project_id: project.id,
          category: quickFilter === "all" ? undefined : quickFilter,
          search: searchQuery || undefined,
          limit: 100,
        }),
        getFileCountsAction(project.id),
        listFoldersAction(project.id),
      ])
      setFiles(filesData)
      setCounts(countsData)
      setFolders(foldersData)
      docsDebugLog("refreshFiles:success", {
        files: filesData.length,
        folders: foldersData.length,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
    } catch (error) {
      console.error("Failed to refresh files:", error)
      docsDebugLog("refreshFiles:error", error)
    } finally {
      setIsLoading(false)
    }
  }, [project.id, quickFilter, searchQuery])

  const refreshDrawingSets = useCallback(async () => {
    try {
      const sets = await listDrawingSetsAction({ project_id: project.id })
      setDrawingSets(sets)
    } catch (error) {
      console.error("Failed to refresh drawing sets:", error)
    }
  }, [project.id])

  // Files/folders are fetched server-side for initial load, and refreshed explicitly
  // after mutations (upload/move/rename/delete) to avoid action polling loops.

  const urlPath = useMemo(() => normalizeDocsPath(searchParams.get("path")), [searchParams])
  const urlSetId = searchParams.get("set")
  const urlStateKey = `${urlSetId ?? ""}|${urlPath}`

  useEffect(() => {
    if (syncedUrlStateRef.current === urlStateKey) return
    syncedUrlStateRef.current = urlStateKey

    if (urlSetId) {
      const set = drawingSets.find((row) => row.id === urlSetId)
      setSelectedDrawingSet(urlSetId, set?.title ?? null)
      setCurrentPathState("")
      setQuickFilter("drawings")
      return
    }

    setSelectedDrawingSet(null, null)
    setCurrentPathState(urlPath)
    setQuickFilter((prev) => (prev === "drawings" || Boolean(urlPath) ? "all" : prev))
  }, [drawingSets, setSelectedDrawingSet, urlPath, urlSetId, urlStateKey])

  useEffect(() => {
    if (!selectedDrawingSetId) return
    const set = drawingSets.find((row) => row.id === selectedDrawingSetId)
    if (!set || set.title === selectedDrawingSetTitle) return
    setSelectedDrawingSetTitle(set.title)
  }, [drawingSets, selectedDrawingSetId, selectedDrawingSetTitle])

  useEffect(() => {
    if (typeof window === "undefined") return
    localStorage.setItem(VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  // Auto-expand parent folders when navigating to a path
  useEffect(() => {
    if (!currentPath) return

    const parts = currentPath.split("/").filter(Boolean)
    const pathsToExpand: string[] = []
    let accumulated = ""

    for (const part of parts.slice(0, -1)) {
      accumulated += `/${part}`
      pathsToExpand.push(accumulated)
    }

    if (pathsToExpand.length > 0) {
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const p of pathsToExpand) {
          if (!prev.has(p)) {
            next.add(p)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
  }, [currentPath])

  useEffect(() => {
    docsDebugLog("state", {
      quickFilter,
      currentPath,
      searchQuery,
      selectedDrawingSetId,
      files: files.length,
      folders: folders.length,
      drawingSets: drawingSets.length,
      isLoading,
      isUploading,
    })
  }, [
    quickFilter,
    currentPath,
    searchQuery,
    selectedDrawingSetId,
    files.length,
    folders.length,
    drawingSets.length,
    isLoading,
    isUploading,
  ])

  // When quickFilter changes away from drawings, clear drawing-set context.
  useEffect(() => {
    if (quickFilter === "drawings") return
    if (!selectedDrawingSetId && !selectedDrawingSetTitle) return
    setSelectedDrawingSet(null, null)
  }, [quickFilter, selectedDrawingSetId, selectedDrawingSetTitle, setSelectedDrawingSet])

  const contextValue: DocumentsContextValue = useMemo(
    () => ({
      projectId: project.id,
      projectName: project.name,
      files,
      drawingSets,
      folders,
      counts,
      currentPath,
      quickFilter,
      searchQuery,
      viewMode,
      setCurrentPath,
      setQuickFilter,
      setSearchQuery,
      setViewMode,
      setSelectedDrawingSet,
      navigateToRoot,
      navigateToFolder,
      navigateToDrawingSet,
      refreshFiles,
      refreshDrawingSets,
      isLoading,
      isUploading,
      expandedFolders,
      toggleFolderExpanded,
      expandedDrawingSets,
      toggleDrawingSetExpanded,
      sheetsBySetId,
      loadSheetsForSet,
      selectedDrawingSetId,
      selectedDrawingSetTitle,
    }),
    [
      files,
      drawingSets,
      folders,
      counts,
      currentPath,
      quickFilter,
      searchQuery,
      viewMode,
      isLoading,
      isUploading,
      expandedFolders,
      expandedDrawingSets,
      sheetsBySetId,
      refreshFiles,
      refreshDrawingSets,
      setCurrentPath,
      setQuickFilter,
      setSearchQuery,
      setViewMode,
      setSelectedDrawingSet,
      navigateToRoot,
      navigateToFolder,
      navigateToDrawingSet,
      toggleFolderExpanded,
      toggleDrawingSetExpanded,
      loadSheetsForSet,
      selectedDrawingSetId,
      selectedDrawingSetTitle,
      project.id,
      project.name,
    ]
  )

  return (
    <DocumentsContext.Provider value={contextValue}>
      {children}
    </DocumentsContext.Provider>
  )
}

// Helper function to build folder tree
export function buildFolderTree(
  folders: string[],
  files: FileWithUrls[]
): FolderNode[] {
  const root: FolderNode[] = []
  const pathMap = new Map<string, FolderNode>()

  // Count files per folder
  const fileCountByFolder = new Map<string, number>()
  for (const file of files) {
    const folderPath = file.folder_path || ""
    if (folderPath) {
      const normalized = folderPath.startsWith("/") ? folderPath : `/${folderPath}`
      fileCountByFolder.set(
        normalized,
        (fileCountByFolder.get(normalized) ?? 0) + 1
      )
    }
  }

  // Build tree from folder list
  const allPaths = new Set<string>(folders)

  // Also include folder paths from files
  for (const file of files) {
    if (file.folder_path) {
      const normalized = file.folder_path.startsWith("/")
        ? file.folder_path
        : `/${file.folder_path}`
      allPaths.add(normalized)
    }
  }

  const sortedPaths = Array.from(allPaths).sort()

  for (const path of sortedPaths) {
    const parts = path.split("/").filter(Boolean)
    let currentPath = ""
    let parentNode: FolderNode | null = null

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath += `/${part}`

      let node = pathMap.get(currentPath)
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          itemCount: fileCountByFolder.get(currentPath) ?? 0,
          children: [],
        }
        pathMap.set(currentPath, node)

        if (parentNode) {
          parentNode.children.push(node)
        } else {
          root.push(node)
        }
      }

      parentNode = node
    }
  }

  return root
}

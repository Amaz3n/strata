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
import { usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  listFilesAction,
  listChildFoldersAction,
  listProjectFolderPermissionsAction,
  loadDocumentsViewAction,
} from "@/app/(app)/documents/actions"
import type { FileWithUrls, ProjectFolderPermissions } from "@/app/(app)/documents/types"
import type { DocumentsContextValue, QuickFilter, RefreshFilesOptions, FolderNode } from "./types"

const DocumentsContext = createContext<DocumentsContextValue | null>(null)

const SEARCH_DEBOUNCE_MS = 250

export function useDocuments() {
  const context = useContext(DocumentsContext)
  if (!context) {
    throw new Error("useDocuments must be used within a DocumentsProvider")
  }
  return context
}

/**
 * Local-immediate search input backed by a debounced commit to the context.
 *
 * The context stores only the committed query, so typing re-renders the input
 * that owns this hook rather than every document consumer.
 */
export function useDocumentsSearchInput() {
  const { searchQuery, setSearchQuery } = useDocuments()
  const [value, setValue] = useState(searchQuery)
  const lastCommittedRef = useRef(searchQuery)

  // Adopt external resets (e.g. "clear filters") without fighting local typing.
  useEffect(() => {
    if (searchQuery === lastCommittedRef.current) return
    lastCommittedRef.current = searchQuery
    setValue(searchQuery)
  }, [searchQuery])

  useEffect(() => {
    if (value === lastCommittedRef.current) return
    const timeout = window.setTimeout(() => {
      lastCommittedRef.current = value
      setSearchQuery(value)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [value, setSearchQuery])

  return [value, setValue] as const
}

interface DocumentsProviderProps {
  children: ReactNode
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

const EXPANDED_FOLDERS_KEY = "documents-expanded-folders"
const SORT_KEY = "documents-sort"
const DIRECTION_KEY = "documents-direction"

type SortField = "name" | "workflow" | "updated_at" | "created_at" | "size"
type SortDirection = "asc" | "desc"

const SORT_FIELDS: SortField[] = ["name", "workflow", "updated_at", "created_at", "size"]

function readStoredSort(): SortField {
  if (typeof window === "undefined") return "created_at"
  const stored = localStorage.getItem(SORT_KEY)
  return SORT_FIELDS.includes(stored as SortField) ? (stored as SortField) : "created_at"
}

function readStoredDirection(): SortDirection {
  if (typeof window === "undefined") return "desc"
  const stored = localStorage.getItem(DIRECTION_KEY)
  return stored === "asc" || stored === "desc" ? stored : "desc"
}

interface FileViewCacheEntry {
  files: FileWithUrls[]
  totalCount: number
  hasMore: boolean
}

function normalizeDocsPath(value?: string | null): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "")
  return normalized === "/" ? "" : normalized
}

function buildFileViewCacheKey({
  path,
  quickFilter,
  searchQuery,
  sort,
  direction,
}: {
  path: string
  quickFilter: QuickFilter
  searchQuery: string
  sort: string
  direction: string
}) {
  return [
    normalizeDocsPath(path) || "/",
    quickFilter,
    searchQuery.trim(),
    sort,
    direction,
  ].join("|")
}

function getCategoryFilter(quickFilter: QuickFilter) {
  if (quickFilter === "all" || quickFilter === "expiring" || quickFilter === "trash") {
    return undefined
  }
  return quickFilter
}

function getExpiringDueRange(quickFilter: QuickFilter) {
  if (quickFilter !== "expiring") {
    return {}
  }
  return {
    due_before: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }
}

export function DocumentsProvider({
  children,
  project,
  initialFiles,
  initialCounts,
  initialFolders,
  initialFolderCounts = {},
  initialFolderPermissions = [],
  initialPath = "",
  initialTotalCount = 0,
  initialHasMore = false,
}: DocumentsProviderProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const basePath = useMemo(() => {
    const match = pathname.match(/^(\/projects\/[^/]+\/documents)/)
    return match?.[1] ?? pathname
  }, [pathname])
  const initialNormalizedPath = useMemo(() => normalizeDocsPath(initialPath), [initialPath])

  // Data state
  const [files, setFiles] = useState<FileWithUrls[]>(initialFiles)
  const [folders, setFolders] = useState<string[]>(initialFolders)
  const [folderItemCounts, setFolderItemCounts] = useState<Record<string, number>>(initialFolderCounts)
  const [folderPermissions, setFolderPermissions] = useState<ProjectFolderPermissions[]>(initialFolderPermissions)
  const [counts, setCounts] = useState<Record<string, number>>(initialCounts)
  const [totalCount, setTotalCount] = useState<number>(initialTotalCount)
  const [hasMore, setHasMore] = useState<boolean>(initialHasMore)
  const fileViewCacheRef = useRef<Map<string, FileViewCacheEntry>>(new Map())
  const initialCacheSeededRef = useRef(false)
  const fileRefreshRequestRef = useRef(0)

  // Filter state. searchQuery is the committed query — live input state lives in
  // whichever component owns the search box (see useDocumentsSearchInput).
  const [currentPath, setCurrentPathState] = useState<string>(initialNormalizedPath)
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [error, setError] = useState<string | null>(null)

  const [sort, setSort] = useState<SortField>(readStoredSort)
  const [direction, setDirection] = useState<SortDirection>(readStoredDirection)

  useEffect(() => {
    if (initialCacheSeededRef.current) return
    initialCacheSeededRef.current = true
    const key = buildFileViewCacheKey({
      path: initialNormalizedPath,
      quickFilter: "all",
      searchQuery: "",
      sort,
      direction,
    })
    fileViewCacheRef.current.set(key, {
      files: initialFiles,
      totalCount: initialTotalCount,
      hasMore: initialHasMore,
    })
  }, [direction, initialFiles, initialHasMore, initialNormalizedPath, initialTotalCount, sort])

  const hydrateFilesFromCache = useCallback(
    (path: string, nextQuickFilter = quickFilter) => {
      const key = buildFileViewCacheKey({
        path,
        quickFilter: nextQuickFilter,
        searchQuery,
        sort,
        direction,
      })
      const cached = fileViewCacheRef.current.get(key)
      if (!cached) return false
      setFiles(cached.files)
      setTotalCount(cached.totalCount)
      setHasMore(cached.hasMore)
      return true
    },
    [searchQuery, direction, quickFilter, sort],
  )

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

  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const loadingFolderPathsRef = useRef<Set<string>>(new Set())
  const syncedUrlStateRef = useRef(initialNormalizedPath)

  const pushDocsState = useCallback(
    (nextPath: string | null, nextSort?: string, nextDirection?: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.delete("path")
      params.delete("sort")
      params.delete("direction")

      if (nextPath) {
        params.set("path", normalizeDocsPath(nextPath))
      }

      const s = nextSort ?? sort
      const d = nextDirection ?? direction
      if (s !== "created_at") params.set("sort", s)
      if (d !== "desc") params.set("direction", d)

      const nextQuery = params.toString()
      const nextUrl = nextQuery ? `${basePath}?${nextQuery}` : basePath
      const currentQuery = searchParams.toString()
      const currentUrl = currentQuery ? `${basePath}?${currentQuery}` : basePath
      if (nextUrl !== currentUrl) {
        window.history.pushState(null, "", nextUrl)
      }
    },
    [basePath, searchParams, sort, direction]
  )

  const navigateToRoot = useCallback(() => {
    pushDocsState(null)
    hydrateFilesFromCache("", "all")
    setCurrentPathState("")
    setQuickFilter("all")
  }, [hydrateFilesFromCache, pushDocsState])

  const navigateToFolder = useCallback((path: string) => {
    const normalizedPath = normalizeDocsPath(path)
    pushDocsState(normalizedPath || null)
    hydrateFilesFromCache(normalizedPath, "all")
    setCurrentPathState(normalizedPath)
    setQuickFilter("all")
  }, [hydrateFilesFromCache, pushDocsState])

  const updateSort = useCallback((newSort: SortField) => {
    setSort(newSort)
    pushDocsState(currentPath, newSort, direction)
  }, [currentPath, direction, pushDocsState])

  const updateDirection = useCallback((newDirection: SortDirection) => {
    setDirection(newDirection)
    pushDocsState(currentPath, sort, newDirection)
  }, [currentPath, sort, pushDocsState])

  const toggleSort = useCallback((nextSort: SortField) => {
    const nextDirection =
      sort === nextSort
        ? direction === "asc"
          ? "desc"
          : "asc"
        : nextSort === "name"
          ? "asc"
          : "desc"

    setSort(nextSort)
    setDirection(nextDirection)
    pushDocsState(currentPath, nextSort, nextDirection)
  }, [currentPath, sort, direction, pushDocsState])

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

  const pageSize = 100

  const loadFolderChildren = useCallback(async (path?: string) => {
    const normalizedPath = normalizeDocsPath(path)
    const cacheKey = normalizedPath || "/"
    if (loadingFolderPathsRef.current.has(cacheKey)) return

    loadingFolderPathsRef.current.add(cacheKey)
    try {
      const childFolders = await listChildFoldersAction(project.id, normalizedPath || undefined)
      setFolderItemCounts((prev) => {
        const next = { ...prev }
        for (const folder of childFolders) {
          next[folder.path] = folder.itemCount
        }
        return next
      })
      setFolders((prev) => {
        const next = new Set(prev)
        if (normalizedPath) {
          next.add(normalizedPath)
        }
        for (const folder of childFolders) {
          next.add(folder.path)
        }
        return Array.from(next).sort()
      })
    } catch (error) {
      console.error("Failed to load folder children:", error)
      toast.error("Could not load folders")
    } finally {
      loadingFolderPathsRef.current.delete(cacheKey)
    }
  }, [project.id])

  // Refresh functions
  const refreshFiles = useCallback(async (options: RefreshFilesOptions = {}) => {
    const searchFilter = searchQuery.trim()
    const includeMetadata = options.includeMetadata ?? true
    const isTrashView = quickFilter === "trash"
    const isFilteredView = quickFilter !== "all"
    const dueRange = getExpiringDueRange(quickFilter)
    const requestId = fileRefreshRequestRef.current + 1
    fileRefreshRequestRef.current = requestId
    setIsLoading(true)
    setError(null)
    // A mutation invalidates every cached view, not just the one being refreshed.
    if (options.invalidateCache) {
      fileViewCacheRef.current.clear()
    }
    try {
      const shouldLoadFolders = includeMetadata && !searchFilter
      // ONE action, not four: the app router queues a client's server actions
      // serially, so a Promise.all here would cost four sequential round trips.
      const view = await loadDocumentsViewAction({
        projectId: project.id,
        filters: {
          category: getCategoryFilter(quickFilter),
          folder_path: currentPath || undefined,
          root_only: isTrashView || isFilteredView || currentPath || searchFilter ? undefined : true,
          search: searchFilter || undefined,
          include_archived: isTrashView,
          archived_only: isTrashView,
          ...dueRange,
          sort,
          direction,
          limit: pageSize,
          offset: 0,
        },
        includeMetadata,
        includeChildFolders: shouldLoadFolders,
        childFolderPath: currentPath || undefined,
      })
      if (requestId !== fileRefreshRequestRef.current) return
      const cacheKey = buildFileViewCacheKey({
        path: currentPath,
        quickFilter,
        searchQuery: searchFilter,
        sort,
        direction,
      })
      fileViewCacheRef.current.set(cacheKey, {
        files: view.files,
        totalCount: view.totalCount,
        hasMore: view.hasMore,
      })
      setFiles(view.files)
      setTotalCount(view.totalCount)
      setHasMore(view.hasMore)
      if (view.counts) setCounts(view.counts)
      if (view.folderPermissions) setFolderPermissions(view.folderPermissions)
      if (view.childFolders) {
        const childFolders = view.childFolders
        setFolderItemCounts((prev) => {
          const next = { ...prev }
          for (const folder of childFolders) {
            next[folder.path] = folder.itemCount
          }
          return next
        })
        setFolders((prev) => {
          const next = new Set(prev)
          if (currentPath) {
            next.add(currentPath)
          }
          for (const folder of childFolders) {
            next.add(folder.path)
          }
          return Array.from(next).sort()
        })
      }
    } catch (error) {
      console.error("Failed to refresh files:", error)
      if (requestId === fileRefreshRequestRef.current) {
        setError(error instanceof Error ? error.message : "Could not load documents")
      }
    } finally {
      if (requestId === fileRefreshRequestRef.current) {
        setIsLoading(false)
      }
    }
  }, [project.id, quickFilter, searchQuery, currentPath, sort, direction])

  const refreshFolderPermissions = useCallback(async () => {
    try {
      const perms = await listProjectFolderPermissionsAction(project.id)
      setFolderPermissions(perms)
    } catch (error) {
      console.error("Failed to refresh folder permissions:", error)
    }
  }, [project.id])

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore) return

    setIsLoadingMore(true)
    try {
      const dueRange = getExpiringDueRange(quickFilter)
      const filesData = await listFilesAction({
        project_id: project.id,
        category: getCategoryFilter(quickFilter),
        folder_path: currentPath || undefined,
        root_only: quickFilter !== "all" || currentPath || searchQuery ? undefined : true,
        search: searchQuery || undefined,
        include_archived: quickFilter === "trash",
        archived_only: quickFilter === "trash",
        ...dueRange,
        sort,
        direction,
        limit: pageSize,
        offset: files.length,
      })

      setFiles((prev) => {
        const nextFiles = [...prev, ...filesData.data]
        const cacheKey = buildFileViewCacheKey({
          path: currentPath,
          quickFilter,
          searchQuery,
          sort,
          direction,
        })
        fileViewCacheRef.current.set(cacheKey, {
          files: nextFiles,
          totalCount: filesData.count,
          hasMore: filesData.hasMore,
        })
        return nextFiles
      })
      setHasMore(filesData.hasMore)
      setTotalCount(filesData.count)
    } catch (error) {
      console.error("Failed to load more files:", error)
      toast.error("Could not load more documents")
    } finally {
      setIsLoadingMore(false)
    }
  }, [project.id, quickFilter, hasMore, isLoadingMore, currentPath, searchQuery, sort, direction, files.length])

  const urlPath = useMemo(() => normalizeDocsPath(searchParams.get("path")), [searchParams])
  const urlSort = searchParams.get("sort")
  const urlDirection = searchParams.get("direction")
  const urlStateKey = `${urlPath}|${urlSort ?? ""}|${urlDirection ?? ""}`

  useEffect(() => {
    if (syncedUrlStateRef.current === urlStateKey) return
    syncedUrlStateRef.current = urlStateKey

    if (urlSort && SORT_FIELDS.includes(urlSort as SortField)) setSort(urlSort as SortField)
    if (urlDirection === "asc" || urlDirection === "desc") setDirection(urlDirection)

    setCurrentPathState(urlPath)
    if (urlPath) setQuickFilter("all")
  }, [urlPath, urlSort, urlDirection, urlStateKey])

  useEffect(() => {
    if (typeof window === "undefined") return
    localStorage.setItem(SORT_KEY, sort)
  }, [sort])

  useEffect(() => {
    if (typeof window === "undefined") return
    localStorage.setItem(DIRECTION_KEY, direction)
  }, [direction])

  // Files/folders are fetched server-side for initial load, and refreshed explicitly
  // after mutations (upload/move/rename/delete) to avoid action polling loops.
  // Depend on the filter values themselves so revalidation cannot be silently lost
  // by a change to how refreshFiles is memoized.
  const refreshFilesRef = useRef(refreshFiles)
  useEffect(() => {
    refreshFilesRef.current = refreshFiles
  }, [refreshFiles])

  const isFirstMountRef = useRef(true)
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false
      return
    }
    void refreshFilesRef.current({ includeMetadata: !searchQuery })
  }, [searchQuery, quickFilter, currentPath, sort, direction])

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

  const contextValue: DocumentsContextValue = useMemo(
    () => ({
      projectId: project.id,
      projectName: project.name,
      files,
      folders,
      folderItemCounts,
      folderPermissions,
      counts,
      totalCount,
      hasMore,
      currentPath,
      quickFilter,
      searchQuery,
      sort,
      direction,
      error,
      setCurrentPath,
      setQuickFilter,
      setSearchQuery,
      setSort: updateSort,
      setDirection: updateDirection,
      toggleSort,
      navigateToRoot,
      navigateToFolder,
      loadFolderChildren,
      refreshFiles,
      loadMore,
      refreshFolderPermissions,
      isLoading,
      isLoadingMore,
      expandedFolders,
      toggleFolderExpanded,
    }),
    [
      files,
      folders,
      folderItemCounts,
      folderPermissions,
      counts,
      totalCount,
      hasMore,
      currentPath,
      quickFilter,
      searchQuery,
      sort,
      direction,
      error,
      isLoading,
      isLoadingMore,
      expandedFolders,
      refreshFiles,
      loadMore,
      refreshFolderPermissions,
      setCurrentPath,
      setQuickFilter,
      setSearchQuery,
      updateSort,
      updateDirection,
      toggleSort,
      navigateToRoot,
      navigateToFolder,
      loadFolderChildren,
      toggleFolderExpanded,
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
  files: FileWithUrls[],
  folderItemCounts: Record<string, number> = {}
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
          itemCount: folderItemCounts[currentPath] ?? fileCountByFolder.get(currentPath) ?? 0,
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

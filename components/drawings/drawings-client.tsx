"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Upload,
  FileText,
  Search,
  Filter,
  Grid,
  List,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Download,
  Share2,
  Eye,
  MoreHorizontal,
  Trash2,
  ChevronDown,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { DISCIPLINE_LABELS } from "@/lib/validation/drawings"
import {
  type DrawingSet,
  type DrawingSheet,
  type DrawingDiscipline,
  type DrawingMarkup,
  type DrawingPin,
  listDrawingSetsAction,
  listDrawingSheetsWithUrlsAction,
  uploadPlanSetAction,
  deleteDrawingSetAction,
  getProcessingStatusAction,
  getDisciplineCountsAction,
  bulkUpdateSheetSharingAction,
  getSheetDownloadUrlAction,
  retryProcessingAction,
  listDrawingMarkupsAction,
  listDrawingPinsWithEntitiesAction,
  createDrawingMarkupAction,
  updateDrawingMarkupAction,
  deleteDrawingMarkupAction,
  createDrawingPinAction,
  updateDrawingPinAction,
  deleteDrawingPinAction,
} from "@/app/drawings/actions"
import { DrawingViewer } from "./drawing-viewer"
import { CreateFromDrawingDialog } from "./create-from-drawing-dialog"

type ViewMode = "grid" | "list"
type TabMode = "sets" | "sheets"

interface DrawingsClientProps {
  initialSets: DrawingSet[]
  initialSheets: DrawingSheet[]
  initialDisciplineCounts: Record<string, number>
  projects: Array<{ id: string; name: string }>
  defaultProjectId?: string
  lockProject?: boolean
}

export function DrawingsClient({
  initialSets,
  initialSheets,
  initialDisciplineCounts,
  projects,
  defaultProjectId,
  lockProject = false,
}: DrawingsClientProps) {
  const router = useRouter()

  // Data state
  const [sets, setSets] = useState<DrawingSet[]>(initialSets)
  const [sheets, setSheets] = useState<DrawingSheet[]>(initialSheets)
  const [disciplineCounts, setDisciplineCounts] = useState(initialDisciplineCounts)

  // Filter state
  const [selectedProject, setSelectedProject] = useState<string | undefined>(defaultProjectId)
  const [selectedDiscipline, setSelectedDiscipline] = useState<DrawingDiscipline | "all">("all")
  const [selectedSet, setSelectedSet] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState("")
  const [tabMode, setTabMode] = useState<TabMode>("sheets")

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Upload state
  const [isUploading, setIsUploading] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadTitle, setUploadTitle] = useState("")
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerSheet, setViewerSheet] = useState<DrawingSheet | null>(null)
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [viewerMarkups, setViewerMarkups] = useState<DrawingMarkup[]>([])
  const [viewerPins, setViewerPins] = useState<DrawingPin[]>([])

  // Create from drawing dialog
  const [createFromDrawingOpen, setCreateFromDrawingOpen] = useState(false)
  const [createFromDrawingPosition, setCreateFromDrawingPosition] = useState<{ x: number; y: number } | null>(null)

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [setToDelete, setSetToDelete] = useState<DrawingSet | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Loading state
  const [isLoading, setIsLoading] = useState(false)

  // Polling for processing sets
  const processingSetIds = useMemo(
    () => sets.filter((s) => s.status === "processing").map((s) => s.id),
    [sets]
  )

  useEffect(() => {
    if (processingSetIds.length === 0) return

    const interval = setInterval(async () => {
      for (const setId of processingSetIds) {
        try {
          const status = await getProcessingStatusAction(setId)
          setSets((prev) =>
            prev.map((s) =>
              s.id === setId
                ? { ...s, status: status.status as any, processed_pages: status.processed_pages, total_pages: status.total_pages, error_message: status.error_message }
                : s
            )
          )

          // If processing complete, refresh sheets
          if (status.status === "ready") {
            await fetchSheets()
          }
        } catch (e) {
          console.error("Failed to poll status:", e)
        }
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [processingSetIds])

  // Fetch data
  const fetchSets = useCallback(async () => {
    try {
      const data = await listDrawingSetsAction({
        project_id: selectedProject,
        search: searchQuery || undefined,
      })
      setSets(data)
    } catch (error) {
      console.error("Failed to fetch drawing sets:", error)
    }
  }, [selectedProject, searchQuery])

  const fetchSheets = useCallback(async () => {
    if (!selectedProject) {
      setSheets([])
      setDisciplineCounts({})
      return
    }

    try {
      const [sheetsData, countsData] = await Promise.all([
        listDrawingSheetsWithUrlsAction({
          project_id: selectedProject,
          discipline: selectedDiscipline === "all" ? undefined : selectedDiscipline,
          search: searchQuery || undefined,
          drawing_set_id: selectedSet,
        }),
        getDisciplineCountsAction(selectedProject),
      ])
      const derivedCounts = selectedSet
        ? sheetsData.reduce<Record<string, number>>(
            (acc, sheet) => {
              const disc = sheet.discipline ?? "X"
              acc.all = (acc.all ?? 0) + 1
              acc[disc] = (acc[disc] ?? 0) + 1
              return acc
            },
            { all: 0 }
          )
        : countsData
      setSheets(sheetsData)
      setDisciplineCounts(derivedCounts)
    } catch (error) {
      console.error("Failed to fetch sheets:", error)
    }
  }, [selectedProject, selectedDiscipline, searchQuery, selectedSet])

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    try {
      await Promise.all([fetchSets(), fetchSheets()])
    } finally {
      setIsLoading(false)
    }
  }, [fetchSets, fetchSheets])

  useEffect(() => {
    if (!selectedSet) return
    if (!sets.some((set) => set.id === selectedSet)) {
      setSelectedSet(undefined)
    }
  }, [sets, selectedSet])

  // Debounce search
  useEffect(() => {
    const timeout = setTimeout(() => {
      fetchData()
    }, 300)
    return () => clearTimeout(timeout)
  }, [fetchData])

  // Handle project change
  const handleProjectChange = (projectId: string) => {
    if (lockProject) return
    const newProject = projectId === "all" ? undefined : projectId
    setSelectedProject(newProject)
    setSelectedSet(undefined)
    setSelectedIds(new Set())

    // Update URL
    if (newProject) {
      router.push(`/drawings?project=${newProject}`)
    } else {
      router.push("/drawings")
    }
  }

  // Handle file selection for upload
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are supported")
      return
    }

    setUploadFile(file)
    setUploadTitle(file.name.replace(/\.pdf$/i, ""))
    setUploadDialogOpen(true)
  }

  // Handle upload
  const handleUpload = async () => {
    if (!uploadFile || !selectedProject) return

    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", uploadFile)
      formData.append("projectId", selectedProject)
      formData.append("title", uploadTitle)

      const newSet = await uploadPlanSetAction(formData)
      setSets((prev) => [newSet, ...prev])
      setUploadDialogOpen(false)
      setUploadFile(null)
      setUploadTitle("")
      toast.success("Plan set uploaded. Processing will begin shortly.")
    } catch (error) {
      console.error("Upload failed:", error)
      toast.error("Failed to upload plan set")
    } finally {
      setIsUploading(false)
    }
  }

  // Handle sheet view
  const handleViewSheet = async (sheet: DrawingSheet) => {
    try {
      const url = await getSheetDownloadUrlAction(sheet.id)
      if (url) {
        // Load markups and pins for the sheet
        const [markups, pins] = await Promise.all([
          listDrawingMarkupsAction({ sheet_id: sheet.id }),
          listDrawingPinsWithEntitiesAction(sheet.id)
        ])

        setViewerSheet(sheet)
        setViewerUrl(url)
        setViewerMarkups(markups)
        setViewerPins(pins)
        setViewerOpen(true)
      } else {
        toast.error("Sheet file not available")
      }
    } catch (error) {
      toast.error("Failed to load sheet")
    }
  }

  // Handle markup actions
  const handleSaveMarkup = async (markup: Omit<DrawingMarkup, "id" | "org_id" | "created_at" | "updated_at">) => {
    try {
      const newMarkup = await createDrawingMarkupAction(markup)
      setViewerMarkups(prev => [...prev, newMarkup])
      toast.success("Markup saved")
    } catch (error) {
      console.error("Failed to save markup:", error)
      toast.error("Failed to save markup")
    }
  }

  const handleDeleteMarkup = async (markupId: string) => {
    try {
      await deleteDrawingMarkupAction(markupId)
      setViewerMarkups(prev => prev.filter(m => m.id !== markupId))
      toast.success("Markup deleted")
    } catch (error) {
      console.error("Failed to delete markup:", error)
      toast.error("Failed to delete markup")
    }
  }

  const handleCreatePin = (x: number, y: number) => {
    setCreateFromDrawingPosition({ x, y })
    setCreateFromDrawingOpen(true)
  }

  const handlePinClick = (pin: DrawingPin) => {
    // Navigate to the entity
    // This would depend on the entity type
    console.log("Navigate to entity:", pin)
    toast.info(`Navigate to ${pin.entity_type}: ${pin.entity_id}`)
  }

  // Handle create from drawing
  const handleCreateFromDrawing = async (input: any) => {
    if (!viewerSheet || !createFromDrawingPosition) return

    try {
      // First create the entity (this would be implemented based on entity type)
      // For now, just create a pin at the position
      const pin = await createDrawingPinAction({
        sheet_id: viewerSheet.id,
        entity_type: input.entityType,
        entity_id: "temp-entity-id", // This would be the actual entity ID
        x: createFromDrawingPosition.x,
        y: createFromDrawingPosition.y,
        status: "open",
      })

      setViewerPins(prev => [...prev, pin])
      setCreateFromDrawingOpen(false)
      setCreateFromDrawingPosition(null)
      toast.success("Entity created and pinned to drawing")
    } catch (error) {
      console.error("Failed to create entity:", error)
      toast.error("Failed to create entity")
    }
  }

  // Handle delete set
  const handleDeleteSet = async () => {
    if (!setToDelete) return

    setIsDeleting(true)
    try {
      await deleteDrawingSetAction(setToDelete.id)
      setSets((prev) => prev.filter((s) => s.id !== setToDelete.id))
      await fetchSheets() // Refresh sheets
      toast.success("Drawing set deleted")
    } catch (error) {
      toast.error("Failed to delete drawing set")
    } finally {
      setIsDeleting(false)
      setDeleteDialogOpen(false)
      setSetToDelete(null)
    }
  }

  // Handle retry processing
  const handleRetry = async (setId: string) => {
    try {
      await retryProcessingAction(setId)
      toast.success("Processing restarted")
      await fetchSets()
    } catch (error) {
      toast.error("Failed to restart processing")
    }
  }

  // Handle bulk share
  const handleBulkShare = async (shareWith: "clients" | "subs") => {
    if (selectedIds.size === 0) return

    try {
      await bulkUpdateSheetSharingAction(
        Array.from(selectedIds),
        shareWith === "clients"
          ? { share_with_clients: true }
          : { share_with_subs: true }
      )
      toast.success(`${selectedIds.size} sheets shared`)
      setSelectedIds(new Set())
      await fetchSheets()
    } catch (error) {
      toast.error("Failed to update sharing")
    }
  }

  // Toggle sheet selection
  const toggleSheetSelection = (sheetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sheetId)) {
        next.delete(sheetId)
      } else {
        next.add(sheetId)
      }
      return next
    })
  }

  // Select all visible sheets
  const selectAllVisible = () => {
    setSelectedIds(new Set(sheets.map((s) => s.id)))
  }

  // Clear selection
  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col gap-4 p-4 border-b bg-background">
        <div className="flex flex-wrap items-center gap-2">
          {lockProject ? (
            <div className="rounded-md border px-3 py-2 text-sm">
              {projects.find((p) => p.id === selectedProject)?.name ?? "Project"}
            </div>
          ) : (
            <Select value={selectedProject ?? "all"} onValueChange={handleProjectChange}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {selectedProject && tabMode === "sheets" && (
            <Select
              value={selectedSet ?? "all"}
              onValueChange={(value) => setSelectedSet(value === "all" ? undefined : value)}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="All plan sets" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Plan Sets</SelectItem>
                {sets.map((set) => (
                  <SelectItem key={set.id} value={set.id}>
                    {set.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search drawings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex items-center gap-1 border rounded-md">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode("grid")}
            >
              <Grid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1" />

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={handleFileSelect}
          />

          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={!selectedProject}
          >
            <Upload className="h-4 w-4 mr-2" />
            Upload Plan Set
          </Button>
        </div>

        {/* Tabs and discipline filters */}
        {selectedProject && (
          <div className="flex items-center justify-between">
            <Tabs value={tabMode} onValueChange={(v) => setTabMode(v as TabMode)}>
              <TabsList>
                <TabsTrigger value="sheets">
                  Sheets {disciplineCounts.all ? `(${disciplineCounts.all})` : ""}
                </TabsTrigger>
                <TabsTrigger value="sets">
                  Plan Sets ({sets.length})
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {tabMode === "sheets" && (
              <div className="flex items-center gap-2 overflow-x-auto">
                <Button
                  variant={selectedDiscipline === "all" ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setSelectedDiscipline("all")}
                >
                  All
                </Button>
                {Object.entries(DISCIPLINE_LABELS)
                  .filter(([code]) => disciplineCounts[code])
                  .map(([code, label]) => (
                    <Button
                      key={code}
                      variant={selectedDiscipline === code ? "secondary" : "outline"}
                      size="sm"
                      onClick={() => setSelectedDiscipline(code as DrawingDiscipline)}
                    >
                      {code} ({disciplineCounts[code] ?? 0})
                    </Button>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* Selection actions */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
            <span className="text-sm font-medium">
              {selectedIds.size} selected
            </span>
            <Button variant="outline" size="sm" onClick={clearSelection}>
              <X className="h-4 w-4 mr-1" />
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBulkShare("clients")}
            >
              <Share2 className="h-4 w-4 mr-1" />
              Share with Clients
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBulkShare("subs")}
            >
              <Share2 className="h-4 w-4 mr-1" />
              Share with Subs
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedProject ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <FileText className="h-16 w-16 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">Select a Project</h2>
            <p className="text-muted-foreground max-w-md">
              Choose a project from the dropdown above to view and manage drawings.
            </p>
          </div>
        ) : isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[8.5/11] rounded-md" />
            ))}
          </div>
        ) : tabMode === "sets" ? (
          /* Drawing Sets View */
          <div className="space-y-4">
            {sets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Upload className="h-12 w-12 text-muted-foreground mb-4" />
                <h2 className="text-lg font-semibold mb-2">No Plan Sets</h2>
                <p className="text-muted-foreground mb-4">
                  Upload a PDF plan set to get started.
                </p>
                <Button onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Plan Set
                </Button>
              </div>
            ) : (
              sets.map((set) => (
                <div
                  key={set.id}
                  className="flex items-center justify-between p-4 border rounded-lg bg-card"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-muted rounded-md">
                      <FileText className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">{set.title}</h3>
                      <p className="text-sm text-muted-foreground">
                        {set.sheet_count ?? 0} sheets
                        {set.description && ` - ${set.description}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {set.status === "processing" && (
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-blue-500 animate-pulse" />
                        <div className="w-32">
                          <Progress
                            value={
                              set.total_pages
                                ? (set.processed_pages / set.total_pages) * 100
                                : 0
                            }
                          />
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {set.processed_pages}/{set.total_pages ?? "?"}
                        </span>
                      </div>
                    )}

                    {set.status === "ready" && (
                      <Badge variant="default" className="bg-green-500">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Ready
                      </Badge>
                    )}

                    {set.status === "failed" && (
                      <div className="flex items-center gap-2">
                        <Badge variant="destructive">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          Failed
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRetry(set.id)}
                        >
                          <RefreshCw className="h-4 w-4 mr-1" />
                          Retry
                        </Button>
                      </div>
                    )}

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setSetToDelete(set)
                            setDeleteDialogOpen(true)
                          }}
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          /* Sheets View */
          sheets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <h2 className="text-lg font-semibold mb-2">No Sheets</h2>
              <p className="text-muted-foreground">
                {sets.some((s) => s.status === "processing")
                  ? "Sheets are being processed..."
                  : "Upload a plan set to generate sheets."}
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
              {sheets.map((sheet) => (
                <div
                  key={sheet.id}
                  className={cn(
                    "relative group cursor-pointer border rounded-lg overflow-hidden bg-card",
                    selectedIds.has(sheet.id) && "ring-2 ring-primary"
                  )}
                  onClick={() => handleViewSheet(sheet)}
                >
                  {/* Thumbnail */}
                  <div className="aspect-[8.5/11] bg-muted flex items-center justify-center">
                    {sheet.thumbnail_url ? (
                      <img
                        src={sheet.thumbnail_url}
                        alt={sheet.sheet_number}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <FileText className="h-12 w-12 text-muted-foreground" />
                    )}
                  </div>

                  {/* Selection checkbox */}
                  <button
                    className={cn(
                      "absolute top-2 left-2 w-5 h-5 rounded border bg-background",
                      "opacity-0 group-hover:opacity-100 transition-opacity",
                      selectedIds.has(sheet.id) && "opacity-100 bg-primary border-primary"
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSheetSelection(sheet.id)
                    }}
                  >
                    {selectedIds.has(sheet.id) && (
                      <CheckCircle2 className="h-4 w-4 text-primary-foreground" />
                    )}
                  </button>

                  {/* Sharing badges */}
                  <div className="absolute top-2 right-2 flex gap-1">
                    {sheet.share_with_clients && (
                      <Badge variant="secondary" className="text-xs">C</Badge>
                    )}
                    {sheet.share_with_subs && (
                      <Badge variant="secondary" className="text-xs">S</Badge>
                    )}
                  </div>

                  {/* Info */}
                  <div className="p-2">
                    <p className="font-medium text-sm truncate">
                      {sheet.sheet_number}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {sheet.sheet_title}
                    </p>
                    {sheet.discipline && (
                      <Badge variant="outline" className="text-xs mt-1">
                        {sheet.discipline}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* List View */
            <div className="border rounded-lg divide-y">
              <div className="grid grid-cols-[auto,1fr,1fr,1fr,auto] gap-4 p-3 bg-muted font-medium text-sm">
                <div className="w-5" />
                <div>Sheet #</div>
                <div>Title</div>
                <div>Discipline</div>
                <div className="w-24 text-center">Sharing</div>
              </div>
              {sheets.map((sheet) => (
                <div
                  key={sheet.id}
                  className={cn(
                    "grid grid-cols-[auto,1fr,1fr,1fr,auto] gap-4 p-3 items-center hover:bg-muted/50 cursor-pointer",
                    selectedIds.has(sheet.id) && "bg-primary/5"
                  )}
                  onClick={() => handleViewSheet(sheet)}
                >
                  <button
                    className={cn(
                      "w-5 h-5 rounded border",
                      selectedIds.has(sheet.id) && "bg-primary border-primary"
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSheetSelection(sheet.id)
                    }}
                  >
                    {selectedIds.has(sheet.id) && (
                      <CheckCircle2 className="h-4 w-4 text-primary-foreground" />
                    )}
                  </button>
                  <div className="font-medium">{sheet.sheet_number}</div>
                  <div className="text-muted-foreground">
                    {sheet.sheet_title || "-"}
                  </div>
                  <div>
                    {sheet.discipline ? (
                      <Badge variant="outline">
                        {sheet.discipline} - {DISCIPLINE_LABELS[sheet.discipline]}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                  <div className="w-24 flex justify-center gap-1">
                    {sheet.share_with_clients && (
                      <Badge variant="secondary" className="text-xs">Clients</Badge>
                    )}
                    {sheet.share_with_subs && (
                      <Badge variant="secondary" className="text-xs">Subs</Badge>
                    )}
                    {!sheet.share_with_clients && !sheet.share_with_subs && (
                      <span className="text-muted-foreground text-xs">Private</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Plan Set</DialogTitle>
            <DialogDescription>
              Upload a multi-page PDF plan set. It will be automatically split into individual sheets.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Enter plan set title"
              />
            </div>

            {uploadFile && (
              <div className="flex items-center gap-2 p-2 border rounded-md">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm">{uploadFile.name}</span>
                <span className="text-xs text-muted-foreground">
                  ({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)
                </span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUploadDialogOpen(false)}
              disabled={isUploading}
            >
              Cancel
            </Button>
            <Button onClick={handleUpload} disabled={isUploading || !uploadTitle}>
              {isUploading ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Drawing Set?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{setToDelete?.title}&quot; and all its sheets.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSet}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sheet Viewer */}
      {viewerOpen && viewerSheet && viewerUrl && (
        <DrawingViewer
          sheet={viewerSheet}
          fileUrl={viewerUrl}
          markups={viewerMarkups}
          pins={viewerPins}
          onClose={() => setViewerOpen(false)}
          onSaveMarkup={handleSaveMarkup}
          onDeleteMarkup={handleDeleteMarkup}
          onCreatePin={handleCreatePin}
          onPinClick={handlePinClick}
        />
      )}

      {/* Create from Drawing Dialog */}
      <CreateFromDrawingDialog
        open={createFromDrawingOpen}
        onOpenChange={setCreateFromDrawingOpen}
        onCreate={handleCreateFromDrawing}
        sheet={viewerSheet}
        position={createFromDrawingPosition || { x: 0, y: 0 }}
        projectId={selectedProject || undefined}
      />
    </div>
  )
}

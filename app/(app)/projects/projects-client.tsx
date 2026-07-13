"use client"

import { useState, useEffect, type CSSProperties } from "react"
import { OptimisticLink as Link } from "@/lib/navigation/optimistic-pathname"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Plus, Search, MoreHorizontal, FolderOpen, X, SlidersHorizontal, Edit, Trash2, Check, ArrowUp, ArrowDown, ArrowUpDown } from "@/components/icons"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { useForm, type UseFormReturn } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { Contact, Project, ProjectScheduleSummary, ProjectStatus } from "@/lib/types"
import { Progress } from "@/components/ui/progress"
import { ProjectScheduleSheet } from "@/components/projects/project-schedule-sheet"
import {
  createProjectAction,
  updateProjectAction,
  deleteProjectAction,
  listProjectQboClassesAction,
  searchProjectQboCustomersAction,
  createProjectQboCustomerAction,
} from "./actions"
import { projectInputSchema } from "@/lib/validation/projects"
import type { ProjectInput } from "@/lib/validation/projects"
import type { QBOClassOption, QBOCustomerOption } from "@/lib/integrations/accounting/qbo-api"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { GooglePlacesAutocomplete } from "@/components/ui/google-places-autocomplete"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import type { DateRange } from "react-day-picker"
import {
  ProjectFinancialSetupFields,
  emptyFinancialSetup,
  financialSetupFromProject,
  financialSetupToProjectInput,
  modelLabel,
  validateFinancialSetup,
  type FinancialSetupValue,
} from "@/components/projects/project-financial-setup-fields"
import { ArrowLeft, ArrowRight } from "@/components/icons"
import { cn } from "@/lib/utils"
import {
  getDefaultProjectPropertyType,
  getProjectPosture,
  type ProductTier,
} from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"

import { unwrapAction } from "@/lib/action-result"

const statusColors: Record<ProjectStatus, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  bidding: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusLabels: Record<ProjectStatus, string> = {
  planning: "Planning",
  bidding: "Bidding",
  active: "Active",
  on_hold: "Paused",
  completed: "Complete",
  cancelled: "Canceled",
}

const statusOptions = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "Paused" },
  { value: "completed", label: "Complete" },
  { value: "cancelled", label: "Canceled" },
]

const filterStatusOptions: { value: ProjectStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "on_hold", label: "Paused" },
  { value: "completed", label: "Complete" },
  { value: "cancelled", label: "Canceled" },
]

interface ProjectsClientProps {
  projects: Project[]
  clientContacts: Contact[]
  scheduleSummaries: Record<string, ProjectScheduleSummary>
  productTier: ProductTier
}

type SortKey = "name" | "client" | "status" | "progress" | "value"
type SortDir = "asc" | "desc"

function projectValueCents(project: Project): number | null {
  if (typeof project.billing_contract?.total_cents === "number") return project.billing_contract.total_cents
  if (typeof project.total_value === "number") return project.total_value * 100
  return null
}

function toOperationalProjectStatus(status: ProjectStatus): ProjectStatus {
  return status === "planning" || status === "bidding" ? "active" : status
}

// Step 1 detail fields only; billing/financial setup is captured separately via FinancialSetupValue.
function projectToFormValues(project: Project): ProjectInput {
  return {
    name: project.name,
    status: toOperationalProjectStatus(project.status),
    start_date: project.start_date ?? "",
    end_date: project.end_date ?? "",
    address: project.address ?? "",
    client_id: project.client_id ?? null,
    total_value: project.total_value ?? undefined,
    property_type: project.property_type ?? undefined,
    project_type: project.project_type ?? undefined,
    description: project.description ?? "",
    qbo_class_id: project.qbo_class_id ?? null,
    qbo_class_name: project.qbo_class_name ?? null,
    qbo_customer_id: project.qbo_customer_id ?? null,
    qbo_customer_name: project.qbo_customer_name ?? null,
  }
}

function normalizeProjectInput(values: ProjectInput): ProjectInput {
  const contractValue =
    typeof values.total_contract_value_cents === "number" ? values.total_contract_value_cents / 100 : undefined

  return {
    ...values,
    start_date: values.start_date || null,
    end_date: values.end_date || null,
    total_value: contractValue,
  }
}

export function ProjectsClient({ projects, clientContacts, scheduleSummaries, productTier }: ProjectsClientProps) {
  const defaultPropertyType = getDefaultProjectPropertyType(productTier)
  const orgTerms = terminology(productTier)
  const [projectsState, setProjectsState] = useState<Project[]>(projects)

  // Sorting (client-side; all projects are already loaded)
  const [sortKey, setSortKey] = useState<SortKey>("name")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  // Schedule progress sheet
  const [scheduleSheetProject, setScheduleSheetProject] = useState<Project | null>(null)

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  // Create sheet
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createDateRange, setCreateDateRange] = useState<DateRange | undefined>()
  const [createFinancialSetup, setCreateFinancialSetup] = useState<FinancialSetupValue>(() =>
    emptyFinancialSetup("fixed_price", defaultPropertyType),
  )

  // Edit sheet
  const [editSheetOpen, setEditSheetOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [editDateRange, setEditDateRange] = useState<DateRange | undefined>()
  const [editFinancialSetup, setEditFinancialSetup] = useState<FinancialSetupValue>(() => emptyFinancialSetup())

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Filters
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("all")
  const [qboClasses, setQboClasses] = useState<QBOClassOption[]>([])

  const createForm = useForm<ProjectInput>({
    resolver: zodResolver(projectInputSchema),
    defaultValues: {
      name: "",
      status: "active",
      start_date: "",
      end_date: "",
      address: "",
      client_id: null,
      total_value: undefined,
      property_type: defaultPropertyType,
      project_type: undefined,
      description: "",
      contract_type: "fixed",
      billing_model: "fixed_price",
      markup_percent: undefined,
      gmp_cents: undefined,
      savings_split_owner_pct: undefined,
      savings_split_builder_pct: undefined,
      labor_burden_multiplier: 1,
      requires_client_cost_approval: false,
      open_book: true,
      total_contract_value_cents: undefined,
      qbo_class_id: null,
      qbo_class_name: null,
      qbo_customer_id: null,
      qbo_customer_name: null,
    },
  })

  const editForm = useForm<ProjectInput>({
    resolver: zodResolver(projectInputSchema),
    defaultValues: {
      name: "",
      status: "active",
      start_date: "",
      end_date: "",
      address: "",
      client_id: null,
      total_value: undefined,
      property_type: undefined,
      project_type: undefined,
      description: "",
      contract_type: "fixed",
      billing_model: "fixed_price",
      markup_percent: undefined,
      gmp_cents: undefined,
      savings_split_owner_pct: undefined,
      savings_split_builder_pct: undefined,
      labor_burden_multiplier: 1,
      requires_client_cost_approval: false,
      open_book: true,
      total_contract_value_cents: undefined,
      qbo_class_id: null,
      qbo_class_name: null,
      qbo_customer_id: null,
      qbo_customer_name: null,
    },
  })

  useEffect(() => {
    let cancelled = false
    listProjectQboClassesAction()
      .then((classes) => {
        if (!cancelled) setQboClasses(classes)
      })
      .catch(() => {
        if (!cancelled) setQboClasses([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Sync create date range → form
  useEffect(() => {
    createForm.setValue("start_date", createDateRange?.from ? createDateRange.from.toISOString().split("T")[0] : "")
    createForm.setValue("end_date", createDateRange?.to ? createDateRange.to.toISOString().split("T")[0] : "")
  }, [createDateRange, createForm])

  // Sync edit date range → form
  useEffect(() => {
    editForm.setValue("start_date", editDateRange?.from ? editDateRange.from.toISOString().split("T")[0] : "")
    editForm.setValue("end_date", editDateRange?.to ? editDateRange.to.toISOString().split("T")[0] : "")
  }, [editDateRange, editForm])

  function openEditSheet(project: Project) {
    setEditingProject(project)
    const values = projectToFormValues(project)
    editForm.reset(values)
    setEditFinancialSetup(financialSetupFromProject(project))
    setEditDateRange(
      project.start_date
        ? {
            from: new Date(project.start_date),
            to: project.end_date ? new Date(project.end_date) : undefined,
          }
        : undefined
    )
    setEditSheetOpen(true)
  }

  function openDeleteDialog(project: Project) {
    setDeletingProject(project)
    setDeleteDialogOpen(true)
  }

  async function handleCreate(values: ProjectInput) {
    setIsCreating(true)
    try {
      const payload = normalizeProjectInput({ ...values, ...financialSetupToProjectInput(createFinancialSetup) })
      const created = unwrapAction(await createProjectAction(payload))
      setProjectsState((prev) => [created, ...prev])
      createForm.reset({
        name: "",
        status: "active",
        start_date: "",
        end_date: "",
        address: "",
        client_id: null,
        total_value: undefined,
        property_type: defaultPropertyType,
        project_type: undefined,
        description: "",
        qbo_class_id: null,
        qbo_class_name: null,
        qbo_customer_id: null,
        qbo_customer_name: null,
      })
      setCreateFinancialSetup(emptyFinancialSetup("fixed_price", defaultPropertyType))
      setCreateDateRange(undefined)
      toast.success("Project created", { description: created.name })
      setCreateSheetOpen(false)
    } catch (error) {
      console.error(error)
      toast.error("Failed to create project")
    } finally {
      setIsCreating(false)
    }
  }

  async function handleUpdate(values: ProjectInput) {
    if (!editingProject) return
    setIsUpdating(true)
    try {
      const payload = normalizeProjectInput({ ...values, ...financialSetupToProjectInput(editFinancialSetup) })
      const updated = unwrapAction(await updateProjectAction(editingProject.id, payload))
      setProjectsState((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
      toast.success("Project updated", { description: updated.name })
      setEditSheetOpen(false)
      setEditingProject(null)
    } catch (error) {
      console.error(error)
      toast.error("Failed to update project")
    } finally {
      setIsUpdating(false)
    }
  }

  async function handleDelete() {
    if (!deletingProject) return
    setIsDeleting(true)
    try {
      unwrapAction(await deleteProjectAction(deletingProject.id))
      setProjectsState((prev) => prev.filter((p) => p.id !== deletingProject.id))
      toast.success("Project deleted")
      setDeleteDialogOpen(false)
      setDeletingProject(null)
    } catch (error) {
      console.error(error)
      toast.error("Failed to delete project")
    } finally {
      setIsDeleting(false)
    }
  }

  const filteredProjects = projectsState.filter((p) => {
    const q = searchQuery.toLowerCase()
    const matchesSearch = !q || p.name.toLowerCase().includes(q) || (p.address ?? "").toLowerCase().includes(q)
    const matchesStatus = statusFilter === "all" || p.status === statusFilter
    return matchesSearch && matchesStatus
  })

  const clientById = new Map(clientContacts.map((contact) => [contact.id, contact]))
  const activeFilters = statusFilter !== "all" ? 1 : 0

  const sortedProjects = [...filteredProjects].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1
    let cmp = 0
    switch (sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name)
        break
      case "client":
        cmp = (clientById.get(a.client_id ?? "")?.full_name ?? "").localeCompare(
          clientById.get(b.client_id ?? "")?.full_name ?? "",
        )
        break
      case "status":
        cmp = a.status.localeCompare(b.status)
        break
      case "progress":
        cmp = (scheduleSummaries[a.id]?.percent ?? -1) - (scheduleSummaries[b.id]?.percent ?? -1)
        break
      case "value":
        cmp = (projectValueCents(a) ?? -1) - (projectValueCents(b) ?? -1)
        break
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name)
    return cmp * dir
  })

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="relative z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search projects..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span className="text-xs">Filter</span>
                  {activeFilters > 0 && (
                    <Badge variant="secondary" className="ml-0.5 px-1 py-0 h-4 text-[10px] min-w-[1.25rem] justify-center">
                      {activeFilters}
                    </Badge>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Filter by status</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {filterStatusOptions.map((opt) => (
                  <DropdownMenuCheckboxItem
                    key={opt.value}
                    checked={statusFilter === opt.value}
                    onCheckedChange={() => setStatusFilter(opt.value)}
                    className="text-xs"
                  >
                    {opt.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" className="h-8" onClick={() => setCreateSheetOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New project
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        {filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[400px]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
              <FolderOpen className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-base">
              {searchQuery || statusFilter !== "all" ? "No projects found" : "No projects yet"}
            </h3>
            <p className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
              {searchQuery || statusFilter !== "all"
                ? "No projects match your filters. Try adjusting your search."
                : "Create your first project to get started."}
            </p>
            {!searchQuery && statusFilter === "all" && (
              <Button className="mt-3" size="sm" onClick={() => setCreateSheetOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New project
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Mobile list */}
            <div className="md:hidden divide-y">
              {sortedProjects.map((project) => (
                <div key={project.id} className="flex items-start justify-between gap-2 px-4 py-3">
                  <Link
                    href={`/projects/${project.id}`}
                    className="min-w-0 flex-1 transition-colors hover:text-primary"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold truncate">{project.name}</span>
                      <Badge variant="outline" className={statusColors[project.status]}>
                        {statusLabels[project.status]}
                      </Badge>
                    </div>
                    {project.address && (
                      <p className="text-sm text-muted-foreground mt-0.5 truncate">{project.address}</p>
                    )}
                  </Link>
                  <ProjectRowMenu project={project} onEdit={openEditSheet} onDelete={openDeleteDialog} />
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHeader label="Project" column="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="pl-6 w-[22%]" />
                    <SortHeader label={orgTerms.owner} column="client" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-[16%]" />
                    <TableHead>Address</TableHead>
                    <SortHeader label="Status" column="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-[11%]" />
                    <SortHeader label="Progress" column="progress" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-[15%]" />
                    <SortHeader label="Value" column="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="w-[11%]" align="right" />
                    <TableHead className="w-[52px] pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedProjects.map((project) => {
                    const client = project.client_id ? clientById.get(project.client_id) : null
                    const summary = scheduleSummaries[project.id] ?? null

                    return (
                      <TableRow key={project.id}>
                        <TableCell className="pl-6 py-3">
                          <Link
                            href={`/projects/${project.id}`}
                            className="font-medium hover:text-primary transition-colors"
                          >
                            {project.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm py-3">
                          {client?.full_name || "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm py-3">
                          {project.address || "—"}
                        </TableCell>
                        <TableCell className="py-3">
                          <Badge variant="outline" className={statusColors[project.status]}>
                            {statusLabels[project.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-3">
                          {summary && summary.total > 0 ? (
                            <button
                              type="button"
                              onClick={() => setScheduleSheetProject(project)}
                              className="group flex w-full items-center gap-2 text-left"
                              title="View schedule progress"
                            >
                              <Progress value={summary.percent} className="h-1.5 flex-1" />
                              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground group-hover:text-foreground">
                                {summary.percent}%
                              </span>
                            </button>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm py-3">
                          {projectValueCents(project) !== null
                            ? `$${(projectValueCents(project)! / 100).toLocaleString()}`
                            : "—"}
                        </TableCell>
                        <TableCell className="pr-4 py-3">
                          <ProjectRowMenu project={project} onEdit={openEditSheet} onDelete={openDeleteDialog} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      {/* Create sheet */}
      <ProjectFormSheet
        mode="create"
        open={createSheetOpen}
        onOpenChange={setCreateSheetOpen}
        form={createForm}
        dateRange={createDateRange}
        onDateRangeChange={setCreateDateRange}
        isSubmitting={isCreating}
        onSubmit={handleCreate}
        clientContacts={clientContacts}
        qboClasses={qboClasses}
        financialSetup={createFinancialSetup}
        onFinancialSetupChange={setCreateFinancialSetup}
        productTier={productTier}
        onClose={() => {
          createForm.reset()
          setCreateFinancialSetup(emptyFinancialSetup("fixed_price", defaultPropertyType))
          setCreateDateRange(undefined)
          setCreateSheetOpen(false)
        }}
      />

      {/* Edit sheet */}
      <ProjectFormSheet
        mode="edit"
        open={editSheetOpen}
        onOpenChange={setEditSheetOpen}
        form={editForm}
        dateRange={editDateRange}
        onDateRangeChange={setEditDateRange}
        isSubmitting={isUpdating}
        onSubmit={handleUpdate}
        clientContacts={clientContacts}
        qboClasses={qboClasses}
        financialSetup={editFinancialSetup}
        onFinancialSetupChange={setEditFinancialSetup}
        productTier={productTier}
        onClose={() => {
          setEditSheetOpen(false)
          setEditingProject(null)
        }}
      />

      {/* Schedule progress */}
      <ProjectScheduleSheet
        open={scheduleSheetProject !== null}
        onOpenChange={(open) => {
          if (!open) setScheduleSheetProject(null)
        }}
        projectId={scheduleSheetProject?.id ?? null}
        projectName={scheduleSheetProject?.name ?? ""}
        summary={scheduleSheetProject ? scheduleSummaries[scheduleSheetProject.id] ?? null : null}
      />

      {/* Delete confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">&ldquo;{deletingProject?.name}&rdquo;</span>?
              This action cannot be undone and will remove all associated data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SortHeader({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  className,
  align,
}: {
  label: string
  column: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  className?: string
  align?: "right"
}) {
  const active = sortKey === column
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "",
        )}
      >
        {label}
        {active ? (
          sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  )
}

function ProjectRowMenu({
  project,
  onEdit,
  onDelete,
}: {
  project: Project
  onEdit: (project: Project) => void
  onDelete: (project: Project) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onEdit(project)}>
          <Edit className="mr-2 h-3.5 w-3.5" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => onDelete(project)}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ProjectFormSheetProps {
  mode: "create" | "edit"
  open: boolean
  onOpenChange: (open: boolean) => void
  form: UseFormReturn<ProjectInput>
  dateRange: DateRange | undefined
  onDateRangeChange: (range: DateRange | undefined) => void
  isSubmitting: boolean
  onSubmit: (values: ProjectInput) => Promise<void>
  clientContacts: Contact[]
  qboClasses: QBOClassOption[]
  financialSetup: FinancialSetupValue
  onFinancialSetupChange: (value: FinancialSetupValue) => void
  productTier: ProductTier
  onClose: () => void
}

function ProjectFormSheet({
  mode,
  open,
  onOpenChange,
  form,
  dateRange,
  onDateRangeChange,
  isSubmitting,
  onSubmit,
  clientContacts,
  qboClasses,
  financialSetup,
  onFinancialSetupChange,
  productTier,
  onClose,
}: ProjectFormSheetProps) {
  const isEdit = mode === "edit"
  const [step, setStep] = useState<"details" | "financials">("details")
  const financialMessages = validateFinancialSetup(financialSetup)
  const canSubmit = financialMessages.blocking.length === 0 && !isSubmitting
  const propertyType = form.watch("property_type")
  const posture = getProjectPosture(propertyType, productTier)
  const terms = terminology(posture)

  // Default QBO customer — drives cost attribution and pre-fills new invoices. Stored on the form (qbo_customer_id/name).
  const qboCustomerId = form.watch("qbo_customer_id")
  const qboCustomerName = form.watch("qbo_customer_name")
  const clientId = form.watch("client_id")
  // The contact backing the unified "Client" field — also the auto QBO customer name when none is set explicitly.
  const selectedClientContact = clientId ? clientContacts.find((contact) => contact.id === clientId) ?? null : null
  const [qboConnected, setQboConnected] = useState(false)
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [customerQuery, setCustomerQuery] = useState("")
  const [customerResults, setCustomerResults] = useState<QBOCustomerOption[]>([])
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false)
  const [createCustomerOpen, setCreateCustomerOpen] = useState(false)
  const [newCustomer, setNewCustomer] = useState({ name: "", email: "", line1: "", city: "", state: "", postalCode: "" })
  const [creatingCustomer, setCreatingCustomer] = useState(false)

  // Always start at step 1 when the sheet opens.
  useEffect(() => {
    if (open) setStep("details")
  }, [open])

  // Probe QBO connection (and seed initial customer results) so the customer picker only renders when connected.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCustomerQuery("")
    setCreateCustomerOpen(false)
    setNewCustomer({ name: "", email: "", line1: "", city: "", state: "", postalCode: "" })
    searchProjectQboCustomersAction("")
      .then((result) => {
        if (cancelled) return
        setQboConnected(Boolean(result.connected))
        setCustomerResults(result.customers ?? [])
      })
      .catch(() => {
        if (!cancelled) setQboConnected(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Live QBO customer typeahead — QBO is the source of truth, so we query it directly while the picker is open.
  useEffect(() => {
    if (!open || !qboConnected || !customerPickerOpen) return
    let cancelled = false
    setCustomerSearchLoading(true)
    const handle = setTimeout(() => {
      searchProjectQboCustomersAction(customerQuery)
        .then((result) => {
          if (!cancelled) setCustomerResults(result.customers ?? [])
        })
        .catch(() => {
          if (!cancelled) setCustomerResults([])
        })
        .finally(() => {
          if (!cancelled) setCustomerSearchLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [open, qboConnected, customerPickerOpen, customerQuery])

  function selectQboCustomer(customer: QBOCustomerOption) {
    form.setValue("qbo_customer_id", customer.id)
    form.setValue("qbo_customer_name", customer.name)
    setCustomerPickerOpen(false)
    setCreateCustomerOpen(false)
  }

  async function handleCreateQboCustomer() {
    const name = newCustomer.name.trim()
    if (!name || creatingCustomer) return
    setCreatingCustomer(true)
    try {
      const created = unwrapAction(await createProjectQboCustomerAction({
        name,
        email: newCustomer.email.trim() || null,
        line1: newCustomer.line1.trim() || null,
        city: newCustomer.city.trim() || null,
        state: newCustomer.state.trim() || null,
        postalCode: newCustomer.postalCode.trim() || null,
      }))
      selectQboCustomer(created)
      setNewCustomer({ name: "", email: "", line1: "", city: "", state: "", postalCode: "" })
      toast.success(`Created "${created.name}" in QuickBooks`)
    } catch (error: any) {
      toast.error("Couldn't create customer in QuickBooks", { description: error?.message ?? "Try again." })
    } finally {
      setCreatingCustomer(false)
    }
  }

  async function goToFinancials() {
    const valid = await form.trigger("name")
    if (valid) setStep("financials")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <div className="flex-1 overflow-y-auto px-4">
          <div className="pt-6 pb-4">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              {isEdit ? "Edit project" : "New project"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              {step === "details"
                ? "Step 1 of 2 · Project details"
                : "Step 2 of 2 · Financial setup"}
            </SheetDescription>
            <div className="mt-3 flex gap-1.5">
              <span className={cn("h-1 flex-1 rounded-full", step === "details" ? "bg-primary" : "bg-primary/30")} />
              <span className={cn("h-1 flex-1 rounded-full", step === "financials" ? "bg-primary" : "bg-muted")} />
            </div>
          </div>

          <Form {...form}>
            <form onSubmit={(event) => event.preventDefault()} className="space-y-4">
              <div className={cn("space-y-4", step === "details" ? "block" : "hidden")}>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Project name</FormLabel>
                    <FormControl>
                      <Input placeholder="Oakwood Residence" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select stage" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {statusOptions.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="start_date"
                render={() => (
                  <FormItem>
                    <FormLabel>Schedule</FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <DateRangePicker
                          dateRange={dateRange}
                          onDateRangeChange={onDateRangeChange}
                          placeholder="Optional start and end dates"
                        />
                        {dateRange?.from || dateRange?.to ? (
                          <Button type="button" variant="outline" size="sm" onClick={() => onDateRangeChange(undefined)}>
                            Clear
                          </Button>
                        ) : null}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address</FormLabel>
                    <FormControl>
                      <GooglePlacesAutocomplete
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="123 Main St, City, State"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* Client — one field. The contact drives portal invites & signatures; */}
              {/* the QuickBooks customer (the sync target) is shown beneath as an overridable detail. */}
              <FormField
                control={form.control}
                name="client_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{terms.owner}</FormLabel>
                    <Select
                      value={field.value ?? "none"}
                      onValueChange={(value) => field.onChange(value === "none" ? null : value)}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select contact" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Not set</SelectItem>
                        {clientContacts.map((contact) => (
                          <SelectItem key={contact.id} value={contact.id}>
                            {contact.full_name}
                            {contact.email ? ` - ${contact.email}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {qboConnected ? (
                      <Popover
                        open={customerPickerOpen}
                        onOpenChange={(next) => {
                          setCustomerPickerOpen(next)
                          if (!next) setCreateCustomerOpen(false)
                        }}
                        modal
                      >
                        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
                          {qboCustomerId ? (
                            <>
                              <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                                <span className="truncate">
                                  Billed in QuickBooks as{" "}
                                  <span className="font-medium text-foreground">{qboCustomerName || "selected customer"}</span>
                                </span>
                              </span>
                              <div className="flex shrink-0 items-center gap-3">
                                <PopoverTrigger asChild>
                                  <button
                                    type="button"
                                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                                  >
                                    Change
                                  </button>
                                </PopoverTrigger>
                                <button
                                  type="button"
                                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                                  onClick={() => {
                                    form.setValue("qbo_customer_id", null)
                                    form.setValue("qbo_customer_name", null)
                                  }}
                                >
                                  Clear
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {selectedClientContact?.full_name ? (
                                  <>
                                    Will sync to QuickBooks as{" "}
                                    <span className="font-medium text-foreground">&ldquo;{selectedClientContact.full_name}&rdquo;</span>
                                  </>
                                ) : (
                                  "Choose the QuickBooks customer to bill"
                                )}
                              </span>
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  className="shrink-0 text-xs font-medium text-primary transition-colors hover:text-primary/80"
                                >
                                  {selectedClientContact?.full_name ? "Change" : "Set customer"}
                                </button>
                              </PopoverTrigger>
                            </>
                          )}
                        </div>
                        <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[320px] p-0" align="start">
                          {createCustomerOpen ? (
                            <div className="space-y-3 p-3">
                              <div className="space-y-1.5">
                                <Label className="text-xs">Name</Label>
                                <Input
                                  value={newCustomer.name}
                                  onChange={(e) => setNewCustomer((s) => ({ ...s, name: e.target.value }))}
                                  placeholder="Customer name"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs">Email</Label>
                                <Input
                                  type="email"
                                  value={newCustomer.email}
                                  onChange={(e) => setNewCustomer((s) => ({ ...s, email: e.target.value }))}
                                  placeholder="email@customer.com"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs">Street</Label>
                                <Input
                                  value={newCustomer.line1}
                                  onChange={(e) => setNewCustomer((s) => ({ ...s, line1: e.target.value }))}
                                  placeholder="123 Main St"
                                />
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                <div className="space-y-1.5">
                                  <Label className="text-xs">City</Label>
                                  <Input
                                    value={newCustomer.city}
                                    onChange={(e) => setNewCustomer((s) => ({ ...s, city: e.target.value }))}
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs">State</Label>
                                  <Input
                                    value={newCustomer.state}
                                    onChange={(e) => setNewCustomer((s) => ({ ...s, state: e.target.value }))}
                                    placeholder="FL"
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs">ZIP</Label>
                                  <Input
                                    value={newCustomer.postalCode}
                                    onChange={(e) => setNewCustomer((s) => ({ ...s, postalCode: e.target.value }))}
                                  />
                                </div>
                              </div>
                              <div className="flex gap-2 pt-1">
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="flex-1"
                                  onClick={() => setCreateCustomerOpen(false)}
                                  disabled={creatingCustomer}
                                >
                                  Back
                                </Button>
                                <Button
                                  type="button"
                                  className="flex-1"
                                  onClick={handleCreateQboCustomer}
                                  disabled={creatingCustomer || !newCustomer.name.trim()}
                                >
                                  {creatingCustomer ? <Spinner className="h-3.5 w-3.5" /> : "Create"}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Command shouldFilter={false}>
                              <CommandInput
                                placeholder="Search QuickBooks customers…"
                                value={customerQuery}
                                onValueChange={setCustomerQuery}
                              />
                              <CommandList>
                                {customerSearchLoading && (
                                  <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                                    <Spinner className="h-3.5 w-3.5" /> Searching…
                                  </div>
                                )}
                                {!customerSearchLoading && customerResults.length === 0 && (
                                  <CommandEmpty>No QuickBooks customers found.</CommandEmpty>
                                )}
                                {customerResults.length > 0 && (
                                  <CommandGroup>
                                    {customerResults.map((customer) => (
                                      <CommandItem key={customer.id} value={customer.id} onSelect={() => selectQboCustomer(customer)}>
                                        <span className="flex min-w-0 flex-col">
                                          <span className="truncate">{customer.name}</span>
                                          {customer.email && <span className="text-xs text-muted-foreground">{customer.email}</span>}
                                        </span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                )}
                                <CommandSeparator />
                                <CommandGroup>
                                  <CommandItem
                                    value="__create_new"
                                    onSelect={() => {
                                      setNewCustomer((s) => ({ ...s, name: customerQuery.trim() || selectedClientContact?.full_name?.trim() || "" }))
                                      setCreateCustomerOpen(true)
                                    }}
                                  >
                                    <Plus className="mr-2 h-3.5 w-3.5" /> Create new customer…
                                  </CommandItem>
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          )}
                        </PopoverContent>
                      </Popover>
                    ) : null}

                    <p className="text-sm text-muted-foreground">
                      Used as the default {terms.owner.toLowerCase()} for portal invites and signatures{qboConnected ? ", and as the QuickBooks customer for invoices, payables, and expenses" : ""}. This does not grant portal access.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {qboClasses.length > 0 ? (
                <FormField
                  control={form.control}
                  name="qbo_class_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>QuickBooks class</FormLabel>
                      <Select
                        value={field.value ?? "none"}
                        onValueChange={(value) => {
                          if (value === "none") {
                            field.onChange(null)
                            form.setValue("qbo_class_name", null)
                            return
                          }
                          const selected = qboClasses.find((qboClass) => qboClass.id === value)
                          field.onChange(value)
                          form.setValue("qbo_class_name", selected?.fullyQualifiedName ?? selected?.name ?? null)
                        }}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select class" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Not set</SelectItem>
                          {qboClasses.map((qboClass) => (
                            <SelectItem key={qboClass.id} value={qboClass.id}>
                              {qboClass.fullyQualifiedName ?? qboClass.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="property_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Property Type</FormLabel>
                      <Select
                        onValueChange={(value) => {
                          field.onChange(value)
                          if (mode === "create") {
                            onFinancialSetupChange({
                              ...financialSetup,
                              fixedPriceBillingBasis: value === "commercial" ? "progress" : "draws",
                              retainagePercent: value === "commercial" ? "10" : "0",
                            })
                          }
                        }}
                        value={field.value ?? ""}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="residential">Residential</SelectItem>
                          <SelectItem value="commercial">Commercial</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="project_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="new_construction">New Construction</SelectItem>
                          <SelectItem value="remodel">Remodel</SelectItem>
                          <SelectItem value="addition">Addition</SelectItem>
                          <SelectItem value="renovation">Renovation</SelectItem>
                          <SelectItem value="repair">Repair</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Project description..." className="resize-none" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              </div>

              <div className={cn(step === "financials" ? "block" : "hidden")}>
                <ProjectFinancialSetupFields
                  value={financialSetup}
                  onChange={onFinancialSetupChange}
                  posture={posture}
                />
                {financialMessages.blocking[0] || financialMessages.warnings[0] ? (
                  <p
                    className={cn(
                      "mt-4 text-xs",
                      financialMessages.blocking[0] ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {financialMessages.blocking[0] ?? financialMessages.warnings[0]}
                  </p>
                ) : null}
              </div>
            </form>
          </Form>
        </div>

        <div className="flex-shrink-0 border-t bg-background p-4">
          <div className="flex gap-2">
            {step === "details" ? (
              <>
                <Button type="button" variant="outline" onClick={onClose} className="flex-1">
                  Cancel
                </Button>
                <Button type="button" className="flex-1" onClick={goToFinancials}>
                  Next: {modelLabel(financialSetup.billingModel)}
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setStep("details")} className="flex-1">
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  Back
                </Button>
                <Button type="button" disabled={!canSubmit} className="flex-1" onClick={form.handleSubmit(onSubmit)}>
                  {isSubmitting ? (isEdit ? "Saving..." : "Creating...") : isEdit ? "Save changes" : "Create project"}
                </Button>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

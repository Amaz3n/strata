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
import { Plus, Search, MoreHorizontal, FolderOpen, X, SlidersHorizontal, Edit, Trash2 } from "@/components/icons"
import { toast } from "sonner"
import { useForm, type UseFormReturn } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { Contact, Project, ProjectStatus } from "@/lib/types"
import { createProjectAction, updateProjectAction, deleteProjectAction } from "./actions"
import { projectInputSchema } from "@/lib/validation/projects"
import type { ProjectInput } from "@/lib/validation/projects"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { GooglePlacesAutocomplete } from "@/components/ui/google-places-autocomplete"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import type { DateRange } from "react-day-picker"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { resolveProjectBillingModel } from "@/lib/financials/billing-model"

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

const billingModeOptions = [
  {
    value: "fixed_price",
    label: "Fixed price",
    description: "Invoice against one agreed contract amount.",
  },
  {
    value: "cost_plus_percent",
    label: "Cost plus %",
    description: "Bill actual costs with a percentage markup.",
  },
  {
    value: "cost_plus_fixed_fee",
    label: "Cost plus fixed fee",
    description: "Bill actual costs with a fixed builder fee.",
  },
  {
    value: "cost_plus_gmp",
    label: "Cost plus GMP",
    description: "Bill actual costs with a guaranteed maximum price.",
  },
  {
    value: "time_and_materials",
    label: "Time & materials",
    description: "Bill labor and material costs as they are incurred.",
  },
] as const

interface ProjectsClientProps {
  projects: Project[]
  clientContacts: Contact[]
}

function toOperationalProjectStatus(status: ProjectStatus): ProjectStatus {
  return status === "planning" || status === "bidding" ? "active" : status
}

function projectToFormValues(project: Project): ProjectInput {
  const contractValueCents =
    project.billing_contract?.total_cents ??
    (typeof project.total_value === "number" ? Math.round(project.total_value * 100) : undefined)

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
    contract_type: project.billing_contract?.contract_type === "cost_plus" || project.billing_contract?.contract_type === "time_materials" ? project.billing_contract.contract_type : "fixed",
    billing_model: resolveProjectBillingModel(project, project.billing_contract),
    markup_percent: project.billing_contract?.markup_percent ?? undefined,
    gmp_cents: project.billing_contract?.gmp_cents ?? undefined,
    savings_split_owner_pct: project.billing_contract?.savings_split_owner_pct ?? undefined,
    savings_split_builder_pct: project.billing_contract?.savings_split_builder_pct ?? undefined,
    labor_burden_multiplier: project.billing_contract?.labor_burden_multiplier ?? 1,
    requires_client_cost_approval: project.billing_contract?.requires_client_cost_approval ?? false,
    open_book: project.billing_contract?.open_book ?? true,
    total_contract_value_cents: contractValueCents,
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

export function ProjectsClient({ projects, clientContacts }: ProjectsClientProps) {
  const [projectsState, setProjectsState] = useState<Project[]>(projects)

  // Create sheet
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createDateRange, setCreateDateRange] = useState<DateRange | undefined>()

  // Edit sheet
  const [editSheetOpen, setEditSheetOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [editDateRange, setEditDateRange] = useState<DateRange | undefined>()

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Filters
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("all")

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
    },
  })

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
      const created = await createProjectAction(normalizeProjectInput(values))
      setProjectsState((prev) => [created, ...prev])
      createForm.reset()
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
      const updated = await updateProjectAction(editingProject.id, normalizeProjectInput(values))
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
      await deleteProjectAction(deletingProject.id)
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
              {filteredProjects.map((project) => (
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
                    <TableHead className="pl-6 w-[24%]">Project</TableHead>
                    <TableHead className="w-[18%]">Client</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead className="w-[12%]">Status</TableHead>
                    <TableHead className="w-[18%]">Schedule</TableHead>
                    <TableHead className="text-right w-[12%]">Value</TableHead>
                    <TableHead className="w-[52px] pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProjects.map((project) => {
                    const client = project.client_id ? clientById.get(project.client_id) : null

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
                        <TableCell className="text-muted-foreground text-sm py-3">
                          {project.start_date && project.end_date
                            ? `${new Date(project.start_date).toLocaleDateString()} - ${new Date(project.end_date).toLocaleDateString()}`
                            : project.start_date
                              ? `Starts ${new Date(project.start_date).toLocaleDateString()}`
                              : project.end_date
                                ? `Ends ${new Date(project.end_date).toLocaleDateString()}`
                                : "No schedule"}
                        </TableCell>
                        <TableCell className="text-right text-sm py-3">
                          {typeof (project.billing_contract?.total_cents ?? (typeof project.total_value === "number" ? project.total_value * 100 : undefined)) === "number"
                            ? `$${((project.billing_contract?.total_cents ?? project.total_value! * 100) / 100).toLocaleString()}`
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
        onClose={() => {
          createForm.reset()
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
        onClose={() => {
          setEditSheetOpen(false)
          setEditingProject(null)
        }}
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
  onClose,
}: ProjectFormSheetProps) {
  const isEdit = mode === "edit"
  const billingMode = form.watch("billing_model") ?? "fixed_price"
  const isCostBilling = billingMode !== "fixed_price"
  const isGmpBilling = billingMode === "cost_plus_gmp"
  const usesMarkup = billingMode === "cost_plus_percent" || billingMode === "cost_plus_gmp" || billingMode === "time_and_materials"
  const contractValueLabel = isCostBilling ? "Contract value or cap" : "Contract value"
  const selectedBillingMode = billingModeOptions.find((option) => option.value === billingMode) ?? billingModeOptions[0]

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
              {isEdit
                ? "Update the project details below."
                : "Set up a new construction project to get started."}
            </SheetDescription>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
              <FormField
                control={form.control}
                name="client_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Primary client contact</FormLabel>
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
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="property_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Property Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
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
              <Separator />
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">Contract and billing</h3>
                  <p className="text-xs text-muted-foreground">Set the project value once, then choose how costs should flow into billing.</p>
                </div>
                <FormField
                  control={form.control}
                  name="total_contract_value_cents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{contractValueLabel}</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder="$500,000"
                          className="font-mono"
                          value={typeof field.value === "number" ? `$${(field.value / 100).toLocaleString()}` : ""}
                          onChange={(e) => {
                            const raw = e.target.value.replace(/[^\d.]/g, "")
                            field.onChange(raw ? Math.round(Number(raw) * 100) : undefined)
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="billing_model"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Billing mode</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? "fixed_price"}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {billingModeOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">{selectedBillingMode.description}</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {isCostBilling ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {usesMarkup ? <NumberField form={form} name="markup_percent" label="Default markup %" suffix="%" /> : null}
                    <NumberField form={form} name="labor_burden_multiplier" label="Labor burden multiplier" step="0.01" />
                    {isGmpBilling ? <MoneyCentsField form={form} name="gmp_cents" label="GMP" /> : null}
                    {isGmpBilling ? <NumberField form={form} name="savings_split_owner_pct" label="Owner savings %" suffix="%" /> : null}
                    {isGmpBilling ? <NumberField form={form} name="savings_split_builder_pct" label="Builder savings %" suffix="%" /> : null}
                    <div className="space-y-3 rounded-md border p-3">
                      <BooleanField form={form} name="open_book" label="Open-book client detail" />
                      <BooleanField form={form} name="requires_client_cost_approval" label="Client cost approval" />
                    </div>
                  </div>
                ) : null}
              </div>
            </form>
          </Form>
        </div>

        <div className="flex-shrink-0 border-t bg-background p-4">
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="flex-1"
              onClick={form.handleSubmit(onSubmit)}
            >
              {isSubmitting
                ? isEdit ? "Saving..." : "Creating..."
                : isEdit ? "Save changes" : "Create project"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function NumberField({
  form,
  name,
  label,
  suffix,
  step = "1",
}: {
  form: UseFormReturn<ProjectInput>
  name: keyof ProjectInput
  label: string
  suffix?: string
  step?: string
}) {
  return (
    <FormField
      control={form.control}
      name={name as any}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <div className="relative">
              <Input
                type="number"
                step={step}
                min="0"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                className={suffix ? "pr-8" : undefined}
              />
              {suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{suffix}</span> : null}
            </div>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function MoneyCentsField({ form, name, label }: { form: UseFormReturn<ProjectInput>; name: keyof ProjectInput; label: string }) {
  return (
    <FormField
      control={form.control}
      name={name as any}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="text"
              placeholder="$0"
              className="font-mono"
              value={typeof field.value === "number" ? `$${(field.value / 100).toLocaleString()}` : ""}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d.]/g, "")
                field.onChange(raw ? Math.round(Number(raw) * 100) : undefined)
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function BooleanField({ form, name, label }: { form: UseFormReturn<ProjectInput>; name: keyof ProjectInput; label: string }) {
  return (
    <FormField
      control={form.control}
      name={name as any}
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-3">
          <FormLabel className="text-sm font-normal">{label}</FormLabel>
          <FormControl>
            <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  )
}

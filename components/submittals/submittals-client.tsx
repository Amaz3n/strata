"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Project, Submittal } from "@/lib/types"
import type { SubmittalInput } from "@/lib/validation/submittals"
import { createSubmittalAction } from "@/app/(app)/submittals/actions"
import { SubmittalForm } from "@/components/submittals/submittal-form"
import { SubmittalDetailSheet } from "@/components/submittals/submittal-detail-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, MoreHorizontal, FileText, Building2, Calendar } from "@/components/icons"

type StatusKey = "draft" | "submitted" | "in_review" | "approved" | "rejected" | string

const statusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  submitted: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  in_review: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/20 text-destructive border-destructive/30",
}

function formatDate(date?: string | null) {
  if (!date) return ""
  return format(new Date(date), "MMM d, yyyy")
}

interface SubmittalsClientProps {
  submittals: Submittal[]
  projects: Project[]
}

export function SubmittalsClient({ submittals, projects }: SubmittalsClientProps) {
  const [items, setItems] = useState<Submittal[]>(submittals)
  const [search, setSearch] = useState("")
  const [filterProjectId, setFilterProjectId] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [detailSheetOpen, setDetailSheetOpen] = useState(false)
  const [selectedSubmittal, setSelectedSubmittal] = useState<Submittal | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSubmittalClick = (submittal: Submittal) => {
    setSelectedSubmittal(submittal)
    setDetailSheetOpen(true)
  }

  const filtered = useMemo(() => {
    const safeItems = items ?? []
    const term = search.toLowerCase()
    return safeItems.filter((item) => {
      const matchesProject = filterProjectId === "all" || item.project_id === filterProjectId
      const matchesStatus = statusFilter === "all" || item.status === statusFilter
      const matchesSearch =
        term.length === 0 ||
        [String(item.submittal_number ?? ""), item.title ?? "", item.description ?? ""].some((value) =>
          value.toLowerCase().includes(term),
        )
      return matchesProject && matchesStatus && matchesSearch
    })
  }, [filterProjectId, items, search, statusFilter])


  async function handleCreate(values: SubmittalInput) {
    startTransition(async () => {
      try {
        const created = await createSubmittalAction(values)
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success("Submittal created", { description: created.title })
      } catch (error: any) {
        console.error(error)
        toast.error("Could not create submittal", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-4">
      <SubmittalForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <SubmittalDetailSheet
        submittal={selectedSubmittal}
        project={projects.find((p) => p.id === selectedSubmittal?.project_id)}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <Input
            placeholder="Search submittals..."
            className="w-full sm:w-72"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="hidden sm:flex items-center gap-2">
            <Select value={filterProjectId} onValueChange={setFilterProjectId}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusKey)}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(["draft", "submitted", "in_review", "approved", "rejected"] as StatusKey[]).map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          New submittal
        </Button>
      </div>

      {/* Mobile: Card layout */}
      <div className="md:hidden space-y-3">
        {filtered.map((submittal) => (
          <button
            key={submittal.id}
            type="button"
            onClick={() => handleSubmittalClick(submittal)}
            className="block w-full text-left rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 active:bg-muted"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-muted-foreground">{submittal.submittal_number}</span>
                  <Badge variant="secondary" className={`capitalize border text-[11px] ${statusStyles[submittal.status] ?? ""}`}>
                    {statusLabels[submittal.status] ?? submittal.status}
                  </Badge>
                </div>
                <p className="font-semibold mt-1 line-clamp-2">{submittal.title}</p>
                {submittal.due_date && (
                  <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Due {format(new Date(submittal.due_date), "MMM d")}
                  </p>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleSubmittalClick(submittal)}>
                    View details
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <FileText className="h-6 w-6" />
              </div>
              <div>
                <p className="font-medium">No submittals yet</p>
                <p className="text-sm">Create your first submittal to get started.</p>
              </div>
              <Button onClick={() => setSheetOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create submittal
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Desktop: Table layout */}
      <div className="hidden md:block rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Submittal No.</TableHead>
              <TableHead className="px-4 py-4">Title</TableHead>
              <TableHead className="px-4 py-4">Project</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4 text-center">Due Date</TableHead>
              <TableHead className="px-4 py-4 text-center">Spec Section</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((submittal) => (
              <TableRow key={submittal.id} className="divide-x">
                <TableCell className="px-4 py-4">
                  <div className="font-semibold">{submittal.submittal_number}</div>
                </TableCell>
                <TableCell className="px-4 py-4">
                  <button
                    type="button"
                    onClick={() => handleSubmittalClick(submittal)}
                    className="font-semibold text-left hover:text-primary transition-colors"
                    aria-label={`View submittal ${submittal.submittal_number ?? submittal.title ?? ""}`}
                  >
                    {submittal.title}
                  </button>
                </TableCell>
                <TableCell className="px-4 py-4 text-muted-foreground">
                  {projects.find((p) => p.id === submittal.project_id)?.name ?? "Unknown project"}
                </TableCell>
                <TableCell className="px-4 py-4 text-center">
                  <Badge variant="secondary" className={`capitalize border ${statusStyles[submittal.status] ?? ""}`}>
                    {statusLabels[submittal.status] ?? submittal.status}
                  </Badge>
                </TableCell>
                <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                  {submittal.due_date ? format(new Date(submittal.due_date), "MMM d, yyyy") : "—"}
                </TableCell>
                <TableCell className="px-4 py-4 text-center">
                  <Badge variant="outline" className="text-[11px]">
                    {submittal.spec_section || "—"}
                  </Badge>
                </TableCell>
                <TableCell className="text-center w-12 px-4 py-4">
                  <div className="flex justify-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Submittal actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleSubmittalClick(submittal)}>
                          View details
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No submittals yet</p>
                      <p className="text-sm">Create your first submittal to get started.</p>
                    </div>
                    <Button onClick={() => setSheetOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create submittal
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}







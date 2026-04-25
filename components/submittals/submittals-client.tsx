"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { useIsMobile } from "@/hooks/use-mobile"
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
  const isMobile = useIsMobile()
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
      return matchesStatus && matchesSearch
    })
  }, [items, search, statusFilter])


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
    <>
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

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              placeholder="Search submittals..."
              className="w-full sm:w-72"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusKey)}>
                <SelectTrigger className="w-full sm:w-36">
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
          <div className="flex w-full gap-2 sm:w-auto">
            <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New submittal
            </Button>
          </div>
        </div>

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="space-y-3">
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
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[88px] text-left pl-4">No.</TableHead>
              <TableHead className="w-[40%] min-w-[320px]">Title</TableHead>
              <TableHead className="hidden md:table-cell w-[184px] text-center">Type</TableHead>
              <TableHead className="hidden sm:table-cell w-[128px] text-center">Status</TableHead>
              <TableHead className="hidden lg:table-cell w-[112px] text-center">Due Date</TableHead>
              <TableHead className="hidden xl:table-cell w-[100px] text-center">Spec</TableHead>
              <TableHead className="w-[92px] pr-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((submittal) => (
              <TableRow 
                key={submittal.id} 
                className="group cursor-pointer hover:bg-muted/30 h-[64px]"
                onClick={() => handleSubmittalClick(submittal)}
              >
                <TableCell className="text-center px-2">
                  <span className="text-sm font-semibold">{submittal.submittal_number}</span>
                </TableCell>
                <TableCell className="min-w-0">
                  <span className="text-sm font-medium truncate block">{submittal.title}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell text-center">
                  <span className="text-xs text-muted-foreground truncate block capitalize">
                    {submittal.submittal_type?.replace(/_/g, " ") || "—"}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-center">
                  <div className="flex flex-col gap-1 items-center">
                    <Badge variant="secondary" className={`text-[10px] px-1 py-0 h-4 font-normal capitalize border ${statusStyles[submittal.status] ?? ""}`}>
                      {statusLabels[submittal.status] ?? submittal.status}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-center">
                  <span className="text-xs text-muted-foreground">
                    {submittal.due_date ? format(new Date(submittal.due_date), "MMM d, yyyy") : "—"}
                  </span>
                </TableCell>
                <TableCell className="hidden xl:table-cell text-center">
                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal">
                    {submittal.spec_section || "—"}
                  </Badge>
                </TableCell>
                <TableCell className="pr-2" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
                          <MoreHorizontal className="h-3.5 w-3.5" />
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
              <TableRow>
                <TableCell colSpan={7} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                  <div className="flex flex-col items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div className="text-center max-w-[400px]">
                      <p className="font-medium">No submittals yet</p>
                      <p className="text-sm text-muted-foreground mt-0.5">Create your first submittal to get started.</p>
                    </div>
                    <div className="mt-2">
                      <Button variant="default" size="sm" onClick={() => setSheetOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        Create submittal
                      </Button>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
          </div>
        )}
      </div>
    </>
  )
}









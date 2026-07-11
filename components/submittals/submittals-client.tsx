"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { useIsMobile } from "@/hooks/use-mobile"
import type { Company, Project, Submittal } from "@/lib/types"
import type { SubmittalInput } from "@/lib/validation/submittals"
import { unwrapAction } from "@/lib/action-result"
import { downloadCsv } from "@/lib/csv"
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
import { cn, parseLocalDate, formatLocalDate, isDateExpired } from "@/lib/utils"

type StatusKey =
  | "draft"
  | "pending"
  | "submitted"
  | "in_review"
  | "approved"
  | "approved_as_noted"
  | "revise_resubmit"
  | "rejected"
  | string

const statusLabels: Record<string, string> = {
  draft: "Draft",
  pending: "Pending",
  submitted: "Submitted",
  in_review: "In review",
  approved: "Approved",
  approved_as_noted: "Approved as noted",
  revise_resubmit: "Revise & resubmit",
  rejected: "Rejected",
}

function overdueDays(dueDate: string | null | undefined): number {
  if (!dueDate) return 0
  const due = parseLocalDate(dueDate)
  if (!due) return 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000))
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  pending: "bg-muted text-muted-foreground border-muted",
  submitted: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  in_review: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  approved_as_noted: "bg-success/15 text-success border-success/25",
  revise_resubmit: "bg-orange-500/15 text-orange-600 border-orange-500/30",
  rejected: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusDot: Record<string, string> = {
  draft: "bg-muted-foreground/40",
  pending: "bg-muted-foreground/40",
  submitted: "bg-blue-500",
  in_review: "bg-amber-500",
  approved: "bg-emerald-500",
  approved_as_noted: "bg-emerald-500",
  revise_resubmit: "bg-orange-500",
  rejected: "bg-rose-500",
}

const mobileFilterOrder: Array<"all" | StatusKey> = [
  "all",
  "pending",
  "submitted",
  "in_review",
  "approved",
  "revise_resubmit",
  "rejected",
]

const shortStatusLabel: Record<string, string> = {
  all: "All",
  pending: "Pending",
  submitted: "Submitted",
  in_review: "In review",
  approved: "Approved",
  revise_resubmit: "Resubmit",
  rejected: "Rejected",
}

function formatDate(date?: string | null) {
  if (!date) return ""
  if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return formatLocalDate(date, "MMM d, yyyy")
  }
  return format(new Date(date), "MMM d, yyyy")
}

interface SubmittalsClientProps {
  submittals: Submittal[]
  projects: Project[]
  companies: Company[]
}

export function SubmittalsClient({ submittals, projects, companies }: SubmittalsClientProps) {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<Submittal[]>(submittals)
  const [search, setSearch] = useState("")
  const [filterProjectId, setFilterProjectId] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [waitingOnUsOnly, setWaitingOnUsOnly] = useState(false)
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
      // Only current revisions in the log; history lives in the detail sheet.
      if (item.superseded_by_id) return false
      const matchesProject = filterProjectId === "all" || item.project_id === filterProjectId
      const matchesStatus = statusFilter === "all" || item.status === statusFilter
      // "Waiting on us": undecided and the ball is not in the sub's court.
      const matchesCourt =
        !waitingOnUsOnly ||
        (!item.decision_status &&
          (item.status === "submitted" || item.status === "in_review") &&
          !(item.ball_in_court ?? "").startsWith("Subcontractor"))
      const matchesSearch =
        term.length === 0 ||
        [String(item.submittal_number ?? ""), item.title ?? "", item.description ?? "", item.spec_section ?? ""].some(
          (value) => value.toLowerCase().includes(term),
        )
      return matchesProject && matchesStatus && matchesCourt && matchesSearch
    })
  }, [items, search, statusFilter, filterProjectId, waitingOnUsOnly])

  const companyName = (companyId?: string | null) =>
    companyId ? companies.find((c) => c.id === companyId)?.name ?? null : null

  function ballInCourt(submittal: Submittal): string {
    // Routed submittals persist their court label on every workflow transition.
    if (submittal.ball_in_court) return submittal.ball_in_court
    if (submittal.status === "approved" || submittal.status === "approved_as_noted" || submittal.status === "rejected") {
      return "—"
    }
    if (submittal.status === "submitted" || submittal.status === "in_review") return "GC review"
    return companyName(submittal.assigned_company_id) ?? "Internal"
  }

  async function handleCreate(values: SubmittalInput) {
    startTransition(async () => {
      try {
        const created = unwrapAction(await createSubmittalAction(values))
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success("Submittal created", { description: created.title })
      } catch (error) {
        console.error(error)
        toast.error("Could not create submittal", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  function handleUpdated(updated: Submittal) {
    setSelectedSubmittal(updated)
    setItems((prev) => {
      const exists = prev.some((item) => item.id === updated.id)
      const next = exists ? prev.map((item) => (item.id === updated.id ? updated : item)) : [updated, ...prev]
      // A resubmission supersedes its predecessor locally too.
      return next.map((item) =>
        updated.supersedes_submittal_id && item.id === updated.supersedes_submittal_id
          ? { ...item, superseded_by_id: updated.id }
          : item,
      )
    })
  }

  function handleExportCsv() {
    const rows = filtered.map((submittal) => ({
      number: submittal.revision > 0 ? `${submittal.display_number ?? submittal.submittal_number} Rev ${submittal.revision}` : (submittal.display_number ?? submittal.submittal_number),
      title: submittal.title,
      type: submittal.submittal_type?.replace(/_/g, " ") ?? "",
      spec_section: submittal.spec_section ?? "",
      status: statusLabels[submittal.status] ?? submittal.status,
      ball_in_court: ballInCourt(submittal),
      responsible: companyName(submittal.assigned_company_id) ?? "",
      submitted: submittal.submitted_at ? formatDate(submittal.submitted_at) : "",
      review_due: submittal.due_date ? formatDate(submittal.due_date) : "",
      required_on_site: submittal.required_on_site ? formatDate(submittal.required_on_site) : "",
      lead_time_days: submittal.lead_time_days ?? "",
      decided: submittal.decision_at ? formatDate(submittal.decision_at) : "",
    }))
    downloadCsv(`submittal-log-${format(new Date(), "yyyy-MM-dd")}.csv`, rows, [
      { key: "number", header: "Submittal #" },
      { key: "title", header: "Title" },
      { key: "type", header: "Type" },
      { key: "spec_section", header: "Spec Section" },
      { key: "status", header: "Status" },
      { key: "ball_in_court", header: "Ball in Court" },
      { key: "responsible", header: "Responsible Company" },
      { key: "submitted", header: "Submitted" },
      { key: "review_due", header: "Review Due" },
      { key: "required_on_site", header: "Required On Site" },
      { key: "lead_time_days", header: "Lead Time (days)" },
      { key: "decided", header: "Decided" },
    ])
    toast.success(`Exported ${rows.length} submittal${rows.length === 1 ? "" : "s"} to CSV`)
  }

  return (
    <>
      <SubmittalForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        companies={companies}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <SubmittalDetailSheet
        submittal={selectedSubmittal}
        project={projects.find((p) => p.id === selectedSubmittal?.project_id)}
        companies={companies}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
        onUpdate={handleUpdated}
      />

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        {isMobile ? (
          <div className="sticky top-0 z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-2 px-3 pt-3">
              <Input
                placeholder="Search submittals..."
                className="h-10 text-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                inputMode="search"
              />
              <Button
                size="icon"
                className="h-10 w-10 shrink-0"
                onClick={() => setSheetOpen(true)}
                aria-label="New submittal"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="-mx-px flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {mobileFilterOrder.map((key) => {
                const active = statusFilter === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground active:bg-muted",
                    )}
                  >
                    {shortStatusLabel[key]}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              placeholder="Search submittals..."
              className="w-full sm:w-72"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setWaitingOnUsOnly((v) => !v)}
                className={cn(
                  "shrink-0 border px-3 py-1.5 text-xs font-medium transition-colors",
                  waitingOnUsOnly
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                Waiting on us
              </button>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusKey)}>
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {(
                    [
                      "draft",
                      "pending",
                      "submitted",
                      "in_review",
                      "approved",
                      "approved_as_noted",
                      "revise_resubmit",
                      "rejected",
                    ] as StatusKey[]
                  ).map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabels[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button variant="outline" onClick={handleExportCsv} disabled={filtered.length === 0} className="w-full sm:w-auto">
              Export CSV
            </Button>
            <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New submittal
            </Button>
          </div>
        </div>
        )}

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <FileText className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">No submittals yet</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Create your first submittal to get started.
                  </p>
                </div>
                <Button onClick={() => setSheetOpen(true)} className="mt-1">
                  <Plus className="mr-2 h-4 w-4" />
                  New submittal
                </Button>
              </div>
            ) : (
              <ul className="divide-y">
                {filtered.map((submittal) => {
                  const dueDate = submittal.due_date ? parseLocalDate(submittal.due_date) : null
                  const isOverdue = Boolean(
                    submittal.due_date &&
                      submittal.status !== "approved" &&
                      submittal.status !== "rejected" &&
                      isDateExpired(submittal.due_date),
                  )
                  const subtitleParts = [
                    `#${submittal.display_number ?? submittal.submittal_number}`,
                    statusLabels[submittal.status] ?? submittal.status,
                    submittal.spec_section || null,
                  ].filter(Boolean) as string[]

                  return (
                    <li key={submittal.id} className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => handleSubmittalClick(submittal)}
                        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            statusDot[submittal.status] ?? "bg-muted-foreground/40",
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
                              {submittal.title}
                            </p>
                            {dueDate ? (
                              <span
                                className={cn(
                                  "shrink-0 text-[10px]",
                                  isOverdue
                                    ? "font-medium text-rose-600 dark:text-rose-400"
                                    : "text-muted-foreground",
                                )}
                              >
                                {isOverdue ? `${overdueDays(submittal.due_date)}d overdue` : format(dueDate, "MMM d")}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {subtitleParts.join(" · ")}
                          </p>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[88px] text-left pl-4">No.</TableHead>
              <TableHead className="w-[32%] min-w-[280px]">Title</TableHead>
              <TableHead className="hidden md:table-cell w-[160px] text-center">Ball in Court</TableHead>
              <TableHead className="hidden sm:table-cell w-[128px] text-center">Status</TableHead>
              <TableHead className="hidden lg:table-cell w-[112px] text-center">Aging / Due</TableHead>
              <TableHead className="hidden lg:table-cell w-[112px] text-center">On Site</TableHead>
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
                  <span className="text-sm font-semibold">
                    {submittal.display_number ?? submittal.submittal_number}
                    {submittal.revision > 0 ? <span className="text-xs font-normal text-muted-foreground"> R{submittal.revision}</span> : null}
                  </span>
                </TableCell>
                <TableCell className="min-w-0">
                  <span className="text-sm font-medium truncate block">{submittal.title}</span>
                  {submittal.submittal_type ? (
                    <span className="text-xs text-muted-foreground truncate block capitalize mt-0.5">
                      {submittal.submittal_type.replace(/_/g, " ")}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="hidden md:table-cell text-center">
                  <span className="text-xs text-muted-foreground truncate block">{ballInCourt(submittal)}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-center">
                  <div className="flex flex-col gap-1 items-center">
                    <Badge variant="secondary" className={`text-[10px] px-1 py-0 h-4 font-normal capitalize border ${statusStyles[submittal.status] ?? ""}`}>
                      {statusLabels[submittal.status] ?? submittal.status}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-center">
                  <span
                    className={cn(
                      "text-xs",
                      submittal.due_date &&
                        !submittal.decision_status &&
                        isDateExpired(submittal.due_date)
                        ? "font-medium text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {submittal.due_date ? (overdueDays(submittal.due_date) > 0 && !submittal.decision_status ? `${overdueDays(submittal.due_date)}d overdue` : formatDate(submittal.due_date)) : "—"}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-center">
                  <span className="text-xs text-muted-foreground">
                    {submittal.required_on_site ? formatDate(submittal.required_on_site) : "—"}
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
                <TableCell colSpan={8} className="h-48 text-center text-muted-foreground hover:bg-transparent">
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





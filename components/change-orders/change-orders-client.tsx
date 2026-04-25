"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { useIsMobile } from "@/hooks/use-mobile"
import type { ChangeOrder, CostCode, Project } from "@/lib/types"
import type { ChangeOrderInput } from "@/lib/validation/change-orders"
import { createChangeOrderAction, publishChangeOrderAction } from "@/app/(app)/change-orders/actions"
import { ChangeOrderForm } from "@/components/change-orders/change-order-form"
import { ChangeOrderDetailSheet } from "@/components/change-orders/change-order-detail-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Plus, Share2, FolderOpen, MoreHorizontal } from "@/components/icons"

type StatusKey = "draft" | "pending" | "sent" | "approved" | "requested_changes" | "cancelled"
type StatusFilter = StatusKey | "all"

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  pending: "Pending client",
  sent: "Sent",
  approved: "Approved",
  requested_changes: "Needs changes",
  cancelled: "Cancelled",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  pending: "bg-warning/20 text-warning border-warning/40",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  approved: "bg-success/20 text-success border-success/30",
  requested_changes: "bg-amber-100 text-amber-800 border-amber-200",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function resolveStatusKey(status?: string | null): StatusKey {
  if (!status) return "draft"
  const allowed: StatusKey[] = ["draft", "pending", "sent", "approved", "requested_changes", "cancelled"]
  return allowed.includes(status as StatusKey) ? (status as StatusKey) : "draft"
}

interface ChangeOrdersClientProps {
  changeOrders: ChangeOrder[]
  projects: Project[]
  costCodes?: CostCode[]
  hideProjectFilter?: boolean
}

export function ChangeOrdersClient({ changeOrders, projects, costCodes, hideProjectFilter }: ChangeOrdersClientProps) {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<ChangeOrder[]>(changeOrders)
  const [filterProjectId, setFilterProjectId] = useState<string>(() =>
    hideProjectFilter ? projects[0]?.id ?? "all" : "all",
  )
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [searchTerm, setSearchTerm] = useState("")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [detailSheetOpen, setDetailSheetOpen] = useState(false)
  const [selectedChangeOrder, setSelectedChangeOrder] = useState<ChangeOrder | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleRowClick = (changeOrder: ChangeOrder) => {
    setSelectedChangeOrder(changeOrder)
    setDetailSheetOpen(true)
  }

  const handleUpdate = (updated: ChangeOrder) => {
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    setSelectedChangeOrder(updated)
  }

  const projectLookup = useMemo(() => {
    return projects.reduce<Record<string, Project>>((acc, project) => {
      acc[project.id] = project
      return acc
    }, {})
  }, [projects])

  const filtered = useMemo(() => {
    const safeItems = items ?? []
    const term = searchTerm.trim().toLowerCase()
    return safeItems.filter((item) => {
      const matchesProject = filterProjectId === "all" || item.project_id === filterProjectId
      const resolvedStatus = resolveStatusKey(item.status)
      const matchesStatus = statusFilter === "all" || resolvedStatus === statusFilter
      const projectName = projectLookup[item.project_id]?.name ?? ""
      const matchesSearch =
        term.length === 0 ||
        [item.title ?? "", item.summary ?? "", projectName].some((value) => value.toLowerCase().includes(term))
      return matchesProject && matchesStatus && matchesSearch
    })
  }, [filterProjectId, items, projectLookup, searchTerm, statusFilter])

  async function handleCreate(values: ChangeOrderInput, published: boolean) {
    startTransition(async () => {
      try {
        const created = await createChangeOrderAction(values)
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success(published ? "Sent to client" : "Draft saved", {
          description: published ? "Client can now view and approve." : "You can publish when ready.",
        })
      } catch (error: any) {
        console.error(error)
        toast.error("Could not save change order", { description: error?.message ?? "Please try again." })
      }
    })
  }

  async function handlePublish(changeOrderId: string) {
    startTransition(async () => {
      try {
        const updated = await publishChangeOrderAction(changeOrderId)
        setItems((prev) => prev.map((co) => (co.id === updated.id ? updated : co)))
        toast.success("Published to client")
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to publish", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <>
      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search by title, summary, or project"
              className="w-full sm:w-72"
            />
            <div className="flex items-center gap-2">
              {!hideProjectFilter && (
                <Select value={filterProjectId} onValueChange={setFilterProjectId}>
                  <SelectTrigger className="w-full sm:w-40">
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
              )}
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {(Object.keys(statusLabels) as StatusKey[]).map((status) => (
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
              <Plus className="h-4 w-4 mr-2" />
              New change order
            </Button>
          </div>
        </div>

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="space-y-3">
              {filtered.map((changeOrder) => {
                const projectName = projectLookup[changeOrder.project_id]?.name ?? "Unknown project"
                const statusKey = resolveStatusKey(changeOrder.status)
                const total = formatMoneyFromCents(changeOrder.total_cents ?? changeOrder.totals?.total_cents)
                const impact =
                  changeOrder.days_impact != null && changeOrder.days_impact !== 0
                    ? `${changeOrder.days_impact} day${Math.abs(changeOrder.days_impact) === 1 ? "" : "s"}`
                    : "—"

                return (
                  <button
                    key={changeOrder.id}
                    type="button"
                    onClick={() => handleRowClick(changeOrder)}
                    className="block w-full text-left rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 active:bg-muted"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="secondary" className={`capitalize border text-[11px] ${statusStyles[statusKey]}`}>
                            {statusLabels[statusKey]}
                          </Badge>
                          {changeOrder.client_visible ? (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal bg-primary/10 text-primary border-primary/20">
                              <Share2 className="mr-1 h-3 w-3" />
                              Client can view
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal text-muted-foreground">
                              Internal
                            </Badge>
                          )}
                        </div>
                        <p className="font-semibold mt-1 line-clamp-2">{changeOrder.title}</p>
                        <p className="text-xs text-muted-foreground mt-1">Project: {projectName}</p>
                        <div className="mt-2 flex items-center gap-4 text-xs">
                          <div className="font-semibold">{total}</div>
                          <div className="text-muted-foreground">Impact: {impact}</div>
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
              {filtered.length === 0 && !isPending && (
                <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FolderOpen className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No change orders yet</p>
                      <p className="text-sm">Create your first change order to get started.</p>
                    </div>
                    <Button onClick={() => setSheetOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create change order
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
                  <TableHead className="w-[40%] min-w-[320px] pl-4">Title</TableHead>
                  {!hideProjectFilter && (
                    <TableHead className="hidden md:table-cell w-[184px]">Project</TableHead>
                  )}
                  <TableHead className="hidden lg:table-cell w-[112px] text-center">Created</TableHead>
                  <TableHead className="hidden xl:table-cell w-[112px] text-center">Impact</TableHead>
                  <TableHead className="hidden sm:table-cell w-[140px] text-right">Total</TableHead>
                  <TableHead className="hidden sm:table-cell w-[128px] text-center">Status</TableHead>
                  <TableHead className="hidden xl:table-cell w-[128px] text-center">Client</TableHead>
                  <TableHead className="w-[92px] pr-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((changeOrder) => {
                  const projectName = projectLookup[changeOrder.project_id]?.name ?? "Unknown project"
                  const statusKey = resolveStatusKey(changeOrder.status)
                  const total = formatMoneyFromCents(changeOrder.total_cents ?? changeOrder.totals?.total_cents)
                  const impact =
                    changeOrder.days_impact != null && changeOrder.days_impact !== 0
                      ? `${changeOrder.days_impact} day${Math.abs(changeOrder.days_impact) === 1 ? "" : "s"}`
                      : "—"

                  return (
                    <TableRow
                      key={changeOrder.id}
                      className="group cursor-pointer hover:bg-muted/30 h-[64px]"
                      onClick={() => handleRowClick(changeOrder)}
                    >
                      <TableCell className="min-w-0 pl-4">
                        <span className="text-sm font-medium truncate block">{changeOrder.title}</span>
                        {changeOrder.summary ? (
                          <span className="text-xs text-muted-foreground truncate block mt-0.5">{changeOrder.summary}</span>
                        ) : null}
                      </TableCell>

                      {!hideProjectFilter && (
                        <TableCell className="hidden md:table-cell">
                          <span className="text-xs text-muted-foreground truncate block">{projectName}</span>
                        </TableCell>
                      )}

                      <TableCell className="hidden lg:table-cell text-center">
                        <span className="text-xs text-muted-foreground">
                          {changeOrder.created_at ? format(new Date(changeOrder.created_at), "MMM d, yyyy") : "—"}
                        </span>
                      </TableCell>

                      <TableCell className="hidden xl:table-cell text-center">
                        <span className="text-xs text-muted-foreground">{impact}</span>
                      </TableCell>

                      <TableCell className="hidden sm:table-cell text-right">
                        <div className="font-semibold text-sm">{total}</div>
                      </TableCell>

                      <TableCell className="hidden sm:table-cell text-center">
                        <div className="flex flex-col gap-1 items-center">
                          <Badge variant="secondary" className={`text-[10px] px-1 py-0 h-4 font-normal capitalize border ${statusStyles[statusKey]}`}>
                            {statusLabels[statusKey]}
                          </Badge>
                        </div>
                      </TableCell>

                      <TableCell className="hidden xl:table-cell text-center">
                        {changeOrder.client_visible ? (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal bg-primary/10 text-primary border-primary/20">
                            <Share2 className="mr-1 h-3 w-3" />
                            Client can view
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal text-muted-foreground">
                            Internal
                          </Badge>
                        )}
                      </TableCell>

                      <TableCell className="pr-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
                                <MoreHorizontal className="h-3.5 w-3.5" />
                                <span className="sr-only">Actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleRowClick(changeOrder)}>
                                Edit
                              </DropdownMenuItem>
                              {!changeOrder.client_visible && (
                                <DropdownMenuItem onClick={() => handlePublish(changeOrder.id)} disabled={isPending}>
                                  Publish to client
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}

                {filtered.length === 0 && !isPending && (
                  <TableRow>
                    <TableCell colSpan={hideProjectFilter ? 7 : 8} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <FolderOpen className="h-6 w-6" />
                        </div>
                        <div className="text-center max-w-[400px]">
                          <p className="font-medium">No change orders yet</p>
                          <p className="text-sm text-muted-foreground mt-0.5">Create your first change order to get started.</p>
                        </div>
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={() => setSheetOpen(true)}>
                            <Plus className="mr-2 h-4 w-4" />
                            Create change order
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}

                {isPending && filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={hideProjectFilter ? 7 : 8} className="py-6 hover:bg-transparent">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {[...Array(3)].map((_, idx) => (
                          <Skeleton key={idx} className="h-16 w-full rounded-md" />
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <ChangeOrderForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        costCodes={costCodes}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <ChangeOrderDetailSheet
        changeOrder={selectedChangeOrder}
        project={projects.find((p) => p.id === selectedChangeOrder?.project_id)}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
        onUpdate={handleUpdate}
      />
    </>
  )
}

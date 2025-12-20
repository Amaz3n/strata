"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ChangeOrder, Project } from "@/lib/types"
import type { ChangeOrderInput } from "@/lib/validation/change-orders"
import { createChangeOrderAction, publishChangeOrderAction } from "@/app/change-orders/actions"
import { ChangeOrderForm } from "@/components/change-orders/change-order-form"
import { ChangeOrderDetailSheet } from "@/components/change-orders/change-order-detail-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Share2, FolderOpen } from "@/components/icons"

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
}

export function ChangeOrdersClient({ changeOrders, projects }: ChangeOrdersClientProps) {
  const [items, setItems] = useState<ChangeOrder[]>(changeOrders)
  const [filterProjectId, setFilterProjectId] = useState<string>("all")
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

  const projectLookup = useMemo(() => {
    return projects.reduce<Record<string, Project>>((acc, project) => {
      acc[project.id] = project
      return acc
    }, {})
  }, [projects])

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return items.filter((item) => {
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
    <div className="space-y-4 lg:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-md">
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by title, summary, or project"
            className="w-full"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={filterProjectId} onValueChange={setFilterProjectId}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder="Filter by project" />
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

          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
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

          <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            New change order
          </Button>
        </div>
      </div>

      <ChangeOrderForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <ChangeOrderDetailSheet
        changeOrder={selectedChangeOrder}
        project={projects.find((p) => p.id === selectedChangeOrder?.project_id)}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
      />

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="divide-x">
                <TableHead className="min-w-[200px] px-4 py-4">Title</TableHead>
                <TableHead className="px-4 py-4">Project</TableHead>
                <TableHead className="px-4 py-4 text-center">Created</TableHead>
                <TableHead className="px-4 py-4 text-center">Impact</TableHead>
                <TableHead className="text-right px-4 py-4">Total</TableHead>
                <TableHead className="px-4 py-4 text-center">Status</TableHead>
                <TableHead className="px-4 py-4 text-center">Client</TableHead>
                <TableHead className="text-center w-24 px-4 py-4">Actions</TableHead>
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
                    className="divide-x cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => handleRowClick(changeOrder)}
                  >
                    <TableCell className="px-4 py-4 align-top">
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">{changeOrder.title}</div>
                        {changeOrder.summary && (
                          <p className="text-sm text-muted-foreground line-clamp-2">{changeOrder.summary}</p>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="px-4 py-4 text-muted-foreground">{projectName}</TableCell>

                    <TableCell className="px-4 py-4 text-center text-sm text-muted-foreground">
                      {changeOrder.created_at ? format(new Date(changeOrder.created_at), "MMM d, yyyy") : "—"}
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center text-sm text-muted-foreground">{impact}</TableCell>

                    <TableCell className="px-4 py-4 text-right">
                      <div className="font-semibold">{total}</div>
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center">
                      <Badge variant="secondary" className={`capitalize border ${statusStyles[statusKey]}`}>
                        {statusLabels[statusKey]}
                      </Badge>
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center">
                      {changeOrder.client_visible ? (
                        <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/20">
                          <Share2 className="mr-1 h-3 w-3" />
                          Client can view
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          Internal
                        </Badge>
                      )}
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center">
                      {!changeOrder.client_visible ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            handlePublish(changeOrder.id)
                          }}
                          disabled={isPending}
                        >
                          <Share2 className="h-4 w-4 mr-2" />
                          Publish
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">Published</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}

              {filtered.length === 0 && !isPending && (
                <TableRow className="divide-x">
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
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
                  </TableCell>
                </TableRow>
              )}

              {isPending && filtered.length === 0 && (
                <TableRow className="divide-x">
                  <TableCell colSpan={8} className="py-6">
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
      </div>
    </div>
  )
}





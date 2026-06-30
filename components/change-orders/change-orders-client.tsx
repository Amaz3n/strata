"use client"

import { useMemo, useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { format } from "date-fns"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ChangeOrder, Invoice, Project } from "@/lib/types"
import type { ChangeOrderInput } from "@/lib/validation/change-orders"
import type { InvoiceInput } from "@/lib/validation/invoices"
import { resolveProjectBillingModel } from "@/lib/financials/billing-model"
import {
  approveChangeOrderAction,
  createChangeOrderAction,
  updateChangeOrderAction,
  deleteChangeOrderAction,
  voidChangeOrderAction,
  publishChangeOrderAction,
} from "@/app/(app)/change-orders/actions"
import { createInvoiceAction } from "@/app/(app)/invoices/actions"
import { ArrowDown, ArrowUp, Ban, ChevronsUpDown, FileCheck2, FileText, Pencil, Receipt, Trash2 } from "lucide-react"
import { ChangeOrderForm } from "@/components/change-orders/change-order-form"
import { ChangeOrderDetailSheet } from "@/components/change-orders/change-order-detail-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Plus, FolderOpen, MoreHorizontal, PenLine } from "@/components/icons"

const InvoiceComposerSheet = dynamic(() =>
  import("@/components/invoices/invoice-composer-sheet").then((module) => module.InvoiceComposerSheet),
)

type StatusKey = "draft" | "awaiting_approval" | "approved" | "requested_changes" | "voided"
type StatusFilter = StatusKey | "all"

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  requested_changes: "Needs changes",
  voided: "Voided",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  awaiting_approval: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  approved: "bg-success/20 text-success border-success/30",
  requested_changes: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  voided: "bg-destructive/20 text-destructive border-destructive/30",
}

type SortColumn = "co_number" | "created" | "schedule" | "total"
type SortDirection = "asc" | "desc"

function coNumberSortValue(changeOrder: ChangeOrder) {
  const raw = changeOrder.co_number
  if (raw == null) return 0
  if (typeof raw === "number") return raw
  const match = String(raw).match(/\d+/)
  return match ? Number.parseInt(match[0], 10) : 0
}

function SortHeader({
  label,
  column,
  activeColumn,
  direction,
  onSort,
  align = "left",
  className,
}: {
  label: string
  column: SortColumn
  activeColumn: SortColumn
  direction: SortDirection
  onSort: (column: SortColumn) => void
  align?: "left" | "right"
  className?: string
}) {
  const isActive = activeColumn === column
  const Icon = !isActive ? ChevronsUpDown : direction === "asc" ? ArrowUp : ArrowDown
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 font-medium transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !isActive && "opacity-50")} />
      </button>
    </TableHead>
  )
}

function formatMoneyFromCents(cents?: number | null) {
  const value = (cents ?? 0) / 100
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function changeOrderTotalCents(changeOrder: ChangeOrder) {
  return changeOrder.total_cents ?? changeOrder.totals?.total_cents ?? 0
}

function formatCoNumber(changeOrder: ChangeOrder): string | null {
  const raw = changeOrder.co_number
  if (raw == null || raw === "") return null
  if (typeof raw === "number") return `CO-${String(raw).padStart(3, "0")}`
  const value = raw.trim()
  if (value === "") return null
  if (/^\d+$/.test(value)) return `CO-${value.padStart(3, "0")}`
  return /^co/i.test(value) ? value.toUpperCase() : `CO-${value}`
}

function formatScheduleImpact(daysImpact?: number | null) {
  if (daysImpact == null || daysImpact === 0) return null
  const abs = Math.abs(daysImpact)
  const unit = abs === 1 ? "day" : "days"
  return {
    label: `${daysImpact > 0 ? "+" : "−"}${abs} ${unit}`,
    className: daysImpact > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
  }
}

function hasActiveClientChangeRequest(changeOrder: ChangeOrder) {
  if (changeOrder.metadata?.portal_change_request_active === false) return false
  return (
    changeOrder.status === "requested_changes" ||
    changeOrder.metadata?.portal_change_request_active === true
  )
}

function resolveStatusKey(changeOrder: ChangeOrder): StatusKey {
  const status = changeOrder.status
  if (status !== "approved" && hasActiveClientChangeRequest(changeOrder)) return "requested_changes"
  if (!status) return "draft"
  if (status === "pending" || status === "sent") return "awaiting_approval"
  if (status === "cancelled" || status === "void") return "voided"
  const allowed: StatusKey[] = ["draft", "approved", "requested_changes"]
  return allowed.includes(status as StatusKey) ? (status as StatusKey) : "draft"
}

function canSendToClient(changeOrder: ChangeOrder) {
  return changeOrder.status === "draft" || hasActiveClientChangeRequest(changeOrder)
}

function isLockedFromEditing(changeOrder: ChangeOrder) {
  if (hasActiveClientChangeRequest(changeOrder)) return false
  return ["approved", "cancelled", "pending", "sent"].includes(changeOrder.status)
}

function resolveGmpBadge(changeOrder: ChangeOrder) {
  const financialImpact = changeOrder.metadata?.financial_impact
  const firstLine = changeOrder.lines?.[0]
  const impact = financialImpact?.gmp_impact ?? firstLine?.gmp_impact ?? "none"
  const classification = firstLine?.gmp_classification ?? "inside_gmp"

  if (impact === "increase_gmp") return { label: "GMP +", className: "bg-blue-500/15 text-blue-700 border-blue-500/30" }
  if (impact === "decrease_gmp") return { label: "GMP -", className: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30" }
  if (impact === "outside_gmp" || classification === "outside_gmp") {
    return { label: "Outside GMP", className: "bg-amber-500/15 text-amber-700 border-amber-500/30" }
  }
  return { label: "Inside GMP", className: "bg-muted text-muted-foreground border-muted" }
}

function InvoiceLinkedBadge({ linkedInvoice, compact = false }: {
  linkedInvoice: NonNullable<ChangeOrder["linked_invoice"]>
  compact?: boolean
}) {
  const invoiceNumber = linkedInvoice.invoice_number ? String(linkedInvoice.invoice_number) : null
  const label = invoiceNumber ? `Invoice ${invoiceNumber}` : "Invoice linked"
  const tooltip = invoiceNumber
    ? `Linked to invoice ${invoiceNumber}`
    : "Linked to a client invoice"

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="inline-flex h-5 shrink-0 items-center gap-1 border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
          >
            <FileCheck2 className="h-3 w-3" />
            <span>{compact ? "Invoiced" : label}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function InvoiceLinkedIcon({ linkedInvoice }: {
  linkedInvoice: NonNullable<ChangeOrder["linked_invoice"]>
}) {
  const invoiceNumber = linkedInvoice.invoice_number ? String(linkedInvoice.invoice_number) : null
  const tooltip = invoiceNumber ? `Invoiced — invoice ${invoiceNumber}` : "Invoiced"

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-400">
            <FileCheck2 className="h-3 w-3" />
            <span className="sr-only">{tooltip}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface ChangeOrdersClientProps {
  changeOrders: ChangeOrder[]
  projects: Project[]
  hideProjectFilter?: boolean
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
}

export function ChangeOrdersClient({ changeOrders, projects, hideProjectFilter, builderInfo }: ChangeOrdersClientProps) {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<ChangeOrder[]>(changeOrders)
  const [filterProjectId, setFilterProjectId] = useState<string>(() =>
    hideProjectFilter ? projects[0]?.id ?? "all" : "all",
  )
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [sortColumn, setSortColumn] = useState<SortColumn>("created")
  const [sortDir, setSortDir] = useState<SortDirection>("desc")
  const [searchTerm, setSearchTerm] = useState("")
const [sheetOpen, setSheetOpen] = useState(false)
  const [detailSheetOpen, setDetailSheetOpen] = useState(false)
  const [selectedChangeOrder, setSelectedChangeOrder] = useState<ChangeOrder | null>(null)
  const [editingChangeOrder, setEditingChangeOrder] = useState<ChangeOrder | null>(null)
  const [invoiceComposerOpen, setInvoiceComposerOpen] = useState(false)
  const [invoiceSource, setInvoiceSource] = useState<ChangeOrder | null>(null)
  const [creatingInvoice, setCreatingInvoice] = useState(false)
  const [isPending, startTransition] = useTransition()

  const handleRowClick = (changeOrder: ChangeOrder) => {
    setSelectedChangeOrder(changeOrder)
    setDetailSheetOpen(true)
  }

  const handleUpdate = (updated: ChangeOrder) => {
    setItems((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
    setSelectedChangeOrder((current) => current?.id === updated.id ? { ...current, ...updated } : updated)
  }

  const handleSendToClient = (changeOrder: ChangeOrder) => {
    startTransition(async () => {
      try {
        const result = await publishChangeOrderAction(changeOrder.id)
        setItems((prev) => prev.map((item) => (item.id === changeOrder.id ? { ...item, ...result.changeOrder } : item)))
        setSelectedChangeOrder((current) => current?.id === changeOrder.id ? { ...current, ...result.changeOrder } : current)
        toast.success(result.email_sent ? "Change order emailed to client" : "Change order published to client portal", {
          description: result.email_sent
            ? `Sent to ${result.sent_to}.`
            : "Email was not sent, but the client portal link is ready.",
        })
      } catch (error: any) {
        toast.error("Could not send change order", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handlePrepareInvoice = (changeOrder: ChangeOrder) => {
    setInvoiceSource(changeOrder)
    setInvoiceComposerOpen(true)
  }

  const handleEditFromDetail = (changeOrder: ChangeOrder) => {
    setEditingChangeOrder(changeOrder)
    setDetailSheetOpen(false)
    setSheetOpen(true)
  }

  const handleCreateInvoice = async (
    values: InvoiceInput,
    sendToClient: boolean,
    options?: { silent?: boolean },
  ): Promise<Invoice> => {
    setCreatingInvoice(true)
    try {
      const created = await createInvoiceAction(values)
      const linkedInvoice = {
        id: created.id,
        invoice_number: created.invoice_number,
        status: created.status,
      }
      if (invoiceSource) {
        setItems((prev) => prev.map((item) => item.id === invoiceSource.id ? { ...item, linked_invoice: linkedInvoice } : item))
        setSelectedChangeOrder((current) => current?.id === invoiceSource.id ? { ...current, linked_invoice: linkedInvoice } : current)
      }
      setInvoiceComposerOpen(false)
      setInvoiceSource(null)
      if (!options?.silent) {
        toast.success(sendToClient ? "Invoice sent" : "Invoice saved", {
          description: sendToClient ? "Client can now view this invoice." : "Invoice saved to receivables.",
        })
      }
      return created
    } catch (error: any) {
      toast.error("Could not save invoice", { description: error?.message ?? "Please try again." })
      throw error
    } finally {
      setCreatingInvoice(false)
    }
  }

  const projectLookup = useMemo(() => {
    return projects.reduce<Record<string, Project>>((acc, project) => {
      acc[project.id] = project
      return acc
    }, {})
  }, [projects])

  const formProjectId = filterProjectId !== "all" ? filterProjectId : projects[0]?.id ?? ""
  const formProject = formProjectId ? projectLookup[formProjectId] : null
  const isGmpProject = formProject ? resolveProjectBillingModel(formProject) === "cost_plus_gmp" : false

  const filtered = useMemo(() => {
    const safeItems = items ?? []
    const term = searchTerm.trim().toLowerCase()
    const matches = safeItems.filter((item) => {
      const matchesProject = filterProjectId === "all" || item.project_id === filterProjectId
      const resolvedStatus = resolveStatusKey(item)
      const matchesStatus = statusFilter === "all" || resolvedStatus === statusFilter
      const projectName = projectLookup[item.project_id]?.name ?? ""
      const matchesSearch =
        term.length === 0 ||
        [item.title ?? "", item.summary ?? "", projectName].some((value) => value.toLowerCase().includes(term))
      return matchesProject && matchesStatus && matchesSearch
    })

    const dir = sortDir === "asc" ? 1 : -1
    const sorted = [...matches]
    sorted.sort((a, b) => {
      switch (sortColumn) {
        case "co_number":
          return (coNumberSortValue(a) - coNumberSortValue(b)) * dir
        case "schedule":
          return ((a.days_impact ?? 0) - (b.days_impact ?? 0)) * dir
        case "total":
          return (changeOrderTotalCents(a) - changeOrderTotalCents(b)) * dir
        case "created":
        default:
          return (new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()) * dir
      }
    })
    return sorted
  }, [filterProjectId, items, projectLookup, searchTerm, sortColumn, sortDir, statusFilter])

  const handleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortColumn(column)
      setSortDir("desc")
    }
  }

  const hasActiveFilters =
    searchTerm.trim().length > 0 ||
    statusFilter !== "all" ||
    (!hideProjectFilter && filterProjectId !== "all")

  const clearFilters = () => {
    setSearchTerm("")
    setStatusFilter("all")
    if (!hideProjectFilter) setFilterProjectId("all")
  }

  const handleNewChangeOrder = () => {
    setEditingChangeOrder(null)
    setSheetOpen(true)
  }

  async function handleSubmit(values: ChangeOrderInput) {
    startTransition(async () => {
      try {
        if (editingChangeOrder) {
          const shouldRecordOfflineApproval = values.status === "approved" && editingChangeOrder.status !== "approved"
          if (shouldRecordOfflineApproval) {
            const confirmed = window.confirm(
              "Record this change order as approved without an Arc executed document? Use this only when approval happened outside Arc.",
            )
            if (!confirmed) return
          }

          const updatedDetails = await updateChangeOrderAction(editingChangeOrder.id, {
            ...values,
            status: shouldRecordOfflineApproval ? editingChangeOrder.status as ChangeOrderInput["status"] : values.status,
          })
          const updated = shouldRecordOfflineApproval
            ? await approveChangeOrderAction(editingChangeOrder.id)
            : updatedDetails
          const mergedUpdated = { ...editingChangeOrder, ...updated }
          setItems((prev) => prev.map((item) => (item.id === mergedUpdated.id ? mergedUpdated : item)))
          if (selectedChangeOrder?.id === updated.id) {
            setSelectedChangeOrder(mergedUpdated)
          }
          setSheetOpen(false)
          setEditingChangeOrder(null)
          toast.success("Change order updated")
        } else {
          const created = await createChangeOrderAction(values)
          setItems((prev) => [created, ...prev])
          setSheetOpen(false)
          toast.success("Change order saved", {
            description: "Send it to the client portal when ready.",
          })
        }
      } catch (error: any) {
        console.error(error)
        toast.error(
          editingChangeOrder ? "Could not update change order" : "Could not save change order",
          { description: error?.message ?? "Please try again." }
        )
      }
    })
  }

  async function handleVoid(changeOrder: ChangeOrder) {
    const confirmed = window.confirm(
      `Void "${changeOrder.title}"? This reverses its impact on the contract value, GMP, budget, and pending draws. The change order is kept on record as cancelled.`
    )
    if (!confirmed) return

    startTransition(async () => {
      try {
        const updated = await voidChangeOrderAction(changeOrder.id)
        setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
        if (selectedChangeOrder?.id === updated.id) {
          setSelectedChangeOrder(updated)
        }
        toast.success("Change order voided", {
          description: "Its financial impact has been reversed.",
        })
      } catch (error: any) {
        console.error(error)
        toast.error("Could not void change order", {
          description: error?.message ?? "Please try again.",
        })
      }
    })
  }

  async function handleDelete(changeOrder: ChangeOrder) {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${changeOrder.title}"? This action cannot be undone.`
    )
    if (!confirmed) return

    startTransition(async () => {
      try {
        await deleteChangeOrderAction(changeOrder.id)
        setItems((prev) => prev.filter((item) => item.id !== changeOrder.id))
        toast.success("Change order deleted")
      } catch (error: any) {
        console.error(error)
        toast.error("Could not delete change order", {
          description: error?.message ?? "Please try again.",
        })
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
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {hasActiveFilters && (
              <Button variant="ghost" onClick={clearFilters} className="shrink-0 text-muted-foreground">
                Clear
              </Button>
            )}
            <Button onClick={handleNewChangeOrder} className="w-full sm:w-auto">
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
                const statusKey = resolveStatusKey(changeOrder)
                const total = formatMoneyFromCents(changeOrder.total_cents ?? changeOrder.totals?.total_cents)
                const impact =
                  changeOrder.days_impact != null && changeOrder.days_impact !== 0
                    ? `${changeOrder.days_impact} day${Math.abs(changeOrder.days_impact) === 1 ? "" : "s"}`
                    : "—"
                const gmp = resolveGmpBadge(changeOrder)

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
                          {resolveProjectBillingModel(projectLookup[changeOrder.project_id]) === "cost_plus_gmp" ? (
                            <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 font-normal ${gmp.className}`}>
                              {gmp.label}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 flex items-start gap-1.5">
                          <p className="min-w-0 font-semibold line-clamp-2">
                            {formatCoNumber(changeOrder) ? (
                              <span className="mr-1.5 font-mono text-xs font-medium text-muted-foreground">
                                {formatCoNumber(changeOrder)}
                              </span>
                            ) : null}
                            {changeOrder.title}
                          </p>
                          {changeOrder.linked_invoice ? (
                            <InvoiceLinkedBadge linkedInvoice={changeOrder.linked_invoice} compact />
                          ) : null}
                        </div>
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
                    <Button onClick={handleNewChangeOrder}>
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
                <TableRow className="sticky top-0 z-10 bg-muted/50 hover:bg-muted/50">
                  <SortHeader
                    label="CO #"
                    column="co_number"
                    activeColumn={sortColumn}
                    direction={sortDir}
                    onSort={handleSort}
                    className="w-[88px] pl-4"
                  />
                  <TableHead className="min-w-[280px]">Title</TableHead>
                  {!hideProjectFilter && (
                    <TableHead className="hidden w-[180px] md:table-cell">Project</TableHead>
                  )}
                  <TableHead className="w-[140px]">Status</TableHead>
                  <SortHeader
                    label="Schedule"
                    column="schedule"
                    activeColumn={sortColumn}
                    direction={sortDir}
                    onSort={handleSort}
                    className="hidden w-[120px] lg:table-cell"
                  />
                  <SortHeader
                    label="Created"
                    column="created"
                    activeColumn={sortColumn}
                    direction={sortDir}
                    onSort={handleSort}
                    className="hidden w-[130px] lg:table-cell"
                  />
                  <SortHeader
                    label="Total"
                    column="total"
                    activeColumn={sortColumn}
                    direction={sortDir}
                    onSort={handleSort}
                    align="right"
                    className="w-[150px] text-right"
                  />
                  <TableHead className="w-[140px] pr-3" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((changeOrder) => {
                  const projectName = projectLookup[changeOrder.project_id]?.name ?? "Unknown project"
                  const statusKey = resolveStatusKey(changeOrder)
                  const total = formatMoneyFromCents(changeOrder.total_cents ?? changeOrder.totals?.total_cents)
                  const coNumber = formatCoNumber(changeOrder)
                  const schedule = formatScheduleImpact(changeOrder.days_impact)
                  const isGmp = resolveProjectBillingModel(projectLookup[changeOrder.project_id]) === "cost_plus_gmp"
                  const gmp = resolveGmpBadge(changeOrder)
                  const approvedNotBilled = changeOrder.status === "approved" && !changeOrder.linked_invoice

                  return (
                    <TableRow
                      key={changeOrder.id}
                      className="group cursor-pointer"
                      onClick={() => handleRowClick(changeOrder)}
                    >
                      <TableCell className="pl-4 align-middle font-mono text-xs tabular-nums text-muted-foreground">
                        {coNumber ?? "—"}
                      </TableCell>

                      <TableCell className="max-w-0 align-middle">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{changeOrder.title}</span>
                          {isGmp ? (
                            <Badge variant="outline" className={`hidden h-4 shrink-0 px-1 py-0 text-[10px] font-normal lg:inline-flex ${gmp.className}`}>
                              {gmp.label}
                            </Badge>
                          ) : null}
                        </div>
                        {changeOrder.summary ? (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{changeOrder.summary}</span>
                        ) : null}
                      </TableCell>

                      {!hideProjectFilter && (
                        <TableCell className="hidden max-w-[180px] align-middle md:table-cell">
                          <span className="block truncate text-sm text-muted-foreground">{projectName}</span>
                        </TableCell>
                      )}

                      <TableCell className="align-middle">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant="secondary"
                            className={`h-5 px-1.5 text-[11px] font-medium capitalize border ${statusStyles[statusKey]}`}
                          >
                            {statusLabels[statusKey]}
                          </Badge>
                          {changeOrder.linked_invoice ? (
                            <InvoiceLinkedIcon linkedInvoice={changeOrder.linked_invoice} />
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="hidden align-middle lg:table-cell">
                        {schedule ? (
                          <span className={`text-sm ${schedule.className}`}>{schedule.label}</span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      <TableCell className="hidden align-middle text-sm text-muted-foreground lg:table-cell">
                        {changeOrder.created_at ? format(new Date(changeOrder.created_at), "MMM d, yyyy") : "—"}
                      </TableCell>

                      <TableCell className="align-middle text-right font-semibold tabular-nums">
                        {total}
                      </TableCell>

                      <TableCell className="pr-3 align-middle" onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          {approvedNotBilled ? (
                            <Button
                              type="button"
                              size="sm"
                              className="h-8"
                              onClick={() => handlePrepareInvoice(changeOrder)}
                            >
                              <Receipt className="mr-1.5 h-3.5 w-3.5" />
                              Invoice
                            </Button>
                          ) : null}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7 opacity-60 transition-opacity group-hover:opacity-100">
                                <MoreHorizontal className="h-3.5 w-3.5" />
                                <span className="sr-only">Actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleRowClick(changeOrder)}>
                                View details
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditingChangeOrder(changeOrder)
                                  setSheetOpen(true)
                                }}
                                disabled={isLockedFromEditing(changeOrder)}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit details
                              </DropdownMenuItem>
                              {canSendToClient(changeOrder) ? (
                                <DropdownMenuItem onClick={() => handleSendToClient(changeOrder)}>
                                  <PenLine className="mr-2 h-4 w-4" />
                                  {hasActiveClientChangeRequest(changeOrder) ? "Resend to client portal" : "Send to client portal"}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem asChild>
                                <a href={`/change-orders/${changeOrder.id}/export`} target="_blank" rel="noopener noreferrer">
                                  <FileText className="mr-2 h-4 w-4" />
                                  Download PDF
                                </a>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handlePrepareInvoice(changeOrder)}
                                disabled={changeOrder.status !== "approved" || Boolean(changeOrder.linked_invoice)}
                              >
                                <Receipt className="mr-2 h-4 w-4" />
                                {changeOrder.linked_invoice ? "Invoice prepared" : "Prepare invoice"}
                              </DropdownMenuItem>
                              {changeOrder.status === "approved" && (
                                <DropdownMenuItem
                                  onClick={() => handleVoid(changeOrder)}
                                  className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                                >
                                  <Ban className="mr-2 h-4 w-4" />
                                  Void
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => handleDelete(changeOrder)}
                                disabled={isLockedFromEditing(changeOrder)}
                                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}

                {filtered.length === 0 && !isPending && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={hideProjectFilter ? 7 : 8} className="h-48 text-center">
                      <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <FolderOpen className="h-6 w-6" />
                        </div>
                        <div className="max-w-[400px]">
                          <p className="font-medium text-foreground">
                            {hasActiveFilters ? "No matching change orders" : "No change orders yet"}
                          </p>
                          <p className="mt-0.5 text-sm">
                            {hasActiveFilters
                              ? "Try adjusting your search or filters."
                              : "Create your first change order to get started."}
                          </p>
                        </div>
                        <div className="mt-2">
                          {hasActiveFilters ? (
                            <Button variant="outline" size="sm" onClick={clearFilters}>
                              Clear filters
                            </Button>
                          ) : (
                            <Button variant="default" size="sm" onClick={handleNewChangeOrder}>
                              <Plus className="mr-2 h-4 w-4" />
                              Create change order
                            </Button>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}

                {isPending && filtered.length === 0 && (
                  <>
                    {[...Array(5)].map((_, idx) => (
                      <TableRow key={idx} className="hover:bg-transparent">
                        <TableCell colSpan={hideProjectFilter ? 7 : 8} className="py-3">
                          <Skeleton className="h-6 w-full rounded-md" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <ChangeOrderForm
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open)
          if (!open) setEditingChangeOrder(null)
        }}
        projectId={formProjectId}
        onSubmit={handleSubmit}
        isSubmitting={isPending}
        isGmpProject={isGmpProject}
        changeOrder={editingChangeOrder}
      />

      <ChangeOrderDetailSheet
        changeOrder={selectedChangeOrder}
        project={projects.find((p) => p.id === selectedChangeOrder?.project_id)}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
        onUpdate={handleUpdate}
        onEdit={handleEditFromDetail}
        onPrepareInvoice={handlePrepareInvoice}
      />

      {invoiceSource ? (
        <InvoiceComposerSheet
          open={invoiceComposerOpen}
          onOpenChange={(nextOpen) => {
            setInvoiceComposerOpen(nextOpen)
            if (!nextOpen) setInvoiceSource(null)
          }}
          projects={projects.filter((project) => project.id === invoiceSource.project_id)}
          defaultProjectId={invoiceSource.project_id}
          initialSourceChangeOrderId={invoiceSource.id}
          initialSourceChangeOrder={invoiceSource}
          onSubmit={handleCreateInvoice}
          isSubmitting={creatingInvoice}
          builderInfo={builderInfo}
        />
      ) : null}
    </>
  )
}

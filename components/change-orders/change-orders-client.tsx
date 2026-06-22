"use client"

import { useMemo, useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { format } from "date-fns"
import { toast } from "sonner"

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
import { Ban, FileCheck2, Pencil, Receipt, Trash2 } from "lucide-react"
import { ChangeOrderForm } from "@/components/change-orders/change-order-form"
import { ChangeOrderDetailSheet } from "@/components/change-orders/change-order-detail-sheet"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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

function resolveESignStatus(status?: ChangeOrder["esign_status"]) {
  switch (status) {
    case "draft":
      return { label: "Not sent", className: "bg-muted text-muted-foreground border-muted" }
    case "sent":
      return { label: "Out for signature", className: "bg-amber-500/15 text-amber-700 border-amber-500/30" }
    case "signed":
      return { label: "Signed", className: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30" }
    case "voided":
      return { label: "Voided", className: "bg-rose-500/15 text-rose-700 border-rose-500/30" }
    case "expired":
      return { label: "Expired", className: "bg-orange-500/15 text-orange-700 border-orange-500/30" }
    default:
      return { label: "Not sent", className: "bg-muted text-muted-foreground border-muted" }
  }
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  awaiting_approval: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  approved: "bg-success/20 text-success border-success/30",
  requested_changes: "bg-amber-100 text-amber-800 border-amber-200",
  voided: "bg-destructive/20 text-destructive border-destructive/30",
}

function formatMoneyFromCents(cents?: number | null) {
  const value = (cents ?? 0) / 100
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function resolveStatusKey(status?: string | null): StatusKey {
  if (!status) return "draft"
  if (status === "pending" || status === "sent") return "awaiting_approval"
  if (status === "cancelled" || status === "void") return "voided"
  const allowed: StatusKey[] = ["draft", "approved", "requested_changes"]
  return allowed.includes(status as StatusKey) ? (status as StatusKey) : "draft"
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

interface ChangeOrdersClientProps {
  changeOrders: ChangeOrder[]
  projects: Project[]
  hideProjectFilter?: boolean
}

export function ChangeOrdersClient({ changeOrders, projects, hideProjectFilter }: ChangeOrdersClientProps) {
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
  const [editingChangeOrder, setEditingChangeOrder] = useState<ChangeOrder | null>(null)
  const [signatureOpen, setSignatureOpen] = useState(false)
  const [signatureSource, setSignatureSource] = useState<EnvelopeWizardSourceEntity | null>(null)
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

  const handleStartSignature = (changeOrder: ChangeOrder) => {
    setSignatureSource({
      type: "change_order",
      id: changeOrder.id,
      project_id: changeOrder.project_id,
      title: changeOrder.title,
      document_type: "change_order",
    })
    setSignatureOpen(true)
  }

  const handlePrepareInvoice = (changeOrder: ChangeOrder) => {
    setInvoiceSource(changeOrder)
    setInvoiceComposerOpen(true)
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
            description: "Send your company document for signature when ready.",
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
          <div className="flex w-full gap-2 sm:w-auto">
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
                const statusKey = resolveStatusKey(changeOrder.status)
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
                          {(() => {
                            const esign = resolveESignStatus(changeOrder.esign_status)
                            return (
                              <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 font-normal ${esign.className}`}>
                                {esign.label}
                              </Badge>
                            )
                          })()}
                          {resolveProjectBillingModel(projectLookup[changeOrder.project_id]) === "cost_plus_gmp" ? (
                            <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 font-normal ${gmp.className}`}>
                              {gmp.label}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 flex items-start gap-1.5">
                          <p className="min-w-0 font-semibold line-clamp-2">{changeOrder.title}</p>
                          {changeOrder.linked_invoice ? (
                            <FileCheck2
                              aria-label="Invoice linked"
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600"
                            >
                              <title>
                                {changeOrder.linked_invoice.invoice_number
                                  ? `Linked to invoice ${changeOrder.linked_invoice.invoice_number}`
                                  : "Linked to an invoice"}
                              </title>
                            </FileCheck2>
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
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[40%] min-w-[320px] pl-4">Title</TableHead>
                  {!hideProjectFilter && (
                    <TableHead className="hidden md:table-cell w-[184px]">Project</TableHead>
                  )}
                  <TableHead className="hidden lg:table-cell w-[112px] text-center">Created</TableHead>
                  <TableHead className="hidden xl:table-cell w-[112px] text-center">Impact</TableHead>
                  <TableHead className="hidden sm:table-cell w-[140px] text-right">Total</TableHead>
                  <TableHead className="hidden sm:table-cell w-[128px] text-center">Status</TableHead>
                  <TableHead className="hidden xl:table-cell w-[150px] text-center">Signature</TableHead>
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
                  const gmp = resolveGmpBadge(changeOrder)

                  return (
                    <TableRow
                      key={changeOrder.id}
                      className="group cursor-pointer hover:bg-muted/30 h-[64px]"
                      onClick={() => handleRowClick(changeOrder)}
                    >
                      <TableCell className="min-w-0 pl-4">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 truncate text-sm font-medium">{changeOrder.title}</span>
                          {changeOrder.linked_invoice ? (
                            <FileCheck2
                              aria-label="Invoice linked"
                              className="h-3.5 w-3.5 shrink-0 text-sky-600"
                            >
                              <title>
                                {changeOrder.linked_invoice.invoice_number
                                  ? `Linked to invoice ${changeOrder.linked_invoice.invoice_number}`
                                  : "Linked to an invoice"}
                              </title>
                            </FileCheck2>
                          ) : null}
                        </div>
                        {changeOrder.summary ? (
                          <span className="text-xs text-muted-foreground truncate block mt-0.5">{changeOrder.summary}</span>
                        ) : null}
                        {resolveProjectBillingModel(projectLookup[changeOrder.project_id]) === "cost_plus_gmp" ? (
                          <Badge variant="outline" className={`mt-1 text-[10px] px-1 py-0 h-4 font-normal ${gmp.className}`}>
                            {gmp.label}
                          </Badge>
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
                        {(() => {
                          const esign = resolveESignStatus(changeOrder.esign_status)
                          return (
                            <Badge variant="secondary" className={`text-[10px] px-1 py-0 h-4 font-normal border ${esign.className}`}>
                              {esign.label}
                            </Badge>
                          )
                        })()}
                      </TableCell>

                      <TableCell className="pr-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end">
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
                                disabled={changeOrder.status === "approved" || changeOrder.status === "cancelled" || changeOrder.esign_status === "sent" || changeOrder.esign_status === "signed"}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit details
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleStartSignature(changeOrder)}>
                                <PenLine className="mr-2 h-4 w-4" />
                                Send for signature
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
                                disabled={changeOrder.status === "approved" || changeOrder.esign_status === "sent" || changeOrder.esign_status === "signed"}
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
                          <Button variant="default" size="sm" onClick={handleNewChangeOrder}>
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
          onSubmit={handleCreateInvoice}
          isSubmitting={creatingInvoice}
        />
      ) : null}

      <EnvelopeWizard
        open={signatureOpen}
        onOpenChange={(nextOpen) => {
          setSignatureOpen(nextOpen)
          if (!nextOpen) setSignatureSource(null)
        }}
        sourceEntity={signatureSource}
        sourceLabel="Change order"
        sheetTitle="Send change order for signature"
        onEnvelopeSent={async ({ documentId }) => {
          if (!signatureSource) return
          try {
            const published = await publishChangeOrderAction(signatureSource.id)
            setItems((prev) => prev.map((item) => item.id === signatureSource.id
              ? { ...item, ...published, esign_status: "sent", esign_document_id: documentId }
              : item))
          } catch (error: any) {
            setItems((prev) => prev.map((item) => item.id === signatureSource.id
              ? { ...item, esign_status: "sent", esign_document_id: documentId }
              : item))
            toast.error("Signature sent, but status could not be updated", {
              description: error?.message ?? "Refresh and try again.",
            })
          }
        }}
      />
    </>
  )
}

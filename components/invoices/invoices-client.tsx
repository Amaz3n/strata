"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"
import { AnimatePresence } from "framer-motion"

import type { Contact, CostCode, Invoice, Project, InvoiceView } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import {
  createInvoiceAction,
  generateInvoiceLinkAction,
  getInvoiceDetailAction,
  listInvoicesAction,
  manualResyncInvoiceAction,
  retryFailedInvoiceSyncsAction,
  sendInvoiceReminderAction,
  syncPendingInvoicesNowAction,
  updateInvoiceAction,
} from "@/app/(app)/invoices/actions"
import { InvoiceComposerSheet } from "@/components/invoices/invoice-composer-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { QBOSyncBadge } from "@/components/invoices/qbo-sync-badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Plus, Building2, Calendar, Filter, FolderOpen, List, MoreHorizontal, RefreshCcw } from "@/components/icons"
import { InvoiceDetailSheet } from "@/components/invoices/invoice-detail-sheet"
import { InvoiceBottomBar } from "@/components/invoices/invoice-bottom-bar"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

type StatusKey = "draft" | "saved" | "sent" | "partial" | "paid" | "overdue" | "void"
type StatusFilter = StatusKey | "all"
type DueFilter = "any" | "due_soon" | "overdue" | "no_due"

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  saved: "Saved",
  sent: "Sent",
  partial: "Partial",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  saved: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  partial: "bg-purple-500/15 text-purple-700 border-purple-500/30",
  paid: "bg-success/20 text-success border-success/30",
  overdue: "bg-destructive/20 text-destructive border-destructive/30",
  void: "bg-muted text-muted-foreground border-muted",
}

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function resolveStatusKey(status?: string | null): StatusKey {
  if (!status) return "draft"
  const allowed: StatusKey[] = ["draft", "saved", "sent", "partial", "paid", "overdue", "void"]
  return allowed.includes(status as StatusKey) ? (status as StatusKey) : "draft"
}

interface InvoicesClientProps {
  invoices: Invoice[]
  projects: Project[]
  initialOpenInvoiceId?: string
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  contacts?: Contact[]
  costCodes?: CostCode[]
}

export function InvoicesClient({ invoices, projects, initialOpenInvoiceId, builderInfo, contacts, costCodes }: InvoicesClientProps) {
  const [items, setItems] = useState<Invoice[]>(invoices)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [filterProjectId, setFilterProjectId] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [dueFilter, setDueFilter] = useState<DueFilter>("any")
  const [searchTerm, setSearchTerm] = useState("")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null)
  const [detailLink, setDetailLink] = useState<string | undefined>(undefined)
  const [detailViews, setDetailViews] = useState<InvoiceView[] | undefined>(undefined)
  const [detailSyncHistory, setDetailSyncHistory] = useState<
    Array<{ id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }>
  >()
  const [isResyncing, setIsResyncing] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [queueRefreshing, setQueueRefreshing] = useState(false)
  const [queueSyncingPending, setQueueSyncingPending] = useState(false)
  const [queueRetryingFailed, setQueueRetryingFailed] = useState(false)
  const [queueSyncingInvoiceId, setQueueSyncingInvoiceId] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null)
  const [sendingReminderId, setSendingReminderId] = useState<string | null>(null)
  const didAutoOpen = useRef(false)

  useEffect(() => {
    if (!initialOpenInvoiceId || didAutoOpen.current) return
    didAutoOpen.current = true
    void handleOpenDetail(initialOpenInvoiceId)
  }, [initialOpenInvoiceId])

  const projectLookup = useMemo(() => {
    return projects.reduce<Record<string, Project>>((acc, project) => {
      acc[project.id] = project
      return acc
    }, {})
  }, [projects])

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const soon = addDays(today, 7)

    return items.filter((item) => {
      const matchesProject = filterProjectId === "all" || item.project_id === filterProjectId
      const resolvedStatus = resolveStatusKey(item.status)
      const matchesStatus = statusFilter === "all" || resolvedStatus === statusFilter

      const dueDate = item.due_date ? new Date(item.due_date) : null
      if (dueDate) dueDate.setHours(0, 0, 0, 0)
      const matchesDue =
        dueFilter === "any"
          ? true
          : dueFilter === "no_due"
            ? !dueDate
            : dueDate
              ? dueFilter === "overdue"
                ? dueDate < today
                : dueDate >= today && dueDate <= soon
              : false

      const matchesSearch =
        term.length === 0 ||
        [item.title ?? "", item.invoice_number ?? "", (item.project_id ? projectLookup[item.project_id]?.name : "") ?? ""].some((value) =>
          value.toLowerCase().includes(term),
        )

      return matchesProject && matchesStatus && matchesDue && matchesSearch
    })
  }, [dueFilter, filterProjectId, items, projectLookup, searchTerm, statusFilter])

  const visibleIds = useMemo(() => filtered.map((item) => item.id), [filtered])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  const someVisibleSelected = visibleIds.some((id) => selectedIds.includes(id)) && !allVisibleSelected
  const qboPendingCount = useMemo(() => items.filter((item) => item.qbo_sync_status === "pending").length, [items])
  const qboErrorCount = useMemo(() => items.filter((item) => item.qbo_sync_status === "error").length, [items])
  const queueItems = useMemo(
    () =>
      items
        .filter((item) => item.qbo_sync_status === "pending" || item.qbo_sync_status === "error")
        .sort((a, b) => Number(new Date(b.created_at ?? 0)) - Number(new Date(a.created_at ?? 0))),
    [items],
  )

  async function refreshInvoices() {
    setQueueRefreshing(true)
    try {
      const scopedProjectId = projects.length === 1 ? projects[0]?.id : undefined
      const fresh = await listInvoicesAction(scopedProjectId)
      setItems(fresh)
    } catch (error: any) {
      console.error(error)
      toast.error("Could not refresh invoices", { description: error?.message ?? "Please try again." })
    } finally {
      setQueueRefreshing(false)
    }
  }

  async function handleQueueSyncPending() {
    setQueueSyncingPending(true)
    try {
      const result = await syncPendingInvoicesNowAction()
      toast.success("Sync run complete", {
        description: `${result.processed ?? 0} pending invoices synced`,
      })
      await refreshInvoices()
    } catch (error: any) {
      console.error(error)
      toast.error("Sync failed", { description: error?.message ?? "Please try again." })
    } finally {
      setQueueSyncingPending(false)
    }
  }

  async function handleQueueRetryFailed() {
    setQueueRetryingFailed(true)
    try {
      const result = await retryFailedInvoiceSyncsAction()
      toast.success("Retry queued", {
        description: `${result.retried_invoices ?? 0} failed invoices retried`,
      })
      await refreshInvoices()
    } catch (error: any) {
      console.error(error)
      toast.error("Retry failed", { description: error?.message ?? "Please try again." })
    } finally {
      setQueueRetryingFailed(false)
    }
  }

  async function handleQueueSyncOne(invoiceId: string) {
    setQueueSyncingInvoiceId(invoiceId)
    try {
      await manualResyncInvoiceAction(invoiceId)
      toast.success("Invoice synced")
      await refreshInvoices()
    } catch (error: any) {
      console.error(error)
      toast.error("Sync failed", { description: error?.message ?? "Please try again." })
    } finally {
      setQueueSyncingInvoiceId(null)
    }
  }

  async function handleCreate(values: InvoiceInput, sendToClient: boolean, options?: { silent?: boolean }) {
    setIsCreating(true)
    try {
      const created = await createInvoiceAction(values)
      setItems((prev) => [created, ...prev])
      setSheetOpen(false)
      if (!options?.silent) {
        toast.success(sendToClient ? "Invoice sent" : "Invoice saved", {
          description: sendToClient ? "Client can now view this invoice." : "Invoice saved to receivables.",
        })
      }
      return created
    } catch (error: any) {
      console.error(error)
      toast.error("Could not save invoice", { description: error?.message ?? "Please try again." })
      throw error
    } finally {
      setIsCreating(false)
    }
  }

  async function handleUpdate(values: InvoiceInput, sendToClient: boolean, options?: { silent?: boolean }) {
    if (!editingInvoice) {
      throw new Error("No invoice selected for editing")
    }
    setIsUpdating(true)
    try {
      const updated = await updateInvoiceAction(editingInvoice.id, values)
      setItems((prev) => prev.map((inv) => (inv.id === updated.id ? updated : inv)))
      if (!options?.silent) {
        toast.success(sendToClient ? "Invoice sent" : "Invoice saved")
      }
      if (sendToClient) {
        setEditOpen(false)
        setEditingInvoice(null)
      }
      return updated
    } catch (error: any) {
      console.error(error)
      toast.error("Could not update invoice", { description: error?.message ?? "Please try again." })
      throw error
    } finally {
      setIsUpdating(false)
    }
  }

  async function handleShare(invoiceId: string) {
    setLinkingId(invoiceId)
    try {
      const result = await generateInvoiceLinkAction(invoiceId)
      setItems((prev) => prev.map((inv) => (inv.id === invoiceId ? { ...inv, token: result.token } : inv)))

      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(result.url)
        toast.success("Share link copied", { description: result.url })
      } else {
        toast.success("Share link ready", { description: result.url })
      }
    } catch (error: any) {
      console.error(error)
      toast.error("Could not generate link", { description: error?.message ?? "Please try again." })
    } finally {
      setLinkingId(null)
    }
  }

  async function handleSendReminder(invoice: Invoice) {
    setSendingReminderId(invoice.id)
    try {
      await sendInvoiceReminderAction(invoice.id)
      toast.success("Reminder sent", {
        description: `Payment reminder sent for invoice ${invoice.invoice_number}`,
      })
    } catch (error: any) {
      console.error(error)
      toast.error("Could not send reminder", { description: error?.message ?? "Please try again." })
    } finally {
      setSendingReminderId(null)
    }
  }

  async function handleOpenDetail(invoiceId: string) {
    setDetailOpen(true)
    setDetailLoading(true)
    setDetailInvoice(null)
    setDetailLink(undefined)
    setDetailViews(undefined)
    setDetailSyncHistory(undefined)
    try {
      const result = await getInvoiceDetailAction(invoiceId)
      setDetailInvoice(result.invoice)
      setDetailLink(result.link)
      setDetailViews(result.views as InvoiceView[])
      setDetailSyncHistory(result.syncHistory as any)
    } catch (error: any) {
      console.error(error)
      toast.error("Could not load invoice", { description: error?.message ?? "Please try again." })
    } finally {
      setDetailLoading(false)
    }
  }

  function toggleSelectAll(checked: boolean | "indeterminate") {
    if (checked) {
      const merged = Array.from(new Set([...selectedIds, ...visibleIds]))
      setSelectedIds(merged)
    } else {
      setSelectedIds((prev) => prev.filter((id) => !visibleIds.includes(id)))
    }
  }

  function toggleSelectOne(id: string, checked: boolean | "indeterminate") {
    if (checked) {
      setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    } else {
      setSelectedIds((prev) => prev.filter((itemId) => itemId !== id))
    }
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-xl">
          <div className="relative">
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search or filter"
              className="pr-12"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 border-0 shadow-none hover:bg-muted"
                >
                  <Filter className="h-4 w-4" />
                  <span className="sr-only">Filters</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Building2 className="mr-2 h-4 w-4" />
                    By project
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56" sideOffset={8}>
                    <DropdownMenuRadioGroup value={filterProjectId} onValueChange={setFilterProjectId}>
                      <DropdownMenuRadioItem value="all">All projects</DropdownMenuRadioItem>
                      {projects.map((project) => (
                        <DropdownMenuRadioItem key={project.id} value={project.id}>
                          {project.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Calendar className="mr-2 h-4 w-4" />
                    By due date
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56" sideOffset={8}>
                    <DropdownMenuRadioGroup value={dueFilter} onValueChange={(value) => setDueFilter(value as DueFilter)}>
                      <DropdownMenuRadioItem value="any">Any due date</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="due_soon">Due in next 7 days</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="overdue">Overdue</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="no_due">No due date</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <List className="mr-2 h-4 w-4" />
                    Status
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56" sideOffset={8}>
                    <DropdownMenuRadioGroup
                      value={statusFilter}
                      onValueChange={(value) => setStatusFilter(value as StatusFilter)}
                    >
                      <DropdownMenuRadioItem value="all">Any status</DropdownMenuRadioItem>
                      {(["draft", "saved", "sent", "partial", "paid", "overdue", "void"] as StatusKey[]).map((status) => (
                        <DropdownMenuRadioItem key={status} value={status}>
                          {statusLabels[status]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={() => setQueueOpen(true)} className="w-full sm:w-auto">
            <RefreshCcw className="h-4 w-4 mr-2" />
            Sync queue
            {(qboPendingCount > 0 || qboErrorCount > 0) && (
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px]">
                {qboPendingCount} pending / {qboErrorCount} failed
              </span>
            )}
          </Button>
          <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            New invoice
          </Button>
        </div>
      </div>

      <InvoiceComposerSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isCreating}
        builderInfo={builderInfo}
        contacts={contacts}
        costCodes={costCodes}
      />
      <InvoiceComposerSheet
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open)
          if (!open) setEditingInvoice(null)
        }}
        projects={projects}
        defaultProjectId={editingInvoice?.project_id ?? (filterProjectId !== "all" ? filterProjectId : projects[0]?.id)}
        onSubmit={handleUpdate}
        isSubmitting={isUpdating}
        builderInfo={builderInfo}
        contacts={contacts}
        costCodes={costCodes}
        mode="edit"
        invoice={editingInvoice}
      />
      <Sheet open={queueOpen} onOpenChange={setQueueOpen}>
        <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>QuickBooks Sync Queue</SheetTitle>
            <SheetDescription>Review pending and failed invoice syncs, then trigger targeted actions.</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Pending</p>
                <p className="text-2xl font-semibold">{qboPendingCount}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Failed</p>
                <p className="text-2xl font-semibold">{qboErrorCount}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={refreshInvoices} disabled={queueRefreshing}>
                {queueRefreshing ? "Refreshing..." : "Refresh"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleQueueSyncPending} disabled={queueSyncingPending || qboPendingCount === 0}>
                {queueSyncingPending ? "Syncing pending..." : "Sync pending"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleQueueRetryFailed} disabled={queueRetryingFailed || qboErrorCount === 0}>
                {queueRetryingFailed ? "Retrying failed..." : "Retry failed"}
              </Button>
            </div>

            <div className="space-y-2">
              {queueItems.length === 0 ? (
                <div className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">No invoices in sync queue.</div>
              ) : (
                queueItems.map((invoice) => (
                  <div key={invoice.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{invoice.invoice_number || invoice.title || "Untitled invoice"}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatMoneyFromCents(invoice.total_cents ?? invoice.totals?.total_cents)} • {invoice.qbo_sync_status === "error" ? "Failed" : "Pending"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={queueSyncingInvoiceId === invoice.id}
                        onClick={() => handleQueueSyncOne(invoice.id)}
                      >
                        {queueSyncingInvoiceId === invoice.id ? "Syncing..." : "Sync now"}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <AnimatePresence>
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="divide-x">
                <TableHead className="w-12 py-4 text-center relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Checkbox
                      checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                      onCheckedChange={toggleSelectAll}
                      aria-label="Select all invoices"
                    />
                  </div>
                </TableHead>
                <TableHead className="min-w-[90px] px-4 py-4">Invoice No.</TableHead>
                <TableHead className="px-4 py-4">Project</TableHead>
                <TableHead className="px-4 py-4 text-center">Issue date</TableHead>
                <TableHead className="px-4 py-4 text-center">Due date</TableHead>
                <TableHead className="text-right px-4 py-4">Amount</TableHead>
                <TableHead className="px-4 py-4 text-center">Status</TableHead>
                <TableHead className="px-4 py-4 text-center">QuickBooks</TableHead>
                <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((invoice) => {
                const projectName = (invoice.project_id ? projectLookup[invoice.project_id]?.name : "") ?? "Unknown project"
                const total = formatMoneyFromCents(invoice.total_cents ?? invoice.totals?.total_cents)
                const invoiceLabel = invoice.invoice_number || invoice.title || "Untitled invoice"
                return (
                  <TableRow key={invoice.id} className="align-top divide-x">
                    <TableCell className="w-12 text-center align-middle py-4 relative">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Checkbox
                          checked={selectedIds.includes(invoice.id)}
                          onCheckedChange={(checked) => toggleSelectOne(invoice.id, checked)}
                          aria-label={`Select invoice ${invoice.invoice_number ?? invoice.title ?? ""}`}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => handleOpenDetail(invoice.id)}
                          className="font-semibold text-left hover:text-primary transition-colors"
                          aria-label={`View invoice ${invoice.invoice_number ?? invoice.title ?? ""}`}
                        >
                          {invoiceLabel}
                        </button>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4 text-muted-foreground">
                      {projectName}
                    </TableCell>
                    <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                      {invoice.issue_date ? format(new Date(invoice.issue_date), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                      {invoice.due_date ? format(new Date(invoice.due_date), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="px-4 py-4 text-right">
                      <div className="font-semibold">{total}</div>
                    </TableCell>
                    <TableCell className="px-4 py-4 text-center">
                      <Badge
                        variant="secondary"
                        className={`capitalize border ${statusStyles[resolveStatusKey(invoice.status)]}`}
                      >
                        {statusLabels[resolveStatusKey(invoice.status)]}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-4 text-center">
                      <QBOSyncBadge
                        status={invoice.qbo_sync_status}
                        syncedAt={invoice.qbo_synced_at ?? undefined}
                        qboId={invoice.qbo_id ?? undefined}
                      />
                    </TableCell>
                    <TableCell className="text-center w-12 px-4 py-4">
                      <div className="flex justify-center">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Invoice actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault()
                                setEditingInvoice(invoice)
                                setEditOpen(true)
                              }}
                            >
                              Edit invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={linkingId === invoice.id}
                              onSelect={(event) => {
                                event.preventDefault()
                                handleShare(invoice.id)
                              }}
                            >
                              {linkingId === invoice.id ? "Copying…" : "Copy link"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={
                                invoice.status === "paid" ||
                                invoice.status === "void" ||
                                sendingReminderId === invoice.id
                              }
                              onSelect={(event) => {
                                event.preventDefault()
                                handleSendReminder(invoice)
                              }}
                              className={
                                invoice.status === "paid" || invoice.status === "void"
                                  ? "text-muted-foreground"
                                  : ""
                              }
                            >
                              {sendingReminderId === invoice.id ? "Sending…" : "Send reminder"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filtered.length === 0 && !isCreating && (
                <TableRow className="divide-x">
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <FolderOpen className="h-6 w-6" />
                      </div>
                      <div>
                        <p className="font-medium">No invoices yet</p>
                        <p className="text-sm">Create your first invoice to get started.</p>
                      </div>
                      <Button onClick={() => setSheetOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        Create invoice
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {isCreating && filtered.length === 0 && (
                <TableRow className="divide-x">
                  <TableCell colSpan={7}>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {[...Array(3)].map((_, idx) => (
                        <Skeleton key={idx} className="h-24 w-full rounded-md" />
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {selectedIds.length > 0 && (
          <InvoiceBottomBar
            selectedCount={selectedIds.length}
            onDeselectAll={() => setSelectedIds([])}
          />
        )}
      </AnimatePresence>

      <InvoiceDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        invoice={detailInvoice}
        link={detailLink}
        views={detailViews}
        syncHistory={detailSyncHistory}
        loading={detailLoading}
        manualResyncing={isResyncing}
        onCopyLink={async () => {
          if (detailLink && typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(detailLink)
            toast.success("Link copied")
          }
        }}
        onManualResync={async () => {
          if (!detailInvoice) return
          setIsResyncing(true)
          try {
            await manualResyncInvoiceAction(detailInvoice.id)
            toast.success("Resync enqueued")
            await handleOpenDetail(detailInvoice.id)
          } catch (error: any) {
            console.error(error)
            toast.error("Failed to resync", { description: error?.message ?? "Please try again." })
          } finally {
            setIsResyncing(false)
          }
        }}
        onEdit={
          detailInvoice
            ? () => {
              setEditingInvoice(detailInvoice)
              setEditOpen(true)
              setDetailOpen(false)
            }
            : undefined
        }
      />
    </div>
  )
}

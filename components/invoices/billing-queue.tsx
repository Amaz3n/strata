"use client"

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { ChevronDown, ChevronUp, X } from "lucide-react"

import type { Invoice, Project } from "@/lib/types"
import type { OwnerBillingPackageSummary } from "@/lib/services/owner-billing-packages"
import type { InvoiceArSummary, InvoiceQueueKey, InvoiceSortKey } from "@/lib/services/invoices"
import {
  deleteInvoiceAction,
  generateInvoiceLinkAction,
  getInvoiceDetailAction,
  issueInvoiceAction,
  listMovableProjectsAction,
  loadInvoiceQueueAction,
  manualResyncInvoiceAction,
  moveInvoiceToProjectAction,
  reviseInvoiceAction,
  sendInvoiceReminderAction,
  voidInvoiceAction,
} from "@/app/(app)/invoices/actions"
import {
  generateOwnerBillingPackageAction,
  shareOwnerBillingPackageAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import { copyText } from "@/lib/clipboard"
import { AGING_BUCKET_LABELS, agingBucketIndex } from "@/lib/financials/invoice-lifecycle"
import { newInvoiceHref, resumeInvoiceHref } from "@/lib/financials/invoice-destinations"
import { cn } from "@/lib/utils"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import { AccountingSyncSheet } from "@/components/integrations/accounting-sync-sheet"
import { useProductTerminology } from "@/components/layout/use-product-terminology"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Building2, FolderOpen, MoreHorizontal, Plus, Search } from "@/components/icons"

import { InvoiceBottomBar } from "./invoice-bottom-bar"
import { InvoiceSchedulesDialog, MakeRecurringDialog } from "./invoice-schedules"
import { InvoiceInspector, type InvoiceDetailBundle } from "./invoice-inspector"
import {
  InvoiceStatusBadge,
  NEXT_ACTION_TONES,
  balanceCentsOf,
  customerNameOf,
  displayStatusOf,
  formatMoneyCompact,
  formatMoneyFromCents,
  invoiceNeedsAttention,
  invoiceReleaseDescription,
  isEditableInvoice,
  isOpenInvoice,
  nextActionFor,
  overdueDaysOf,
  totalCentsOf,
} from "./invoice-presentation"

const PAGE_SIZE = 100

/**
 * The queues, in the order the work happens: prepare it, get it approved, send
 * it, collect it, chase what broke. The ordering IS the page's argument — a
 * receivables list is a pipeline, not a status filter — which is why "All" sits
 * at the end as the fallback rather than leading.
 */
const QUEUES: Array<{ key: InvoiceQueueKey; label: string; hint: string }> = [
  { key: "preparing", label: "Preparing", hint: "Drafts still being put together" },
  { key: "awaiting_approval", label: "Awaiting approval", hint: "Sent for sign-off, not yet approved" },
  { key: "ready", label: "Ready to issue", hint: "Approved and waiting on someone to send it" },
  { key: "open", label: "Open", hint: "Issued, not yet due" },
  { key: "overdue", label: "Overdue", hint: "Past due with money outstanding" },
  { key: "exceptions", label: "Exceptions", hint: "Delivery or accounting sync needs a person" },
  { key: "paid", label: "Paid", hint: "Settled in full" },
  { key: "all", label: "All", hint: "Everything, including voids" },
]

type Counts = Record<InvoiceQueueKey, number>

export interface BillingQueueProps {
  projectId?: string
  /** The projects this surface can bill. One on a project workbench; many on the org desk. */
  projects: Project[]
  initialInvoices: Invoice[]
  initialTotalCount: number
  initialCounts: Counts
  arSummary?: InvoiceArSummary | null
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  ownerBillingPackages?: OwnerBillingPackageSummary[]
  enableApprovedCostsSource?: boolean
  /** Rendered inside the toolbar; the project workbench passes its artifact tabs. */
  toolbarLeading?: ReactNode
}

export function BillingQueue({
  projectId,
  projects,
  initialInvoices,
  initialTotalCount,
  initialCounts,
  arSummary,
  builderInfo,
  ownerBillingPackages = [],
  enableApprovedCostsSource,
  toolbarLeading,
}: BillingQueueProps) {
  const terms = useProductTerminology()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedId = searchParams.get("invoice")

  const [queue, setQueue] = useState<InvoiceQueueKey>("all")
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<InvoiceSortKey>("activity")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")
  const [agingFilter, setAgingFilter] = useState<0 | 1 | 2 | 3 | null>(null)

  const [rows, setRows] = useState<Invoice[]>(initialInvoices)
  const [totalCount, setTotalCount] = useState(initialTotalCount)
  const [counts, setCounts] = useState<Counts>(initialCounts)
  const [loadingRows, setLoadingRows] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [detail, setDetail] = useState<InvoiceDetailBundle | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [autoPaymentFor, setAutoPaymentFor] = useState<string | null>(null)

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkMode, setBulkMode] = useState(false)
  const [sendingBulk, setSendingBulk] = useState(false)

  const [schedulesOpen, setSchedulesOpen] = useState(false)
  const [syncQueueOpen, setSyncQueueOpen] = useState(false)
  const [recurringInvoice, setRecurringInvoice] = useState<Invoice | null>(null)
  const [voidingInvoice, setVoidingInvoice] = useState<Invoice | null>(null)
  const [revisingInvoice, setRevisingInvoice] = useState<Invoice | null>(null)
  const [deletingInvoice, setDeletingInvoice] = useState<Invoice | null>(null)
  const [movingInvoice, setMovingInvoice] = useState<Invoice | null>(null)
  const [destructiveBusy, setDestructiveBusy] = useState(false)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  const [packages, setPackages] = useState<OwnerBillingPackageSummary[]>(ownerBillingPackages)
  const [newInvoiceProjectOpen, setNewInvoiceProjectOpen] = useState(false)
  const [, startTransition] = useTransition()

  const scopedProject = projects.length === 1 ? projects[0] : null
  const effectiveProjectId = projectId ?? scopedProject?.id
  const releaseDescription = invoiceReleaseDescription(Boolean(enableApprovedCostsSource))

  useEffect(() => {
    setRows(initialInvoices)
    setTotalCount(initialTotalCount)
    setCounts(initialCounts)
  }, [initialInvoices, initialTotalCount, initialCounts])

  useEffect(() => {
    setPackages(ownerBillingPackages)
  }, [ownerBillingPackages])

  const selectInvoice = useCallback(
    (invoiceId: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (invoiceId) params.set("invoice", invoiceId)
      else params.delete("invoice")
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  // ── The list. Filtering, sorting, counting and paging all happen server-side,
  // so a queue chip's number and the rows under it describe the same book.
  const requestSeq = useRef(0)
  const reloadRows = useCallback(
    async (opts?: { silent?: boolean }) => {
      const seq = ++requestSeq.current
      if (!opts?.silent) setLoadingRows(true)
      try {
        const result = unwrapAction(
          await loadInvoiceQueueAction(effectiveProjectId, {
            limit: PAGE_SIZE,
            queue,
            search: search.trim() || undefined,
            sort,
            sortDirection,
          }),
        )
        if (seq !== requestSeq.current) return
        setRows(result.invoices)
        setTotalCount(result.totalCount)
        setCounts(result.counts)
        setListError(null)
      } catch (error) {
        if (seq !== requestSeq.current) return
        setListError(error instanceof Error ? error.message : "The invoice list could not be loaded.")
      } finally {
        if (seq === requestSeq.current) setLoadingRows(false)
      }
    },
    [effectiveProjectId, queue, search, sort, sortDirection],
  )

  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const handle = setTimeout(() => void reloadRows(), 250)
    return () => clearTimeout(handle)
  }, [reloadRows])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const result = unwrapAction(
        await loadInvoiceQueueAction(effectiveProjectId, {
          limit: PAGE_SIZE,
          offset: rows.length,
          queue,
          search: search.trim() || undefined,
          sort,
          sortDirection,
        }),
      )
      setRows((prev) => {
        const known = new Set(prev.map((invoice) => invoice.id))
        return [...prev, ...result.invoices.filter((invoice) => !known.has(invoice.id))]
      })
      setTotalCount(result.totalCount)
    } catch (error) {
      toast.error("Could not load more invoices", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setLoadingMore(false)
    }
  }

  // ── The inspector. A late response for an invoice the user has already left
  // must never overwrite the one they are looking at now.
  const detailSeq = useRef(0)
  const loadDetail = useCallback(async (invoiceId: string) => {
    const seq = ++detailSeq.current
    setDetailLoading(true)
    try {
      const result = unwrapAction(await getInvoiceDetailAction(invoiceId))
      if (seq !== detailSeq.current) return null
      setDetail(result)
      return result
    } catch (error) {
      if (seq !== detailSeq.current) return null
      toast.error("Could not load the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
      setDetail(null)
      return null
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedId) {
      detailSeq.current += 1
      setDetail(null)
      setDetailLoading(false)
      return
    }
    if (detail?.invoice.id === selectedId) return
    void loadDetail(selectedId)
  }, [selectedId, detail?.invoice.id, loadDetail])

  const refreshAll = useCallback(async () => {
    await reloadRows({ silent: true })
    if (selectedId) await loadDetail(selectedId)
    startTransition(() => router.refresh())
  }, [loadDetail, reloadRows, router, selectedId])

  // ── Row actions ────────────────────────────────────────────────────────────
  async function runRowAction(invoice: Invoice, key: string, fn: () => Promise<void>) {
    setRowBusyId(`${invoice.id}:${key}`)
    try {
      await fn()
    } finally {
      setRowBusyId(null)
    }
  }

  const handleIssue = (invoice: Invoice) =>
    runRowAction(invoice, "issue", async () => {
      try {
        unwrapAction(await issueInvoiceAction(invoice.id))
        toast.success(`Invoice ${invoice.invoice_number} issued`)
        await refreshAll()
      } catch (error) {
        toast.error("Could not issue the invoice", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleReminder = (invoice: Invoice) =>
    runRowAction(invoice, "reminder", async () => {
      try {
        unwrapAction(await sendInvoiceReminderAction(invoice.id))
        toast.success("Reminder sent", { description: `Invoice ${invoice.invoice_number}` })
        await refreshAll()
      } catch (error) {
        toast.error("Could not send the reminder", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleCopyLink = (invoice: Invoice) =>
    runRowAction(invoice, "link", async () => {
      try {
        const result = unwrapAction(await generateInvoiceLinkAction(invoice.id))
        const copied = await copyText(result.url)
        toast.success(copied ? "Customer link copied" : "Customer link ready", { description: result.url })
      } catch (error) {
        toast.error("Could not create the link", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  async function handleVoid() {
    if (!voidingInvoice) return
    setDestructiveBusy(true)
    try {
      unwrapAction(await voidInvoiceAction(voidingInvoice.id))
      toast.success("Invoice voided")
      setVoidingInvoice(null)
      await refreshAll()
    } catch (error) {
      toast.error("Could not void the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setDestructiveBusy(false)
    }
  }

  async function handleRevise() {
    if (!revisingInvoice) return
    setDestructiveBusy(true)
    try {
      const replacement = unwrapAction(await reviseInvoiceAction(revisingInvoice.id))
      setRevisingInvoice(null)
      toast.success("Replacement draft created", { description: `Invoice ${replacement.invoice_number} is ready.` })
      selectInvoice(replacement.id)
      await refreshAll()
    } catch (error) {
      toast.error("Could not revise the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setDestructiveBusy(false)
    }
  }

  async function handleDelete() {
    if (!deletingInvoice) return
    setDestructiveBusy(true)
    try {
      unwrapAction(await deleteInvoiceAction(deletingInvoice.id))
      if (selectedId === deletingInvoice.id) selectInvoice(null)
      setDeletingInvoice(null)
      toast.success("Draft deleted")
      await refreshAll()
    } catch (error) {
      toast.error("Could not delete the draft", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setDestructiveBusy(false)
    }
  }

  async function handleBulkReminders() {
    const eligible = rows.filter((invoice) => selectedIds.includes(invoice.id) && isOpenInvoice(invoice))
    if (eligible.length === 0) return
    setSendingBulk(true)
    let sent = 0
    const failures: string[] = []
    for (const invoice of eligible) {
      try {
        unwrapAction(await sendInvoiceReminderAction(invoice.id))
        sent += 1
      } catch {
        failures.push(invoice.invoice_number ?? invoice.id)
      }
    }
    setSendingBulk(false)
    if (sent > 0) toast.success(`Sent ${sent} reminder${sent === 1 ? "" : "s"}`)
    if (failures.length > 0) {
      toast.error(`${failures.length} reminder${failures.length === 1 ? "" : "s"} failed`, {
        description: failures.join(", "),
      })
    }
    if (failures.length === 0) {
      setSelectedIds([])
      setBulkMode(false)
    }
    await refreshAll()
  }

  function handleExportCsv() {
    const exportRows = selectedIds.length > 0 ? rows.filter((row) => selectedIds.includes(row.id)) : rows
    if (exportRows.length === 0) return
    const escape = (value: string | number) => {
      // Neutralize spreadsheet formula injection (=, +, -, @ leads) before CSV quoting.
      const raw = String(value)
      const str = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    const header = ["Invoice No.", "Billed to", "Status", "Next action", "Due date", "Total", "Balance"]
    const lines = exportRows.map((invoice) =>
      [
        invoice.invoice_number ?? "",
        customerNameOf(invoice),
        displayStatusOf(invoice),
        nextActionFor(invoice).label,
        invoice.due_date ?? "",
        (totalCentsOf(invoice) / 100).toFixed(2),
        (balanceCentsOf(invoice) / 100).toFixed(2),
      ]
        .map(escape)
        .join(","),
    )
    const csv = [header.map(escape).join(","), ...lines].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${exportRows.length} invoice${exportRows.length === 1 ? "" : "s"}`)
  }

  const packageByInvoice = useMemo(
    () => new Map(packages.map((summary) => [summary.invoice_id, summary])),
    [packages],
  )
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])

  // The aging strip is a filter on top of whichever queue is active, and it ages
  // through the same ladder the strip's own totals were summed with.
  const visibleRows = useMemo(() => {
    if (agingFilter === null) return rows
    return rows.filter((invoice) => agingBucketIndex(overdueDaysOf(invoice)) === agingFilter)
  }, [agingFilter, rows])

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((row) => selectedIds.includes(row.id))
  const someVisibleSelected = visibleRows.some((row) => selectedIds.includes(row.id)) && !allVisibleSelected
  const showSelection = bulkMode || selectedIds.length > 0

  function toggleSort(key: InvoiceSortKey) {
    if (sort === key) {
      setSortDirection((current) => (current === "desc" ? "asc" : "desc"))
    } else {
      setSort(key)
      setSortDirection("desc")
    }
  }

  const sortHeader = (label: string, key: InvoiceSortKey, className?: string) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className={cn(
        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
        sort === key && "text-foreground",
        className,
      )}
    >
      {label}
      {sort === key ? (
        sortDirection === "desc" ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />
      ) : null}
    </button>
  )

  // With the inspector open the table gives up ~450px, so the one column that is
  // pure duplication goes: the queue is about what is still owed, and the full
  // amount is one glance away in the panel that took the space.
  const compact = Boolean(selectedId)

  const syncPending = rows.filter((row) => row.qbo_sync_status === "pending").length
  const syncAttention = rows.filter((row) => invoiceNeedsAttention(row)).length

  const newHref = effectiveProjectId ? newInvoiceHref(effectiveProjectId) : null

  return (
    <div className="flex w-full flex-col">
      {/* Toolbar */}
      <div className="sticky top-0 z-20 flex min-h-14 w-full flex-col border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-stretch">
        {toolbarLeading ? (
          <div className="flex min-w-0 items-stretch px-4 sm:border-r sm:px-6 lg:px-8">{toolbarLeading}</div>
        ) : null}
        <div className="flex w-full flex-col gap-2 px-4 py-3 sm:flex-1 sm:flex-row sm:items-center sm:justify-end sm:py-2 lg:px-6">
          <div className="w-full sm:max-w-sm">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search invoice number or customer"
                className="h-9 bg-muted/30 pl-9 shadow-none transition-colors focus-visible:bg-background"
              />
            </div>
          </div>
          <div className="flex flex-row gap-2">
            {newHref ? (
              <Button size="sm" className="h-9 flex-1 whitespace-nowrap sm:flex-none" asChild>
                <Link href={newHref}>
                  <Plus className="mr-2 h-4 w-4" />
                  New invoice
                </Link>
              </Button>
            ) : (
              <Button size="sm" className="h-9" onClick={() => setNewInvoiceProjectOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New invoice
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0 bg-background">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Billing settings and tools</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => setSchedulesOpen(true)}>Recurring invoices…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSyncQueueOpen(true)}>
                  Accounting sync queue
                  {syncPending + syncAttention > 0 ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "ml-auto",
                        syncAttention > 0 ? "border-destructive/30 text-destructive" : "border-primary/30 text-primary",
                      )}
                    >
                      {syncPending + syncAttention}
                    </Badge>
                  ) : null}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setBulkMode((value) => !value)}>
                  {showSelection ? "Exit bulk actions" : "Bulk actions"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleExportCsv}>Export CSV</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Money, then aging. Four numbers a person can act on. */}
      {arSummary ? (
        <div className="border-b">
          <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-4 sm:divide-y-0">
            <SummaryTile label="Billed" value={formatMoneyCompact(arSummary.billedCents)} />
            <SummaryTile label="Collected" value={formatMoneyCompact(arSummary.collectedCents)} tone="success" />
            <SummaryTile label="Outstanding" value={formatMoneyCompact(arSummary.outstandingCents)} />
            <SummaryTile
              label="Overdue"
              value={formatMoneyCompact(arSummary.overdueCents)}
              tone={arSummary.overdueCents > 0 ? "destructive" : undefined}
            />
          </div>
          <div className="grid grid-cols-2 divide-x border-t sm:grid-cols-4">
            {AGING_BUCKET_LABELS.map((label, index) => {
              const active = agingFilter === index
              const value = arSummary.buckets[index]
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setAgingFilter(active ? null : (index as 0 | 1 | 2 | 3))
                    if (!active) setQueue("overdue")
                  }}
                  className={cn(
                    "px-4 py-2 text-left transition-colors hover:bg-muted/40",
                    active && "bg-muted/50",
                  )}
                >
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
                  <div
                    className={cn(
                      "mt-0.5 font-mono text-sm tabular-nums",
                      value > 0 ? (index >= 2 ? "font-semibold text-destructive" : "font-medium") : "text-muted-foreground",
                    )}
                  >
                    {formatMoneyCompact(value)}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* Queues */}
      <div className="flex items-center gap-1 overflow-x-auto border-b px-4 py-2 sm:px-6 lg:px-8">
        {QUEUES.map((entry) => {
          const active = queue === entry.key
          const count = counts[entry.key] ?? 0
          return (
            <button
              key={entry.key}
              type="button"
              title={entry.hint}
              aria-pressed={active}
              onClick={() => {
                setQueue(entry.key)
                setAgingFilter(null)
              }}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-foreground/20 bg-foreground text-background"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {entry.label}
              <span className={cn("tabular-nums", active ? "opacity-70" : "text-muted-foreground/70")}>{count}</span>
            </button>
          )
        })}
        {agingFilter !== null ? (
          <Badge variant="secondary" className="ml-2 shrink-0 gap-1 pr-1 font-normal">
            {AGING_BUCKET_LABELS[agingFilter]}
            <button type="button" onClick={() => setAgingFilter(null)} aria-label="Clear the aging filter" className="p-0.5">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ) : null}
      </div>

      {/*
        The inspector is a panel in the flow, not a layer over it: selecting an
        invoice narrows the table and the detail takes the space it gave up, and
        deselecting hands it straight back. It reserves nothing while closed —
        half a screen saying "nothing selected" is not information — and it never
        covers the row you are working from, which a Sheet or a takeover would.
      */}
      <div className="flex min-h-0 w-full flex-1 flex-col lg:flex-row">
        <div
          className={cn(
            "min-w-0 flex-1",
            // On small screens the inspector takes over rather than shrinking the
            // table to nothing; the list comes back via the inspector's Back.
            selectedId ? "hidden lg:block" : "block",
          )}
        >
          {listError ? (
            <div className="m-4 border border-destructive/30 bg-destructive/10 p-4 text-sm">
              <p className="font-medium">The invoice list could not be loaded.</p>
              <p className="mt-1 text-muted-foreground">{listError}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void reloadRows()}>
                Try again
              </Button>
            </div>
          ) : loadingRows ? (
            <QueueSkeleton />
          ) : visibleRows.length === 0 ? (
            <EmptyQueue
              queue={queue}
              hasSearch={search.trim().length > 0 || agingFilter !== null}
              newHref={newHref}
              onClear={() => {
                setSearch("")
                setAgingFilter(null)
                setQueue("all")
              }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {showSelection ? (
                    <TableHead className="w-10 px-3">
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) =>
                          setSelectedIds(checked ? visibleRows.map((row) => row.id) : [])
                        }
                        aria-label="Select every visible invoice"
                      />
                    </TableHead>
                  ) : null}
                  <TableHead className="px-4 py-3">{sortHeader("Invoice", "number")}</TableHead>
                  <TableHead className="px-4 py-3">{sortHeader(terms.owner, "customer")}</TableHead>
                  {compact ? null : (
                    <TableHead className="px-4 py-3 text-right">{sortHeader("Amount", "amount")}</TableHead>
                  )}
                  <TableHead className="px-4 py-3 text-right">{sortHeader("Balance", "balance")}</TableHead>
                  <TableHead className="px-4 py-3">{sortHeader("Next action", "due_date")}</TableHead>
                  <TableHead className="w-32 px-4 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((invoice) => {
                  const action = nextActionFor(invoice)
                  const active = invoice.id === selectedId
                  const balance = balanceCentsOf(invoice)
                  const backup = packageByInvoice.get(invoice.id)
                  return (
                    <TableRow
                      key={invoice.id}
                      data-state={active ? "selected" : undefined}
                      onClick={(event) => {
                        const target = event.target as HTMLElement
                        if (target.closest("button, a, input, [role='checkbox'], [role='menu']")) return
                        selectInvoice(invoice.id)
                      }}
                      className={cn(
                        "group cursor-pointer [contain-intrinsic-size:auto_56px] [content-visibility:auto]",
                        active && "bg-muted/60",
                      )}
                    >
                      {showSelection ? (
                        <TableCell className="w-10 px-3">
                          <Checkbox
                            checked={selectedIds.includes(invoice.id)}
                            onCheckedChange={(checked) =>
                              setSelectedIds((prev) =>
                                checked ? [...new Set([...prev, invoice.id])] : prev.filter((id) => id !== invoice.id),
                              )
                            }
                            aria-label={`Select invoice ${invoice.invoice_number ?? ""}`}
                          />
                        </TableCell>
                      ) : null}
                      <TableCell className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{invoice.invoice_number || invoice.title || "Untitled"}</span>
                          <InvoiceStatusBadge invoice={invoice} />
                        </div>
                        {enableApprovedCostsSource && !backup && isOpenInvoice(invoice) ? (
                          <span className="mt-0.5 block text-[11px] text-warning">Backup package not generated</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-sm">
                        <span className="line-clamp-1">{customerNameOf(invoice) || "—"}</span>
                        {projects.length > 1 && invoice.project_id ? (
                          <span className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                            {projectById.get(invoice.project_id)?.name ?? "Unknown project"}
                          </span>
                        ) : null}
                      </TableCell>
                      {compact ? null : (
                        <TableCell className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                          {formatMoneyFromCents(totalCentsOf(invoice))}
                        </TableCell>
                      )}
                      <TableCell
                        className={cn(
                          "px-4 py-3 text-right font-mono text-sm tabular-nums",
                          balance > 0 ? "font-semibold" : "text-muted-foreground",
                        )}
                      >
                        {formatMoneyFromCents(displayStatusOf(invoice) === "void" ? 0 : balance)}
                      </TableCell>
                      <TableCell className={cn("px-4 py-3 text-sm", NEXT_ACTION_TONES[action.tone])}>
                        <span className="flex items-center gap-2">
                          {action.label}
                          {invoiceNeedsAttention(invoice) ? (
                            <AccountingSyncBadge status={invoice.qbo_sync_status} externalId={invoice.qbo_id ?? undefined} compact />
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <RowPrimaryAction
                            invoice={invoice}
                            busyKey={rowBusyId}
                            projectId={invoice.project_id ?? effectiveProjectId ?? null}
                            onIssue={() => void handleIssue(invoice)}
                            onRemind={() => void handleReminder(invoice)}
                            onRecordPayment={() => {
                              setAutoPaymentFor(invoice.id)
                              selectInvoice(invoice.id)
                            }}
                          />
                          <RowOverflowMenu
                            invoice={invoice}
                            projectId={invoice.project_id ?? effectiveProjectId ?? null}
                            enableApprovedCostsSource={Boolean(enableApprovedCostsSource)}
                            backup={backup}
                            onCopyLink={() => void handleCopyLink(invoice)}
                            onMakeRecurring={() => setRecurringInvoice(invoice)}
                            onRevise={() => setRevisingInvoice(invoice)}
                            onVoid={() => setVoidingInvoice(invoice)}
                            onDelete={() => setDeletingInvoice(invoice)}
                            onMove={() => setMovingInvoice(invoice)}
                            onGenerateBackup={async () => {
                              if (!invoice.project_id) return
                              try {
                                const summary = unwrapAction(
                                  await generateOwnerBillingPackageAction({
                                    projectId: invoice.project_id,
                                    invoiceId: invoice.id,
                                  }),
                                )
                                setPackages((prev) => [summary, ...prev.filter((item) => item.invoice_id !== invoice.id)])
                                toast.success("Backup package generated", {
                                  description: `${summary.cost_count} costs and ${summary.proof_count} proofs captured.`,
                                })
                              } catch (error) {
                                toast.error("Could not generate the backup package", {
                                  description: error instanceof Error ? error.message : "Please try again.",
                                })
                              }
                            }}
                            onShareBackup={async () => {
                              const summary = packageByInvoice.get(invoice.id)
                              if (!invoice.project_id || !summary) return
                              try {
                                const shared = unwrapAction(
                                  await shareOwnerBillingPackageAction({
                                    projectId: invoice.project_id,
                                    packageId: summary.package_id,
                                  }),
                                )
                                setPackages((prev) => [shared, ...prev.filter((item) => item.invoice_id !== invoice.id)])
                                toast.success("Backup shared to the portal")
                              } catch (error) {
                                toast.error("Could not share the backup package", {
                                  description: error instanceof Error ? error.message : "Please try again.",
                                })
                              }
                            }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}

          {rows.length < totalCount && !loadingRows ? (
            <div className="flex items-center justify-center gap-3 border-t py-3 text-xs text-muted-foreground">
              <span>
                Showing {rows.length} of {totalCount}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>

        <aside
          aria-hidden={!selectedId}
          className={cn(
            // Width is what animates, so the table reflows with it rather than
            // being covered. `overflow-hidden` clips the fixed-width contents
            // while that happens, so nothing inside squashes on the way in — and
            // it is on the STICKY element rather than around it, because an
            // overflow ancestor captures a sticky descendant and quietly stops it
            // sticking to the viewport.
            "min-h-0 shrink-0 overflow-hidden bg-background transition-[width] duration-200 ease-out motion-reduce:transition-none",
            "lg:sticky lg:top-[3.5rem] lg:h-[calc(100vh-3.5rem)] lg:self-start",
            selectedId
              ? "block w-full border-t lg:w-[440px] lg:border-l lg:border-t-0 xl:w-[520px]"
              : "hidden w-0 lg:block",
          )}
        >
          <div className="w-full lg:h-full lg:w-[440px] xl:w-[520px]">
            {selectedId ? (
              <InvoiceInspector
                detail={detail}
                loading={detailLoading}
                projectId={detail?.invoice.project_id ?? effectiveProjectId ?? null}
                projectName={
                  detail?.invoice.project_id ? projectById.get(detail.invoice.project_id)?.name ?? null : scopedProject?.name ?? null
                }
                builderInfo={builderInfo}
                autoOpenPayment={autoPaymentFor === selectedId}
                onAutoPaymentHandled={() => setAutoPaymentFor(null)}
                onBack={() => selectInvoice(null)}
                onChanged={refreshAll}
                onDuplicate={(invoice) => {
                  const target = invoice.project_id ?? effectiveProjectId
                  if (!target) return
                  router.push(newInvoiceHref(target, { duplicateOf: invoice.id }))
                }}
                onRevise={(invoice) => setRevisingInvoice(invoice)}
                onVoid={(invoice) => setVoidingInvoice(invoice)}
                onMakeRecurring={(invoice) => setRecurringInvoice(invoice)}
                onMove={(invoice) => setMovingInvoice(invoice)}
                onResync={async (invoice) => {
                  try {
                    unwrapAction(await manualResyncInvoiceAction(invoice.id))
                    toast.success("Sync queued")
                    await refreshAll()
                  } catch (error) {
                    toast.error("Could not sync", {
                      description: error instanceof Error ? error.message : "Please try again.",
                    })
                  }
                }}
              />
            ) : null}
          </div>
        </aside>
      </div>

      {selectedIds.length > 0 ? (
        <InvoiceBottomBar
          selectedCount={selectedIds.length}
          onDeselectAll={() => {
            setSelectedIds([])
            setBulkMode(false)
          }}
          onExportCsv={handleExportCsv}
          onSendReminders={() => void handleBulkReminders()}
          reminderEligibleCount={rows.filter((row) => selectedIds.includes(row.id) && isOpenInvoice(row)).length}
          sendingReminders={sendingBulk}
        />
      ) : null}

      <InvoiceSchedulesDialog open={schedulesOpen} onOpenChange={setSchedulesOpen} projectId={effectiveProjectId} />
      <AccountingSyncSheet
        open={syncQueueOpen}
        onOpenChange={setSyncQueueOpen}
        projectId={effectiveProjectId}
        projectName={scopedProject?.name}
        onOpenInvoice={selectInvoice}
      />
      <MakeRecurringDialog
        invoice={recurringInvoice}
        open={Boolean(recurringInvoice)}
        onOpenChange={(open) => !open && setRecurringInvoice(null)}
      />

      <ChooseProjectDialog
        open={newInvoiceProjectOpen}
        onOpenChange={setNewInvoiceProjectOpen}
        projects={projects}
        onChoose={(id) => router.push(newInvoiceHref(id))}
      />

      <MoveInvoiceDialog
        invoice={movingInvoice}
        releaseDescription={releaseDescription}
        onClose={() => setMovingInvoice(null)}
        onMoved={async () => {
          setMovingInvoice(null)
          if (selectedId && movingInvoice?.id === selectedId) selectInvoice(null)
          await refreshAll()
        }}
      />

      <AlertDialog open={Boolean(voidingInvoice)} onOpenChange={(open) => !open && setVoidingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels {voidingInvoice?.invoice_number ?? "the invoice"} and releases {releaseDescription} so they can
              be billed again. The record and its history stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveBusy}>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={destructiveBusy} onClick={() => void handleVoid()}>
              {destructiveBusy ? "Voiding…" : "Void invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(revisingInvoice)} onOpenChange={(open) => !open && setRevisingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revise and reissue?</AlertDialogTitle>
            <AlertDialogDescription>
              This voids {revisingInvoice?.invoice_number ?? "the invoice"}, keeps its history, and opens a linked draft
              with a new number.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={destructiveBusy} onClick={() => void handleRevise()}>
              {destructiveBusy ? "Creating…" : "Create replacement draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deletingInvoice)} onOpenChange={(open) => !open && setDeletingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingInvoice?.invoice_number ?? "This draft"} has never been issued, so it can be removed outright.
              Anything already billed has to be voided instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={destructiveBusy}
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {destructiveBusy ? "Deleting…" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "success" | "destructive"
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-lg font-semibold tabular-nums",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * One button per row, and it says what to do with THIS invoice. The old menu
 * offered every action on every row — including "Record payment" on a draft that
 * had never been sent to anybody.
 */
function RowPrimaryAction({
  invoice,
  busyKey,
  projectId,
  onIssue,
  onRemind,
  onRecordPayment,
}: {
  invoice: Invoice
  busyKey: string | null
  projectId: string | null
  onIssue: () => void
  onRemind: () => void
  onRecordPayment: () => void
}) {
  const action = nextActionFor(invoice)
  const busy = (key: string) => busyKey === `${invoice.id}:${key}`

  if (action.key === "resume" && isEditableInvoice(invoice) && projectId) {
    return (
      <Button variant="ghost" size="sm" className="h-8 text-xs" asChild>
        <Link href={resumeInvoiceHref(projectId, invoice.id)}>Resume</Link>
      </Button>
    )
  }
  if (action.key === "issue") {
    return (
      <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={onIssue} disabled={busy("issue")}>
        {busy("issue") ? "Issuing…" : "Issue"}
      </Button>
    )
  }
  if (action.key === "remind" || action.key === "resend") {
    return (
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onRemind} disabled={busy("reminder")}>
        {busy("reminder") ? "Sending…" : action.key === "resend" ? "Resend" : "Remind"}
      </Button>
    )
  }
  if (action.key === "collect") {
    return (
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onRecordPayment}>
        Record payment
      </Button>
    )
  }
  return null
}

function RowOverflowMenu({
  invoice,
  projectId,
  enableApprovedCostsSource,
  backup,
  onCopyLink,
  onMakeRecurring,
  onRevise,
  onVoid,
  onDelete,
  onMove,
  onGenerateBackup,
  onShareBackup,
}: {
  invoice: Invoice
  projectId: string | null
  enableApprovedCostsSource: boolean
  backup?: OwnerBillingPackageSummary
  onCopyLink: () => void
  onMakeRecurring: () => void
  onRevise: () => void
  onVoid: () => void
  onDelete: () => void
  onMove: () => void
  onGenerateBackup: () => Promise<void>
  onShareBackup: () => Promise<void>
}) {
  const status = displayStatusOf(invoice)
  const editable = isEditableInvoice(invoice)
  const published = Boolean(invoice.client_visible && invoice.sent_at)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">More actions for invoice {invoice.invoice_number}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {projectId ? (
          <DropdownMenuItem asChild>
            <Link href={newInvoiceHref(projectId, { duplicateOf: invoice.id })}>Duplicate</Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onMakeRecurring} disabled={status === "void"}>
          Make recurring…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyLink}>
          {/* Naming the consequence: for an unissued invoice this MINTS public access. */}
          {published ? "Copy customer link" : "Publish a customer link…"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRevise} disabled={!["sent", "overdue"].includes(status)}>
          Revise and reissue
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onMove} disabled={!editable}>
          <FolderOpen className="mr-2 h-4 w-4" />
          Move to project…
        </DropdownMenuItem>
        {enableApprovedCostsSource ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void onGenerateBackup()} disabled={!invoice.project_id}>
              {backup ? "Regenerate backup package" : "Generate backup package"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void onShareBackup()}
              disabled={!backup || ["shared", "downloaded", "accepted"].includes(backup.status)}
            >
              Share backup to portal
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onVoid} disabled={["paid", "partial", "void"].includes(status) || editable}>
          Void invoice
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onDelete}
          disabled={!editable}
          className="text-destructive focus:text-destructive"
        >
          Delete draft
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function QueueSkeleton() {
  return (
    <div className="divide-y">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}

const EMPTY_COPY: Record<InvoiceQueueKey, { title: string; body: string }> = {
  all: { title: "No invoices yet", body: "Bill a draw, a change order, approved costs, or write one by hand." },
  preparing: { title: "Nothing in preparation", body: "Drafts you start will wait here until they are ready to go out." },
  awaiting_approval: { title: "Nothing awaiting approval", body: "Billing sent for sign-off will appear here." },
  ready: { title: "Nothing ready to issue", body: "Approved drafts land here, one click from the customer." },
  open: { title: "Nothing outstanding", body: "Every issued invoice is either paid or past due." },
  overdue: { title: "Nothing overdue", body: "Everything issued is still inside its terms." },
  exceptions: { title: "No exceptions", body: "Every invoice delivered and every one synced to accounting." },
  paid: { title: "Nothing settled yet", body: "Paid invoices collect here." },
  void: { title: "Nothing voided", body: "Cancelled invoices are kept here for the record." },
}

function EmptyQueue({
  queue,
  hasSearch,
  newHref,
  onClear,
}: {
  queue: InvoiceQueueKey
  hasSearch: boolean
  newHref: string | null
  onClear: () => void
}) {
  const copy = EMPTY_COPY[queue]
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-sm font-medium">{hasSearch ? "Nothing matches" : copy.title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {hasSearch ? "Try a different search, or clear the filters to see the whole book." : copy.body}
      </p>
      {hasSearch ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear search and filters
        </Button>
      ) : queue === "all" && newHref ? (
        <Button size="sm" asChild>
          <Link href={newHref}>
            <Plus className="mr-2 h-4 w-4" />
            New invoice
          </Link>
        </Button>
      ) : null}
    </div>
  )
}

function ChooseProjectDialog({
  open,
  onOpenChange,
  projects,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  onChoose: (projectId: string) => void
}) {
  const [search, setSearch] = useState("")
  const visible = projects.filter(
    (project) => search.trim().length === 0 || project.name.toLowerCase().includes(search.trim().toLowerCase()),
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Which job are you billing?</DialogTitle>
          <DialogDescription>
            The project decides the billing workflow — a draw schedule, a pay application, or a closing statement.
          </DialogDescription>
        </DialogHeader>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" className="h-9" />
        <div className="max-h-64 space-y-1 overflow-y-auto border p-1">
          {visible.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => {
                onOpenChange(false)
                onChoose(project.id)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
            >
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{project.name}</span>
            </button>
          ))}
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No projects match.</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MoveInvoiceDialog({
  invoice,
  releaseDescription,
  onClose,
  onMoved,
}: {
  invoice: Invoice | null
  releaseDescription: string
  onClose: () => void
  onMoved: () => void | Promise<void>
}) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [moving, setMoving] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  useEffect(() => {
    if (!invoice) return
    setTargetId(null)
    setSearch("")
    setLoading(true)
    listMovableProjectsAction()
      .then((result) => setProjects(unwrapAction(result).filter((project) => project.id !== invoice.project_id)))
      .catch((error) =>
        toast.error("Could not load projects", {
          description: error instanceof Error ? error.message : "Please try again.",
        }),
      )
      .finally(() => setLoading(false))
  }, [invoice])

  async function submit() {
    if (!invoice || !targetId) return
    setMoving(true)
    try {
      unwrapAction(await moveInvoiceToProjectAction(invoice.id, targetId))
      toast.success("Invoice moved", { description: projects.find((p) => p.id === targetId)?.name })
      await onMoved()
    } catch (error) {
      toast.error("Could not move the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setMoving(false)
    }
  }

  const visible = projects.filter(
    (project) => search.trim().length === 0 || project.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <Dialog open={Boolean(invoice)} onOpenChange={(open) => !open && !moving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to another project</DialogTitle>
          <DialogDescription>
            {invoice?.invoice_number ?? "This invoice"} moves with its lines. Any {releaseDescription} linked to the
            current project are released so they can be billed there again.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search projects"
          className="h-9"
          disabled={loading || moving}
        />
        <div className="max-h-64 space-y-1 overflow-y-auto border p-1">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading projects…</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {projects.length === 0 ? "No other projects available." : "No projects match."}
            </p>
          ) : (
            visible.map((project) => (
              <button
                key={project.id}
                type="button"
                disabled={moving}
                onClick={() => setTargetId(project.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                  targetId === project.id && "bg-muted font-medium",
                )}
              >
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{project.name}</span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={moving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!targetId || moving}>
            {moving ? "Moving…" : "Move invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

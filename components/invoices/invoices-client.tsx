"use client"

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { addDays, format, parseISO } from "date-fns"
import { toast } from "sonner"
import { AnimatePresence } from "framer-motion"

import { useRouter, useSearchParams } from "next/navigation"

import type { Contact, CostCode, Invoice, Project } from "@/lib/types"
import type { OwnerBillingPackageSummary } from "@/lib/services/owner-billing-packages"
import {
  deleteInvoiceAction,
  generateInvoiceLinkAction,
  listInvoicesAction,
  listMovableProjectsAction,
  moveInvoiceToProjectAction,
  reviseInvoiceAction,
  sendInvoiceReminderAction,
  voidInvoiceAction,
} from "@/app/(app)/invoices/actions"
import {
  generateOwnerBillingPackageAction,
  shareOwnerBillingPackageAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { ReceivablesWorkspace } from "@/components/invoices/receivables-workspace"
import { InvoiceSchedulesDialog, MakeRecurringDialog } from "@/components/invoices/invoice-schedules"
import { unwrapAction } from "@/lib/action-result"
import { useProductTerminology } from "@/components/layout/use-product-terminology"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
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
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Ban, Plus, Building2, Calendar, Copy, Filter, FolderOpen, List, MoreHorizontal, RefreshCcw, Search, Trash2 } from "@/components/icons"
import { ChevronDown, ChevronUp, Repeat, X } from "lucide-react"
import { InvoiceBottomBar } from "@/components/invoices/invoice-bottom-bar"
import { QboSyncSheet } from "@/components/integrations/qbo-sync-sheet"

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
  sent: "bg-primary/10 text-primary border-primary/30",
  partial: "bg-warning/15 text-warning border-warning/30",
  paid: "bg-success/20 text-success border-success/30",
  overdue: "bg-destructive/20 text-destructive border-destructive/30",
  void: "bg-muted text-muted-foreground border-muted",
}

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  })
}

function resolveStatusKey(status?: string | null): StatusKey {
  if (!status) return "draft"
  const allowed: StatusKey[] = ["draft", "saved", "sent", "partial", "paid", "overdue", "void"]
  return allowed.includes(status as StatusKey) ? (status as StatusKey) : "draft"
}

function balanceCentsOf(invoice: Invoice): number {
  return (
    invoice.balance_due_cents ??
    invoice.totals?.balance_due_cents ??
    invoice.total_cents ??
    invoice.totals?.total_cents ??
    0
  )
}

function totalCentsOf(invoice: Invoice): number {
  return invoice.total_cents ?? invoice.totals?.total_cents ?? 0
}

function customerNameOf(invoice: Invoice): string {
  return (
    invoice.customer_name ??
    (invoice.metadata as Record<string, any> | undefined)?.customer_name ??
    invoice.sent_to_emails?.[0] ??
    ""
  )
}

function startOfToday(): Date {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

/**
 * Invoice dates are date-only strings ("yyyy-MM-dd"). `new Date(str)` parses them as UTC
 * midnight, which shifts them a day early for anyone west of UTC — parseISO keeps them local.
 */
function parseDateOnly(value: string): Date {
  const date = parseISO(value)
  date.setHours(0, 0, 0, 0)
  return date
}

function daysPastDue(invoice: Invoice): number {
  if (!invoice.due_date) return 0
  const due = parseDateOnly(invoice.due_date)
  const diff = startOfToday().getTime() - due.getTime()
  return diff > 0 ? Math.floor(diff / (1000 * 60 * 60 * 24)) : 0
}

/**
 * Single source of truth for "overdue" in this view: a sent/partial invoice with an
 * outstanding balance past its due date shows as overdue even if the stored status
 * hasn't been rolled forward yet.
 */
function displayStatusKey(invoice: Invoice): StatusKey {
  const base = resolveStatusKey(invoice.status)
  if ((base === "sent" || base === "partial") && balanceCentsOf(invoice) > 0 && daysPastDue(invoice) > 0) {
    return "overdue"
  }
  return base
}

const OPEN_STATUSES: StatusKey[] = ["sent", "partial", "overdue"]

const INVOICE_PAGE_SIZE = 100

const AGING_BUCKET_LABELS = ["1–30 days", "31–60 days", "61–90 days", "90+ days"] as const

type AgingBucket = 0 | 1 | 2 | 3

function agingBucketOf(days: number): AgingBucket | null {
  if (days <= 0) return null
  if (days <= 30) return 0
  if (days <= 60) return 1
  if (days <= 90) return 2
  return 3
}

export interface InvoiceArSummary {
  outstandingCents: number
  overdueCents: number
  buckets: [number, number, number, number]
}

type SortKey = "number" | "customer" | "issue_date" | "due_date" | "amount" | "balance" | "status"

function BackupPackageBadge({
  summary,
  busy,
}: {
  summary?: OwnerBillingPackageSummary
  busy?: "generate" | "share" | null
}) {
  if (busy) {
    return (
      <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
        {busy === "generate" ? "Generating" : "Sharing"}
      </Badge>
    )
  }

  if (!summary) {
    return (
      <Badge variant="outline" className="border-dashed text-muted-foreground">
        Missing
      </Badge>
    )
  }

  const labels: Record<string, string> = {
    generated: "Generated",
    shared: "Shared",
    downloaded: "Downloaded",
    accepted: "Accepted",
    draft: "Draft",
    voided: "Voided",
  }
  const styles: Record<string, string> = {
    generated: "border-warning/30 bg-warning/10 text-warning",
    shared: "border-primary/30 bg-primary/10 text-primary",
    downloaded: "border-success/30 bg-success/10 text-success",
    accepted: "border-success/30 bg-success/15 text-success",
    draft: "border-muted bg-muted/40 text-muted-foreground",
    voided: "border-muted bg-muted/40 text-muted-foreground",
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Badge variant="outline" className={styles[summary.status] ?? styles.draft}>
        {labels[summary.status] ?? summary.status}
      </Badge>
      <span className="text-[10px] text-muted-foreground">
        {summary.cost_count} costs · {summary.proof_count} proofs
      </span>
    </div>
  )
}

interface InvoicesClientProps {
  invoices: Invoice[]
  /** The single project this workbench is scoped to (composer + QBO sheet context). */
  projects: Project[]
  initialOpenInvoiceId?: string
  onInitialOpenInvoiceHandled?: () => void
  pendingOpenInvoiceLabel?: string
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  contacts?: Contact[]
  costCodes?: CostCode[]
  ownerBillingPackages?: OwnerBillingPackageSummary[]
  enableApprovedCostsSource?: boolean
  toolbarLeading?: ReactNode
  /** Server-computed aging over the whole book — correct even when only a page of rows is loaded. */
  arSummary?: InvoiceArSummary | null
}

export function InvoicesClient({
  invoices,
  projects,
  initialOpenInvoiceId,
  onInitialOpenInvoiceHandled,
  pendingOpenInvoiceLabel,
  builderInfo,
  contacts,
  costCodes,
  ownerBillingPackages = [],
  enableApprovedCostsSource,
  toolbarLeading,
  arSummary: serverArSummary = null,
}: InvoicesClientProps) {
  const terms = useProductTerminology()
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlInvoiceId = searchParams.get("invoice") || searchParams.get("invoiceId")

  const [items, setItems] = useState<Invoice[]>(invoices)
  const [packageSummaries, setPackageSummaries] = useState<OwnerBillingPackageSummary[]>(ownerBillingPackages)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [dueFilter, setDueFilter] = useState<DueFilter>("any")
  const [agingFilter, setAgingFilter] = useState<AgingBucket | null>(null)
  const [searchTerm, setSearchTerm] = useState("")
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [sendingBulkReminders, setSendingBulkReminders] = useState(false)
  const [hasMore, setHasMore] = useState(invoices.length >= INVOICE_PAGE_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [recurringSourceInvoice, setRecurringSourceInvoice] = useState<Invoice | null>(null)
  const [schedulesOpen, setSchedulesOpen] = useState(false)
  const [sendingReminderId, setSendingReminderId] = useState<string | null>(null)
  const [sharingDraftInvoice, setSharingDraftInvoice] = useState<Invoice | null>(null)
  const [voidingInvoice, setVoidingInvoice] = useState<Invoice | null>(null)
  const [revisingInvoice, setRevisingInvoice] = useState<Invoice | null>(null)
  const [deletingInvoice, setDeletingInvoice] = useState<Invoice | null>(null)
  const [movingInvoice, setMovingInvoice] = useState<Invoice | null>(null)
  const [moveProjects, setMoveProjects] = useState<Array<{ id: string; name: string }>>([])
  const [moveProjectsLoading, setMoveProjectsLoading] = useState(false)
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)
  const [moveSearch, setMoveSearch] = useState("")
  const [moveLoading, setMoveLoading] = useState(false)
  const [destructiveActionLoading, setDestructiveActionLoading] = useState(false)
  const [packageActionInvoiceId, setPackageActionInvoiceId] = useState<string | null>(null)
  const [packageActionKind, setPackageActionKind] = useState<"generate" | "share" | null>(null)
  const lastAutoOpenedInvoiceId = useRef<string | undefined>(undefined)
  const invoiceReleaseDescription = enableApprovedCostsSource
    ? "linked draws, billable costs, or retainage"
    : "linked draws, change orders, or retainage"

  // Navigate to (or open) an invoice in the workspace via the ?invoice URL param.
  const goToInvoice = useCallback(
    (value: string, opts?: { duplicate?: string }) => {
      if (typeof window === "undefined") return
      const params = new URLSearchParams(window.location.search)
      params.set("invoice", value)
      if (opts?.duplicate) params.set("duplicate", opts.duplicate)
      else params.delete("duplicate")
      params.delete("source")
      router.replace(window.location.pathname + `?${params.toString()}`, { scroll: false })
    },
    [router],
  )

  const upsertInvoice = useCallback((invoice: Invoice) => {
    setItems((prev) => (prev.some((item) => item.id === invoice.id) ? prev.map((item) => (item.id === invoice.id ? invoice : item)) : [invoice, ...prev]))
  }, [])

  const removeInvoiceFromList = useCallback((invoiceId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== invoiceId))
    setSelectedIds((prev) => prev.filter((id) => id !== invoiceId))
  }, [])

  useEffect(() => {
    setItems(invoices)
    setHasMore(invoices.length >= INVOICE_PAGE_SIZE)
  }, [invoices])

  useEffect(() => {
    setPackageSummaries(ownerBillingPackages)
  }, [ownerBillingPackages])

  // Source flows (draw generate, fee billing, pay app, period close) create an invoice then hand
  // us its id — open it in the workspace by pushing the ?invoice param.
  useEffect(() => {
    if (!initialOpenInvoiceId || lastAutoOpenedInvoiceId.current === initialOpenInvoiceId) return
    lastAutoOpenedInvoiceId.current = initialOpenInvoiceId
    goToInvoice(initialOpenInvoiceId)
    onInitialOpenInvoiceHandled?.()
  }, [initialOpenInvoiceId, onInitialOpenInvoiceHandled, goToInvoice])

  // When the project has more invoices than are loaded, client-side search would silently miss
  // unloaded rows — fall through to a debounced server search over the whole book instead.
  const [serverSearchResults, setServerSearchResults] = useState<Invoice[] | null>(null)
  const scopedProjectId = projects.length === 1 ? projects[0]?.id : undefined
  useEffect(() => {
    const term = searchTerm.trim()
    if (!term || !hasMore) {
      setServerSearchResults(null)
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      listInvoicesAction(scopedProjectId, { limit: INVOICE_PAGE_SIZE, search: term })
        .then((result) => {
          if (!cancelled) setServerSearchResults(unwrapAction(result))
        })
        .catch(() => {
          if (!cancelled) setServerSearchResults(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [searchTerm, hasMore, scopedProjectId])

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    const today = startOfToday()
    const soon = addDays(today, 7)
    const searchBase = serverSearchResults ?? items

    return searchBase.filter((item) => {
      const resolvedStatus = displayStatusKey(item)
      const matchesStatus = statusFilter === "all" || resolvedStatus === statusFilter

      const dueDate = item.due_date ? parseDateOnly(item.due_date) : null
      const isOpen = OPEN_STATUSES.includes(resolvedStatus) && balanceCentsOf(item) > 0
      const matchesDue =
        dueFilter === "any"
          ? true
          : dueFilter === "no_due"
            ? !dueDate
            : dueDate
              ? dueFilter === "overdue"
                ? // "Overdue" means money actually owed past its date — paid/void invoices don't qualify.
                  isOpen && dueDate < today
                : dueDate >= today && dueDate <= soon
              : false

      const matchesAging = agingFilter === null || (isOpen && agingBucketOf(daysPastDue(item)) === agingFilter)

      const matchesSearch =
        term.length === 0 ||
        [item.title ?? "", item.invoice_number ?? "", customerNameOf(item)].some((value) =>
          value.toLowerCase().includes(term),
        )

      return matchesStatus && matchesDue && matchesAging && matchesSearch
    })
  }, [agingFilter, dueFilter, items, searchTerm, serverSearchResults, statusFilter])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const dir = sortDir === "asc" ? 1 : -1
    const value = (invoice: Invoice): string | number => {
      switch (sortKey) {
        case "number":
          return invoice.invoice_number ?? invoice.title ?? ""
        case "customer":
          return customerNameOf(invoice).toLowerCase()
        case "issue_date":
          return invoice.issue_date ?? ""
        case "due_date":
          return invoice.due_date ?? ""
        case "amount":
          return totalCentsOf(invoice)
        case "balance":
          return balanceCentsOf(invoice)
        case "status":
          return displayStatusKey(invoice)
      }
    }
    return [...filtered].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [filtered, sortKey, sortDir])

  // Prefer the server-computed aging (whole book); fall back to a local pass over loaded rows.
  const arSummary = useMemo<InvoiceArSummary>(() => {
    if (serverArSummary) return serverArSummary
    const open = items.filter((item) => OPEN_STATUSES.includes(displayStatusKey(item)))
    const summary: InvoiceArSummary = {
      outstandingCents: 0,
      overdueCents: 0,
      buckets: [0, 0, 0, 0],
    }
    for (const invoice of open) {
      const balance = balanceCentsOf(invoice)
      if (balance <= 0) continue
      summary.outstandingCents += balance
      const bucket = agingBucketOf(daysPastDue(invoice))
      if (bucket === null) continue
      summary.overdueCents += balance
      summary.buckets[bucket] += balance
    }
    return summary
  }, [items, serverArSummary])

  const activeFilterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = []
    if (statusFilter !== "all") {
      chips.push({ key: "status", label: statusLabels[statusFilter], clear: () => setStatusFilter("all") })
    }
    if (dueFilter !== "any") {
      const dueLabels: Record<Exclude<DueFilter, "any">, string> = {
        due_soon: "Due in next 7 days",
        overdue: "Past due date",
        no_due: "No due date",
      }
      chips.push({ key: "due", label: dueLabels[dueFilter], clear: () => setDueFilter("any") })
    }
    if (agingFilter !== null) {
      chips.push({
        key: "aging",
        label: `Aging ${AGING_BUCKET_LABELS[agingFilter]}`,
        clear: () => setAgingFilter(null),
      })
    }
    return chips
  }, [agingFilter, dueFilter, statusFilter])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      if (sortDir === "desc") {
        setSortDir("asc")
      } else {
        setSortKey(null)
        setSortDir("desc")
      }
    } else {
      setSortKey(key)
      setSortDir("desc")
    }
  }

  const visibleIds = useMemo(() => filtered.map((item) => item.id), [filtered])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  const someVisibleSelected = visibleIds.some((id) => selectedIds.includes(id)) && !allVisibleSelected
  const qboPendingCount = useMemo(() => items.filter((item) => item.qbo_sync_status === "pending").length, [items])
  const qboErrorCount = useMemo(() => items.filter((item) => item.qbo_sync_status === "error").length, [items])
  const packageByInvoiceId = useMemo(() => {
    return new Map(packageSummaries.map((summary) => [summary.invoice_id, summary]))
  }, [packageSummaries])
  const scopedProject = projects.length === 1 ? projects[0] : null

  async function refreshInvoices() {
    try {
      // Refetch at least as many rows as are currently loaded so pagination state holds.
      const fresh = unwrapAction(
        await listInvoicesAction(scopedProject?.id, { limit: Math.max(items.length, INVOICE_PAGE_SIZE) }),
      )
      setItems(fresh)
    } catch (error: any) {
      console.error(error)
      toast.error("Could not refresh invoices", {
        description: error?.message ?? "Please try again.",
      })
    }
  }

  async function handleLoadMore() {
    setLoadingMore(true)
    try {
      const next = unwrapAction(
        await listInvoicesAction(scopedProject?.id, { limit: INVOICE_PAGE_SIZE, offset: items.length }),
      )
      setItems((prev) => {
        const known = new Set(prev.map((invoice) => invoice.id))
        return [...prev, ...next.filter((invoice) => !known.has(invoice.id))]
      })
      setHasMore(next.length === INVOICE_PAGE_SIZE)
    } catch (error: any) {
      console.error(error)
      toast.error("Could not load more invoices", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setLoadingMore(false)
    }
  }

  // Draft/unsent invoices route through a confirmation first — generating a link makes the
  // invoice publicly viewable by anyone holding the URL.
  function handleShareRequest(invoice: Invoice) {
    const status = resolveStatusKey(invoice.status)
    const neverShared = ["draft", "saved"].includes(status) && !invoice.client_visible && !invoice.sent_at
    if (neverShared) {
      setSharingDraftInvoice(invoice)
      return
    }
    void handleShare(invoice.id)
  }

  async function handleShare(invoiceId: string) {
    setLinkingId(invoiceId)
    try {
      const result = unwrapAction(await generateInvoiceLinkAction(invoiceId))
      setItems((prev) => prev.map((inv) => (inv.id === invoiceId ? { ...inv, token: result.token } : inv)))

      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(result.url)
        toast.success("Share link copied", { description: result.url })
      } else {
        toast.success("Share link ready", { description: result.url })
      }
    } catch (error: any) {
      console.error(error)
      toast.error("Could not generate link", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setLinkingId(null)
    }
  }

  async function handleSendReminder(invoice: Invoice) {
    setSendingReminderId(invoice.id)
    try {
      unwrapAction(await sendInvoiceReminderAction(invoice.id))
      toast.success("Reminder sent", {
        description: `Payment reminder sent for invoice ${invoice.invoice_number}`,
      })
    } catch (error: any) {
      console.error(error)
      toast.error("Could not send reminder", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setSendingReminderId(null)
    }
  }

  const selectedInvoices = useMemo(() => items.filter((item) => selectedIds.includes(item.id)), [items, selectedIds])
  const reminderEligibleSelection = useMemo(
    () => selectedInvoices.filter((item) => OPEN_STATUSES.includes(displayStatusKey(item)) && balanceCentsOf(item) > 0),
    [selectedInvoices],
  )

  async function handleBulkSendReminders() {
    if (reminderEligibleSelection.length === 0) return
    setSendingBulkReminders(true)
    let sent = 0
    const failures: string[] = []
    for (const invoice of reminderEligibleSelection) {
      try {
        unwrapAction(await sendInvoiceReminderAction(invoice.id))
        sent++
      } catch (error: any) {
        console.error(error)
        failures.push(invoice.invoice_number ?? invoice.title ?? invoice.id)
      }
    }
    setSendingBulkReminders(false)
    if (sent > 0) {
      toast.success(`Sent ${sent} reminder${sent === 1 ? "" : "s"}`)
    }
    if (failures.length > 0) {
      toast.error(`Could not send ${failures.length} reminder${failures.length === 1 ? "" : "s"}`, {
        description: failures.join(", "),
      })
    }
    if (sent > 0 && failures.length === 0) {
      setSelectedIds([])
    }
  }

  function handleExportCsv() {
    const rows = selectedInvoices.length > 0 ? selectedInvoices : filtered
    if (rows.length === 0) return
    const escape = (value: string | number) => {
      // Neutralize spreadsheet formula injection (=, +, -, @ leads) before CSV quoting.
      const raw = String(value)
      const str = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    const header = ["Invoice No.", "Title", "Billed to", "Status", "Issue date", "Due date", "Total", "Balance"]
    const lines = rows.map((invoice) =>
      [
        invoice.invoice_number ?? "",
        invoice.title ?? "",
        customerNameOf(invoice),
        statusLabels[displayStatusKey(invoice)],
        invoice.issue_date ?? "",
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
    link.download = `invoices-${format(new Date(), "yyyy-MM-dd")}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${rows.length} invoice${rows.length === 1 ? "" : "s"} to CSV`)
  }

  async function handleGenerateBackupPackage(invoice: Invoice) {
    if (!invoice.project_id) {
      toast.error("Project is required to generate a backup package")
      return
    }
    setPackageActionInvoiceId(invoice.id)
    setPackageActionKind("generate")
    try {
      const summary = unwrapAction(await generateOwnerBillingPackageAction({ projectId: invoice.project_id, invoiceId: invoice.id }))
      setPackageSummaries((prev) => [summary, ...prev.filter((item) => item.invoice_id !== invoice.id)])
      toast.success("Backup package generated", {
        description: `${summary.cost_count} costs and ${summary.proof_count} proof files captured.`,
      })
    } catch (error: any) {
      console.error(error)
      toast.error("Could not generate backup package", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setPackageActionInvoiceId(null)
      setPackageActionKind(null)
    }
  }

  async function handleShareBackupPackage(invoice: Invoice) {
    const summary = packageByInvoiceId.get(invoice.id)
    if (!invoice.project_id || !summary) {
      toast.error("Generate a backup package first")
      return
    }
    setPackageActionInvoiceId(invoice.id)
    setPackageActionKind("share")
    try {
      const shared = unwrapAction(await shareOwnerBillingPackageAction({ projectId: invoice.project_id, packageId: summary.package_id }))
      setPackageSummaries((prev) => [shared, ...prev.filter((item) => item.invoice_id !== invoice.id)])
      setItems((prev) => prev.map((item) => (item.id === invoice.id ? { ...item, client_visible: true } : item)))
      toast.success("Backup package shared", {
        description: `The ${terms.ownerPortal.toLowerCase()} invoice now includes the owner backup manifest.`,
      })
    } catch (error: any) {
      console.error(error)
      toast.error("Could not share backup package", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setPackageActionInvoiceId(null)
      setPackageActionKind(null)
    }
  }

  async function handleVoidInvoice() {
    if (!voidingInvoice) return
    setDestructiveActionLoading(true)
    try {
      const updated = unwrapAction(await voidInvoiceAction(voidingInvoice.id))
      setItems((prev) => prev.map((invoice) => (invoice.id === updated.id ? updated : invoice)))
      setVoidingInvoice(null)
      toast.success("Invoice voided")
    } catch (error: any) {
      console.error(error)
      toast.error("Could not void invoice", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setDestructiveActionLoading(false)
    }
  }

  async function handleReviseInvoice() {
    if (!revisingInvoice) return
    setDestructiveActionLoading(true)
    try {
      const replacement = unwrapAction(await reviseInvoiceAction(revisingInvoice.id))
      setItems((prev) => [
        replacement,
        ...prev.map((invoice) =>
          invoice.id === revisingInvoice.id
            ? { ...invoice, status: "void" as const, client_visible: false, balance_due_cents: 0 }
            : invoice,
        ),
      ])
      setRevisingInvoice(null)
      goToInvoice(replacement.id)
      toast.success("Replacement draft created", {
        description: `Invoice ${replacement.invoice_number} is ready for review.`,
      })
    } catch (error: any) {
      console.error(error)
      toast.error("Could not revise invoice", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setDestructiveActionLoading(false)
    }
  }

  async function handleDeleteInvoice() {
    if (!deletingInvoice) return
    setDestructiveActionLoading(true)
    try {
      unwrapAction(await deleteInvoiceAction(deletingInvoice.id))
      setItems((prev) => prev.filter((invoice) => invoice.id !== deletingInvoice.id))
      setSelectedIds((prev) => prev.filter((id) => id !== deletingInvoice.id))
      setDeletingInvoice(null)
      toast.success("Invoice deleted")
    } catch (error: any) {
      console.error(error)
      toast.error("Could not delete invoice", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setDestructiveActionLoading(false)
    }
  }

  async function handleOpenMove(invoice: Invoice) {
    setMovingInvoice(invoice)
    setMoveTargetId(null)
    setMoveSearch("")
    setMoveProjectsLoading(true)
    try {
      const list = unwrapAction(await listMovableProjectsAction())
      setMoveProjects(list.filter((project) => project.id !== invoice.project_id))
    } catch (error: any) {
      console.error(error)
      toast.error("Could not load projects", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setMoveProjectsLoading(false)
    }
  }

  async function handleMoveInvoice() {
    if (!movingInvoice || !moveTargetId) return
    setMoveLoading(true)
    try {
      const updated = unwrapAction(await moveInvoiceToProjectAction(movingInvoice.id, moveTargetId))
      // The invoice now belongs to another project — drop it from this project-scoped list.
      setItems((prev) => prev.filter((invoice) => invoice.id !== updated.id))
      setSelectedIds((prev) => prev.filter((id) => id !== updated.id))
      const targetName = moveProjects.find((project) => project.id === moveTargetId)?.name
      setMovingInvoice(null)
      setMoveTargetId(null)
      toast.success("Invoice moved", {
        description: targetName ? `Moved to ${targetName}.` : undefined,
      })
      router.refresh()
    } catch (error: any) {
      console.error(error)
      toast.error("Could not move invoice", {
        description: error?.message ?? "Please try again.",
      })
    } finally {
      setMoveLoading(false)
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

  const renderSortHeader = (label: string, key: SortKey) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${sortKey === key ? "text-foreground" : ""}`}
    >
      {label}
      {sortKey === key ? (
        sortDir === "desc" ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" />
        )
      ) : null}
    </button>
  )

  const columnCount = 9 + (enableApprovedCostsSource ? 1 : 0)

  return (
    <div className="w-full">
      <div className="sticky top-0 z-20 flex min-h-14 w-full flex-col border-b bg-background/95 shadow-[0_1px_0_rgba(0,0,0,0.02)] backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-stretch">
        {toolbarLeading && <div className="flex min-w-0 items-stretch px-4 sm:border-r sm:px-6 lg:px-8">{toolbarLeading}</div>}
        <div
          className={
            toolbarLeading ? "flex w-full flex-col gap-2 px-4 py-3 sm:flex-1 sm:flex-row sm:items-center sm:justify-end sm:px-4 sm:py-2 lg:px-6" : "contents"
          }
        >
          <div className={toolbarLeading ? "w-full sm:max-w-sm lg:max-w-md xl:max-w-lg" : "w-full sm:max-w-xl"}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search invoices"
                className="h-9 rounded-md bg-muted/30 pl-9 pr-12 shadow-none transition-colors focus-visible:bg-background"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 border-0 shadow-none hover:bg-background">
                    <Filter className="h-4 w-4" />
                    {activeFilterChips.length > 0 && (
                      <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium text-primary-foreground">
                        {activeFilterChips.length}
                      </span>
                    )}
                    <span className="sr-only">Filters</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Calendar className="mr-2 h-4 w-4" />
                      By due date
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent className="w-56" sideOffset={8}>
                        <DropdownMenuRadioGroup value={dueFilter} onValueChange={(value) => setDueFilter(value as DueFilter)}>
                          <DropdownMenuRadioItem value="any">Any due date</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="due_soon">Due in next 7 days</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="overdue">Overdue</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="no_due">No due date</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <List className="mr-2 h-4 w-4" />
                      Status
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent className="w-56" sideOffset={8}>
                        <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                          <DropdownMenuRadioItem value="all">Any status</DropdownMenuRadioItem>
                          {(["draft", "saved", "sent", "partial", "paid", "overdue", "void"] as StatusKey[]).map((status) => (
                            <DropdownMenuRadioItem key={status} value={status}>
                              {statusLabels[status]}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="flex flex-row gap-2">
            <Button onClick={() => goToInvoice("new")} size="sm" className="h-9 flex-1 whitespace-nowrap sm:flex-none">
              <Plus className="h-4 w-4 mr-2" />
              New invoice
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSchedulesOpen(true)}
              className="h-9 w-9 shrink-0 bg-background"
              title="Recurring invoices"
              aria-label="Open recurring invoices"
            >
              <Repeat className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setQueueOpen(true)}
              className="relative h-9 w-9 shrink-0 bg-background"
              title={`QuickBooks: ${qboPendingCount} waiting, ${qboErrorCount} failed`}
              aria-label={`Open QuickBooks sheet. ${qboPendingCount} waiting, ${qboErrorCount} failed`}
            >
              <RefreshCcw className="h-4 w-4" />
              {(qboPendingCount > 0 || qboErrorCount > 0) && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                  {qboPendingCount + qboErrorCount}
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>

      {items.length > 0 && (
        <div className="border-b">
          <div className="grid grid-cols-2 divide-y sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6 lg:divide-x">
            <div className="p-3 sm:border-r lg:border-r-0">
              <div className="text-[11px] font-medium uppercase text-muted-foreground">Outstanding</div>
              <div className="mt-1 font-mono text-sm font-semibold">{formatMoneyFromCents(arSummary.outstandingCents)}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                setAgingFilter(null)
                setStatusFilter((current) => (current === "overdue" ? "all" : "overdue"))
              }}
              aria-pressed={statusFilter === "overdue"}
              className={`p-3 text-left transition-colors hover:bg-muted/40 ${statusFilter === "overdue" ? "bg-muted/40" : ""}`}
            >
              <div className="text-[11px] font-medium uppercase text-muted-foreground">Overdue</div>
              <div className={`mt-1 font-mono text-sm font-semibold ${arSummary.overdueCents > 0 ? "text-destructive" : ""}`}>
                {formatMoneyFromCents(arSummary.overdueCents)}
              </div>
            </button>
            {AGING_BUCKET_LABELS.map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => setAgingFilter((current) => (current === index ? null : (index as AgingBucket)))}
                aria-pressed={agingFilter === index}
                className={`p-3 text-left transition-colors hover:bg-muted/40 ${agingFilter === index ? "bg-muted/40" : ""}`}
              >
                <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
                <div
                  className={`mt-1 font-mono text-sm ${
                    arSummary.buckets[index] > 0 ? (index >= 2 ? "font-semibold text-destructive" : "font-medium") : "text-muted-foreground"
                  }`}
                >
                  {formatMoneyFromCents(arSummary.buckets[index])}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {activeFilterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/20 px-4 py-2 sm:px-6 lg:px-8">
          <span className="text-xs text-muted-foreground">Filtered by</span>
          {activeFilterChips.map((chip) => (
            <Badge key={chip.key} variant="secondary" className="gap-1 pr-1 font-normal">
              {chip.label}
              <button
                type="button"
                onClick={chip.clear}
                className="rounded-sm p-0.5 hover:bg-background/80"
                aria-label={`Clear ${chip.key} filter`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              setStatusFilter("all")
              setDueFilter("any")
              setAgingFilter(null)
            }}
          >
            Clear all
          </button>
        </div>
      )}

      <QboSyncSheet
        open={queueOpen}
        onOpenChange={setQueueOpen}
        projectId={scopedProject?.id}
        projectName={scopedProject?.name}
        onOpenInvoice={goToInvoice}
      />
      <MakeRecurringDialog
        invoice={recurringSourceInvoice}
        open={Boolean(recurringSourceInvoice)}
        onOpenChange={(open) => !open && setRecurringSourceInvoice(null)}
      />
      <InvoiceSchedulesDialog open={schedulesOpen} onOpenChange={setSchedulesOpen} projectId={scopedProject?.id} />

      <AnimatePresence>
        <div className="overflow-hidden border-b">
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
                <TableHead className="min-w-[90px] px-4 py-4">{renderSortHeader("Invoice No.", "number")}</TableHead>
                <TableHead className="px-4 py-4">{renderSortHeader("Billed to", "customer")}</TableHead>
                <TableHead className="px-4 py-4 text-center">{renderSortHeader("Issue date", "issue_date")}</TableHead>
                <TableHead className="px-4 py-4 text-center">{renderSortHeader("Due date", "due_date")}</TableHead>
                <TableHead className="text-right px-4 py-4">{renderSortHeader("Amount", "amount")}</TableHead>
                <TableHead className="text-right px-4 py-4">{renderSortHeader("Balance", "balance")}</TableHead>
                {enableApprovedCostsSource && <TableHead className="px-4 py-4 text-center">Backup</TableHead>}
                <TableHead className="px-4 py-4 text-center">{renderSortHeader("Status", "status")}</TableHead>
                <TableHead className="text-center w-12 px-4 py-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((invoice) => {
                const total = formatMoneyFromCents(totalCentsOf(invoice))
                const balanceCents = displayStatusKey(invoice) === "paid" || displayStatusKey(invoice) === "void" ? 0 : balanceCentsOf(invoice)
                const balance = formatMoneyFromCents(balanceCents)
                const customerName = customerNameOf(invoice)
                const overdueDays = daysPastDue(invoice)
                const invoiceLabel = invoice.invoice_number || invoice.title || "Untitled invoice"
                const backupPackage = packageByInvoiceId.get(invoice.id)
                const packageBusy = packageActionInvoiceId === invoice.id
                return (
                  <TableRow
                    key={invoice.id}
                    className="align-top divide-x cursor-pointer"
                    onClick={(event) => {
                      // The whole row opens the detail sheet, except clicks on interactive
                      // controls (checkbox, menus, buttons) which keep their own behavior.
                      const target = event.target as HTMLElement
                      if (target.closest("button, a, input, [role='checkbox'], [role='menu'], [data-row-noclick]")) return
                      goToInvoice(invoice.id)
                    }}
                  >
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
                          onClick={() => goToInvoice(invoice.id)}
                          className="font-semibold text-left hover:text-primary transition-colors"
                          aria-label={`View invoice ${invoice.invoice_number ?? invoice.title ?? ""}`}
                        >
                          {invoiceLabel}
                        </button>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4 text-sm">
                      <span className="line-clamp-1">{customerName || "—"}</span>
                    </TableCell>
                    <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                      {invoice.issue_date ? format(parseDateOnly(invoice.issue_date), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="px-4 py-4 text-sm text-center">
                      <span className={balanceCents > 0 && overdueDays > 0 ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {invoice.due_date ? format(parseDateOnly(invoice.due_date), "MMM d, yyyy") : "—"}
                      </span>
                      {balanceCents > 0 && overdueDays > 0 && (
                        <div className="text-[11px] text-destructive/80">{overdueDays}d past due</div>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-4 text-right">
                      <div className="font-semibold">{total}</div>
                    </TableCell>
                    <TableCell className="px-4 py-4 text-right">
                      <div className={balanceCents > 0 ? "font-semibold" : "text-muted-foreground"}>{balance}</div>
                    </TableCell>
                    {enableApprovedCostsSource && (
                      <TableCell className="px-4 py-4 text-center">
                        <BackupPackageBadge summary={backupPackage} busy={packageBusy ? packageActionKind : null} />
                      </TableCell>
                    )}
                    <TableCell className="px-4 py-4 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Badge variant="secondary" className={`capitalize border ${statusStyles[displayStatusKey(invoice)]}`}>
                          {statusLabels[displayStatusKey(invoice)]}
                        </Badge>
                        <AccountingSyncBadge
                          status={invoice.qbo_sync_status}
                          syncedAt={invoice.qbo_synced_at ?? undefined}
                          externalId={invoice.qbo_id ?? undefined}
                          compact
                        />
                      </div>
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
                              disabled={
                                !["draft", "saved"].includes(resolveStatusKey(invoice.status)) ||
                                Boolean(invoice.sent_at) ||
                                Boolean(invoice.qbo_id)
                              }
                              onSelect={(event) => {
                                event.preventDefault()
                                goToInvoice(invoice.id)
                              }}
                            >
                              Edit invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={
                                ["draft", "saved", "partial", "paid", "void"].includes(resolveStatusKey(invoice.status))
                              }
                              onSelect={(event) => {
                                event.preventDefault()
                                setRevisingInvoice(invoice)
                              }}
                            >
                              Revise and reissue
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault()
                                goToInvoice("new", { duplicate: invoice.id })
                              }}
                            >
                              <Copy className="mr-2 h-4 w-4" />
                              Duplicate invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={resolveStatusKey(invoice.status) === "void"}
                              onSelect={(event) => {
                                event.preventDefault()
                                setRecurringSourceInvoice(invoice)
                              }}
                            >
                              <Repeat className="mr-2 h-4 w-4" />
                              Make recurring…
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={linkingId === invoice.id}
                              onSelect={(event) => {
                                event.preventDefault()
                                handleShareRequest(invoice)
                              }}
                            >
                              {linkingId === invoice.id ? "Copying…" : "Copy link"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault()
                                void handleOpenMove(invoice)
                              }}
                            >
                              <FolderOpen className="mr-2 h-4 w-4" />
                              Move to project…
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={
                                ["paid", "partial", "void"].includes(resolveStatusKey(invoice.status)) ||
                                // An unsent, unsynced draft should be deleted, not voided.
                                (["draft", "saved"].includes(resolveStatusKey(invoice.status)) &&
                                  !invoice.client_visible &&
                                  !invoice.sent_at &&
                                  !invoice.qbo_id)
                              }
                              onSelect={(event) => {
                                event.preventDefault()
                                setVoidingInvoice(invoice)
                              }}
                            >
                              <Ban className="mr-2 h-4 w-4" />
                              Void invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={
                                !["draft", "saved"].includes(resolveStatusKey(invoice.status)) ||
                                invoice.client_visible === true ||
                                Boolean(invoice.sent_at) ||
                                Boolean(invoice.qbo_id)
                              }
                              onSelect={(event) => {
                                event.preventDefault()
                                setDeletingInvoice(invoice)
                              }}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete invoice
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={
                                // Reminders only make sense for sent invoices with money still owed.
                                !OPEN_STATUSES.includes(displayStatusKey(invoice)) ||
                                balanceCentsOf(invoice) <= 0 ||
                                sendingReminderId === invoice.id
                              }
                              onSelect={(event) => {
                                event.preventDefault()
                                handleSendReminder(invoice)
                              }}
                            >
                              {sendingReminderId === invoice.id ? "Sending…" : "Send reminder"}
                            </DropdownMenuItem>
                            {enableApprovedCostsSource && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={!invoice.project_id || packageBusy}
                                  onSelect={(event) => {
                                    event.preventDefault()
                                    void handleGenerateBackupPackage(invoice)
                                  }}
                                >
                                  {packageBusy && packageActionKind === "generate"
                                    ? "Generating…"
                                    : backupPackage
                                      ? "Regenerate backup package"
                                      : "Generate backup package"}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={
                                    !invoice.project_id ||
                                    !backupPackage ||
                                    packageBusy ||
                                    ["shared", "downloaded", "accepted"].includes(backupPackage.status)
                                  }
                                  onSelect={(event) => {
                                    event.preventDefault()
                                    void handleShareBackupPackage(invoice)
                                  }}
                                >
                                  {packageBusy && packageActionKind === "share" ? "Sharing…" : "Share backup to portal"}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filtered.length === 0 && (
                <TableRow className="divide-x">
                  <TableCell colSpan={columnCount} className="py-10 text-center text-muted-foreground">
                    {items.length === 0 ? (
                      <div className="flex flex-col items-center gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <FolderOpen className="h-6 w-6" />
                        </div>
                        <div>
                          <p className="font-medium">No invoices yet</p>
                          <p className="text-sm">Create your first invoice to get started.</p>
                        </div>
                        <Button onClick={() => goToInvoice("new")}>
                          <Plus className="mr-2 h-4 w-4" />
                          Create invoice
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-3">
                        <div>
                          <p className="font-medium">No invoices match</p>
                          <p className="text-sm">Adjust the search or clear the active filters.</p>
                        </div>
                        {(activeFilterChips.length > 0 || searchTerm.trim().length > 0) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSearchTerm("")
                              setStatusFilter("all")
                              setDueFilter("any")
                              setAgingFilter(null)
                            }}
                          >
                            Clear search and filters
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {hasMore && !serverSearchResults && (
            <div className="flex justify-center border-t py-3">
              <Button variant="ghost" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : `Load more (${items.length} loaded)`}
              </Button>
            </div>
          )}
        </div>

        {selectedIds.length > 0 && (
          <InvoiceBottomBar
            selectedCount={selectedIds.length}
            onDeselectAll={() => setSelectedIds([])}
            onExportCsv={handleExportCsv}
            onSendReminders={handleBulkSendReminders}
            reminderEligibleCount={reminderEligibleSelection.length}
            sendingReminders={sendingBulkReminders}
          />
        )}
      </AnimatePresence>

      <ReceivablesWorkspace
        projectId={scopedProject?.id ?? projects[0]?.id ?? ""}
        projects={projects}
        invoices={items}
        builderInfo={builderInfo}
        contacts={contacts}
        costCodes={costCodes}
        enableApprovedCostsSource={enableApprovedCostsSource}
        pendingLabel={pendingOpenInvoiceLabel}
        onUpsertInvoice={upsertInvoice}
        onRemoveInvoice={removeInvoiceFromList}
        onRefresh={() => {
          void refreshInvoices()
          router.refresh()
        }}
      />

      <AlertDialog open={Boolean(sharingDraftInvoice)} onOpenChange={(open) => !open && setSharingDraftInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Share an unsent invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              {sharingDraftInvoice?.invoice_number ?? "This invoice"} hasn&apos;t been sent yet. Creating a link makes it
              viewable by anyone who has the URL.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const invoice = sharingDraftInvoice
                setSharingDraftInvoice(null)
                if (invoice) void handleShare(invoice.id)
              }}
            >
              Create link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(voidingInvoice)} onOpenChange={(open) => !open && setVoidingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels {voidingInvoice?.invoice_number ?? "this invoice"} and releases {invoiceReleaseDescription} so they can be invoiced again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveActionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={destructiveActionLoading} onClick={() => void handleVoidInvoice()}>
              {destructiveActionLoading ? "Voiding..." : "Void invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(revisingInvoice)} onOpenChange={(open) => !open && setRevisingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revise and reissue invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This voids invoice {revisingInvoice?.invoice_number ?? ""}, preserves its audit history, and creates a new linked draft with a new invoice number.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveActionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={destructiveActionLoading} onClick={() => void handleReviseInvoice()}>
              {destructiveActionLoading ? "Creating revision..." : "Create replacement draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deletingInvoice)} onOpenChange={(open) => !open && setDeletingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the unsent invoice {deletingInvoice?.invoice_number ?? ""}. Sent, synced, or paid invoices should be voided instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveActionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={destructiveActionLoading}
              onClick={() => void handleDeleteInvoice()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {destructiveActionLoading ? "Deleting..." : "Delete invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={Boolean(movingInvoice)}
        onOpenChange={(open) => {
          if (!open && !moveLoading) {
            setMovingInvoice(null)
            setMoveTargetId(null)
            setMoveSearch("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move invoice to another project</DialogTitle>
            <DialogDescription>
              Move {movingInvoice?.invoice_number ?? "this invoice"} to a different project. Any {invoiceReleaseDescription}
              linked to the current project will be released so they can be billed again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={moveSearch}
                onChange={(event) => setMoveSearch(event.target.value)}
                placeholder="Search projects"
                className="h-9 pl-9"
                disabled={moveProjectsLoading || moveLoading}
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
              {moveProjectsLoading ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading projects…</div>
              ) : (
                (() => {
                  const term = moveSearch.trim().toLowerCase()
                  const visible = moveProjects.filter(
                    (project) => term.length === 0 || project.name.toLowerCase().includes(term),
                  )
                  if (visible.length === 0) {
                    return (
                      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {moveProjects.length === 0 ? "No other projects available." : "No projects match your search."}
                      </div>
                    )
                  }
                  return visible.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      disabled={moveLoading}
                      onClick={() => setMoveTargetId(project.id)}
                      className={`flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                        moveTargetId === project.id ? "bg-muted font-medium" : ""
                      }`}
                    >
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{project.name}</span>
                    </button>
                  ))
                })()
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={moveLoading}
              onClick={() => {
                setMovingInvoice(null)
                setMoveTargetId(null)
                setMoveSearch("")
              }}
            >
              Cancel
            </Button>
            <Button disabled={!moveTargetId || moveLoading} onClick={() => void handleMoveInvoice()}>
              {moveLoading ? "Moving…" : "Move invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { toast } from "sonner"

import { getOrgPayableContextAction, savePayableViewAction } from "./actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"
import {
  getPayablesAccountingContextAction,
  getPayablesAccountingSyncStatesAction,
  approveVendorBillsAtomicAction,
  updateProjectVendorBillStatusAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import { Plus, Receipt, Search, Upload, X } from "@/components/icons"
import { AddPayableSheet } from "@/components/payables/add-payable-sheet"
import { QboSyncSheet } from "@/components/integrations/qbo-sync-sheet"
import { PayablesWorkspace } from "@/components/payables/payables-workspace"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ProjectAvatar } from "@/components/ui/project-avatar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { vendorLabel } from "@/components/payables/payables-ui"
import {
  isVendorCredit,
  payableOutstandingCents,
} from "@/lib/financials/payables-rules"
import { unwrapAction } from "@/lib/action-result"
import type {
  OrgPayablesDeskData,
  PayableRunMembership,
} from "@/lib/services/org-payables"
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { BudgetLineOption } from "@/lib/types"
import type { AccountingSyncState } from "@/lib/services/accounting-sync-state"
import type { SavedPayableView } from "@/lib/services/payable-views"
import { cn } from "@/lib/utils"

type QBOAccountOption = {
  id: string
  name: string
  fullyQualifiedName?: string
  account_type?: string
  account_sub_type?: string
}
type ProjectBillingModel =
  | "fixed_price"
  | "cost_plus_percent"
  | "cost_plus_fixed_fee"
  | "cost_plus_gmp"
  | "time_and_materials"
type ProjectOption = {
  id: string
  name: string
  billingModel: ProjectBillingModel
}

type TabKey = "due" | "approval" | "approved" | "paid" | "all"

const TABS: { key: TabKey; label: string }[] = [
  { key: "due", label: "Due" },
  { key: "approval", label: "Needs approval" },
  { key: "approved", label: "Approved" },
  { key: "paid", label: "Paid" },
  { key: "all", label: "All" },
]

/**
 * Which tabs a payable belongs on. Vendor credits are money coming back, not an
 * obligation — they only ever surface under All, so the money columns on the
 * working tabs mean one thing.
 */
function tabsFor(bill: VendorBillSummary): TabKey[] {
  if (isVendorCredit(bill)) return ["all"]
  if (bill.status === "paid") return ["paid", "all"]
  if (bill.status === "pending") return ["due", "approval", "all"]
  return ["due", "approved", "all"]
}

function matchesSearch(bill: VendorBillSummary, query: string) {
  if (!query) return true
  return [
    bill.company_name,
    bill.qbo_vendor_name,
    bill.bill_number,
    bill.project_name,
    bill.commitment_title,
  ].some((value) => value?.toLowerCase().includes(query))
}

/** The line under the vendor: what this payable is actually for. */
function itemLabel(bill: VendorBillSummary) {
  if (isVendorCredit(bill)) return "Vendor credit"
  return (
    bill.commitment_title ??
    bill.actual_lines?.[0]?.description ??
    "Vendor bill"
  )
}

const DAY_MS = 86_400_000

function daysToDue(dueDate?: string | null): number | null {
  if (!dueDate) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round(
    (new Date(`${dueDate}T00:00:00`).getTime() - today.getTime()) / DAY_MS,
  )
}

function DueCell({ bill }: { bill: VendorBillSummary }) {
  if (!bill.due_date) return <span className="text-muted-foreground">—</span>
  const days = daysToDue(bill.due_date)
  const settled = bill.status === "paid"
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${bill.due_date}T00:00:00`))
  const late = !settled && days != null && days < 0
  const soon = !settled && days != null && days >= 0 && days <= 7
  return (
    <div className="flex flex-col">
      <span
        className={cn(
          "tabular-nums",
          late && "font-medium text-destructive",
          soon && "text-foreground",
        )}
      >
        {date}
      </span>
      {days == null || settled ? null : late ? (
        <span className="text-[11px] text-destructive">{-days}d overdue</span>
      ) : soon ? (
        <span className="text-[11px] text-warning">
          {days === 0
            ? "Due today"
            : days === 1
              ? "Due tomorrow"
              : `In ${days} days`}
        </span>
      ) : null}
    </div>
  )
}

/**
 * `payment_method` predates the payments table and QuickBooks imports write their
 * own vocabulary, so the label map is deliberately wider than the Zod enum.
 */
const METHOD_LABELS: Record<string, string> = {
  ach: "ACH",
  card: "Card",
  credit_card: "Card",
  wire: "Wire",
  check: "Check",
  cash: "Cash",
  other: "Other",
}

/**
 * How this payable was actually paid. An open payable has no method yet — Arc
 * pays by ACH today and will mail checks later, and which rail a bill goes out on
 * is decided when it is released, not by whether its vendor has onboarded. So the
 * column reports the recorded fact and stays quiet otherwise.
 */
function MethodCell({ bill }: { bill: VendorBillSummary }) {
  const recorded =
    bill.payment_method ??
    bill.payments?.find((payment) => payment.method)?.method
  if (!recorded) return <span className="text-muted-foreground">—</span>
  const viaAccounting = bill.payments?.some(
    (payment) => payment.provider === "qbo",
  )
  return (
    <span
      className="text-sm text-muted-foreground"
      title={viaAccounting ? "Recorded in QuickBooks" : undefined}
    >
      {METHOD_LABELS[recorded] ?? recorded}
    </span>
  )
}

function StatusCell({
  bill,
  membership,
  awaitsViewer,
}: {
  bill: VendorBillSummary
  membership?: PayableRunMembership
  awaitsViewer?: boolean
}) {
  if (isVendorCredit(bill)) {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        Credit
      </Badge>
    )
  }
  // A bill inside a run is no longer just "approved" — say where the money is.
  if (membership) {
    const label = awaitsViewer
      ? "Awaiting your approval"
      : membership.runStatus === "pending_approval"
        ? "In approval"
        : membership.runStatus === "processing"
          ? "Paying"
          : "Scheduled"
    return (
      <Badge
        variant="outline"
        className={cn(
          "font-normal",
          awaitsViewer
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-primary/25 bg-primary/5 text-primary",
        )}
      >
        {label}
      </Badge>
    )
  }
  const config: Record<string, { label: string; className: string }> = {
    paid: {
      label: "Paid",
      className: "border-success/25 bg-success/10 text-success",
    },
    partial: {
      label: "Partly paid",
      className: "border-primary/25 bg-primary/10 text-primary",
    },
    approved: {
      label: "Approved",
      className: "border-border bg-accent text-accent-foreground",
    },
    pending: {
      label: "Needs approval",
      className: "border-warning/25 bg-warning/10 text-warning",
    },
  }
  const tone = config[bill.status] ?? config.pending
  return (
    <Badge variant="outline" className={cn("font-normal", tone.className)}>
      {tone.label}
    </Badge>
  )
}

/**
 * Sticky header cells. `border-collapse` drops borders on sticky cells, so the
 * hairline under the header is an inset shadow. `text-muted-foreground` restores
 * the microlabel tone that TableHead's own `text-foreground` would otherwise win.
 */
const HEAD =
  "sticky top-0 z-10 bg-background text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]"

export function PayablesDesk({
  data,
  savedViews,
  railOpen,
  viewerMayApproveRuns = false,
}: {
  data: OrgPayablesDeskData
  savedViews: SavedPayableView[]
  railOpen: boolean
  viewerMayApproveRuns?: boolean
}) {
  const router = useRouter()
  const urlSearchParams = useSearchParams()
  const [isPending, startTransition] = React.useTransition()

  const [tab, setTab] = React.useState<TabKey>(data.query.tab)
  const [search, setSearch] = React.useState(data.query.search)
  const [savingView, setSavingView] = React.useState(false)
  const [viewName, setViewName] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set(),
  )
  const [workspaceBillId, openBill] = useWorkspaceParam("bill")

  // Org-level accounting context — the same one the project workbench loads.
  const [accountingEnabled, setAccountingEnabled] = React.useState(false)
  const [accountingProvider, setAccountingProvider] = React.useState<string | null>(null)
  const [accountingProviderName, setAccountingProviderName] = React.useState<string | null>(null)
  const [accountingSyncByBillId, setAccountingSyncByBillId] = React.useState<Record<string, AccountingSyncState>>({})
  const [qboExpenseAccounts, setQboExpenseAccounts] = React.useState<
    QBOAccountOption[]
  >([])
  const [qboApAccounts, setQboApAccounts] = React.useState<QBOAccountOption[]>(
    [],
  )
  const [qboDefaults, setQboDefaults] = React.useState<{
    expenseAccountId?: string
    apAccountId?: string
  }>({})
  const [projects, setProjects] = React.useState<ProjectOption[]>([])

  // Adding a bill: opened by the toolbar button, or by dropping a file anywhere
  // on the page. `droppedFile` is what the sheet scans on open.
  const [addOpen, setAddOpen] = React.useState(false)
  const [syncSheetOpen, setSyncSheetOpen] = React.useState(false)
  const [droppedFile, setDroppedFile] = React.useState<File | null>(null)
  const [isDraggingFile, setIsDraggingFile] = React.useState(false)

  // Per-payable project context, fetched only when a payable is opened.
  const [costCodesEnabled, setCostCodesEnabled] = React.useState(true)
  const [budgetLines, setBudgetLines] = React.useState<BudgetLineOption[]>([])
  const [holdEvaluations, setHoldEvaluations] = React.useState<
    Record<string, PaymentHoldEvaluation>
  >({})

  React.useEffect(() => {
    let cancelled = false
    getPayablesAccountingContextAction()
      .then((context) => {
        if (cancelled) return
        setAccountingEnabled(Boolean(context.enabled))
        setAccountingProvider(context.provider ?? null)
        setAccountingProviderName(context.providerName ?? null)
        setQboExpenseAccounts(context.expenseAccounts ?? [])
        setQboApAccounts(context.apAccounts ?? [])
        setQboDefaults(context.defaults ?? {})
      })
      .catch(() => {
        if (!cancelled) setAccountingEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!accountingEnabled) return
    void getPayablesAccountingSyncStatesAction(data.bills.map((bill) => bill.id)).then(setAccountingSyncByBillId).catch(() => setAccountingSyncByBillId({}))
  }, [accountingEnabled, data.bills])

  React.useEffect(() => {
    let cancelled = false
    listProjectsAction()
      .then((rows) => {
        if (cancelled) return
        setProjects(
          (rows ?? []).map((project: any) => ({
            id: project.id,
            name: project.name,
            billingModel:
              project.financial_settings?.billing_model ?? "fixed_price",
          })),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const openedBill = React.useMemo(
    () => data.bills.find((bill) => bill.id === workspaceBillId) ?? null,
    [data.bills, workspaceBillId],
  )
  const openedProjectId = openedBill?.project_id

  React.useEffect(() => {
    if (!workspaceBillId || !openedProjectId) return
    let cancelled = false
    getOrgPayableContextAction(openedProjectId, workspaceBillId).then(
      (result) => {
        if (cancelled || !result.success) return
        setCostCodesEnabled(result.data.costCodesEnabled)
        setBudgetLines(result.data.budgetLines)
        const holds = result.data.holds
        if (holds)
          setHoldEvaluations((current) => ({
            ...current,
            [workspaceBillId]: holds,
          }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [openedProjectId, workspaceBillId])

  const counts = data.counts
  const rows = data.bills

  const navigateQuery = React.useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(urlSearchParams.toString())
    for (const [key, value] of Object.entries(updates)) value ? params.set(key, value) : params.delete(key)
    router.replace(`/payables?${params.toString()}`, { scroll: false })
  }, [router, urlSearchParams])

  React.useEffect(() => {
    setTab(data.query.tab)
    setSearch(data.query.search)
  }, [data.query.search, data.query.tab])

  React.useEffect(() => {
    if (search === data.query.search) return
    const timer = window.setTimeout(() => navigateQuery({ q: search.trim() || null, page: null }), 350)
    return () => window.clearTimeout(timer)
  }, [data.query.search, navigateQuery, search])

  /**
   * Method is settled history, so it only earns a column where settled rows live.
   * On the working tabs nothing has been paid yet and the column would be a full
   * height of em dashes.
   */
  const showMethod = tab === "paid" || tab === "all"

  // Selection only ever means the rows you can still see.
  const visibleIds = React.useMemo(
    () => new Set(rows.map((bill) => bill.id)),
    [rows],
  )
  const selected = React.useMemo(
    () => rows.filter((bill) => selectedIds.has(bill.id)),
    [rows, selectedIds],
  )
  const selectableRows = React.useMemo(
    () => rows.filter((bill) => !isVendorCredit(bill)),
    [rows],
  )
  const approvable = React.useMemo(
    () => selected.filter((bill) => bill.status === "pending"),
    [selected],
  )
  // Bills a payment run could take today: approved with a balance, an ACH-ready
  // vendor, and not already claimed by an active run.
  const payable = React.useMemo(
    () =>
      selected.filter(
        (bill) =>
          (bill.status === "approved" || bill.status === "partial") &&
          payableOutstandingCents(bill) > 0 &&
          bill.company_id &&
          data.paymentReadinessByCompanyId[bill.company_id] === "ready" &&
          !data.runMembershipByBillId[bill.id],
      ),
    [selected, data.paymentReadinessByCompanyId, data.runMembershipByBillId],
  )

  React.useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        Array.from(current).filter((id) => visibleIds.has(id)),
      )
      return next.size === current.size ? current : next
    })
  }, [visibleIds])

  const outstandingCents = rows.reduce(
    (sum, bill) => sum + payableOutstandingCents(bill),
    0,
  )
  const overdueCount = rows.filter((bill) => {
    if (bill.status === "paid") return false
    const days = daysToDue(bill.due_date)
    return days != null && days < 0
  }).length

  /** A payment this viewer is the one being asked to release. */
  const awaitsMyApproval = React.useCallback(
    (bill: VendorBillSummary) => {
      const membership = data.runMembershipByBillId[bill.id]
      return Boolean(
        viewerMayApproveRuns &&
        membership &&
        membership.runStatus === "pending_approval" &&
        !membership.preparedByViewer,
      )
    },
    [data.runMembershipByBillId, viewerMayApproveRuns],
  )

  /**
   * Page-wide file drop.
   *
   * Listeners are on `window`, not a wrapper element, so the whole desk is the
   * target — a bill arrives as a PDF someone is already dragging, and making them
   * find a small dropzone first is the part worth deleting.
   *
   * `dragleave` fires every time the pointer crosses into a child element, so a
   * depth counter tracks real entry and exit; a boolean flickers.
   */
  React.useEffect(() => {
    // While the sheet is open it owns file drops — it has its own dropzone, and a
    // second drop landing here would silently swap the invoice being scanned.
    if (addOpen) return
    let depth = 0
    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files")

    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth += 1
      setIsDraggingFile(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      // Without this the browser navigates to the file instead of dropping it.
      event.preventDefault()
    }
    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setIsDraggingFile(false)
    }
    const onDrop = (event: DragEvent) => {
      depth = 0
      setIsDraggingFile(false)
      if (!carriesFiles(event)) return
      event.preventDefault()
      const file = event.dataTransfer?.files?.[0]
      if (!file) return
      setDroppedFile(file)
      setAddOpen(true)
    }

    window.addEventListener("dragenter", onDragEnter)
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("dragleave", onDragLeave)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragenter", onDragEnter)
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("dragleave", onDragLeave)
      window.removeEventListener("drop", onDrop)
      setIsDraggingFile(false)
    }
  }, [addOpen])

  const toggleAll = (checked: boolean) => {
    setSelectedIds(
      checked ? new Set(selectableRows.map((bill) => bill.id)) : new Set(),
    )
  }
  const toggleOne = (billId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(billId)
      else next.delete(billId)
      return next
    })
  }

  /** Approve the selection as one all-or-nothing transaction. */
  const approveBills = (bills: VendorBillSummary[]) => {
    if (bills.length === 0) return
    startTransition(async () => {
      const result = await approveVendorBillsAtomicAction(bills.map((bill) => ({ id: bill.id, expected_updated_at: bill.updated_at })))
      if (!result.success) {
        toast.error(result.error, { description: "No payables were changed." })
        return
      }
      toast.success(`${result.data.approvedCount} payable${result.data.approvedCount === 1 ? "" : "s"} approved atomically`)
      setSelectedIds(new Set())
      router.refresh()
    })
  }

  const allSelected =
    selectableRows.length > 0 && selected.length === selectableRows.length
  const someSelected = selected.length > 0 && !allSelected

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Drop target feedback. Fixed and pointer-events-none: the window listeners
        own the drop, so this is purely the answer to "will it take this?" — an
        overlay that intercepted the event would break the drop it advertises.
      */}
      {isDraggingFile ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/90">
          <div className="flex flex-col items-center gap-3 border-2 border-dashed border-primary px-12 py-10 text-center">
            <Upload className="size-8 text-primary" />
            <p className="text-sm font-medium">Drop the invoice to add a bill</p>
            <p className="text-xs text-muted-foreground">
              Arc reads the vendor, invoice number, amount, and dates. You pick the project.
            </p>
          </div>
        </div>
      ) : null}

      {/* Toolbar: what you're looking at, and how to find one row in it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2.5 sm:px-6">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as TabKey)
            navigateQuery({ tab: value === "due" ? null : value, page: null })
          }}
          className="w-auto"
        >
          {/*
            A segmented control, not a pill row: shared hairlines collapsed with
            -ml-px so five filters read as one instrument. The active cell is the
            only filled surface; counts ride their own cell's ink so a tab never
            reads as two competing labels.
          */}
          <TabsList className="h-8 rounded-none bg-transparent p-0">
            {TABS.map((entry) => (
              <TabsTrigger
                key={entry.key}
                value={entry.key}
                className={cn(
                  "relative -ml-px h-full flex-none gap-1.5 rounded-none border border-border px-2.5 text-xs font-normal text-muted-foreground shadow-none transition-colors first:ml-0",
                  "hover:bg-accent/40 hover:text-foreground",
                  "data-[state=active]:z-10 data-[state=active]:bg-accent data-[state=active]:font-medium data-[state=active]:text-accent-foreground data-[state=active]:shadow-none",
                  "dark:text-muted-foreground dark:data-[state=active]:border-border dark:data-[state=active]:bg-accent dark:data-[state=active]:text-accent-foreground",
                )}
              >
                {entry.label}
                <span className="tabular-nums opacity-60">
                  {counts[entry.key]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <select
            aria-label="Saved payable views"
            defaultValue=""
            onChange={(event) => {
              const view = savedViews.find((candidate) => candidate.id === event.target.value)
              if (!view) return
              setTab(view.filters.queue as TabKey)
              setSearch(view.filters.search)
              navigateQuery({ tab: view.filters.queue === "due" ? null : view.filters.queue, q: view.filters.search || null, pageSize: String(view.filters.pageSize), page: null })
            }}
            className="h-8 border bg-background px-2 text-xs"
          >
            <option value="">Saved views</option>
            {savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}{view.isDefault ? " · default" : ""}</option>)}
          </select>
          {savingView ? (
            <div className="flex items-center gap-1">
              <Input autoFocus value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="View name" aria-label="Saved view name" className="h-8 w-36 text-xs" />
              <Button size="sm" className="h-8 text-xs" disabled={!viewName.trim() || isPending} onClick={() => startTransition(async () => {
                const result = await savePayableViewAction({ name: viewName, filters: { queue: tab, search, pageSize: data.pagination.pageSize } })
                if (!result.success) { toast.error(result.error); return }
                toast.success("Payables view saved")
                setSavingView(false)
                setViewName("")
                router.refresh()
              })}>Save</Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSavingView(false)}>Cancel</Button>
            </div>
          ) : <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSavingView(true)}>Save view</Button>}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search vendor, invoice, project…"
              aria-label="Search payables"
              className="h-8 w-56 pl-8 pr-8 text-xs"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button asChild variant="outline" size="sm" className="h-8 text-xs">
            <Link href="/payables/payment-runs">Payment runs</Link>
          </Button>
          {/*
            The queue was only reachable from project-level list pages, so the
            desk where AP is actually worked had no way to see what had failed to
            reach the accounting file.
          */}
          {accountingEnabled ? (
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setSyncSheetOpen(true)}>
              Sync queue
            </Button>
          ) : null}
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setDroppedFile(null)
              setAddOpen(true)
            }}
          >
            <Plus className="size-3.5" />
            Add bill
          </Button>
        </div>
      </div>

      {/*
        The list. shadcn's Table wraps itself in an overflow container, which becomes
        the scrollport — so it has to be the element with the bounded height, or the
        sticky header has nothing to stick to.
      */}
      <div className="desk-rise min-h-0 flex-1 [&>[data-slot=table-container]]:h-full">
        {rows.length === 0 ? (
          <Empty className="h-full border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Receipt />
              </EmptyMedia>
              <EmptyTitle>
                {search ? "No payables match" : "Nothing here"}
              </EmptyTitle>
              <EmptyDescription>
                {search
                  ? "Try a different vendor, invoice number, or project."
                  : tab === "due"
                    ? "No vendor bills are waiting to be paid."
                    : "No payables in this view yet."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table className={showMethod ? "min-w-[1020px]" : "min-w-[900px]"}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={cn(HEAD, "w-10 pl-4 sm:pl-6")}>
                  <Checkbox
                    checked={
                      allSelected || (someSelected ? "indeterminate" : false)
                    }
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                    aria-label="Select all payables"
                  />
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel")}>Vendor</TableHead>
                <TableHead className={cn(HEAD, "microlabel w-[200px]")}>
                  Project
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel w-[130px]")}>
                  Invoice
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel w-[150px]")}>
                  Due
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel w-[140px]")}>
                  Status
                </TableHead>
                {showMethod ? (
                  <TableHead className={cn(HEAD, "microlabel w-[120px]")}>
                    Method
                  </TableHead>
                ) : null}
                <TableHead
                  className={cn(HEAD, "microlabel w-[150px] text-right")}
                >
                  Amount
                </TableHead>
                <TableHead className={cn(HEAD, "w-[104px] pr-4 sm:pr-6")}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((bill) => {
                const outstanding = payableOutstandingCents(bill)
                const total = bill.total_cents ?? 0
                const isSelected = selectedIds.has(bill.id)
                return (
                  <TableRow
                    key={bill.id}
                    data-state={isSelected ? "selected" : undefined}
                    onClick={() => openBill(bill.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        openBill(bill.id)
                      }
                    }}
                    tabIndex={0}
                    aria-label={`Open ${vendorLabel(bill)} invoice ${bill.bill_number ?? "payable"}`}
                    className="h-14 cursor-pointer"
                  >
                    <TableCell
                      className="pl-4 sm:pl-6"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {isVendorCredit(bill) ? null : (
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) =>
                            toggleOne(bill.id, checked === true)
                          }
                          aria-label={`Select ${vendorLabel(bill)}`}
                        />
                      )}
                    </TableCell>
                    {/* Width lives on the inner div: `max-w` on a <td> is ignored under auto table layout. */}
                    <TableCell>
                      <div className="max-w-[320px] truncate font-medium">
                        {vendorLabel(bill)}
                      </div>
                      <div className="max-w-[320px] truncate text-xs text-muted-foreground">
                        {itemLabel(bill)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-[190px] items-center gap-2">
                        <ProjectAvatar projectId={bill.project_id} size="sm" />
                        <span className="truncate text-sm text-muted-foreground">
                          {bill.project_name ?? "—"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {bill.bill_number ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      <DueCell bill={bill} />
                    </TableCell>
                    <TableCell>
                      <StatusCell
                        bill={bill}
                        membership={data.runMembershipByBillId[bill.id]}
                        awaitsViewer={awaitsMyApproval(bill)}
                      />
                    </TableCell>
                    {showMethod ? (
                      <TableCell>
                        <MethodCell bill={bill} />
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right">
                      <div className="font-mono text-sm font-medium tabular-nums">
                        {formatMoneyFromCents(total)}
                      </div>
                      {!isVendorCredit(bill) && outstanding !== total ? (
                        <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {outstanding > 0
                            ? `${formatMoneyFromCents(outstanding)} due`
                            : "Settled"}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className="pr-4 text-right sm:pr-6"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {/*
                        One row action, always visible: open the payable. Deciding
                        it — approve, code, pay, read the invoice — happens in the
                        workspace, so the row never has to guess which verb applies.
                      */}
                      <Button
                        variant={awaitsMyApproval(bill) ? "default" : "outline"}
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => openBill(bill.id)}
                      >
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pinned summary — and the bulk action, once rows are picked. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-card px-4 py-2 text-xs sm:px-6">
        {selected.length > 0 ? (
          <>
            <div className="flex items-center gap-3">
              <span className="font-medium tabular-nums">
                {selected.length} selected
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatMoneyFromCents(
                  selected.reduce(
                    (sum, bill) => sum + payableOutstandingCents(bill),
                    0,
                  ),
                )}
              </span>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear
              </button>
            </div>
            <div className="flex items-center gap-2">
              {approvable.length > 0 || payable.length === 0 ? (
                <Button
                  size="sm"
                  variant={
                    railOpen && payable.length > 0 ? "outline" : "default"
                  }
                  className="h-7 text-xs"
                  disabled={isPending || approvable.length === 0}
                  onClick={() => approveBills(approvable)}
                >
                  {approvable.length === 0
                    ? "Nothing to approve"
                    : `Approve ${approvable.length} ${approvable.length === 1 ? "payable" : "payables"}`}
                </Button>
              ) : null}
              {railOpen && payable.length > 0 ? (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() =>
                    router.push(
                      `/payables/payment-runs?bills=${payable.map((bill) => bill.id).join(",")}`,
                    )
                  }
                >
                  Pay {payable.length} by ACH ·{" "}
                  {formatMoneyFromCents(
                    payable.reduce(
                      (sum, bill) => sum + payableOutstandingCents(bill),
                      0,
                    ),
                  )}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <span className="tabular-nums">
                {rows.length} {rows.length === 1 ? "payable" : "payables"}
              </span>
              {outstandingCents > 0 ? (
                <span>
                  <span className="font-mono tabular-nums text-foreground">
                    {formatMoneyFromCents(outstandingCents)}
                  </span>{" "}
                  due
                </span>
              ) : null}
              {overdueCount > 0 ? (
                <span className="font-medium text-destructive tabular-nums">
                  {overdueCount} overdue
                </span>
              ) : null}
              <span className="tabular-nums">{data.pagination.total} total · page {data.pagination.page} of {data.pagination.pageCount}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={data.pagination.page <= 1} onClick={() => navigateQuery({ page: String(data.pagination.page - 1) })}>Previous</Button>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={data.pagination.page >= data.pagination.pageCount} onClick={() => navigateQuery({ page: String(data.pagination.page + 1) })}>Next</Button>
            {data.inboundBillsEmail ? (
              <button
                type="button"
                title="Copy address"
                onClick={() => {
                  void navigator.clipboard.writeText(data.inboundBillsEmail!)
                  toast.success("Address copied")
                }}
                className="font-mono text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                {data.inboundBillsEmail}
              </button>
            ) : null}
            </div>
          </>
        )}
      </div>

      <QboSyncSheet
        open={syncSheetOpen}
        onOpenChange={(next) => {
          setSyncSheetOpen(next)
          if (!next) router.refresh()
        }}
      />

      <AddPayableSheet
        projects={projects}
        initialFile={droppedFile}
        open={addOpen}
        onOpenChange={(next) => {
          setAddOpen(next)
          if (!next) setDroppedFile(null)
        }}
        onSuccess={() => router.refresh()}
      />

      <PayablesWorkspace
        bills={data.bills}
        selectedBillId={workspaceBillId}
        onSelectBill={openBill}
        costCodes={data.costCodes}
        budgetLines={budgetLines}
        costCodesEnabled={costCodesEnabled}
        projects={projects}
        accountingEnabled={accountingEnabled}
        accountingProvider={accountingProvider}
        accountingProviderName={accountingProviderName}
        accountingSyncByBillId={accountingSyncByBillId}
        qboExpenseAccounts={qboExpenseAccounts}
        qboApAccounts={qboApAccounts}
        qboDefaults={qboDefaults}
        onChanged={() => router.refresh()}
        holdEvaluations={holdEvaluations}
        railOpen={railOpen}
        paymentReadinessByCompanyId={data.paymentReadinessByCompanyId}
        runMembershipByBillId={data.runMembershipByBillId}
        viewerMayApproveRuns={viewerMayApproveRuns}
      />
    </div>
  )
}

"use client"

import { useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { toast } from "sonner"

import { getOrgPayableContextAction } from "./actions"
import { listProjectBillingOptionsAction } from "@/app/(app)/projects/actions"
import {
  getPayablesAccountingContextAction,
  getPayablesAccountingSyncStatesAction,
  approveVendorBillsAtomicAction,
  deleteProjectVendorBillAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import { AlertTriangle, MoreHorizontal, Plus, Receipt, Search, Upload, X } from "@/components/icons"
import { PayableCreateWorkspace } from "@/components/payables/payable-create-workspace"
import { AccountingSyncSheet } from "@/components/integrations/accounting-sync-sheet"
import { accountingProviderLabel, isAccountingProviderKey } from "@/components/accounting/provider-label"
import { PayBatchDialog } from "@/components/payables/pay-batch-dialog"
import { BlockedPaymentsStrip } from "@/components/payables/blocked-payments-strip"
import type { BlockedPaymentRun } from "@/lib/services/payment-risk"
import { PayablesWorkspace } from "@/components/payables/payables-workspace"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import { dueDisplay, formatDay, payableStatusTone, vendorLabel } from "@/components/payables/payables-ui"
import {
  isVendorCredit,
  payableOutstandingCents,
} from "@/lib/financials/payables-rules"
import type { CodingAutomationStats } from "@/lib/services/books/coding-rules"
import type {
  OrgPayablesDeskData,
  PayableRunMembership,
  PayableTabKey,
} from "@/lib/services/org-payables"
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"
import type { BudgetLineOption, ComplianceRules, ComplianceStatusSummary } from "@/lib/types"
import type { AccountingSyncState } from "@/lib/services/accounting-sync-state"
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

/**
 * The pipeline, in the order money travels it. A payable sits on exactly one
 * working tab, which is what lets each tab carry a total instead of a tally:
 * "$84.2k waiting on approval" is a decision, "23 payables" is trivia. Drafts,
 * Paid and All keep counts — a draft's amount is provisional, and a lifetime sum
 * of settled bills answers no question anyone is asking on this desk.
 */
const TABS: { key: PayableTabKey; label: string; money: boolean }[] = [
  { key: "drafts", label: "Drafts", money: false },
  { key: "approval", label: "Needs approval", money: true },
  { key: "ready", label: "Ready to pay", money: true },
  { key: "inflight", label: "In flight", money: true },
  { key: "paid", label: "Paid", money: false },
  { key: "all", label: "All", money: false },
]

const EMPTY_DESCRIPTIONS: Record<PayableTabKey, string> = {
  drafts: "Captured bills that still need someone to finish them.",
  approval: "Nothing is waiting on an approver right now.",
  ready: "No approved payables are waiting to be paid.",
  inflight: "No payments are moving right now.",
  paid: "Nothing has been paid yet.",
  all: "No payables yet.",
}

/** Compact enough to ride inside a tab without widening it. */
function compactMoney(cents: number) {
  const dollars = cents / 100
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(dollars) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(dollars) >= 10_000 ? 1 : 0,
  })
}

const DAY_MS = 86_400_000

/**
 * `payment_method` predates the payments table and accounting imports write their
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
  const accountingPayment = bill.payments?.find((payment) => isAccountingProviderKey(payment.provider))
  return (
    <span
      className="text-sm text-muted-foreground"
      title={
        accountingPayment ? `Recorded in ${accountingProviderLabel(accountingPayment.provider)}` : undefined
      }
    >
      {METHOD_LABELS[recorded] ?? recorded}
    </span>
  )
}

/**
 * What the release gate is likely to say, from facts the desk already has.
 *
 * The real verdict comes from `evaluateHolds`, which is seven queries a bill and
 * cannot run for a whole page. These are the same inputs it reads, so a row that
 * will stop at the payment gate says so here instead of at the gate — the reason
 * a "Ready to pay" tab is worth trusting.
 */
function releaseWarnings(
  bill: VendorBillSummary,
  complianceRules: ComplianceRules,
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>,
): string[] {
  if (bill.is_draft || isVendorCredit(bill) || bill.status === "paid") return []
  const warnings: string[] = []
  const compliance = bill.company_id
    ? complianceStatusByCompanyId[bill.company_id]
    : undefined
  if (compliance && !compliance.is_compliant) {
    warnings.push(
      compliance.expired.length > 0
        ? "Vendor compliance documents have expired"
        : "Vendor is missing required compliance documents",
    )
  }
  if (complianceRules.require_lien_waiver && bill.lien_waiver_status !== "received") {
    warnings.push("Lien waiver not received")
  }
  if (bill.over_budget) warnings.push("Exceeds the linked commitment")
  return warnings
}

/**
 * The warning marker on a row, and what it is warning about. An icon whose only
 * explanation is its colour makes people open the payable to find out — which is
 * the trip it exists to save.
 */
function ReleaseWarningTip({ warnings }: { warnings: string[] }) {
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 leading-none"
          onClick={(event) => event.stopPropagation()}
        >
          <AlertTriangle className="size-3.5 text-warning" />
          <span className="sr-only">
            May block payment: {warnings.join("; ")}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        <p className="font-medium">May block payment</p>
        <ul className="mt-1 space-y-0.5">
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5 text-muted-foreground">
              <span aria-hidden>·</span>
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Per-row actions, revealed on hover.
 *
 * Delete is offered only while a payable is still just a record: no recorded
 * payment, no active run, no accounting document. Once money or an approved run
 * is attached, the row is evidence — the item stays visible and says why, rather
 * than disappearing and leaving people to guess whether they lack permission.
 */
function PayableRowActions({
  bill,
  membership,
  onEdit,
  onDelete,
}: {
  bill: VendorBillSummary
  membership?: PayableRunMembership
  onEdit: () => void
  onDelete: () => void
}) {
  const blockedReason = membership
    ? "it belongs to an active payment run"
    : bill.status === "paid" ||
        bill.status === "partial" ||
        (bill.paid_cents ?? 0) > 0
      ? "it has recorded payments"
      : bill.qbo_id
        ? "it exists in the accounting file"
        : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Actions for {vendorLabel(bill)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={onEdit}>Edit payable</DropdownMenuItem>
        <DropdownMenuSeparator />
        {blockedReason ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Cannot be deleted — {blockedReason}.
          </p>
        ) : (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            Delete payable
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Only ever renders for a vendor who is not ready — a healthy row stays quiet. */
function ReadinessDot({
  readiness,
}: {
  readiness: CompanyPaymentReadinessStatus | undefined
}) {
  if (readiness === "ready") return null
  const label =
    readiness === "verifying"
      ? "Vendor is verifying their bank account — ACH is not available yet"
      : readiness === "invited"
        ? "Vendor was invited to set up ACH but has not finished"
        : readiness === "suspended"
          ? "Vendor's Arc Pay access is suspended"
          : readiness === "revoked"
            ? "Vendor's Arc Pay access was revoked"
            : "Vendor cannot be paid by ACH yet — invite them from the payable"
  return (
    <span
      title={label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        readiness === "verifying" ? "bg-muted-foreground" : "bg-warning",
      )}
    >
      <span className="sr-only">{label}</span>
    </span>
  )
}

function statusTone(
  bill: VendorBillSummary,
  membership: PayableRunMembership | undefined,
  awaitsViewer: boolean,
): { label: string; className: string } {
  if (isVendorCredit(bill))
    return { label: "Credit", className: "border-border text-muted-foreground" }
  // A bill inside a run is no longer just "approved" — say where the money is,
  // and when a release was scheduled, say which day it goes. "Scheduled" without
  // the date withholds the only fact that made scheduling worth doing.
  if (membership) {
    return {
      label: awaitsViewer
        ? "Awaiting your approval"
        : membership.runStatus === "pending_approval"
          ? "In approval"
          : membership.runStatus === "processing"
            ? "Paying"
            : membership.scheduledFor
              ? `Sends ${formatDay(membership.scheduledFor)}`
              : "Scheduled",
      className: awaitsViewer
        ? "border-primary/40 bg-primary/10 text-primary"
        : "border-primary/25 bg-primary/5 text-primary",
    }
  }
  return payableStatusTone(bill.status, bill.is_draft)
}

function StatusCell({
  bill,
  membership,
  awaitsViewer = false,
}: {
  bill: VendorBillSummary
  membership?: PayableRunMembership
  awaitsViewer?: boolean
}) {
  const tone = statusTone(bill, membership, awaitsViewer)
  return (
    <Badge
      variant="outline"
      title={tone.label}
      className={cn("max-w-full truncate font-normal", tone.className)}
    >
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
  railOpen,
  viewerMayApproveRuns = false,
  approvalViewer = null,
  blockedRuns = [],
}: {
  data: OrgPayablesDeskData
  railOpen: boolean
  viewerMayApproveRuns?: boolean
  approvalViewer?: {
    userId: string
    approvers: Array<{ userId: string; name: string }>
  } | null
  /** Payments an automated control stopped. Empty on a normal day. */
  blockedRuns?: BlockedPaymentRun[]
}) {
  const router = useRouter()
  const urlSearchParams = useSearchParams()
  const [isPending, startTransition] = React.useTransition()
  /** Held separately from mutations: this one only ever means "fetching rows". */
  const [isNavigating, startNavigation] = React.useTransition()

  const [tab, setTab] = React.useState<PayableTabKey>(data.query.tab)
  const [search, setSearch] = React.useState(data.query.search)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set(),
  )
  /**
   * Concurrency tokens the server moved on its own — opening a payable caches
   * its advisory approval signals, which is a write. Bulk approval sends the
   * token from this server-rendered list, so it has to learn the new value or
   * it would reject an approval as a conflict nobody caused.
   */
  const [freshTokens, setFreshTokens] = React.useState<Record<string, string>>({})
  const noteFreshToken = React.useCallback((billId: string, updatedAt: string) => {
    setFreshTokens((current) => (current[billId] === updatedAt ? current : { ...current, [billId]: updatedAt }))
  }, [])
  /** The row the keyboard is on. -1 until j/k or a click moves it. */
  const [cursor, setCursor] = React.useState(-1)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const [workspaceBillId, openBill] = useWorkspaceParam("bill")

  // Org-level accounting context — the same one the project workbench loads.
  const [accountingEnabled, setAccountingEnabled] = React.useState(false)
  /** Any accounting integration, healthy or not — the gate for the sync queue. */
  const [hasAccountingConnection, setHasAccountingConnection] = React.useState(false)
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
  const [accountingDimensions, setAccountingDimensions] = React.useState<Array<{
    key: string
    label: string
    values: QBOAccountOption[]
  }>>([])
  const [projects, setProjects] = React.useState<ProjectOption[]>([])

  // Adding a bill: opened by the toolbar button, or by dropping a file anywhere
  // on the page. `droppedFile` is what the sheet scans on open.
  const [addOpen, setAddOpen] = React.useState(() => urlSearchParams.get("new") === "1")
  const [syncSheetOpen, setSyncSheetOpen] = React.useState(false)
  /** The selection being turned into one payment run, or null when idle. */
  const [payBatch, setPayBatch] = React.useState<VendorBillSummary[] | null>(null)
  /** The payable a row menu asked to delete, held until it is confirmed. */
  const [deleteTarget, setDeleteTarget] = React.useState<VendorBillSummary | null>(null)
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
        setHasAccountingConnection(Boolean(context.hasAnyConnection))
        setAccountingProvider(context.provider ?? null)
        setAccountingProviderName(context.providerName ?? null)
        setQboExpenseAccounts(context.expenseAccounts ?? [])
        setQboApAccounts(context.apAccounts ?? [])
        setQboDefaults(context.defaults ?? {})
        setAccountingDimensions(context.dimensions ?? [])
      })
      .catch(() => {
        if (!cancelled) {
          setAccountingEnabled(false)
          setHasAccountingConnection(false)
        }
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
    listProjectBillingOptionsAction()
      .then((rows) => {
        if (cancelled) return
        setProjects(rows ?? [])
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

  const rows = data.bills

  const buildHref = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(urlSearchParams.toString())
      for (const [key, value] of Object.entries(updates)) value ? params.set(key, value) : params.delete(key)
      const query = params.toString()
      return query ? `/payables?${query}` : "/payables"
    },
    [urlSearchParams],
  )

  /**
   * Navigation runs inside a transition so the desk keeps showing the rows it
   * has while the next tab loads. Without it React tears the table down and the
   * switch reads as a page load instead of a filter.
   */
  const navigateQuery = React.useCallback(
    (updates: Record<string, string | null>) => {
      const href = buildHref(updates)
      startNavigation(() => router.replace(href, { scroll: false }))
    },
    [buildHref, router],
  )

  const tabHref = React.useCallback(
    (key: PayableTabKey) => buildHref({ tab: key === "approval" ? null : key, page: null }),
    [buildHref],
  )

  const selectTab = React.useCallback(
    (next: PayableTabKey) => {
      if (next === tab) return
      setTab(next)
      navigateQuery({ tab: next === "approval" ? null : next, page: null })
    },
    [navigateQuery, tab],
  )

  /**
   * Warm a tab when the pointer reaches it, which is a few hundred milliseconds
   * before the click. Deliberately not all six on mount: this page is dynamic, so
   * each prefetch is a full server render, and six of them would compete with the
   * one request the user is actually waiting for. Prefetches are deduped by the
   * router, so re-hovering costs nothing.
   */
  const prefetchTab = React.useCallback(
    (key: PayableTabKey) => {
      if (key !== tab) router.prefetch(tabHref(key))
    },
    [router, tab, tabHref],
  )

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
  /** Outstanding is the operative number until the bill is history. */
  const outstandingLeads = tab !== "paid" && tab !== "all"

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
  const mayDecideBillApproval = React.useCallback(
    (bill: VendorBillSummary) =>
      !bill.preferred_approver_ids?.length ||
      Boolean(approvalViewer && bill.preferred_approver_ids.includes(approvalViewer.userId)),
    [approvalViewer],
  )
  const approvable = React.useMemo(
    () => selected.filter((bill) => bill.status === "pending" && !bill.is_draft && mayDecideBillApproval(bill)),
    [mayDecideBillApproval, selected],
  )
  const isPayable = React.useCallback(
    (bill: VendorBillSummary) =>
      (bill.status === "approved" || bill.status === "partial") &&
      payableOutstandingCents(bill) > 0 &&
      Boolean(bill.company_id) &&
      data.paymentReadinessByCompanyId[bill.company_id!] === "ready" &&
      !data.runMembershipByBillId[bill.id],
    [data.paymentReadinessByCompanyId, data.runMembershipByBillId],
  )
  // Bills a payment run could take today: approved with a balance, an ACH-ready
  // vendor, and not already claimed by an active run.
  const payable = React.useMemo(
    () => selected.filter(isPayable),
    [selected, isPayable],
  )
  /**
   * Why the rest of the selection cannot go out. A footer that silently offers
   * to pay six of the ten rows you picked is the moment people stop trusting it.
   */
  const excluded = React.useMemo(() => {
    const reasons: string[] = []
    const candidates = selected.filter(
      (bill) => !isVendorCredit(bill) && !bill.is_draft && bill.status !== "paid",
    )
    const unready = candidates.filter(
      (bill) =>
        (bill.status === "approved" || bill.status === "partial") &&
        !data.runMembershipByBillId[bill.id] &&
        (!bill.company_id ||
          data.paymentReadinessByCompanyId[bill.company_id] !== "ready"),
    ).length
    const inRun = candidates.filter(
      (bill) => data.runMembershipByBillId[bill.id],
    ).length
    const unapproved = candidates.filter((bill) => bill.status === "pending").length
    if (unready > 0)
      reasons.push(`${unready} ${unready === 1 ? "vendor is" : "vendors are"} not payment-ready`)
    if (inRun > 0) reasons.push(`${inRun} already in a run`)
    if (unapproved > 0) reasons.push(`${unapproved} not approved yet`)
    return reasons
  }, [selected, data.paymentReadinessByCompanyId, data.runMembershipByBillId])

  React.useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        Array.from(current).filter((id) => visibleIds.has(id)),
      )
      return next.size === current.size ? current : next
    })
  }, [visibleIds])

  /** A payment this viewer is the one being asked to release. */
  const awaitsMyApproval = React.useCallback(
    (bill: VendorBillSummary) => {
      const membership = data.runMembershipByBillId[bill.id]
      return Boolean(
        viewerMayApproveRuns &&
        membership &&
        membership.runStatus === "pending_approval" &&
        (!membership.preparedByViewer || membership.requesterMayApprove),
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
  const approveBills = React.useCallback(
    (bills: VendorBillSummary[]) => {
      if (bills.length === 0) return
      startTransition(async () => {
        const result = await approveVendorBillsAtomicAction(
          bills.map((bill) => ({ id: bill.id, expected_updated_at: freshTokens[bill.id] ?? bill.updated_at })),
        )
        if (!result.success) {
          toast.error(result.error, { description: "No payables were changed." })
          return
        }
        toast.success(`${result.data.approvedCount} payable${result.data.approvedCount === 1 ? "" : "s"} approved atomically`)
        setSelectedIds(new Set())
        router.refresh()
      })
    },
    [freshTokens, router],
  )

  /**
   * Delete one payable. The server re-checks every reason a payable may not be
   * deleted, so a refusal here is reported, not assumed away.
   */
  const deletePayable = React.useCallback(
    (bill: VendorBillSummary) => {
      startTransition(async () => {
        const result = await deleteProjectVendorBillAction(bill.project_id, bill.id)
        if (!result.success) {
          toast.error(result.error)
          return
        }
        if (!result.data.success) {
          toast.error(result.data.error ?? "This payable could not be deleted")
          return
        }
        toast.success(
          bill.bill_number ? `Payable ${bill.bill_number} deleted` : "Payable deleted",
        )
        setDeleteTarget(null)
        setSelectedIds((current) => {
          if (!current.has(bill.id)) return current
          const next = new Set(current)
          next.delete(bill.id)
          return next
        })
        router.refresh()
      })
    },
    [router],
  )

  /**
   * Keyboard triage. AP is list work — the hands should never have to leave the
   * keyboard to walk a queue, mark the rows that belong in a run, and send it.
   */
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Anything modal owns the keyboard while it is open.
      if (workspaceBillId || addOpen || payBatch || syncSheetOpen || deleteTarget) return
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName?.toLowerCase()
      const isTextEntry =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target?.isContentEditable === true
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTextEntry) {
        if (event.key === "Escape") target?.blur()
        return
      }

      if (event.key === "/") {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (event.key === "Escape") {
        setSelectedIds(new Set())
        setCursor(-1)
        return
      }
      if (event.key >= "1" && event.key <= String(TABS.length)) {
        const next = TABS[Number(event.key) - 1]
        if (next) {
          event.preventDefault()
          selectTab(next.key)
        }
        return
      }
      if (rows.length === 0) return
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault()
        setCursor((current) => Math.min(rows.length - 1, current + 1))
        return
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault()
        setCursor((current) => Math.max(0, current - 1))
        return
      }

      const cursorBill = cursor >= 0 ? rows[cursor] : undefined
      if (event.key === "Enter" || event.key === "o") {
        // A row that has real DOM focus opens itself — handling it here too
        // would open whatever the cursor was last on instead.
        if (event.key === "Enter" && target?.closest("[data-payable-row]")) return
        if (!cursorBill) return
        event.preventDefault()
        openBill(cursorBill.id)
        return
      }
      if (event.key === "x" || event.key === " ") {
        if (!cursorBill || isVendorCredit(cursorBill)) return
        event.preventDefault()
        toggleOne(cursorBill.id, !selectedIds.has(cursorBill.id))
        return
      }
      if (event.key === "a") {
        const bills =
          approvable.length > 0
            ? approvable
            : cursorBill &&
                cursorBill.status === "pending" &&
                !cursorBill.is_draft &&
                !isVendorCredit(cursorBill) &&
                mayDecideBillApproval(cursorBill)
              ? [cursorBill]
              : []
        if (bills.length === 0) return
        event.preventDefault()
        approveBills(bills)
        return
      }
      if (event.key === "p") {
        const bills =
          payable.length > 0
            ? payable
            : cursorBill && isPayable(cursorBill)
              ? [cursorBill]
              : []
        if (!railOpen || bills.length === 0) return
        event.preventDefault()
        setPayBatch(bills)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    addOpen,
    approvable,
    approveBills,
    cursor,
    deleteTarget,
    isPayable,
    mayDecideBillApproval,
    openBill,
    payBatch,
    payable,
    railOpen,
    rows,
    selectTab,
    selectedIds,
    syncSheetOpen,
    workspaceBillId,
  ])

  // Keep the cursor row on screen as j/k walk past the viewport edge.
  React.useEffect(() => {
    if (cursor < 0) return
    document
      .querySelector(`[data-payable-row="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  React.useEffect(() => {
    setCursor(-1)
  }, [data.query.tab, data.query.search, data.pagination.page])

  const allSelected =
    selectableRows.length > 0 && selected.length === selectableRows.length
  const someSelected = selected.length > 0 && !allSelected
  const selectedOutstandingCents = selected.reduce(
    (sum, bill) => sum + payableOutstandingCents(bill),
    0,
  )
  const payableCents = payable.reduce(
    (sum, bill) => sum + payableOutstandingCents(bill),
    0,
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BlockedPaymentsStrip blockedRuns={blockedRuns} onDecided={() => router.refresh()} />
      {/*
        Drop target feedback. Fixed and pointer-events-none: the window listeners
        own the drop, so this is purely the answer to "will it take this?" — an
        overlay that intercepted the event would break the drop it advertises.
      */}
      {isDraggingFile ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/90">
          <div className="relative flex flex-col items-center gap-3 border-2 border-dashed border-primary bg-background/80 px-12 py-10 text-center">
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
          onValueChange={(value) => selectTab(value as PayableTabKey)}
          className="w-auto"
        >
          {/*
            A segmented control, not a pill row: shared hairlines collapsed with
            -ml-px so the pipeline reads as one instrument. The active cell is the
            only filled surface; the figure beside each label rides its own ink so
            a tab never reads as two competing labels.
          */}
          <TabsList className="h-8 rounded-none bg-transparent p-0">
            {TABS.map((entry) => {
              const summary = data.tabs[entry.key]
              return (
                <TabsTrigger
                  key={entry.key}
                  value={entry.key}
                  onPointerEnter={() => prefetchTab(entry.key)}
                  onFocus={() => prefetchTab(entry.key)}
                  title={
                    entry.money
                      ? `${summary.count} ${summary.count === 1 ? "payable" : "payables"} · ${formatMoneyFromCents(summary.amountCents)} outstanding`
                      : undefined
                  }
                  className={cn(
                    "relative -ml-px h-full flex-none gap-1.5 rounded-none border border-border px-2.5 text-xs font-normal text-muted-foreground shadow-none transition-colors first:ml-0",
                    "hover:bg-accent/40 hover:text-foreground",
                    "data-[state=active]:z-10 data-[state=active]:bg-accent data-[state=active]:font-medium data-[state=active]:text-accent-foreground data-[state=active]:shadow-none",
                    "dark:text-muted-foreground dark:data-[state=active]:border-border dark:data-[state=active]:bg-accent dark:data-[state=active]:text-accent-foreground",
                  )}
                >
                  {entry.label}
                  <span className="tabular-nums opacity-60">
                    {entry.money && summary.amountCents > 0
                      ? compactMoney(summary.amountCents)
                      : summary.count}
                  </span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search payables…"
              aria-label="Search vendor, invoice, or project"
              className="h-8 w-52 pl-8 pr-8 text-xs"
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
          {/*
            The queue was only reachable from project-level list pages, so the
            desk where AP is actually worked had no way to see what had failed to
            reach the accounting file.
          */}
          {hasAccountingConnection ? (
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

        Keyed by tab so switching plays a short entrance: the rows are a different
        set, and saying so in motion is what separates a filter from a redraw. The
        key also resets the scrollport, which is what you want on a new queue.
      */}
      <div
        key={data.query.tab}
        className={cn(
          "min-h-0 flex-1 [&>[data-slot=table-container]]:h-full",
          "animate-in fade-in slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none",
          // Rows stay on screen while the next tab loads; dimming them says the
          // list is stale without blanking the desk.
          isNavigating && "pointer-events-none opacity-60 transition-opacity",
        )}
      >
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
                  : EMPTY_DESCRIPTIONS[tab]}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          /*
            `table-fixed` is what makes the declared widths real — under auto
            layout they are only hints, so one long vendor name re-proportions
            the whole desk and `truncate` never fires.
          */
          <Table
            className={cn(
              "table-fixed",
              showMethod ? "min-w-[1020px]" : "min-w-[900px]",
            )}
          >
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
                {/*
                  Percentage widths, not pixels: the columns divide the desk
                  evenly at any width instead of leaving the vendor column to
                  absorb every pixel the fixed ones did not want. They stop just
                  short of 100% so the checkbox gutter has its own room.
                */}
                <TableHead className={cn(HEAD, "microlabel", showMethod ? "w-[22%]" : "w-[25%]")}>
                  Vendor
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel", showMethod ? "w-[16%]" : "w-[18%]")}>
                  Project
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel", showMethod ? "w-[11%]" : "w-[12%]")}>
                  Invoice
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel", showMethod ? "w-[11%]" : "w-[12%]")}>
                  Due
                </TableHead>
                <TableHead className={cn(HEAD, "microlabel", showMethod ? "w-[15%]" : "w-[16%]")}>
                  Status
                </TableHead>
                {showMethod ? (
                  <TableHead className={cn(HEAD, "microlabel w-[8%]")}>
                    Method
                  </TableHead>
                ) : null}
                <TableHead
                  className={cn(HEAD, "microlabel text-right", showMethod ? "w-[13%]" : "w-[14%]")}
                >
                  Amount
                </TableHead>
                <TableHead className={cn(HEAD, "w-11 pr-2 sm:pr-4")}>
                  <span className="sr-only">Row actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((bill, index) => {
                const outstanding = payableOutstandingCents(bill)
                const total = bill.total_cents ?? 0
                const isSelected = selectedIds.has(bill.id)
                const membership = data.runMembershipByBillId[bill.id]
                const warnings = releaseWarnings(
                  bill,
                  data.complianceRules,
                  data.complianceStatusByCompanyId,
                )
                const showReadiness =
                  railOpen &&
                  !membership &&
                  !isVendorCredit(bill) &&
                  !bill.is_draft &&
                  (bill.status === "approved" || bill.status === "partial")
                const due = dueDisplay(bill)
                const leadCents = outstandingLeads && !isVendorCredit(bill) ? outstanding : total
                return (
                  <TableRow
                    key={bill.id}
                    data-payable-row={index}
                    data-state={isSelected ? "selected" : undefined}
                    onClick={() => {
                      setCursor(index)
                      openBill(bill.id)
                    }}
                    // Tabbing to a row moves the keyboard cursor with it, so the
                    // two ways of walking the list never disagree.
                    onFocus={() => setCursor(index)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        openBill(bill.id)
                      }
                    }}
                    tabIndex={0}
                    aria-label={`Open ${vendorLabel(bill)} invoice ${bill.bill_number ?? "payable"}`}
                    className={cn(
                      "group/row h-14 cursor-pointer",
                      cursor === index && "ring-1 ring-inset ring-primary/40",
                    )}
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
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">
                          {vendorLabel(bill)}
                        </span>
                        {warnings.length > 0 ? (
                          <ReleaseWarningTip warnings={warnings} />
                        ) : null}
                        {showReadiness ? (
                          <ReadinessDot
                            readiness={
                              bill.company_id
                                ? data.paymentReadinessByCompanyId[bill.company_id]
                                : undefined
                            }
                          />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <ProjectAvatar projectId={bill.project_id} size="sm" />
                        <span className="truncate text-sm text-muted-foreground">
                          {bill.project_name ?? "—"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="truncate text-sm text-muted-foreground">
                        {bill.bill_number ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className={cn("whitespace-nowrap text-sm tabular-nums", due.className)}>
                      {due.text}
                    </TableCell>
                    <TableCell>
                      <StatusCell
                        bill={bill}
                        membership={membership}
                        awaitsViewer={awaitsMyApproval(bill)}
                      />
                    </TableCell>
                    {showMethod ? (
                      <TableCell>
                        <MethodCell bill={bill} />
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right">
                      {/*
                        The biggest type on the row. Everything else here is
                        reference; this is the number people are actually reading,
                        often across a desk, and it should not need leaning in.
                      */}
                      <div className="text-base font-semibold leading-tight tabular-nums">
                        {formatMoneyFromCents(leadCents)}
                      </div>
                      <AmountFootnote
                        bill={bill}
                        outstanding={outstanding}
                        total={total}
                        outstandingLeads={outstandingLeads}
                      />
                    </TableCell>
                    <TableCell
                      className="pr-2 text-right sm:pr-4"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <PayableRowActions
                        bill={bill}
                        membership={membership}
                        onEdit={() => openBill(bill.id)}
                        onDelete={() => setDeleteTarget(bill)}
                      />
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
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium tabular-nums">
                {selected.length} selected
              </span>
              <span className="tabular-nums text-muted-foreground">
                {formatMoneyFromCents(selectedOutstandingCents)}
              </span>
              {railOpen && excluded.length > 0 && payable.length < selected.length ? (
                <span className="text-muted-foreground">
                  Not payable now: {excluded.join(", ")}
                </span>
              ) : null}
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
                  onClick={() => setPayBatch(payable)}
                >
                  Pay {payable.length} by ACH · {formatMoneyFromCents(payableCents)}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <span className="tabular-nums">
                {data.pagination.total} {data.pagination.total === 1 ? "payable" : "payables"} · page {data.pagination.page} of {data.pagination.pageCount}
              </span>
              {data.summaryTruncated ? (
                <span title="Tab totals are summed from the first 2,000 open payables.">
                  Tab totals cover the first 2,000 open payables
                </span>
              ) : null}
              <CodingAutomationReadout stats={data.codingAutomation} />
              <span className="hidden tabular-nums lg:inline">
                j/k move · enter open · x select · a approve{railOpen ? " · p pay" : ""} · / search
              </span>
            </div>
            <div className="flex items-center gap-2">
              {data.inboundBillsEmail ? (
                <button
                  type="button"
                  title="Email invoices here and Arc files them as drafts"
                  onClick={() => {
                    void navigator.clipboard.writeText(data.inboundBillsEmail!)
                    toast.success("Address copied")
                  }}
                  className="text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  {data.inboundBillsEmail}
                </button>
              ) : null}
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={data.pagination.page <= 1} onClick={() => navigateQuery({ page: String(data.pagination.page - 1) })}>Previous</Button>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={data.pagination.page >= data.pagination.pageCount} onClick={() => navigateQuery({ page: String(data.pagination.page + 1) })}>Next</Button>
            </div>
          </>
        )}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this payable?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${deleteTarget.bill_number ? `Invoice ${deleteTarget.bill_number}` : "This payable"} for ${vendorLabel(deleteTarget)}${
                    deleteTarget.project_name ? ` on ${deleteTarget.project_name}` : ""
                  } — ${formatMoneyFromCents(deleteTarget.total_cents ?? 0)} — and its coding will be removed. This cannot be undone.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isPending}
              onClick={(event) => {
                // The dialog closes itself on action; hold it open until the
                // server has actually accepted the delete.
                event.preventDefault()
                if (deleteTarget) deletePayable(deleteTarget)
              }}
            >
              {isPending ? "Deleting…" : "Delete payable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PayBatchDialog
        open={payBatch !== null}
        onOpenChange={(next) => {
          if (!next) setPayBatch(null)
        }}
        bills={payBatch ?? []}
        onSubmitted={() => {
          setSelectedIds(new Set())
          router.refresh()
        }}
      />

      <AccountingSyncSheet
        open={syncSheetOpen}
        onOpenChange={(next) => {
          setSyncSheetOpen(next)
          if (!next) router.refresh()
        }}
      />

      <PayableCreateWorkspace
        projects={projects}
        initialFile={droppedFile}
        initialCompanyId={urlSearchParams.get("vendor")}
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
        accountingDimensions={accountingDimensions}
        onChanged={() => router.refresh()}
        holdEvaluations={holdEvaluations}
        railOpen={railOpen}
        paymentReadinessByCompanyId={data.paymentReadinessByCompanyId}
        runMembershipByBillId={data.runMembershipByBillId}
        viewerMayApproveRuns={viewerMayApproveRuns}
        onConcurrencyTokenRefresh={noteFreshToken}
        approvalViewer={approvalViewer}
        queueTotals={data.tabs}
      />
    </div>
  )
}

/**
 * The second line under an amount, when there is one worth printing: what the
 * full bill was when only part of it is still owed, or the discount still on the
 * table. Never both — the row is one line of money, not a statement.
 */
/**
 * How much coding the org still does by hand — B1's acceptance criterion, in
 * the one place the people who do that coding actually stand. It reports a rate
 * rather than a total so it stays comparable as volume grows, and says nothing
 * at all until there are enough payables for the rate to mean something.
 */
function CodingAutomationReadout({ stats }: { stats: CodingAutomationStats | null }) {
  if (!stats || stats.touchesPerTransaction === null || stats.transactions < 5) return null
  const rate = stats.touchesPerTransaction.toFixed(1)
  const autoPercent = stats.autoCodedShare === null ? null : Math.round(stats.autoCodedShare * 100)
  return (
    <span
      className="tabular-nums"
      title={`${stats.touches} coding edits across ${stats.transactions} payables captured in the last ${stats.windowDays} days.`}
    >
      {rate} touches/payable
      {autoPercent === null ? null : <span className="text-foreground/70"> · {autoPercent}% auto-coded</span>}
    </span>
  )
}

function AmountFootnote({
  bill,
  outstanding,
  total,
  outstandingLeads,
}: {
  bill: VendorBillSummary
  outstanding: number
  total: number
  outstandingLeads: boolean
}) {
  if (isVendorCredit(bill)) return null
  if (outstanding !== total) {
    return (
      <div className="text-xs tabular-nums text-muted-foreground">
        {outstandingLeads
          ? `of ${formatMoneyFromCents(total)}`
          : outstanding > 0
            ? `${formatMoneyFromCents(outstanding)} due`
            : "Settled"}
      </div>
    )
  }
  const percent = bill.early_pay_discount_percent
  const days = bill.early_pay_discount_days
  if (
    !outstandingLeads ||
    !percent ||
    !days ||
    !bill.bill_date ||
    bill.status === "paid"
  )
    return null
  const deadline = new Date(
    new Date(`${bill.bill_date}T00:00:00`).getTime() + days * DAY_MS,
  )
  if (deadline.getTime() < new Date().setHours(0, 0, 0, 0)) return null
  return (
    <div className="text-xs tabular-nums text-success">
      {percent}% by {formatDay(deadline.toISOString().slice(0, 10))}
    </div>
  )
}

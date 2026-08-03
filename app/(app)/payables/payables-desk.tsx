"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import * as React from "react"
import { toast } from "sonner"

import { getOrgPayableContextAction } from "./actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"
import {
  getPayablesAccountingContextAction,
  updateProjectVendorBillStatusAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import { FileText, Receipt, Search, X } from "@/components/icons"
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
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { BudgetLineOption } from "@/lib/types"
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

const READINESS_LABELS: Record<CompanyPaymentReadinessStatus, string> = {
  ready: "ACH",
  verifying: "ACH pending",
  invited: "Check",
  not_started: "Check",
}

/**
 * How this payable was paid, or — while it is still open — the rail it would go out
 * on. With no payout rail configured there is no second option to report, so the
 * column stays quiet rather than labelling every open bill "Check".
 */
function MethodCell({
  bill,
  readiness,
  railOpen,
}: {
  bill: VendorBillSummary
  readiness?: CompanyPaymentReadinessStatus
  railOpen: boolean
}) {
  const recorded =
    bill.payment_method ??
    bill.payments?.find((payment) => payment.method)?.method
  if (recorded) {
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
  if (bill.status === "paid" || isVendorCredit(bill) || !railOpen) {
    return <span className="text-muted-foreground">—</span>
  }
  return (
    <span className="text-sm text-muted-foreground">
      {READINESS_LABELS[readiness ?? "not_started"]}
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
  railOpen,
  viewerMayApproveRuns = false,
}: {
  data: OrgPayablesDeskData
  railOpen: boolean
  viewerMayApproveRuns?: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = React.useTransition()

  const [tab, setTab] = React.useState<TabKey>("due")
  const [search, setSearch] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set(),
  )
  const [workspaceBillId, openBill] = useWorkspaceParam("bill")

  // Org-level accounting context — the same one the project workbench loads.
  const [accountingEnabled, setAccountingEnabled] = React.useState(false)
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

  const counts = React.useMemo(() => {
    const totals: Record<TabKey, number> = {
      due: 0,
      approval: 0,
      approved: 0,
      paid: 0,
      all: 0,
    }
    for (const bill of data.bills)
      for (const key of tabsFor(bill)) totals[key] += 1
    return totals
  }, [data.bills])

  const rows = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return data.bills.filter(
      (bill) => tabsFor(bill).includes(tab) && matchesSearch(bill, query),
    )
  }, [data.bills, search, tab])

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

  /** Approve is the desk's one write — it calls the workbench's own action per bill. */
  const approveBills = (bills: VendorBillSummary[]) => {
    if (bills.length === 0) return
    startTransition(async () => {
      let approved = 0
      for (const bill of bills) {
        const result = unwrapAction(
          await updateProjectVendorBillStatusAction(bill.project_id, bill.id, {
            status: "approved",
            expected_updated_at: bill.updated_at,
            qbo_expense_account_id:
              bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
            qbo_expense_account_name:
              bill.qbo_expense_account_name ??
              qboExpenseAccounts.find(
                (account) => account.id === qboDefaults.expenseAccountId,
              )?.name,
          }),
        )
        if (result.success) approved += 1
        else
          toast.error(result.error, {
            description: bill.bill_number ?? vendorLabel(bill),
          })
      }
      if (approved > 0)
        toast.success(
          `${approved} payable${approved === 1 ? "" : "s"} approved`,
        )
      setSelectedIds(new Set())
      router.refresh()
    })
  }

  const allSelected =
    selectableRows.length > 0 && selected.length === selectableRows.length
  const someSelected = selected.length > 0 && !allSelected

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar: what you're looking at, and how to find one row in it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2.5 sm:px-6">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as TabKey)}
          className="w-auto"
        >
          <TabsList className="h-8">
            {TABS.map((entry) => (
              <TabsTrigger
                key={entry.key}
                value={entry.key}
                className="gap-1.5 text-xs"
              >
                {entry.label}
                <span className="tabular-nums text-muted-foreground">
                  {counts[entry.key]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
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
          <Table className="min-w-[1020px]">
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
                <TableHead className={cn(HEAD, "microlabel w-[120px]")}>
                  Method
                </TableHead>
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
                    className="group h-14 cursor-pointer"
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
                    <TableCell>
                      <MethodCell
                        bill={bill}
                        readiness={
                          bill.company_id
                            ? data.paymentReadinessByCompanyId[bill.company_id]
                            : undefined
                        }
                        railOpen={railOpen}
                      />
                    </TableCell>
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
                      <div className="flex items-center justify-end gap-1">
                        {awaitsMyApproval(bill) ? (
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => openBill(bill.id)}
                          >
                            Review
                          </Button>
                        ) : bill.status === "pending" &&
                          !isVendorCredit(bill) ? (
                          /*
                            With a payment rail configured, approving a bill is the
                            first half of releasing money — so the row opens the
                            payable instead of deciding it from a list.
                          */
                          railOpen ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                              onClick={() => openBill(bill.id)}
                            >
                              Review
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isPending}
                              className="h-7 px-2 text-xs opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                              onClick={() => approveBills([bill])}
                            >
                              Approve
                            </Button>
                          )
                        ) : null}
                        {data.documentFileIdByBillId[bill.id] ? (
                          <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            title="Open invoice"
                          >
                            <a
                              href={`/api/files/${data.documentFileIdByBillId[bill.id]}/raw`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <FileText className="size-4 text-muted-foreground" />
                              <span className="sr-only">
                                Open invoice document
                              </span>
                            </a>
                          </Button>
                        ) : null}
                      </div>
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
              {data.truncated ? (
                <span className="text-warning">
                  Capped at the 500 most urgent open payables
                </span>
              ) : null}
            </div>
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
          </>
        )}
      </div>

      <PayablesWorkspace
        bills={data.bills}
        selectedBillId={workspaceBillId}
        onSelectBill={openBill}
        costCodes={data.costCodes}
        budgetLines={budgetLines}
        costCodesEnabled={costCodesEnabled}
        projects={projects}
        accountingEnabled={accountingEnabled}
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

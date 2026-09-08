"use client";

import { usePayableIntake } from "./use-payable-intake";
import { PayableIntakeStatus } from "./payable-intake-status";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import * as React from "react";
import { toast } from "sonner";

import {
  getOrgPayableContextAction,
  getSelectedPayablesAction,
  selectMatchingPayableIdsAction,
} from "@/app/(app)/payables/actions";
import { listProjectBillingOptionsAction } from "@/app/(app)/projects/actions";
import {
  getPayablesAccountingContextAction,
  getPayablesAccountingSyncStatesAction,
  approveVendorBillsAtomicAction,
  submitVendorBillsForApprovalAction,
  deleteProjectVendorBillAction,
} from "@/app/(app)/projects/[id]/payables/actions";
import {
  MoreHorizontal,
  Plus,
  Receipt,
  Search,
  Upload,
  X,
} from "@/components/icons";
const PayableCreateWorkspace = dynamic(() =>
  import("@/components/payables/payable-create-workspace").then(
    (module) => module.PayableCreateWorkspace,
  ),
);
const AccountingSyncSheet = dynamic(() =>
  import("@/components/integrations/accounting-sync-sheet").then(
    (module) => module.AccountingSyncSheet,
  ),
);
import {
  accountingProviderLabel,
  isAccountingProviderKey,
} from "@/components/accounting/provider-label";
const PayBatchDialog = dynamic(() =>
  import("@/components/payables/pay-batch-dialog").then(
    (module) => module.PayBatchDialog,
  ),
);
import { BlockedPaymentsStrip } from "@/components/payables/blocked-payments-strip";
import { AwaitingRunApprovalBand } from "@/components/payables/awaiting-run-approval-band";
const PaymentRunsSheet = dynamic(() =>
  import("@/components/payables/payment-runs-sheet").then(
    (module) => module.PaymentRunsSheet,
  ),
);
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge";
import {
  BulkOutcomeList,
  type BulkOutcome,
} from "@/components/payables/bulk-outcome-list";
import type { BlockedPaymentRun } from "@/lib/services/payment-risk";
import type { PaymentRunListRow } from "@/lib/services/payment-runs";
const PayablesWorkspace = dynamic(() =>
  import("@/components/payables/payables-workspace").then(
    (module) => module.PayablesWorkspace,
  ),
);
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param";
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ProjectAvatar } from "@/components/ui/project-avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PAYABLE_BAND_LABELS,
  PAYABLE_BANDS,
  type PayableSort,
  parsePayablesBookQuery,
} from "@/lib/financials/payables-book";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { PayableCodingCell } from "./payable-coding-cell";
import {
  dueDisplay,
  formatDay,
  vendorLabel,
} from "@/components/payables/payables-ui";
import {
  PayableOperationalStatus,
  PayableReadinessDot,
  PayableReleaseWarning,
  payableDeleteBlockedReason,
  payableReleaseWarnings,
} from "@/components/payables/payable-row-state";
import {
  isVendorCredit,
  payableOutstandingCents,
} from "@/lib/financials/payables-rules";
import type { CodingAutomationStats } from "@/lib/services/books/coding-rules";
import type {
  OrgPayablesDeskData,
  PayableRunMembership,
} from "@/lib/services/org-payables";
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations";
import type {
  BudgetLineOption,
  ComplianceRules,
  ComplianceStatusSummary,
} from "@/lib/types";
import {
  indexLatestBillPaymentSyncByBillId,
  type AccountingSyncState,
} from "@/lib/services/accounting-sync-state";
import { cn } from "@/lib/utils";

type QBOAccountOption = {
  id: string;
  name: string;
  fullyQualifiedName?: string;
  account_type?: string;
  account_sub_type?: string;
};
type ProjectBillingModel =
  | "fixed_price"
  | "cost_plus_percent"
  | "cost_plus_fixed_fee"
  | "cost_plus_gmp"
  | "time_and_materials";
type ProjectOption = {
  id: string;
  name: string;
  billingModel: ProjectBillingModel;
  costCodesEnabled?: boolean;
};

const DAY_MS = 86_400_000;

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
};

/**
 * How this payable was actually paid. An open payable has no method yet — Arc
 * pays by ACH today and will mail checks later, and which rail a bill goes out on
 * is decided when it is released, not by whether its vendor has onboarded. So the
 * column reports the recorded fact and stays quiet otherwise.
 */
function MethodCell({ bill }: { bill: VendorBillSummary }) {
  const recorded =
    bill.payment_method ??
    bill.payments?.find((payment) => payment.method)?.method;
  if (!recorded) return <span className="text-muted-foreground">—</span>;
  const accountingPayment = bill.payments?.find((payment) =>
    isAccountingProviderKey(payment.provider),
  );
  return (
    <span
      className="text-sm text-muted-foreground"
      title={
        accountingPayment
          ? `Recorded in ${accountingProviderLabel(accountingPayment.provider)}`
          : undefined
      }
    >
      {METHOD_LABELS[recorded] ?? recorded}
    </span>
  );
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
  bill: VendorBillSummary;
  membership?: PayableRunMembership;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const blockedReason = payableDeleteBlockedReason(bill, membership);
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
  );
}

/**
 * Sticky header cells. `border-collapse` drops borders on sticky cells, so the
 * hairline under the header is an inset shadow. `text-muted-foreground` restores
 * the microlabel tone that TableHead's own `text-foreground` would otherwise win.
 */
const HEAD =
  "sticky top-0 z-10 bg-background text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]";

export function PayablesDesk({
  data,
  project,
  railOpen,
  viewerMayApproveRuns = false,
  approvalViewer = null,
  blockedRuns = [],
  approvalRuns = [],
}: {
  data: OrgPayablesDeskData;
  project?: ProjectOption;
  railOpen: boolean;
  viewerMayApproveRuns?: boolean;
  approvalViewer?: {
    userId: string;
    approvers: Array<{ userId: string; name: string }>;
  } | null;
  /** Payments an automated control stopped. Empty on a normal day. */
  blockedRuns?: BlockedPaymentRun[];
  approvalRuns?: PaymentRunListRow[];
}) {
  const basePath = project
    ? `/projects/${project.id}/financials/payables`
    : "/payables";
  const router = useRouter();
  const urlSearchParams = useSearchParams();
  const communityId = urlSearchParams.get("community");
  const [isPending, startTransition] = React.useTransition();
  /** Held separately from mutations: this one only ever means "fetching rows". */
  const [isNavigating, startNavigation] = React.useTransition();

  const [collapsedBands, setCollapsedBands] = React.useState<Set<string>>(
    new Set(),
  );
  const [search, setSearch] = React.useState(data.query.search);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [bulkOutcomes, setBulkOutcomes] = React.useState<BulkOutcome[]>([]);
  const [lastBulkOperation, setLastBulkOperation] = React.useState<
    "submit" | "approve" | null
  >(null);

  // Selection is local to this desk. Persisted IDs can cross projects or users.
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [basePath, communityId]);
  /**
   * Concurrency tokens the server moved on its own — opening a payable caches
   * its advisory approval signals, which is a write. Bulk approval sends the
   * token from this server-rendered list, so it has to learn the new value or
   * it would reject an approval as a conflict nobody caused.
   */
  const [freshTokens, setFreshTokens] = React.useState<Record<string, string>>(
    {},
  );
  const noteFreshToken = React.useCallback(
    (billId: string, updatedAt: string) => {
      setFreshTokens((current) =>
        current[billId] === updatedAt
          ? current
          : { ...current, [billId]: updatedAt },
      );
    },
    [],
  );
  /** The row the keyboard is on. -1 until j/k or a click moves it. */
  const [cursor, setCursor] = React.useState(-1);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [workspaceBillId, openBill] = useWorkspaceParam("bill");
  const intake = usePayableIntake(project?.id, () => router.refresh());
  const addIntakeFiles = intake.add;

  const accountingProjectId =
    project?.id ??
    (data.selectedBill?.id === workspaceBillId
      ? data.selectedBill?.project_id
      : data.bills.find((bill) => bill.id === workspaceBillId)?.project_id) ??
    undefined;

  // Org-level accounting context — the same one the project workbench loads.
  const [accountingEnabled, setAccountingEnabled] = React.useState(false);
  const [accountingReady, setAccountingReady] = React.useState(false);
  const [accountingError, setAccountingError] = React.useState<string | null>(
    null,
  );
  const [accountingAttempt, setAccountingAttempt] = React.useState(0);
  /** Any accounting integration, healthy or not — the gate for the sync queue. */
  const [hasAccountingConnection, setHasAccountingConnection] =
    React.useState(false);
  const [accountingProvider, setAccountingProvider] = React.useState<
    string | null
  >(null);
  const nativeBooks = accountingProvider === "arc_books";
  const [accountingProviderName, setAccountingProviderName] = React.useState<
    string | null
  >(null);
  const [accountingSyncByBillId, setAccountingSyncByBillId] = React.useState<
    Record<string, AccountingSyncState>
  >({});
  const [paymentSyncByBillId, setPaymentSyncByBillId] = React.useState<
    Record<string, AccountingSyncState>
  >({});
  const [syncFilter, setSyncFilter] = React.useState<"all" | "attention">(
    "all",
  );
  const [qboExpenseAccounts, setQboExpenseAccounts] = React.useState<
    QBOAccountOption[]
  >([]);
  const [qboApAccounts, setQboApAccounts] = React.useState<QBOAccountOption[]>(
    [],
  );
  const [qboDefaults, setQboDefaults] = React.useState<{
    expenseAccountId?: string;
    apAccountId?: string;
  }>({});
  const [accountingDimensions, setAccountingDimensions] = React.useState<
    Array<{
      key: string;
      label: string;
      values: QBOAccountOption[];
    }>
  >([]);
  const [projects, setProjects] = React.useState<ProjectOption[]>([]);

  // Adding a bill: opened by the toolbar button, or by dropping a file anywhere
  // on the page. `droppedFile` is what the sheet scans on open.
  const [addOpen, setAddOpen] = React.useState(
    () => urlSearchParams.get("new") === "1",
  );
  const [syncSheetOpen, setSyncSheetOpen] = React.useState(false);
  const [paymentHistoryOpen, setPaymentHistoryOpen] = React.useState(false);
  /** The selection being turned into one payment run, or null when idle. */
  const [payBatch, setPayBatch] = React.useState<VendorBillSummary[] | null>(
    null,
  );
  /** The payable a row menu asked to delete, held until it is confirmed. */
  const [deleteTarget, setDeleteTarget] =
    React.useState<VendorBillSummary | null>(null);
  const [droppedFile, setDroppedFile] = React.useState<File | null>(null);
  const [isDraggingFile, setIsDraggingFile] = React.useState(false);

  // Per-payable project context, fetched only when a payable is opened.
  const [costCodesEnabled, setCostCodesEnabled] = React.useState(true);
  const [budgetLines, setBudgetLines] = React.useState<BudgetLineOption[]>([]);
  const [holdEvaluations, setHoldEvaluations] = React.useState<
    Record<string, PaymentHoldEvaluation>
  >({});

  React.useEffect(() => {
    let cancelled = false;
    setAccountingReady(false);
    setAccountingError(null);
    getPayablesAccountingContextAction(accountingProjectId)
      .then((context) => {
        if (cancelled) return;
        setAccountingReady(true);
        setAccountingEnabled(Boolean(context.enabled));
        setHasAccountingConnection(Boolean(context.hasAnyConnection));
        setAccountingProvider(context.provider ?? null);
        setAccountingProviderName(context.providerName ?? null);
        setQboExpenseAccounts(context.expenseAccounts ?? []);
        setQboApAccounts(context.apAccounts ?? []);
        setQboDefaults(context.defaults ?? {});
        setAccountingDimensions(context.dimensions ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setAccountingError("Accounting setup could not load.");
          setAccountingEnabled(false);
          setHasAccountingConnection(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountingProjectId, accountingAttempt]);

  React.useEffect(() => {
    if (!accountingEnabled || nativeBooks) return;
    let cancelled = false;
    const billIds =
      data.selectedBill &&
      !data.bills.some((bill) => bill.id === data.selectedBill?.id)
        ? [...data.bills.map((bill) => bill.id), data.selectedBill.id]
        : data.bills.map((bill) => bill.id);
    void getPayablesAccountingSyncStatesAction(billIds)
      .then((states) => {
        if (cancelled) return;
        setAccountingSyncByBillId(states.bills);
        setPaymentSyncByBillId(
          indexLatestBillPaymentSyncByBillId(
            states.latestPaymentIdByBillId,
            states.billPayments,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setAccountingSyncByBillId({});
          setPaymentSyncByBillId({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountingEnabled, nativeBooks, data.bills, data.selectedBill]);

  const needsProjectOptions = addOpen || Boolean(workspaceBillId);
  React.useEffect(() => {
    let cancelled = false;
    if (!needsProjectOptions || projects.length > 0) return;
    listProjectBillingOptionsAction()
      .then((rows) => {
        if (cancelled) return;
        setProjects(rows ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needsProjectOptions, projects.length]);

  const openedBill = React.useMemo(
    () =>
      data.selectedBill?.id === workspaceBillId
        ? data.selectedBill
        : (data.bills.find((bill) => bill.id === workspaceBillId) ?? null),
    [data.bills, data.selectedBill, workspaceBillId],
  );
  const openedProjectId = openedBill?.project_id;

  React.useEffect(() => {
    if (!workspaceBillId || openedProjectId === undefined) return;
    let cancelled = false;
    setBudgetLines([]);
    getOrgPayableContextAction(openedProjectId ?? null, workspaceBillId)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        setCostCodesEnabled(result.data.costCodesEnabled);
        setBudgetLines(result.data.budgetLines);
        const holds = result.data.holds;
        if (holds)
          setHoldEvaluations((current) => ({
            ...current,
            [workspaceBillId]: holds,
          }));
      })
      .catch(() => {
        if (!cancelled)
          toast.error(
            "Could not load payable context. Close and reopen the bill to retry.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [openedProjectId, workspaceBillId]);

  const intakeById = React.useMemo(() => new Map(intake.rows.map(row => [row.id, row])), [intake.rows]);
  const billById = React.useMemo(() => {
    const map = new Map(data.bills.map(bill => [bill.id, bill]));
    for (const row of intake.rows) {
      const existing = map.get(row.id);
      map.set(row.id, { ...existing, id: row.id, org_id: existing?.org_id ?? "", project_id: existing?.project_id ?? project?.id ?? null,
        payable_type: existing?.payable_type ?? "bill", qbo_pushable: existing?.qbo_pushable ?? false, imported_from_qbo: existing?.imported_from_qbo ?? false, payments: existing?.payments ?? [],
        currency: existing?.currency ?? "usd", created_at: existing?.created_at ?? "", status: existing?.status ?? "pending", is_draft: true,
        company_name: row.vendor || existing?.company_name || row.name,
        bill_number: row.billNumber || existing?.bill_number, total_cents: row.amount ?? existing?.total_cents,
      });
    }
    return map;
  }, [data.bills, intake.rows, project?.id]);
  const bands = React.useMemo(
    () =>
      (data.bands?.some(band => band.key === "drafts") ? data.bands : [{ key: "drafts" as const, billIds: [], total: 0, page: 1, pageCount: 1 }, ...(data.bands ?? [])])
      .map(band => {
        if (band.key !== "drafts") return band;
        const extra = intake.rows.filter(row => !band.billIds.includes(row.id));
        return { ...band, billIds: [...extra.map(row => row.id), ...band.billIds], total: Math.max(band.total, band.billIds.length + extra.length) };
      }).filter((band) => band.total > 0).map((band) => ({
        ...band,
        rows: band.billIds.flatMap((id) => {
          const bill = billById.get(id);
          if (
            !bill ||
            (syncFilter === "attention" &&
              ![
                accountingSyncByBillId[id]?.status,
                paymentSyncByBillId[id]?.status,
              ].some((status) =>
                ["error", "conflict", "needs_review"].includes(status ?? ""),
              ))
          )
            return [];
          return [bill];
        }),
      })),
    [
      data.bands,
      intake.rows,
      billById,
      syncFilter,
      accountingSyncByBillId,
      paymentSyncByBillId,
    ],
  );
  const rows = React.useMemo(
    () =>
      bands.flatMap((band) => (collapsedBands.has(band.key) ? [] : band.rows)),
    [bands, collapsedBands],
  );

  const rowIndexById = React.useMemo(
    () => new Map(rows.map((bill, index) => [bill.id, index])),
    [rows],
  );

  const buildHref = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(urlSearchParams.toString());
      if (params.get("tab") === "paid" || params.get("queue") === "paid")
        params.set("history", "1");
      for (const key of ["tab", "queue", "due", "page"]) params.delete(key);
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const query = params.toString();
      return query ? `${basePath}?${query}` : basePath;
    },
    [basePath, urlSearchParams],
  );

  /**
   * Navigation runs inside a transition so the desk keeps showing the rows it
   * has while the next tab loads. Without it React tears the table down and the
   * switch reads as a page load instead of a filter.
   */
  const navigateQuery = React.useCallback(
    (updates: Record<string, string | null>) => {
      const href = buildHref(updates);
      startNavigation(() => router.replace(href, { scroll: false }));
    },
    [buildHref, router],
  );

  React.useEffect(() => {
    setSearch(data.query.search);
  }, [data.query.search, data.query.tab]);

  React.useEffect(() => {
    if (search === data.query.search) return;
    const timer = window.setTimeout(
      () =>
        navigateQuery({
          q: search.trim() || null,
          ...Object.fromEntries(
            PAYABLE_BANDS.map((band) => [`page_${band}`, null]),
          ),
        }),
      350,
    );
    return () => window.clearTimeout(timer);
  }, [data.query.search, navigateQuery, search]);

  /**
   * Method is settled history, so it only earns a column where settled rows live.
   * On the working tabs nothing has been paid yet and the column would be a full
   * height of em dashes.
   */
  const showMethod = false;
  /** Outstanding is the operative number until the bill is history. */
  const outstandingLeads = false;

  // Selection only ever means the rows you can still see.
  const visibleIds = React.useMemo(
    () => new Set(rows.map((bill) => bill.id)),
    [rows],
  );
  const [selectionRows, setSelectionRows] = React.useState<VendorBillSummary[]>(
    [],
  );
  const [selectionLoading, setSelectionLoading] = React.useState(false);
  React.useEffect(() => {
    const missing = [...selectedIds].filter((id) => !billById.has(id));
    if (!missing.length) {
      setSelectionRows([]);
      setSelectionLoading(false);
      return;
    }
    let cancelled = false;
    setSelectionLoading(true);
    getSelectedPayablesAction(missing)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setSelectionRows([]);
          toast.error(result.error);
          return;
        }
        setSelectionRows(result.data);
      })
      .catch(() => {
        if (!cancelled)
          toast.error("Could not load the selection. Clear it and try again.");
      })
      .finally(() => {
        if (!cancelled) setSelectionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedIds, billById]);
  const selected = React.useMemo(() => {
    const byId = new Map(
      [...selectionRows, ...data.bills].map((bill) => [bill.id, bill]),
    );
    return [...selectedIds].flatMap((id) =>
      byId.has(id) ? [byId.get(id)!] : [],
    );
  }, [data.bills, selectionRows, selectedIds]);
  const selectableRows = React.useMemo(
    () => rows.filter((bill) => !isVendorCredit(bill)),
    [rows],
  );
  const mayDecideBillApproval = React.useCallback(
    (bill: VendorBillSummary) =>
      !bill.preferred_approver_ids?.length ||
      Boolean(
        approvalViewer &&
        bill.preferred_approver_ids.includes(approvalViewer.userId),
      ),
    [approvalViewer],
  );
  const approvable = React.useMemo(
    () =>
      selected.filter(
        (bill) =>
          bill.status === "pending" &&
          !bill.is_draft &&
          mayDecideBillApproval(bill),
      ),
    [mayDecideBillApproval, selected],
  );
  const isPayable = React.useCallback(
    (bill: VendorBillSummary) =>
      (bill.status === "approved" || bill.status === "partial") &&
      payableOutstandingCents(bill) > 0 &&
      Boolean(bill.company_id) &&
      data.paymentReadinessByCompanyId[bill.company_id!] === "ready" &&
      data.electronicReadinessByBillId[bill.id]?.readiness === "ready" &&
      !data.runMembershipByBillId[bill.id],
    [
      data.electronicReadinessByBillId,
      data.paymentReadinessByCompanyId,
      data.runMembershipByBillId,
    ],
  );
  // Bills a payment run could take today: approved with a balance, an ACH-ready
  // vendor, and not already claimed by an active run.
  const payable = React.useMemo(
    () => selected.filter(isPayable),
    [selected, isPayable],
  );
  // Keep the payment workspace reachable for approved selections that still
  // need vendor setup. The dialog groups those bills and links directly to the
  // invitation/setup surface instead of leaving the selection at a dead end.
  const payCandidates = React.useMemo(
    () =>
      selected.filter(
        (bill) =>
          (bill.status === "approved" || bill.status === "partial") &&
          payableOutstandingCents(bill) > 0 &&
          !data.runMembershipByBillId[bill.id],
      ),
    [data.runMembershipByBillId, selected],
  );
  const mayOpenPayBatch =
    payCandidates.length > 0 ||
    (lastBulkOperation === "approve" &&
      bulkOutcomes.some(
        (outcome) => outcome.ok && selectedIds.has(outcome.id),
      ));
  /**
   * Why the rest of the selection cannot go out. A footer that silently offers
   * to pay six of the ten rows you picked is the moment people stop trusting it.
   */
  const excluded = React.useMemo(() => {
    const reasons: string[] = [];
    const candidates = selected.filter(
      (bill) =>
        !isVendorCredit(bill) && !bill.is_draft && bill.status !== "paid",
    );
    const unready = candidates.filter(
      (bill) =>
        (bill.status === "approved" || bill.status === "partial") &&
        !data.runMembershipByBillId[bill.id] &&
        (!bill.company_id ||
          data.paymentReadinessByCompanyId[bill.company_id] !== "ready" ||
          data.electronicReadinessByBillId[bill.id]?.readiness !== "ready"),
    ).length;
    const inRun = candidates.filter(
      (bill) => data.runMembershipByBillId[bill.id],
    ).length;
    const unapproved = candidates.filter(
      (bill) => bill.status === "pending",
    ).length;
    if (unready > 0)
      reasons.push(
        `${unready} ${unready === 1 ? "vendor is" : "vendors are"} not payment-ready`,
      );
    if (inRun > 0) reasons.push(`${inRun} already in a run`);
    if (unapproved > 0) reasons.push(`${unapproved} not approved yet`);
    return reasons;
  }, [
    selected,
    data.electronicReadinessByBillId,
    data.paymentReadinessByCompanyId,
    data.runMembershipByBillId,
  ]);

  /** A payment this viewer is the one being asked to release. */
  const awaitsMyApproval = React.useCallback(
    (bill: VendorBillSummary) => {
      const membership = data.runMembershipByBillId[bill.id];
      return Boolean(
        viewerMayApproveRuns &&
        membership &&
        membership.runStatus === "pending_approval" &&
        (!membership.preparedByViewer || membership.requesterMayApprove),
      );
    },
    [data.runMembershipByBillId, viewerMayApproveRuns],
  );

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
    if (addOpen || workspaceBillId) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setIsDraggingFile(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser navigates to the file instead of dropping it.
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDraggingFile(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setIsDraggingFile(false);
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) addIntakeFiles(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      setIsDraggingFile(false);
    };
  }, [addOpen, workspaceBillId, addIntakeFiles]);

  const toggleAll = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const bill of selectableRows) {
        if (checked) next.add(bill.id);
        else next.delete(bill.id);
      }
      return next;
    });
  };
  const toggleOne = (billId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(billId);
      else next.delete(billId);
      return next;
    });
  };

  /** The desk reports every row and continues past failures. */
  const approveBills = React.useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      startTransition(async () => {
        const result = await approveVendorBillsAtomicAction(
          ids.map((id) => ({
            id,
            expected_updated_at:
              freshTokens[id] ??
              selected.find((bill) => bill.id === id)?.updated_at ??
              rows.find((bill) => bill.id === id)?.updated_at,
          })),
          "skip_failures",
        );
        if (!result.success) {
          toast.error(result.error, {
            description: "No payables were changed.",
          });
          return;
        }
        const byId = new Map(
          rows.map((bill) => [bill.id, bill.bill_number ?? vendorLabel(bill)]),
        );
        setBulkOutcomes(
          result.data.outcomes.map((outcome) => ({
            ...outcome,
            label: byId.get(outcome.id) ?? `Payable ${outcome.id.slice(0, 8)}`,
          })),
        );
        setLastBulkOperation("approve");
        toast.success(
          `${result.data.approvedCount} payable${result.data.approvedCount === 1 ? "" : "s"} approved`,
        );
        // Keep the successful selection: after refresh those same ids become
        // ready-to-pay and can be split into capped payment runs without a
        // second 300-row selection pass.
        router.refresh();
      });
    },
    [freshTokens, router, rows, selected],
  );

  const submitDrafts = React.useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      startTransition(async () => {
        const result = await submitVendorBillsForApprovalAction(ids);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const byId = new Map(
          rows.map((bill) => [bill.id, bill.bill_number ?? vendorLabel(bill)]),
        );
        setBulkOutcomes(
          result.data.map((outcome) => ({
            ...outcome,
            label: byId.get(outcome.id) ?? `Payable ${outcome.id.slice(0, 8)}`,
          })),
        );
        setLastBulkOperation("submit");
        setSelectedIds(
          (current) =>
            new Set(
              [...current].filter(
                (id) =>
                  !result.data.some(
                    (outcome) => outcome.id === id && outcome.ok,
                  ),
              ),
            ),
        );
        router.refresh();
      });
    },
    [router, rows],
  );

  const openSelectedPayBatch = React.useCallback(() => {
    startTransition(async () => {
      const result = await getSelectedPayablesAction([...selectedIds]);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const candidates = result.data.filter(
        (bill) =>
          (bill.status === "approved" || bill.status === "partial") &&
          payableOutstandingCents(bill) > 0,
      );
      if (candidates.length === 0) {
        toast.error("None of the selected payables are ready to pay");
        return;
      }
      setPayBatch(candidates);
    });
  }, [selectedIds]);

  /**
   * Delete one payable. The server re-checks every reason a payable may not be
   * deleted, so a refusal here is reported, not assumed away.
   */
  const deletePayable = React.useCallback(
    (bill: VendorBillSummary) => {
      startTransition(async () => {
        const result = await deleteProjectVendorBillAction(
          bill.project_id,
          bill.id,
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        if (!result.data.success) {
          toast.error(result.data.error ?? "This payable could not be deleted");
          return;
        }
        toast.success(
          bill.bill_number
            ? `Payable ${bill.bill_number} deleted`
            : "Payable deleted",
        );
        setDeleteTarget(null);
        setSelectedIds((current) => {
          if (!current.has(bill.id)) return current;
          const next = new Set(current);
          next.delete(bill.id);
          return next;
        });
        router.refresh();
      });
    },
    [router],
  );

  /**
   * Keyboard triage. AP is list work — the hands should never have to leave the
   * keyboard to walk a queue, mark the rows that belong in a run, and send it.
   */
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Anything modal owns the keyboard while it is open.
      if (
        workspaceBillId ||
        addOpen ||
        payBatch ||
        syncSheetOpen ||
        deleteTarget
      )
        return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isTextEntry =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target?.isContentEditable === true;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest("[data-slot=popover-content],[role=dialog],[role=menu]")
      )
        return;
      if (isTextEntry) {
        if (event.key === "Escape") target?.blur();
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        setSelectedIds(new Set());
        setCursor(-1);
        return;
      }
      if (rows.length === 0) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((current) => Math.min(rows.length - 1, current + 1));
        return;
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((current) => Math.max(0, current - 1));
        return;
      }

      const cursorBill = cursor >= 0 ? rows[cursor] : undefined;
      if (event.key === "Enter" || event.key === "o") {
        // A row that has real DOM focus opens itself — handling it here too
        // would open whatever the cursor was last on instead.
        if (event.key === "Enter" && target?.closest("[data-payable-row]"))
          return;
        if (!cursorBill) return;
        event.preventDefault();
        openBill(cursorBill.id);
        return;
      }
      if (event.key === "x" || event.key === " ") {
        if (!cursorBill || isVendorCredit(cursorBill)) return;
        event.preventDefault();
        toggleOne(cursorBill.id, !selectedIds.has(cursorBill.id));
        return;
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
              : [];
        if (bills.length === 0) return;
        event.preventDefault();
        approveBills(bills.map((bill) => bill.id));
        return;
      }
      if (event.key === "p") {
        const bills =
          payable.length > 0
            ? payable
            : cursorBill && isPayable(cursorBill)
              ? [cursorBill]
              : [];
        if (!railOpen || bills.length === 0) return;
        event.preventDefault();
        setPayBatch(bills);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    selectedIds,
    syncSheetOpen,
    workspaceBillId,
  ]);

  // Keep the cursor row on screen as j/k walk past the viewport edge.
  React.useEffect(() => {
    if (cursor < 0) return;
    document
      .querySelector(`[data-payable-row="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  React.useEffect(() => {
    setCursor(-1);
  }, [data.bills]);

  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every((bill) => selectedIds.has(bill.id));
  const someSelected =
    selectableRows.some((bill) => selectedIds.has(bill.id)) && !allSelected;
  const selectedOutstandingCents = selected.reduce(
    (sum, bill) => sum + payableOutstandingCents(bill),
    0,
  );
  const payableCents = payable.reduce(
    (sum, bill) => sum + payableOutstandingCents(bill),
    0,
  );

  const changeSort = (key: PayableSort) => {
    navigateQuery({
      sort: key,
      direction:
        data.sort === key && data.direction !== "desc" ? "desc" : "asc",
      ...Object.fromEntries(
        PAYABLE_BANDS.map((band) => [`page_${band}`, null]),
      ),
    });
  };
  const sortLabel = (key: PayableSort, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 py-2 text-inherit hover:text-foreground"
      onClick={() => changeSort(key)}
    >
      {label}
      {data.sort === key ? (
        data.direction === "desc" ? (
          <ArrowDown className="size-3" />
        ) : (
          <ArrowUp className="size-3" />
        )
      ) : null}
    </button>
  );
  const ariaSort = (key: PayableSort) =>
    data.sort === key
      ? data.direction === "desc"
        ? ("descending" as const)
        : ("ascending" as const)
      : ("none" as const);
  const columnCount =
    7 +
    (project ? 0 : 1) +
    (project ? 1 : 0) +
    (accountingEnabled && !nativeBooks ? 1 : 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BlockedPaymentsStrip
        blockedRuns={blockedRuns}
        onDecided={() => router.refresh()}
      />
      <AwaitingRunApprovalBand runs={approvalRuns} />
      {/*
        Drop target feedback. Fixed and pointer-events-none: the window listeners
        own the drop, so this is purely the answer to "will it take this?" — an
        overlay that intercepted the event would break the drop it advertises.
      */}
      {isDraggingFile ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/90">
          <div className="relative flex flex-col items-center gap-3 border-2 border-dashed border-primary bg-background/80 px-12 py-10 text-center">
            <Upload className="size-8 text-primary" />
            <p className="text-sm font-medium">
              Drop invoices to create drafts
            </p>
            <p className="text-xs text-muted-foreground">
              Each invoice gets its own row. Arc scans while you keep working.
            </p>
          </div>
        </div>
      ) : null}


      <div className="flex gap-4 border-b px-4 py-2 text-sm"><span className="font-medium">Payables</span><a className="text-muted-foreground hover:text-foreground" href={`${basePath}/waivers`}>Waivers</a></div>
      {/* Toolbar: what you're looking at, and how to find one row in it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
          <span>
            <span className="font-mono tabular-nums">
              {data.summaryTruncated ? "≥ " : ""}
              {formatMoneyFromCents(
                data.tabs.approval.amountCents +
                  data.tabs.ready.amountCents +
                  data.tabs.inflight.amountCents,
              )}
            </span>{" "}
            <span className="text-muted-foreground">outstanding</span>
          </span>
          {accountingEnabled ? (
            <span className="text-xs text-muted-foreground">
              {nativeBooks
                ? "Arc Books"
                : accountingProviderLabel(
                    accountingProvider,
                    accountingProviderName,
                  )}
            </span>
          ) : null}
          {data.tabs.ready.amountCents > 0 ? (
            <span className="text-muted-foreground">
              <span className="font-mono tabular-nums text-foreground">
                {formatMoneyFromCents(data.tabs.ready.amountCents)}
              </span>{" "}
              ready to pay
            </span>
          ) : null}
        </div>

        <div className="flex max-w-full flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search payables…"
              aria-label="Search vendor, invoice, or project"
              className="h-9 w-52 bg-muted/30 pl-8 pr-8 shadow-none sm:w-64"
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
          <Button
            size="sm"
            className="h-9"
            onClick={() => {
              setDroppedFile(null);
              setAddOpen(true);
            }}
          >
            <Plus className="size-3.5" />
            Add bill
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                aria-label="Payables tools"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hasAccountingConnection ? (
                <DropdownMenuItem onSelect={() => setSyncSheetOpen(true)}>
                  Accounting sync queue
                </DropdownMenuItem>
              ) : null}
              {hasAccountingConnection ? (
                <DropdownMenuItem
                  onSelect={() =>
                    setSyncFilter((value) =>
                      value === "all" ? "attention" : "all",
                    )
                  }
                >
                  {syncFilter === "all"
                    ? "Show sync issues on this page"
                    : "Show all sync states"}
                </DropdownMenuItem>
              ) : null}
              {railOpen ? (
                <DropdownMenuItem onSelect={() => setPaymentHistoryOpen(true)}>
                  {project ? "Organization payment history" : "Payment history"}
                </DropdownMenuItem>
              ) : null}
              {!hasAccountingConnection && !railOpen ? (
                <DropdownMenuItem disabled>
                  No additional tools
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isPending}
                onSelect={() =>
                  startTransition(async () => {
                    const result = await selectMatchingPayableIdsAction({
                      ...parsePayablesBookQuery(
                        Object.fromEntries(urlSearchParams),
                      ),
                      search,
                      projectId: project?.id,
                      communityId: project
                        ? undefined
                        : (urlSearchParams.get("community") ?? undefined),
                    });
                    if (!result.success) {
                      toast.error(result.error);
                      return;
                    }
                    setSelectedIds(new Set(result.data.ids));
                    toast.success(
                      `${result.data.ids.length} matching payables selected`,
                      {
                        description: `Selection cap ${result.data.cap}; Arc Pay runs hold ${result.data.runCap} bills each.`,
                      },
                    );
                  })
                }
              >
                Select all matching filter · max 500
              </DropdownMenuItem>
              {!project && data.inboundBillsEmail ? (
                <DropdownMenuItem
                  onSelect={() => {
                    void navigator.clipboard
                      .writeText(data.inboundBillsEmail!)
                      .then(
                        () => toast.success("Address copied"),
                        () =>
                          toast.error("Could not copy the forwarding address"),
                      );
                  }}
                >
                  Copy invoice forwarding address
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {accountingError ? (
        <div
          role="alert"
          className="flex items-center gap-3 border-b px-4 py-2 text-sm text-destructive"
        >
          <span>{accountingError}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAccountingAttempt((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {syncFilter === "attention" ? (
        <div className="border-b px-4 py-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSyncFilter("all")}
          >
            Sync issues on loaded rows · Clear
          </Button>
        </div>
      ) : null}
      {/*
        The list. shadcn's Table wraps itself in an overflow container, which becomes
        the scrollport — so it has to be the element with the bounded height, or the
        sticky header has nothing to stick to.

        Keyed by tab so switching plays a short entrance: the rows are a different
        set, and saying so in motion is what separates a filter from a redraw. The
        key also resets the scrollport, which is what you want on a new queue.
      */}
      <div
        aria-busy={isNavigating}
        className={cn(
          "min-h-0 flex-1 [&>[data-slot=table-container]]:h-full",
          "animate-in fade-in slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none",
          // Rows stay on screen while the next tab loads; dimming them says the
          // list is stale without blanking the desk.
          isNavigating && "pointer-events-none opacity-60 transition-opacity",
        )}
      >
        {data.bills.length === 0 &&
        !bands.some((band) => band.total > 0) ? (
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
                  : "No open payables. Paid history is available below."}
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
              project
                ? "min-w-[720px]"
                : showMethod
                  ? "min-w-[1020px]"
                  : "min-w-[900px]",
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

                <TableHead
                  aria-sort={ariaSort("vendor")}
                  className={cn(
                    HEAD,
                    "microlabel",
                    showMethod ? "w-[22%]" : "w-[25%]",
                  )}
                >
                  {sortLabel("vendor", "Vendor")}
                </TableHead>
                {!project ? (
                  <TableHead
                    className={cn(
                      HEAD,
                      "microlabel",
                      showMethod ? "w-[16%]" : "w-[18%]",
                    )}
                    aria-sort={ariaSort("project")}
                  >
                    {sortLabel("project", "Project")}
                  </TableHead>
                ) : null}
                <TableHead
                  aria-sort={ariaSort("invoice")}
                  className={cn(
                    HEAD,
                    "microlabel",
                    showMethod ? "w-[11%]" : "w-[12%]",
                  )}
                >
                  {sortLabel("invoice", "Invoice")}
                </TableHead>
                <TableHead
                  aria-sort={ariaSort("due")}
                  className={cn(
                    HEAD,
                    "microlabel",
                    showMethod ? "w-[11%]" : "w-[12%]",
                  )}
                >
                  {sortLabel("due", "Due")}
                </TableHead>
                <TableHead
                  aria-sort={ariaSort("status")}
                  className={cn(
                    HEAD,
                    "microlabel",
                    showMethod ? "w-[15%]" : "w-[16%]",
                  )}
                >
                  {sortLabel("status", "Status")}
                </TableHead>
                {project ? (
                  <TableHead className={cn(HEAD, "microlabel w-[23%]")}>
                    {nativeBooks
                      ? "Arc Books account / Cost code"
                      : accountingEnabled
                        ? `${accountingProviderLabel(accountingProvider, accountingProviderName)} account / Cost code`
                        : "Cost code"}
                  </TableHead>
                ) : null}
                {accountingEnabled && !nativeBooks ? (
                  <TableHead className={cn(HEAD, "microlabel w-[8%]")}>
                    Sync
                  </TableHead>
                ) : null}
                {showMethod ? (
                  <TableHead className={cn(HEAD, "microlabel w-[8%]")}>
                    Method
                  </TableHead>
                ) : null}
                <TableHead
                  aria-sort={ariaSort("amount")}
                  className={cn(
                    HEAD,
                    "microlabel text-right",
                    showMethod ? "w-[13%]" : "w-[14%]",
                  )}
                >
                  {sortLabel("amount", "Bill total")}
                </TableHead>
                <TableHead className={cn(HEAD, "w-11 pr-2 sm:pr-4")}>
                  <span className="sr-only">Row actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bands.map((band) => (
                <React.Fragment key={band.key}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell
                      colSpan={columnCount}
                      className="px-4 py-2 sm:px-6"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          aria-expanded={!collapsedBands.has(band.key)}
                          onClick={() =>
                            setCollapsedBands((current) => {
                              const next = new Set(current);
                              if (next.has(band.key)) next.delete(band.key);
                              else next.add(band.key);
                              return next;
                            })
                          }
                          className="flex items-center gap-2 text-xs font-medium"
                        >
                          {collapsedBands.has(band.key) ? (
                            <ChevronRight className="size-3" />
                          ) : (
                            <ChevronDown className="size-3" />
                          )}
                          {PAYABLE_BAND_LABELS[band.key]}{" "}
                          <span className="font-normal tabular-nums text-muted-foreground">
                            {band.total}
                          </span>
                        </button>
                        {band.pageCount > 1 ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              {band.page} / {band.pageCount}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              aria-label={`Previous ${PAYABLE_BAND_LABELS[band.key]} page`}
                              disabled={isNavigating || band.page <= 1}
                              onClick={() =>
                                navigateQuery({
                                  [`page_${band.key}`]: String(band.page - 1),
                                })
                              }
                            >
                              Previous
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              aria-label={`Next ${PAYABLE_BAND_LABELS[band.key]} page`}
                              disabled={
                                isNavigating || band.page >= band.pageCount
                              }
                              onClick={() =>
                                navigateQuery({
                                  [`page_${band.key}`]: String(band.page + 1),
                                })
                              }
                            >
                              Next
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                  {!collapsedBands.has(band.key) && band.rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={columnCount}
                        className="px-6 py-3 text-xs text-muted-foreground"
                      >
                        {band.total > 0
                          ? "No matches on this page."
                          : "Nothing here."}
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {!collapsedBands.has(band.key)
                    ? band.rows.map((bill) => {
                        const index = rowIndexById.get(bill.id) ?? -1;
                        const outstanding = payableOutstandingCents(bill);
                        const total = bill.total_cents ?? 0;
                        const isSelected = selectedIds.has(bill.id);
                        const membership = data.runMembershipByBillId[bill.id];
                        const warnings = payableReleaseWarnings(
                          bill,
                          data.complianceRules,
                          data.complianceStatusByCompanyId,
                        );
                        const showReadiness =
                          railOpen &&
                          !membership &&
                          !isVendorCredit(bill) &&
                          !bill.is_draft &&
                          (bill.status === "approved" ||
                            bill.status === "partial");
                        const due = dueDisplay(bill);
                        const leadCents =
                          outstandingLeads && !isVendorCredit(bill)
                            ? outstanding
                            : total;
                        return (
                          <TableRow
                            key={bill.id}
                            data-payable-row={index}
                            data-state={isSelected ? "selected" : undefined}
                            onClick={() => {
                              if (intakeById.has(bill.id) && !intakeById.get(bill.id)!.billId) return;
                              setCursor(index);
                              openBill(bill.id);
                            }}
                            // Tabbing to a row moves the keyboard cursor with it, so the
                            // two ways of walking the list never disagree.
                            onFocus={() => setCursor(index)}
                            onKeyDown={(event) => {
                              if (
                                event.key === "Enter" &&
                                event.target === event.currentTarget &&
                                (!intakeById.has(bill.id) || Boolean(intakeById.get(bill.id)!.billId))
                              ) {
                                event.preventDefault();
                                openBill(bill.id);
                              }
                            }}
                            tabIndex={0}
                            aria-label={`Open ${vendorLabel(bill)} invoice ${bill.bill_number ?? "payable"}`}
                            className={cn(
                              "group/row h-14 cursor-pointer",
                              cursor === index &&
                                "ring-1 ring-inset ring-primary/40",
                            )}
                          >
                            <TableCell
                              className="pl-4 sm:pl-6"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {isVendorCredit(bill) ? null : (
                                <Checkbox
                                  disabled={intakeById.has(bill.id) && intakeById.get(bill.id)!.stage !== "ready"}
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
                                  <PayableReleaseWarning warnings={warnings} />
                                ) : null}
                                {showReadiness ? (
                                  data.electronicReadinessByBillId[bill.id]
                                    ?.readiness !== "ready" ? (
                                    <span
                                      title={
                                        data.electronicReadinessByBillId[
                                          bill.id
                                        ]?.message ??
                                        "This payable is outside the enabled Arc Pay jurisdictions"
                                      }
                                      className="size-1.5 shrink-0 rounded-full bg-warning"
                                    >
                                      <span className="sr-only">
                                        {data.electronicReadinessByBillId[
                                          bill.id
                                        ]?.message ??
                                          "This payable is outside the enabled Arc Pay jurisdictions"}
                                      </span>
                                    </span>
                                  ) : (
                                    <PayableReadinessDot
                                      readiness={
                                        bill.company_id
                                          ? data.paymentReadinessByCompanyId[
                                              bill.company_id
                                            ]
                                          : undefined
                                      }
                                    />
                                  )
                                ) : null}
                              </div>
                            </TableCell>
                            {!project ? (
                              <TableCell>
                                <div className="flex min-w-0 items-center gap-2">
                                  {bill.project_id ? (
                                    <ProjectAvatar
                                      projectId={bill.project_id}
                                      size="sm"
                                    />
                                  ) : (
                                    <Receipt className="size-4 shrink-0 text-muted-foreground" />
                                  )}
                                  <span className="truncate text-sm text-muted-foreground">
                                    {bill.project_name ?? "Overhead"}
                                  </span>
                                </div>
                              </TableCell>
                            ) : null}
                            <TableCell>
                              <div className="truncate text-sm text-muted-foreground">
                                {bill.bill_number ?? "—"}
                              </div>
                            </TableCell>
                            <TableCell
                              className={cn(
                                "whitespace-nowrap text-sm tabular-nums",
                                due.className,
                              )}
                            >
                              {due.text}
                            </TableCell>
                            <TableCell
                              onClick={
                                membership
                                  ? (event) => event.stopPropagation()
                                  : undefined
                              }
                            >
                              {membership ? (
                                <Link
                                  href={`/payables/payment-runs/${membership.runId}`}
                                  aria-label={`Open payment run for ${bill.bill_number ?? "payable"}`}
                                >
                                  <PayableOperationalStatus
                                    bill={bill}
                                    membership={membership}
                                    awaitsViewer={awaitsMyApproval(bill)}
                                  />
                                </Link>
                              ) : (
                                intakeById.has(bill.id) && (intakeById.get(bill.id)!.stage !== "ready" || intakeById.get(bill.id)!.warning) ? <PayableIntakeStatus row={intakeById.get(bill.id)!} retry={() => intake.retry(bill.id)} dismiss={() => intake.dismiss(bill.id)} /> : <PayableOperationalStatus bill={bill} />
                              )}
                            </TableCell>
                            {project ? (
                              <TableCell
                                className="p-0"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <PayableCodingCell
                                  bill={bill}
                                  nativeBooks={nativeBooks}
                                  accountingEnabled={accountingEnabled}
                                  accounts={qboExpenseAccounts}
                                  costCodes={data.costCodes}
                                  costCodesEnabled={
                                    project.costCodesEnabled !== false
                                  }
                                  locked={
                                    !accountingReady || Boolean(membership) || (intakeById.has(bill.id) && intakeById.get(bill.id)!.stage !== "ready")
                                  }
                                  expectedUpdatedAt={
                                    freshTokens[bill.id] ?? bill.updated_at
                                  }
                                  onOpen={() => openBill(bill.id)}
                                  onSaved={(updatedAt) => {
                                    if (updatedAt)
                                      noteFreshToken(bill.id, updatedAt);
                                    router.refresh();
                                  }}
                                />
                              </TableCell>
                            ) : null}
                            {accountingEnabled && !nativeBooks ? (
                              <TableCell>
                                <div className="flex gap-1">
                                  <AccountingSyncBadge
                                    compact
                                    status={
                                      accountingSyncByBillId[bill.id]?.status ??
                                      "not_synced"
                                    }
                                    externalId={
                                      accountingSyncByBillId[bill.id]
                                        ?.externalId
                                    }
                                    error={
                                      accountingSyncByBillId[bill.id]?.error
                                    }
                                    provider={
                                      accountingSyncByBillId[bill.id]
                                        ?.provider ?? accountingProvider
                                    }
                                  />
                                  <AccountingSyncBadge
                                    compact
                                    status={
                                      paymentSyncByBillId[bill.id]?.status
                                    }
                                    externalId={
                                      paymentSyncByBillId[bill.id]?.externalId
                                    }
                                    error={paymentSyncByBillId[bill.id]?.error}
                                    provider={
                                      paymentSyncByBillId[bill.id]?.provider ??
                                      accountingProvider
                                    }
                                  />
                                </div>
                              </TableCell>
                            ) : null}
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
                                {intakeById.has(bill.id) && intakeById.get(bill.id)!.amount == null && intakeById.get(bill.id)!.stage !== "ready" ? "—" : formatMoneyFromCents(leadCents)}
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
                        );
                      })
                    : null}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {bulkOutcomes.length > 0 ? (
        <BulkOutcomeList
          outcomes={bulkOutcomes}
          retrying={isPending}
          onRetryFailures={(ids) =>
            lastBulkOperation === "submit"
              ? submitDrafts(ids)
              : approveBills(ids)
          }
        />
      ) : null}

      {/* Pinned summary — and the bulk action, once rows are picked. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-card px-4 py-2 text-xs sm:px-6">
        {selectedIds.size > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium tabular-nums">
                {selectedIds.size} selected across pages
              </span>
              <span className="tabular-nums text-muted-foreground">
                {formatMoneyFromCents(selectedOutstandingCents)}
              </span>
              {railOpen &&
              excluded.length > 0 &&
              payable.length < selected.length ? (
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
              {selected.some((bill) => bill.is_draft) ? (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isPending || selectionLoading}
                  onClick={() =>
                    submitDrafts(
                      selected
                        .filter((bill) => bill.is_draft)
                        .map((bill) => bill.id),
                    )
                  }
                >
                  Submit {selected.filter((bill) => bill.is_draft).length} for
                  approval
                </Button>
              ) : null}
              {approvable.length > 0 ? (
                <Button
                  size="sm"
                  variant={railOpen && mayOpenPayBatch ? "outline" : "default"}
                  className="h-7 text-xs"
                  disabled={
                    isPending || selectionLoading || selectedIds.size === 0
                  }
                  onClick={() =>
                    approveBills(approvable.map((bill) => bill.id))
                  }
                >
                  {selectedIds.size === 0
                    ? "Nothing to approve"
                    : `Approve ${approvable.length} ${approvable.length === 1 ? "payable" : "payables"}`}
                </Button>
              ) : null}
              {railOpen && mayOpenPayBatch ? (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={openSelectedPayBatch}
                >
                  Pay selected by ACH · runs max 200
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <span className="tabular-nums">
                {rows.length} shown · {data.pagination.total} matching payables
              </span>
              {data.summaryTruncated ? (
                <span title="Tab totals are summed from the first 2,000 open payables.">
                  Tab totals cover the first 2,000 open payables
                </span>
              ) : null}
              <CodingAutomationReadout stats={data.codingAutomation} />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() =>
                  navigateQuery({
                    history: data.bands?.some((band) => band.key === "paid")
                      ? null
                      : "1",
                    tab: null,
                    queue: null,
                  })
                }
              >
                {data.bands?.some((band) => band.key === "paid")
                  ? "Hide paid history"
                  : `Show paid history · ${data.tabs.paid.count}`}
              </Button>
            </div>
          </>
        )}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this payable?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${deleteTarget.bill_number ? `Invoice ${deleteTarget.bill_number}` : "This payable"} for ${vendorLabel(deleteTarget)}${
                    deleteTarget.project_name
                      ? ` on ${deleteTarget.project_name}`
                      : ""
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
                event.preventDefault();
                if (deleteTarget) deletePayable(deleteTarget);
              }}
            >
              {isPending ? "Deleting…" : "Delete payable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {payBatch !== null ? (
        <PayBatchDialog
          open={payBatch !== null}
          onOpenChange={(next) => {
            if (!next) setPayBatch(null);
          }}
          bills={payBatch ?? []}
          onSubmitted={() => {
            setSelectedIds(new Set());
            router.refresh();
          }}
        />
      ) : null}

      {syncSheetOpen ? (
        <AccountingSyncSheet
          projectId={project?.id}
          open={syncSheetOpen}
          onOpenChange={(next) => {
            setSyncSheetOpen(next);
            if (!next) router.refresh();
          }}
        />
      ) : null}

      {paymentHistoryOpen ? (
        <PaymentRunsSheet
          open={paymentHistoryOpen}
          onOpenChange={setPaymentHistoryOpen}
        />
      ) : null}

      {addOpen ? (
        <PayableCreateWorkspace
          projectId={project?.id}
          projects={
            project && !projects.some((item) => item.id === project.id)
              ? [project, ...projects]
              : projects
          }
          initialFile={droppedFile}
          initialCompanyId={urlSearchParams.get("vendor")}
          open={addOpen}
          onOpenChange={(next) => {
            setAddOpen(next);
            if (!next) setDroppedFile(null);
          }}
          onSuccess={() => router.refresh()}
        />
      ) : null}

      {workspaceBillId ? (
        <PayablesWorkspace
          projectId={project?.id}
          bills={data.bills}
          selectedBill={data.selectedBill}
          selectedBillId={workspaceBillId}
          onSelectBill={openBill}
          costCodes={data.costCodes}
          budgetLines={budgetLines}
          costCodesEnabled={costCodesEnabled}
          projects={projects}
          accountingEnabled={accountingEnabled}
          codingReady={accountingReady}
          accountingProvider={accountingProvider}
          accountingProviderName={accountingProviderName}
          accountingSyncByBillId={accountingSyncByBillId}
          paymentSyncByBillId={paymentSyncByBillId}
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
      ) : null}
    </div>
  );
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
function CodingAutomationReadout({
  stats,
}: {
  stats: CodingAutomationStats | null;
}) {
  if (!stats || stats.touchesPerTransaction === null || stats.transactions < 5)
    return null;
  const rate = stats.touchesPerTransaction.toFixed(1);
  const autoPercent =
    stats.autoCodedShare === null
      ? null
      : Math.round(stats.autoCodedShare * 100);
  return (
    <span
      className="tabular-nums"
      title={`${stats.touches} coding edits across ${stats.transactions} payables captured in the last ${stats.windowDays} days.`}
    >
      {rate} touches/payable
      {autoPercent === null ? null : (
        <span className="text-foreground/70"> · {autoPercent}% auto-coded</span>
      )}
    </span>
  );
}

function AmountFootnote({
  bill,
  outstanding,
  total,
  outstandingLeads,
}: {
  bill: VendorBillSummary;
  outstanding: number;
  total: number;
  outstandingLeads: boolean;
}) {
  if (isVendorCredit(bill)) return null;
  if (outstanding !== total) {
    return (
      <div className="text-xs tabular-nums text-muted-foreground">
        {outstandingLeads
          ? `of ${formatMoneyFromCents(total)}`
          : outstanding > 0
            ? `${formatMoneyFromCents(outstanding)} due`
            : "Settled"}
      </div>
    );
  }
  const percent = bill.early_pay_discount_percent;
  const days = bill.early_pay_discount_days;
  if (
    !outstandingLeads ||
    !percent ||
    !days ||
    !bill.bill_date ||
    bill.status === "paid"
  )
    return null;
  const deadline = new Date(
    new Date(`${bill.bill_date}T00:00:00`).getTime() + days * DAY_MS,
  );
  if (deadline.getTime() < new Date().setHours(0, 0, 0, 0)) return null;
  return (
    <div className="text-xs tabular-nums text-success">
      {percent}% by {formatDay(deadline.toISOString().slice(0, 10))}
    </div>
  );
}

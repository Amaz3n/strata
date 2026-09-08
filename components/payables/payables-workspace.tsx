"use client";
import { getPayableNativeFundingAccountsAction } from "@/app/(app)/payables/actions";

import { invoiceFileError } from "@/lib/payables/intake";
import type { ExtractedPayableInvoice } from "@/lib/services/document-extraction";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Building2,
  CalendarDays,
  ExternalLink,
  Pencil,
  MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  isPaymentStepUpError,
  usePaymentStepUp,
} from "@/components/payments/payment-step-up";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { type AttachedFile } from "@/components/files";
import { CompanyForm } from "@/components/companies/company-form";
import { PayableDetailShell } from "./workspace/payable-detail-shell";
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers";
import { getCompanyAction } from "@/app/(app)/companies/actions";
import { assessPayableApprovalSignalsAction } from "@/app/(app)/payables/approval-signals-actions";
import {
  applyVendorCreditAction,
  getPayableAuditTrailAction,
  getVendorCreditApplicationWorkspaceAction,
} from "@/app/(app)/payables/actions";
import type { EvenFlowPriceAssessment } from "@/lib/financials/even-flow-price-anomaly";
import type { BillScheduleAssessment } from "@/lib/financials/bill-schedule-crosscheck";
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions";
import {
  ensureProjectVendorCompanyForPayableAction,
  reassignProjectPayableAction,
  releaseRetainageAction,
  reverseManualBillPaymentAction,
  syncProjectVendorBillToAccountingAction,
  updateProjectVendorBillStatusAction,
} from "@/app/(app)/projects/[id]/payables/actions";
import { qboTxnUrl } from "@/lib/integrations/accounting/qbo/links";
import type { FileLinkWithFile } from "@/lib/services/file-links";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import type { AccountingSyncState } from "@/lib/services/accounting-sync-state";
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds";
import type { PayableRunMembership } from "@/lib/services/org-payables";
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations";
import {
  getPayableSyncBlockReason,
  isVendorCredit,
  payableHeldRetainageCents,
  payableOutstandingCents,
} from "@/lib/financials/payables-rules";
import type { BudgetLineOption, Company, CostCode } from "@/lib/types";
import type { EntityAuditEntry } from "@/lib/services/audit";

type VendorCreditWorkspace = Awaited<
  ReturnType<
    typeof import("@/lib/services/vendor-bills").getVendorCreditApplicationWorkspace
  >
>;
import { type PayableQueue } from "./payables-filters";
import { PayableDocumentPane } from "./payable-document-pane";
import { FinancialRecordAccounting } from "@/components/accounting/financial-record-accounting";
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge";
import { accountingProviderLabel } from "@/components/accounting/provider-label";
import { vendorLabel } from "./payables-ui";
import {
  billStatus,
  formIsDirty,
  normalizeLienWaiverStatus,
  parseDollarsToCents,
  payableStage,
  sortCostCodes,
  toFormState,
  type PayableFormState,
  type PayableStage,
} from "./workspace/payable-form";
import { PayableActionBand } from "./workspace/payable-action-band";
import { PayableAmount } from "./workspace/payable-amount";
import { PayableIdentity } from "./workspace/payable-identity";
import { PayablePayView } from "./workspace/payable-pay-view";
import { PayableReviewView } from "./workspace/payable-review-view";
import { PayableWaivers } from "./payable-waivers";
import { PayableTerms } from "./workspace/payable-terms";
import { PayableTimeline } from "./workspace/payable-timeline";
import { RecordSection } from "./workspace/record-section";
import {
  PayableLinesEditor,
  supportsBillableCosts,
  type ProjectOption,
} from "./workspace/payable-lines-editor";

import { unwrapAction } from "@/lib/action-result";

type QBOAccountOption = {
  id: string;
  name: string;
  fullyQualifiedName?: string;
};

interface PayablesWorkspaceProps {
  /**
   * The project the workspace was opened from. Omitted on the org-wide payables
   * desk, where each payable answers to its own project instead.
   */
  projectId?: string;
  bills: VendorBillSummary[];
  /** Selected record loaded independently when a deep link is off-page. */
  selectedBill?: VendorBillSummary | null;
  selectedBillId: string | null;
  onSelectBill: (billId: string | null) => void;
  costCodes: CostCode[];
  budgetLines?: BudgetLineOption[];
  costCodesEnabled: boolean;
  projects: ProjectOption[];
  accountingEnabled: boolean;
  codingReady?: boolean;
  accountingProvider?: string | null;
  accountingProviderName?: string | null;
  accountingSyncByBillId?: Record<string, AccountingSyncState>;
  paymentSyncByBillId?: Record<string, AccountingSyncState>;
  qboExpenseAccounts: QBOAccountOption[];
  qboApAccounts: QBOAccountOption[];
  qboDefaults: { expenseAccountId?: string; apAccountId?: string };
  accountingDimensions?: Array<{
    key: string;
    label: string;
    values: QBOAccountOption[];
  }>;
  onChanged: () => void;
  /** Server hold evaluations by bill id — the release gate's own verdict. */
  holdEvaluations?: Record<string, PaymentHoldEvaluation>;
  /** Whether this org has the Arc Pay rail configured. */
  railOpen?: boolean;
  paymentReadinessByCompanyId?: Record<string, CompanyPaymentReadinessStatus>;
  runMembershipByBillId?: Record<string, PayableRunMembership>;
  /** Whether the viewer is designated to approve payment runs in this org. */
  viewerMayApproveRuns?: boolean;
  /**
   * Reports a payable's `updated_at` when the server moved it without the user
   * editing anything — caching the advisory approval signals does exactly that.
   * The list outside this workspace holds the same token for bulk approval, so
   * it has to hear about the new one or it will send a stale one.
   */
  onConcurrencyTokenRefresh?: (billId: string, updatedAt: string) => void;
  /** Identity and labels used to enforce the selected route in the bill UI. */
  approvalViewer?: {
    userId: string;
    approvers: Array<{ userId: string; name: string }>;
  } | null;
  /**
   * Server-computed per-queue totals (the desk's tab summaries). When provided,
   * the rail reports these real org-wide counts instead of tallying the one
   * page of bills it happens to hold.
   */
  queueTotals?: Partial<Record<PayableQueue, { count: number }>>;
}

/**
 * Which stages will accept an edit at all. While a payable is live — draft,
 * in review, approved but unpaid, or a credit — its fields are inputs drawn as
 * text: click any value and type. Once money is in motion or the record is
 * closed (in a run, rejected, paid) it is evidence, and evidence is read-only.
 */
function stageAcceptsEdits(stage: PayableStage) {
  return (
    stage === "draft" ||
    stage === "review" ||
    stage === "credit" ||
    stage === "payable"
  );
}

export function PayablesWorkspace({
  projectId,
  bills,
  selectedBill: selectedBillOverride = null,
  selectedBillId,
  onSelectBill,
  costCodes,
  budgetLines = [],
  costCodesEnabled,
  projects,
  accountingEnabled,
  codingReady = true,
  accountingProvider = null,
  accountingProviderName = "accounting",
  accountingSyncByBillId = {},
  paymentSyncByBillId = {},
  qboExpenseAccounts,
  qboApAccounts,
  qboDefaults,
  accountingDimensions = [],
  holdEvaluations = {},
  railOpen = false,
  paymentReadinessByCompanyId = {},
  runMembershipByBillId = {},
  viewerMayApproveRuns = false,
  onConcurrencyTokenRefresh,
  approvalViewer = null,
  onChanged,
}: PayablesWorkspaceProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Arc Books is Arc's ledger, not an external file waiting for a push. It uses
  // the same coding fields but must never present vendor-link or manual-sync UI.
  const accountingSyncEnabled =
    accountingEnabled && accountingProvider !== "arc_books";
  const providerName = accountingProviderLabel(
    accountingProvider,
    accountingProviderName,
  );

  const [editing, setEditing] = useState(false);
  const editRevision = useRef<string | undefined>(undefined);
  const [pendingVendor, setPendingVendor] = useState<Pick<Company, "id" | "name"> | null>(null);
  const [recordTab, setRecordTab] = useState<
    "bill" | "activity" | "accounting"
  >("bill");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(false);

  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentsError, setAttachmentsError] = useState(false);
  const [auditTrail, setAuditTrail] = useState<EntityAuditEntry[]>([]);
  const [creditWorkspace, setCreditWorkspace] =
    useState<VendorCreditWorkspace | null>(null);
  const [creditTargetBillId, setCreditTargetBillId] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [vendorEditorOpen, setVendorEditorOpen] = useState(false);
  const [vendorEditorCompanyId, setVendorEditorCompanyId] = useState<
    string | null
  >(null);
  const [vendorEditorCompany, setVendorEditorCompany] = useState<
    (Company & { contacts?: unknown[] }) | null
  >(null);
  const [vendorEditorLoading, setVendorEditorLoading] = useState(false);

  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignProjectId, setReassignProjectId] = useState("");

  /** Which secondary pane the slider is showing, if any. */
  const [sidePane, setSidePane] = useState<"pay" | "review" | null>(null);
  const payViewOpen = sidePane !== null;
  const [paymentFormOpen, setPaymentFormOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [booksPaymentAccountId, setBooksPaymentAccountId] = useState("");
  const [nativeFundingAccounts, setNativeFundingAccounts] = useState<Array<{id:string;code:string;name:string;subtype:string}>>([]);
  useEffect(() => { let cancelled = false; setBooksPaymentAccountId(""); setNativeFundingAccounts([]); if (selectedBillId) void getPayableNativeFundingAccountsAction(selectedBillId).then(result => { if (!cancelled && result.success) setNativeFundingAccounts(result.data); }); return () => { cancelled = true; }; }, [selectedBillId]);
  const [paymentMethod, setPaymentMethod] = useState("check");
  const [paymentRef, setPaymentRef] = useState("");
  /**
   * Captured separately from the reference. There is a unique index and a
   * duplicate-detection message behind this field; folding it into free text
   * meant neither ever ran.
   */
  const [checkNumber, setCheckNumber] = useState("");
  const paymentIdempotencyKeyRef = useRef("");
  const { requireStepUp, stepUpPrompt } = usePaymentStepUp();
  const [paymentDate, setPaymentDate] = useState(() =>
    format(new Date(), "yyyy-MM-dd"),
  );

  // Overrides recorded from this workspace refresh the evaluation immediately,
  // without waiting for the parent surface to reload its hold map.
  const [localHolds, setLocalHolds] = useState<
    Record<string, PaymentHoldEvaluation>
  >({});

  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<
    string | null | undefined
  >(undefined);
  const approveShortcutRef = useRef<(() => void) | null>(null);

  const selectedBill = useMemo(
    () =>
      selectedBillOverride?.id === selectedBillId
        ? selectedBillOverride
        : (bills.find((bill) => bill.id === selectedBillId) ?? null),
    [bills, selectedBillId, selectedBillOverride],
  );
  const [approvalSignals, setApprovalSignals] = useState<{
    evenFlow: EvenFlowPriceAssessment | null;
    schedule: BillScheduleAssessment | null;
  } | null>(null);
  // Caching the advisory signals is a write, so simply opening a payable moves
  // its `updated_at` — the same value every save sends as its concurrency
  // token. Without re-syncing, the first save after opening would be rejected
  // as a conflict the user never caused.
  const [freshTokenByBillId, setFreshTokenByBillId] = useState<
    Record<string, string>
  >({});
  const expectedUpdatedAt = useCallback(
    (bill: { id: string; updated_at?: string }) =>
      freshTokenByBillId[bill.id] ?? bill.updated_at,
    [freshTokenByBillId],
  );
  // Until the fresh check lands, paint whatever was cached on the payable the
  // last time it was opened — the assessment is stored on the bill, so there is
  // no reason to show nothing while the server confirms it is still current.
  const evenFlowAssessment = approvalSignals
    ? approvalSignals.evenFlow
    : (selectedBill?.even_flow_price ?? null);
  const scheduleAssessment = approvalSignals
    ? approvalSignals.schedule
    : (selectedBill?.bill_schedule ?? null);
  // Mutations are keyed by bill; the project only decides which pages get revalidated.
  // Org-wide there is no page project, so the payable's own project stands in.
  const contextProjectId = projectId ?? selectedBill?.project_id ?? "";
  const selectedIsVendorCredit = selectedBill
    ? isVendorCredit(selectedBill)
    : false;
  // Payables imported from the accounting provider (credits or regular bills) can be split
  // across projects at the line level, while Reassign moves the whole payable.
  const selectedIsReassignablePayable = selectedBill
    ? selectedIsVendorCredit || selectedBill.imported_from_qbo === true
    : false;

  const runMembership = selectedBill
    ? runMembershipByBillId[selectedBill.id]
    : undefined;
  const stage: PayableStage = selectedBill
    ? payableStage(selectedBill, runMembership)
    : "review";
  const evaluation = selectedBill
    ? (localHolds[selectedBill.id] ?? holdEvaluations[selectedBill.id])
    : undefined;
  const blocked = (evaluation?.blockingCount ?? 0) > 0;
  const readiness = selectedBill?.company_id
    ? paymentReadinessByCompanyId[selectedBill.company_id]
    : undefined;
  const canPayElectronically =
    railOpen && readiness === "ready" && !selectedIsVendorCredit;

  // Preserve the exact sequence supplied by the originating desk.
  const filtered = bills;

  const sortedCostCodes = useMemo(
    () => (costCodesEnabled ? sortCostCodes(costCodes) : []),
    [costCodes, costCodesEnabled],
  );
  const defaultBillable = useCallback(
    (lineProjectId?: string | null) =>
      !selectedIsVendorCredit &&
      supportsBillableCosts(
        projects.find((project) => project.id === lineProjectId)?.billingModel,
      ),
    [projects, selectedIsVendorCredit],
  );
  const getExpenseAccountName = (id?: string) =>
    qboExpenseAccounts.find((account) => account.id === id)?.name;
  const getApAccountName = (id?: string) =>
    qboApAccounts.find((account) => account.id === id)?.name;

  const baseline = useMemo(
    () =>
      selectedBill
        ? toFormState(selectedBill, {
            nativeBooks: accountingProvider === "arc_books",
            costCodesEnabled,
            qboDefaults,
            defaultBillable,
          })
        : null,
    [
      selectedBill,
      costCodesEnabled,
      qboDefaults,
      defaultBillable,
      accountingProvider,
    ],
  );
  const [form, setForm] = useState<PayableFormState | null>(null);
  const [attachmentScan, setAttachmentScan] = useState<ExtractedPayableInvoice | null>(null);
  const [attachmentScanning, setAttachmentScanning] = useState(false);
  const attachmentScanGeneration = useRef(0);
  const activeBillRef = useRef(selectedBill?.id);
  activeBillRef.current = selectedBill?.id;
  useEffect(() => {
    attachmentScanGeneration.current += 1;
    setAttachmentScan(null);
    setAttachmentScanning(false);
  }, [selectedBill?.id]);

  const scanRunning = Boolean(selectedBill?.invoice_intake && ["queued", "reading", "checking"].includes(selectedBill.invoice_intake.stage));
  const canEdit = codingReady && stageAcceptsEdits(stage);
  const editable = Boolean(form) && canEdit && editing;

  const isDirty = Boolean(
    pendingVendor || (form && baseline && formIsDirty(form, baseline)),
  );

  const requestSelectBill = useCallback(
    (billId: string | null) => {
      if (isDirty) {
        setPendingSelection(billId);
        setDiscardOpen(true);
        return;
      }
      onSelectBill(billId);
    },
    [isDirty, onSelectBill],
  );

  useEffect(() => {
    if (!isDirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [isDirty]);

  const confirmDiscard = () => {
    const next = pendingSelection === undefined ? null : pendingSelection;
    setDiscardOpen(false);
    setPendingSelection(undefined);
    onSelectBill(next);
  };

  // Keyboard navigation stays within the bill; nested dialogs own their keys.
  useEffect(() => {
    if (!selectedBill) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isTextEntry =
        tagName === "input" ||
        tagName === "textarea" ||
        target?.getAttribute("role") === "combobox";
      if (
        isTextEntry ||
        target?.isContentEditable ||
        target?.closest('[role="dialog"]') !==
          document.querySelector("[data-payable-detail]") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      )
        return;
      // No triage shortcuts mid-payment — the pay pane owns the keyboard.
      if (payViewOpenRef.current || editing || isPending) return;
      if (event.key === "j" || event.key === "k") {
        const index = filtered.findIndex((bill) => bill.id === selectedBill.id);
        const next =
          event.key === "j" ? filtered[index + 1] : filtered[index - 1];
        if (next) requestSelectBill(next.id);
      }
      if (
        event.key.toLowerCase() === "a" &&
        billStatus(selectedBill) === "pending" &&
        !selectedIsVendorCredit
      ) {
        approveShortcutRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    filtered,
    requestSelectBill,
    selectedBill,
    selectedIsVendorCredit,
    editing,
    isPending,
  ]);

  const payViewOpenRef = useRef(payViewOpen);
  payViewOpenRef.current = payViewOpen;

  const loadedBillId = useRef<string | null>(null);
  useEffect(() => {
    const navigating = loadedBillId.current !== (selectedBill?.id ?? null);
    if (!navigating && editing) return;
    setForm(baseline);
    if (!navigating) return;
    loadedBillId.current = selectedBill?.id ?? null;
    setEditing(false);
    setPendingVendor(null);
    setRecordTab("bill");
    setSidePane(null);
    setPaymentFormOpen(false);
    setPaymentAmount("");
    setPaymentMethod(
      selectedBill?.payment_method ??
        selectedBill?.preferred_payment_method ??
        "check",
    );
    setPaymentRef(selectedBill?.payment_reference ?? "");
    setPaymentDate(format(new Date(), "yyyy-MM-dd"));
    paymentIdempotencyKeyRef.current = "";
    setReassignProjectId(selectedBill?.project_id ?? "");
  }, [baseline, selectedBill, editing]);

  const attachmentBillId = selectedBill?.id;
  const auditBillId = selectedBill?.id;
  const auditProjectId = selectedBill?.project_id;
  const auditVersion = selectedBill?.updated_at;

  // Load attachments for the selected bill.
  useEffect(() => {
    if (!attachmentBillId) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    setAttachments([]);
    setAttachmentsLoading(true);
    setAttachmentsError(false);
    listAttachmentsAction("vendor_bill", attachmentBillId)
      .then((links) => {
        if (cancelled) return;
        setAttachments(links.map(mapAttachment));
      })
      .catch(() => {
        if (!cancelled) setAttachmentsError(true);
      })
      .finally(() => {
        if (!cancelled) setAttachmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attachmentBillId]);

  useEffect(() => {
    if (!selectedBill || !isVendorCredit(selectedBill)) {
      setCreditWorkspace(null);
      setCreditTargetBillId("");
      setCreditAmount("");
      return;
    }
    let cancelled = false;
    getVendorCreditApplicationWorkspaceAction(selectedBill.id)
      .then((result) => {
        if (cancelled || !result.success) return;
        setCreditWorkspace(result.data);
      })
      .catch(() => {
        if (!cancelled) setCreditWorkspace(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBill]);

  useEffect(() => {
    if (!auditBillId || recordTab !== "activity") return;
    let cancelled = false;
    setAuditTrail([]);
    setAuditLoading(true);
    setAuditError(false);
    getPayableAuditTrailAction(auditBillId, auditProjectId)
      .then((result) => {
        if (!cancelled) {
          if (result.success) setAuditTrail(result.data);
          else setAuditError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setAuditError(true);
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auditBillId, auditProjectId, auditVersion, recordTab]);

  // Approval-time signals for the payable that is actually open: how its trade
  // costs compare with every other lot of the same house plan, and whether the
  // work is on the calendar yet. Computed for one bill on demand rather than
  // across a queue that is routinely hundreds long, and cached server-side
  // against a fingerprint, so re-opening a payable costs almost nothing.
  useEffect(() => {
    if (!selectedBillId) {
      setApprovalSignals(null);
      return;
    }
    let cancelled = false;
    setApprovalSignals(null);
    assessPayableApprovalSignalsAction(selectedBillId)
      .then((result) => {
        if (cancelled || !result.success) return;
        setApprovalSignals({
          evenFlow: result.data.evenFlow,
          schedule: result.data.schedule,
        });
        const refreshed = result.data.updatedAt;
        if (refreshed) {
          setFreshTokenByBillId((current) =>
            current[selectedBillId] === refreshed
              ? current
              : { ...current, [selectedBillId]: refreshed },
          );
          onConcurrencyTokenRefresh?.(selectedBillId, refreshed);
        }
      })
      .catch(() => {
        if (!cancelled) setApprovalSignals(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBillId, onConcurrencyTokenRefresh]);

  useEffect(() => {
    const companyId = selectedBill?.company_id ?? vendorEditorCompanyId;
    if (!vendorEditorOpen || !companyId) {
      if (!vendorEditorOpen) {
        setVendorEditorCompany(null);
        setVendorEditorCompanyId(null);
      }
      return;
    }
    let cancelled = false;
    setVendorEditorLoading(true);
    getCompanyAction(companyId)
      .then((result) => {
        if (!cancelled) setVendorEditorCompany(result.company);
      })
      .catch((error) => toast.error((error as Error).message))
      .finally(() => {
        if (!cancelled) setVendorEditorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBill?.company_id, vendorEditorCompanyId, vendorEditorOpen]);

  if (!selectedBill || !form) return null;

  const billSyncState = accountingSyncByBillId[selectedBill.id];
  const effectiveSyncStatus = billSyncState?.status ?? "not_synced";
  const effectiveSyncError = billSyncState?.error ?? null;
  const effectiveExternalId = billSyncState?.externalId ?? null;

  const refreshAttachments = async () => {
    const links = await listAttachmentsAction("vendor_bill", selectedBill.id);
    setAttachments(links.map(mapAttachment));
  };

  const handleAttach = async (files: File[], linkRole?: string) => {
    const billId = selectedBill.id;
    for (const file of files) {
      let fileId: string;
      const shouldScan = canEdit && !invoiceFileError(file) && (attachments.length === 0 || linkRole === "invoice");
      if (shouldScan) {
        const generation = ++attachmentScanGeneration.current;
        setAttachmentScanning(true);
        setAttachmentScan(null);
        try {
          const formData = new FormData();
          formData.append("invoice", file);
          if (contextProjectId) formData.append("projectId", contextProjectId);
          if (selectedBill.company_id) formData.append("companyId", selectedBill.company_id);
          const response = await fetch("/api/payables/extract", { method: "POST", body: formData });
          const result = await response.json();
          if (!response.ok || !result.fileId) throw new Error(result.error || "Could not upload invoice");
          fileId = result.fileId;
          if (activeBillRef.current === billId && generation === attachmentScanGeneration.current) {
            if (result.ok && result.data.billable) setAttachmentScan(result.data);
            else toast.warning("Invoice attached", { description: result.error || "Review this document manually." });
          }
        } finally {
          if (activeBillRef.current === billId && generation === attachmentScanGeneration.current) setAttachmentScanning(false);
        }
      } else {
        const formData = new FormData();
        formData.append("file", file);
        if (contextProjectId) formData.append("projectId", contextProjectId);
        formData.append("category", "financials");
        fileId = unwrapAction(await uploadFileAction(formData)).id;
      }
      unwrapAction(await attachFileAction(fileId, "vendor_bill", billId, contextProjectId, linkRole));
    }
    if (activeBillRef.current === billId) await refreshAttachments();
  };

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId));
    await refreshAttachments();
  };

  const billTotalCents = selectedBill.total_cents ?? 0;
  const balanceCents = payableOutstandingCents(selectedBill);
  const heldRetainageCents = payableHeldRetainageCents(selectedBill);
  const creditTargetBill =
    creditWorkspace?.bills.find((bill) => bill.id === creditTargetBillId) ??
    null;
  const distinctSplitProjects = Array.from(
    new Set(form.splitLines.map((line) => line.projectId).filter(Boolean)),
  );
  const reassignBlockedBySplit =
    selectedIsReassignablePayable && distinctSplitProjects.length > 1;

  const currentStatus = billStatus(selectedBill);

  const handleSelectCompany = (company: Company) =>
    setPendingVendor(company.id === selectedBill.company_id ? null : company);

  const setStatus = (
    status: "approved" | "partial" | "paid",
    stepUpRetry = false,
  ) => {
    startTransition(async () => {
      try {
        const amountCents = paymentAmount.trim()
          ? (parseDollarsToCents(paymentAmount) ?? undefined)
          : undefined;
        const isPayment = status === "paid" || status === "partial";
        if (isPayment && !paymentIdempotencyKeyRef.current) {
          paymentIdempotencyKeyRef.current = crypto.randomUUID();
        }
        const result = unwrapAction(
          await updateProjectVendorBillStatusAction(
            contextProjectId,
            selectedBill.id,
            {
              status,
              expected_updated_at: expectedUpdatedAt(selectedBill),
              ...(accountingProvider === "arc_books"
                ? {
                    arc_books_gl_account_id:
                      form.qboExpenseAccountId || qboDefaults.expenseAccountId,
                  }
                : {
                    qbo_expense_account_id:
                      form.qboExpenseAccountId || qboDefaults.expenseAccountId,
                  }),
              qbo_expense_account_name:
                accountingProvider === "arc_books"
                  ? undefined
                  : getExpenseAccountName(
                      form.qboExpenseAccountId || qboDefaults.expenseAccountId,
                    ),
              books_payment_account_id: isPayment ? booksPaymentAccountId || null : undefined,
              payment_method: isPayment ? paymentMethod : undefined,
              payment_reference: isPayment
                ? paymentRef || undefined
                : undefined,
              check_number:
                isPayment && paymentMethod === "check"
                  ? checkNumber.trim() || undefined
                  : undefined,
              payment_date: isPayment ? paymentDate : undefined,
              payment_amount_cents:
                isPayment && amountCents ? amountCents : undefined,
              payment_idempotency_key: isPayment
                ? paymentIdempotencyKeyRef.current
                : undefined,
            },
          ),
        );
        if (!result.success) {
          // Recording a payment above the org's per-payment limit demands a
          // second factor, which the client cannot know in advance. Rather than
          // a dead-end toast, ask for the code and run it again.
          if (!stepUpRetry && isPaymentStepUpError(result.error)) {
            void requireStepUp(() => setStatus(status, true));
            return;
          }
          toast.error(result.error);
          return;
        }
        toast.success(
          status === "approved" ? "Approved for payment" : "Payment recorded",
        );
        setPaymentFormOpen(false);
        paymentIdempotencyKeyRef.current = "";
        onChanged();
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  };

  approveShortcutRef.current = () => {
    if (!blocked && !editing && !isPending && mayDecideBillApproval)
      setStatus("approved");
  };

  const saveDetails = () => {
    const retainagePercent = form.retainage.trim()
      ? Number(form.retainage)
      : undefined;
    if (
      form.retainage.trim() &&
      (retainagePercent === undefined ||
        !Number.isFinite(retainagePercent) ||
        retainagePercent < 0)
    ) {
      toast.error("Invalid retainage percentage");
      return;
    }
    const actualLines = form.splitLines.map((line) => ({
      project_id: line.projectId || selectedBill.project_id,
      cost_code_id: costCodesEnabled ? line.costCodeId || null : null,
      budget_line_id: costCodesEnabled ? null : line.budgetLineId || null,
      description: line.description.trim() || form.billNumber || "Vendor bill",
      amount_cents: parseDollarsToCents(line.amountDollars),
      billable_to_customer: line.billableToCustomer,
      ...(accountingProvider === "arc_books"
        ? {
            arc_books_gl_account_id:
              line.qboExpenseAccountId || form.qboExpenseAccountId || undefined,
          }
        : {
            qbo_expense_account_id:
              line.qboExpenseAccountId || form.qboExpenseAccountId || undefined,
          }),
      qbo_expense_account_name:
        accountingProvider === "arc_books"
          ? undefined
          : getExpenseAccountName(
              line.qboExpenseAccountId || form.qboExpenseAccountId,
            ),
      qbo_ap_account_id:
        accountingProvider === "arc_books"
          ? undefined
          : line.qboApAccountId || form.qboApAccountId || undefined,
      qbo_ap_account_name:
        accountingProvider === "arc_books"
          ? undefined
          : getApAccountName(line.qboApAccountId || form.qboApAccountId),
      accounting_dimensions: line.accountingDimensions,
    }));
    const hasInvalidLine = actualLines.some(
      (line) =>
        !line.project_id ||
        (costCodesEnabled && !line.cost_code_id) ||
        line.amount_cents == null ||
        (selectedIsVendorCredit
          ? line.amount_cents > 0
          : line.amount_cents < 0),
    );
    if (hasInvalidLine) {
      toast.error(
        costCodesEnabled
          ? "Each line needs a project, cost code, and amount."
          : "Each line needs a project and amount.",
      );
      return;
    }
    const splitTotalCents = actualLines.reduce(
      (sum, line) => sum + (line.amount_cents ?? 0),
      0,
    );
    if (splitTotalCents !== billTotalCents) {
      toast.error(
        `Lines (${formatMoneyFromCents(splitTotalCents)}) must equal the bill total (${formatMoneyFromCents(billTotalCents)})`,
      );
      return;
    }
    startTransition(async () => {
      try {
        const result = unwrapAction(
          await updateProjectVendorBillStatusAction(
            contextProjectId,
            selectedBill.id,
            {
              status: currentStatus,
              expected_updated_at:
                editRevision.current ?? expectedUpdatedAt(selectedBill),
              company_id: pendingVendor?.id,
              bill_number: form.billNumber.trim() || undefined,
              bill_date: form.billDate || undefined,
              due_date: form.dueDate || null,
              actual_lines: actualLines.map((line) => ({
                ...line,
                amount_cents: line.amount_cents ?? 0,
              })),
              retainage_percent: retainagePercent,
              lien_waiver_status: normalizeLienWaiverStatus(form.lienWaiver),
              // Only when a channel was actually chosen: writing the
              // default would route every saved payable and take the other
              // path away from it.
              payment_channel: form.paymentChannel || undefined,
              ...(accountingProvider === "arc_books"
                ? {
                    arc_books_gl_account_id:
                      form.qboExpenseAccountId || undefined,
                  }
                : {
                    qbo_expense_account_id:
                      form.qboExpenseAccountId || undefined,
                  }),
              qbo_expense_account_name:
                accountingProvider === "arc_books"
                  ? undefined
                  : getExpenseAccountName(form.qboExpenseAccountId),
              qbo_ap_account_id:
                accountingProvider === "arc_books"
                  ? undefined
                  : form.qboApAccountId || undefined,
              qbo_ap_account_name:
                accountingProvider === "arc_books"
                  ? undefined
                  : getApAccountName(form.qboApAccountId),
            },
          ),
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Payable saved");
        setPendingVendor(null);
        setEditing(false);
        onChanged();
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  };

  /**
   * Retainage is released as its own payable, not by editing this one down to
   * zero. The original stays evidence of what was billed and what was held; the
   * release gets its own approval, its own holds and its own payment.
   */
  const releaseHeldRetainage = () => {
    if (heldRetainageCents <= 0) return;
    startTransition(async () => {
      const result = unwrapAction(
        await releaseRetainageAction(contextProjectId, selectedBill.id),
      );
      if (result.success) {
        toast.success("Retainage release payable created");
        onChanged();
      } else {
        toast.error(result.error);
      }
    });
  };

  /**
   * Refusing a payable. The reason is required because it is what the vendor is
   * shown — a rejection with no explanation gets the same invoice back.
   */
  const rejectPayable = (rawReason: string) => {
    const reason = rawReason.trim();
    if (reason.length < 8) {
      toast.error("Tell the vendor why in at least a few words");
      return;
    }
    startTransition(async () => {
      const result = unwrapAction(
        await updateProjectVendorBillStatusAction(
          contextProjectId,
          selectedBill.id,
          {
            status: "rejected",
            expected_updated_at: expectedUpdatedAt(selectedBill),
            rejection_reason: reason,
          },
        ),
      );
      if (result.success) {
        toast.success("Payable rejected");
        onChanged();
      } else {
        toast.error(result.error);
      }
    });
  };

  /**
   * Undo a payment somebody recorded by hand. The server refuses this for rail
   * payments and for anyone without `payment.release`; the band only offers it
   * for manual payments so the common case does not present an action that
   * always fails.
   */
  const reverseManualPayment = (paymentId: string, reason: string) => {
    startTransition(async () => {
      const result = unwrapAction(
        await reverseManualBillPaymentAction(contextProjectId, {
          paymentId,
          reason,
        }),
      );
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Payment reversed", {
        description: `${formatMoneyFromCents(result.data.amountCents)} reopened on this payable.`,
      });
      onChanged();
    });
  };

  /** Put a rejected payable back in the queue; the reason is cleared with it. */
  const reopenPayable = () => {
    startTransition(async () => {
      const result = unwrapAction(
        await updateProjectVendorBillStatusAction(
          contextProjectId,
          selectedBill.id,
          {
            status: "pending",
            expected_updated_at: expectedUpdatedAt(selectedBill),
          },
        ),
      );
      if (result.success) {
        toast.success("Payable reopened");
        onChanged();
      } else {
        toast.error(result.error);
      }
    });
  };

  const reassignPayable = () => {
    if (
      !selectedIsReassignablePayable ||
      !reassignProjectId ||
      reassignProjectId === selectedBill.project_id
    )
      return;
    if (reassignBlockedBySplit) {
      toast.error(
        "Reassign is only available when all line items are assigned to one project.",
      );
      return;
    }
    startTransition(async () => {
      const result = unwrapAction(
        await reassignProjectPayableAction(
          contextProjectId,
          selectedBill.id,
          reassignProjectId,
        ),
      );
      if (result.success) {
        toast.success(
          selectedIsVendorCredit
            ? "Vendor credit reassigned"
            : "Bill reassigned",
        );
        setReassignOpen(false);
        // From a project workbench the payable has left the page it was opened from,
        // so follow it. Org-wide it is still on the desk — stay put and refresh.
        if (projectId)
          router.push(
            `/projects/${result.projectId}/financials/payables?bill=${selectedBill.id}`,
          );
        onChanged();
      } else {
        toast.error(result.error);
      }
    });
  };

  const syncToAccounting = () => {
    const reason = getPayableSyncBlockReason(selectedBill);
    if (reason) {
      toast.error(reason);
      if (!selectedBill.qbo_vendor_id) openVendorEditor();
      return;
    }
    startTransition(async () => {
      unwrapAction(
        await syncProjectVendorBillToAccountingAction(
          contextProjectId,
          selectedBill.id,
        ),
      );
      toast.success(`Queued for ${providerName}`);
      onChanged();
    });
  };

  const openVendorEditor = () => {
    if (selectedBill.company_id) {
      setVendorEditorCompanyId(selectedBill.company_id);
      setVendorEditorOpen(true);
      return;
    }
    startTransition(async () => {
      try {
        const company = unwrapAction(
          await ensureProjectVendorCompanyForPayableAction(
            contextProjectId,
            selectedBill.id,
          ),
        );
        setVendorEditorCompany(company);
        setVendorEditorCompanyId(company.id);
        setVendorEditorOpen(true);
        onChanged();
      } catch (error) {
        toast.error("This payable is not linked to an Arc vendor yet.", {
          description: (error as Error).message,
        });
      }
    });
  };

  const parseDate = (value?: string) => {
    if (!value) return undefined;
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };

  // The viewer is designated, the run is pending, and either someone else
  // prepared it or this owner-operated run explicitly permits self-approval.
  const awaitingViewerApproval = Boolean(
    runMembership &&
    viewerMayApproveRuns &&
    runMembership.runStatus === "pending_approval" &&
    (!runMembership.preparedByViewer || runMembership.requesterMayApprove),
  );

  const designatedBillApproverIds = selectedBill?.preferred_approver_ids ?? [];
  const mayDecideBillApproval =
    designatedBillApproverIds.length === 0 ||
    Boolean(
      approvalViewer &&
      designatedBillApproverIds.includes(approvalViewer.userId),
    );
  const designatedBillApproverNames = designatedBillApproverIds
    .map(
      (id) =>
        approvalViewer?.approvers.find((approver) => approver.userId === id)
          ?.name,
    )
    .filter((name): name is string => Boolean(name));
  const approvalWaitingLabel =
    designatedBillApproverNames.length > 0
      ? `Waiting for approval from ${new Intl.ListFormat("en", { style: "long", type: "disjunction" }).format(designatedBillApproverNames)}.`
      : "Waiting for a designated approver.";

  /** What sits under the vendor name: the reference facts, none of them repeated. */
  const subtitleParts = [
    selectedIsVendorCredit
      ? selectedBill.bill_number
        ? `Credit ${selectedBill.bill_number}`
        : "Vendor credit"
      : selectedBill.bill_number
        ? `Bill ${selectedBill.bill_number}`
        : "Payable",
    ...(projectId ? [] : [selectedBill.project_name ?? "Unassigned project"]),
  ];

  const selectedIndex = bills.findIndex((bill) => bill.id === selectedBill.id);

  const documentPane = attachmentsError ? (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <p className="text-sm text-muted-foreground">
        The invoice could not be loaded.
      </p>
      <Button
        variant="outline"
        onClick={async () => {
          setAttachmentsError(false);
          setAttachmentsLoading(true);
          try {
            await refreshAttachments();
          } catch {
            setAttachmentsError(true);
          } finally {
            setAttachmentsLoading(false);
          }
        }}
      >
        Try again
      </Button>
    </div>
  ) : (
    <PayableDocumentPane
      compact
      attachments={attachments}
      loading={attachmentsLoading}
      onAttach={handleAttach}
      onDetach={handleDetach}
      projectId={contextProjectId}
    />
  );

  return (
    <>
      {stepUpPrompt}
      <PayableDetailShell
        title={`${vendorLabel(selectedBill)} · ${selectedBill.bill_number ?? "Bill"}`}
        paymentOpen={payViewOpen}
        position={
          selectedIndex >= 0
            ? `${selectedIndex + 1} of ${bills.length}`
            : undefined
        }
        onPrevious={
          !isPending && selectedIndex > 0
            ? () => requestSelectBill(bills[selectedIndex - 1].id)
            : undefined
        }
        onNext={
          !isPending && selectedIndex >= 0 && selectedIndex < bills.length - 1
            ? () => requestSelectBill(bills[selectedIndex + 1].id)
            : undefined
        }
        onClose={() =>
          payViewOpen ? setSidePane(null) : requestSelectBill(null)
        }
        documentPane={documentPane}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain",
              payViewOpen && "hidden",
            )}
            inert={payViewOpen}
          >
            <div className="mx-auto w-full max-w-[800px] px-5 pb-12 pt-8 sm:px-10 sm:pt-10">
              {attachmentScanning ? <p className="mb-5 text-sm text-muted-foreground" role="status">Reading attached invoice… You can keep editing.</p> : null}
              {attachmentScan && canEdit ? (
                <div className="mb-6 rounded-lg border px-4 py-3 text-sm">
                  <p className="font-medium">Scanned details</p>
                  <p className="mt-1 text-xs text-muted-foreground">{attachmentScan.vendorName} · {attachmentScan.billNumber || "No invoice number"} · {attachmentScan.totalDollars == null ? "Amount not found" : formatMoneyFromCents(Math.round(attachmentScan.totalDollars * 100))}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Invoice date: {attachmentScan.billDate || "Not found"} · Due: {attachmentScan.dueDate || "Not found"}</p>
                  {attachmentScan.duplicateSuspected ? <p className="mt-2 text-xs text-warning">{attachmentScan.duplicateReason || "Possible duplicate invoice"}</p> : null}
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => {
                      editRevision.current = expectedUpdatedAt(selectedBill);
                      setEditing(true);
                      setRecordTab("bill");
                      setForm(current => current ? {
                        ...current,
                        billNumber: attachmentScan.billNumber || current.billNumber,
                        billDate: attachmentScan.billDate || current.billDate,
                        dueDate: attachmentScan.dueDate || current.dueDate,
                        splitLines: current.splitLines.length === 1 && attachmentScan.totalDollars != null
                          ? current.splitLines.map(line => ({ ...line, amountDollars: attachmentScan.totalDollars!.toFixed(2), description: attachmentScan.description || line.description }))
                          : current.splitLines,
                      } : current);
                      if (attachmentScan.vendorId && attachmentScan.vendorName) setPendingVendor({ id: attachmentScan.vendorId, name: attachmentScan.vendorName });
                      setAttachmentScan(null);
                    }}>Use scanned details</Button>
                    <Button size="sm" variant="ghost" onClick={() => setAttachmentScan(null)}>Dismiss</Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Changes remain unsaved. Existing split allocations are preserved.</p>
                </div>
              ) : null}
              {selectedBill.invoice_intake && selectedBill.is_draft ? (
                <div className="mb-6 rounded-lg bg-muted/40 px-4 py-3 text-sm" role="status">
                  <p className="font-medium">{scanRunning ? "Reading invoice…" : "Invoice captured · review this draft"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{selectedBill.invoice_intake.error || selectedBill.invoice_intake.duplicate_reason || (scanRunning ? "You can keep working. Editing this draft will stop automatic autofill." : "Check the vendor, amounts, and coding before submitting for approval.")}</p>
                </div>
              ) : null}
              {/* ————— Identity: who is owed, and where it stands ————— */}
              <PayableIdentity
                bill={selectedBill}
                stage={stage}
                status={currentStatus}
                subtitleParts={subtitleParts}
                pendingVendorName={pendingVendor?.name}
                canChangeVendor={editable && !isPending}
                onSelectCompany={handleSelectCompany}
                accountingEnabled={accountingSyncEnabled}
                actions={
                  <>
                    {canEdit && !editing ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2 rounded-lg"
                        disabled={isPending}
                        onClick={() => {
                          editRevision.current =
                            expectedUpdatedAt(selectedBill);
                          setEditing(true);
                          setRecordTab("bill");
                        }}
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </Button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          disabled={editing || isPending}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">More actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        {accountingSyncEnabled &&
                        !selectedIsReassignablePayable ? (
                          <DropdownMenuItem
                            disabled={
                              isPending || effectiveSyncStatus === "synced"
                            }
                            onClick={syncToAccounting}
                          >
                            Sync to {providerName}
                          </DropdownMenuItem>
                        ) : null}
                        {selectedIsReassignablePayable ? (
                          <DropdownMenuItem
                            disabled={
                              reassignBlockedBySplit || editing || isPending
                            }
                            onClick={() => setReassignOpen(true)}
                          >
                            Reassign to another project…
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onClick={openVendorEditor}>
                          Edit vendor details
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                }
              />

              {pendingVendor ? (
                <p className="mb-5 text-sm text-muted-foreground">
                  Vendor will change to{" "}
                  <span className="font-medium text-foreground">
                    {pendingVendor.name}
                  </span>{" "}
                  when saved.
                </p>
              ) : null}

              {/* ————— The number, at the size it deserves ————— */}
              <PayableAmount
                bill={selectedBill}
                isVendorCredit={selectedIsVendorCredit}
                totalCents={billTotalCents}
                paidCents={selectedBill.paid_cents ?? 0}
                retainedCents={heldRetainageCents}
                balanceCents={balanceCents}
                accountingProviderName={accountingProviderName}
                accountingEnabled={accountingSyncEnabled}
              />

              {/* ————— The one open question, or nothing at all ————— */}
              {!editing ? (
                <PayableActionBand
                  bill={selectedBill}
                  stage={stage}
                  isPending={isPending}
                  blocked={blocked}
                  evaluation={evaluation}
                  onHoldOverridden={(next) =>
                    setLocalHolds((prev) => ({
                      ...prev,
                      [selectedBill.id]: next,
                    }))
                  }
                  mayDecideApproval={mayDecideBillApproval}
                  approvalWaitingLabel={approvalWaitingLabel}
                  onApprove={() => setStatus("approved")}
                  onReject={rejectPayable}
                  onReopen={reopenPayable}
                  canPayElectronically={canPayElectronically}
                  railOpen={railOpen}
                  readiness={readiness}
                  onPayElectronically={() => setSidePane("pay")}
                  key={selectedBill.id}
                  recordPaymentOpen={paymentFormOpen}
                  onToggleRecordPayment={() =>
                    setPaymentFormOpen((open) => !open)
                  }
                  runMembership={runMembership}
                  onReverseManualPayment={reverseManualPayment}
                  awaitingViewerApproval={awaitingViewerApproval}
                  onReviewRun={() => setSidePane("review")}
                  onVendorInvited={onChanged}
                  recordPaymentForm={
                    <div className="space-y-4 py-2">
                      {nativeFundingAccounts.length ? <div className="space-y-1.5"><Label>Paid from</Label><Select value={booksPaymentAccountId || "unassigned"} onValueChange={value => setBooksPaymentAccountId(value === "unassigned" ? "" : value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unassigned">Select native bank or card</SelectItem>{nativeFundingAccounts.filter(account => ["card","credit_card","company_card"].includes(paymentMethod) ? account.subtype === "credit_card" : account.subtype === "cash").map(account => <SelectItem key={account.id} value={account.id}>{account.code} · {account.name}</SelectItem>)}</SelectContent></Select></div> : null}
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="microlabel">Amount</Label>
                          <div className="relative">
                            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs text-muted-foreground">
                              $
                            </span>
                            <Input
                              className="h-9 pl-7 tabular-nums"
                              placeholder={(
                                (balanceCents || billTotalCents) / 100
                              ).toFixed(2)}
                              value={paymentAmount}
                              onChange={(event) =>
                                setPaymentAmount(event.target.value)
                              }
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="microlabel">Method</Label>
                          <Select
                            value={paymentMethod}
                            onValueChange={setPaymentMethod}
                          >
                            <SelectTrigger className="h-9 w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="check">Check</SelectItem>
                              <SelectItem value="ach">ACH</SelectItem>
                              <SelectItem value="card">Credit card</SelectItem>
                              <SelectItem value="wire">Wire</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex flex-col space-y-1.5">
                          <Label className="microlabel">Payment date</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "h-9 w-full justify-start text-left text-[13px]",
                                  !paymentDate && "text-muted-foreground",
                                )}
                              >
                                <CalendarDays className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">
                                  {paymentDate && parseDate(paymentDate)
                                    ? format(
                                        parseDate(paymentDate) ?? new Date(),
                                        "MMM d, yyyy",
                                      )
                                    : "Pick a date"}
                                </span>
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              className="w-auto p-0"
                              align="start"
                            >
                              <Calendar
                                mode="single"
                                selected={parseDate(paymentDate)}
                                onSelect={(date) =>
                                  setPaymentDate(
                                    date ? format(date, "yyyy-MM-dd") : "",
                                  )
                                }
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="microlabel">Reference</Label>
                          <Input
                            className="h-9"
                            placeholder={
                              paymentMethod === "check"
                                ? "Joint payees, memo"
                                : "Transaction ID"
                            }
                            value={paymentRef}
                            onChange={(event) =>
                              setPaymentRef(event.target.value)
                            }
                          />
                        </div>
                        {paymentMethod === "check" ? (
                          <div className="space-y-1.5">
                            <Label className="microlabel">Check number</Label>
                            <Input
                              className="h-9 tabular-nums"
                              placeholder="1042"
                              value={checkNumber}
                              onChange={(event) =>
                                setCheckNumber(event.target.value)
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Checked against every other payment so the same
                              check cannot be recorded twice.
                            </p>
                          </div>
                        ) : null}
                      </div>
                      <Button
                        className="h-9 w-full"
                        disabled={isPending || blocked}
                        onClick={() => setStatus("paid")}
                      >
                        {isPending ? "Recording…" : "Post payment"}
                      </Button>
                    </div>
                  }
                />
              ) : null}

              {/* ————— The record: one continuous document, no drawers ————— */}
              <div className="mt-8">
                {!editing ? (
                  <div
                    className="mb-7 flex gap-6 border-b border-border/60"
                    role="tablist"
                    aria-label="Bill information"
                  >
                    {(["bill", "activity", "accounting"] as const).map(
                      (tab) => (
                        <button
                          key={tab}
                          type="button"
                          role="tab"
                          id={`payable-tab-${tab}`}
                          aria-controls={`payable-panel-${tab}`}
                          aria-selected={recordTab === tab}
                          tabIndex={recordTab === tab ? 0 : -1}
                          onKeyDown={(event) => {
                            const tabs = [
                              "bill",
                              "activity",
                              "accounting",
                            ] as const;
                            const index = tabs.indexOf(tab);
                            const next =
                              event.key === "ArrowRight"
                                ? tabs[(index + 1) % 3]
                                : event.key === "ArrowLeft"
                                  ? tabs[(index + 2) % 3]
                                  : event.key === "Home"
                                    ? tabs[0]
                                    : event.key === "End"
                                      ? tabs[2]
                                      : null;
                            if (next) {
                              event.preventDefault();
                              setRecordTab(next);
                              document
                                .getElementById(`payable-tab-${next}`)
                                ?.focus();
                            }
                          }}
                          onClick={() => setRecordTab(tab)}
                          className={cn(
                            "border-b-2 px-0 pb-3 text-sm transition-colors",
                            recordTab === tab
                              ? "border-foreground font-medium text-foreground"
                              : "border-transparent text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {tab === "bill"
                            ? "Overview"
                            : tab === "activity"
                              ? "Activity"
                              : "Accounting"}
                        </button>
                      ),
                    )}
                  </div>
                ) : (
                  <p className="mb-6 text-sm text-muted-foreground">
                    Edit bill details, then save your changes.
                  </p>
                )}
                {recordTab === "bill" ? (
                  <div
                    role="tabpanel"
                    id="payable-panel-bill"
                    aria-labelledby="payable-tab-bill"
                  >
                    {projectId && selectedBill.is_shared ? (
                      <p className="mb-6 rounded-xl bg-muted/40 px-4 py-3 text-sm">
                        <span className="text-muted-foreground">
                          This project’s share
                        </span>
                        <span className="ml-3 font-medium tabular-nums">
                          {formatMoneyFromCents(
                            selectedBill.project_amount_cents ?? 0,
                          )}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          The amount above is the balance for the whole bill.
                        </span>
                      </p>
                    ) : null}
                    <RecordSection label="Cost allocation">
                      {!codingReady ? (
                        <p
                          role="status"
                          className="mb-3 text-sm text-muted-foreground"
                        >
                          Coding is unavailable until accounting setup loads. If
                          it does not load, close this record and retry from
                          Payables.
                        </p>
                      ) : null}
                      {selectedBill.coding_source ||
                      selectedBill.extraction_confidence ||
                      selectedBill.line_match ||
                      evenFlowAssessment?.claims.length ||
                      scheduleAssessment?.findings.length ? (
                        <details className="mb-5 rounded-xl bg-muted/30 px-4 py-3">
                          <summary className="cursor-pointer text-sm font-medium">
                            Review insights
                            {selectedBill.over_budget ||
                            evenFlowAssessment?.claims.some(
                              (claim) => claim.direction === "above",
                            ) ||
                            scheduleAssessment?.findings.length ||
                            selectedBill.extraction_confidence === "low" ? (
                              <span className="ml-2 text-xs text-warning">
                                Review recommended
                              </span>
                            ) : null}
                          </summary>
                          <div className="mt-3 space-y-3">
                            <CodingProvenance bill={selectedBill} />
                            <LineMatchEvidence bill={selectedBill} />
                            <EvenFlowPriceEvidence
                              assessment={evenFlowAssessment}
                            />
                            <ScheduleCrosscheckEvidence
                              assessment={scheduleAssessment}
                            />
                          </div>
                        </details>
                      ) : null}
                      {editable ? (
                        <PayableLinesEditor
                          lines={form.splitLines}
                          onLinesChange={(updater) =>
                            setForm((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    splitLines: updater(prev.splitLines),
                                  }
                                : prev,
                            )
                          }
                          locked={!editable}
                          isVendorCredit={selectedIsVendorCredit}
                          isReassignable={selectedIsReassignablePayable}
                          projects={projects}
                          costCodes={sortedCostCodes}
                          costCodesEnabled={costCodesEnabled}
                          budgetLines={budgetLines}
                          accountingEnabled={accountingEnabled}
                          accountingProviderName={accountingProviderName}
                          accountingDimensions={accountingDimensions}
                          qboExpenseAccounts={qboExpenseAccounts}
                          qboApAccounts={
                            accountingProvider === "arc_books"
                              ? []
                              : qboApAccounts
                          }
                          billTotalCents={billTotalCents}
                          fallbackProjectId={selectedBill.project_id ?? ""}
                          defaultDescription={form.billNumber || "Vendor bill"}
                          headerQboExpenseAccountId={form.qboExpenseAccountId}
                          headerQboApAccountId={form.qboApAccountId}
                          defaultBillable={defaultBillable}
                        />
                      ) : (
                        <div className="divide-y divide-border/60">
                          {form.splitLines.map((line) => (
                            <div
                              key={line.id}
                              className="flex items-start justify-between gap-5 py-4 first:pt-0 last:pb-0"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium leading-6">
                                  {line.description ||
                                    form.billNumber ||
                                    "Vendor bill"}
                                </p>
                                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                                  {projects.find(
                                    (project) => project.id === line.projectId,
                                  )?.name ??
                                    selectedBill.project_name ??
                                    "Unassigned project"}
                                  {costCodesEnabled && line.costCodeId
                                    ? ` · ${sortedCostCodes.find((code) => code.id === line.costCodeId)?.name ?? "Cost code unavailable"}`
                                    : budgetLines.find(
                                          (item) =>
                                            item.id === line.budgetLineId,
                                        )?.description
                                      ? ` · ${budgetLines.find((item) => item.id === line.budgetLineId)?.description}`
                                      : ""}
                                  {line.billableToCustomer ? " · Billable" : ""}
                                </p>
                              </div>
                              <span className="shrink-0 pt-1 text-sm font-medium tabular-nums">
                                {formatMoneyFromCents(
                                  parseDollarsToCents(line.amountDollars) ?? 0,
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </RecordSection>

                    <PayableTerms
                      bill={selectedBill}
                      form={form}
                      onChange={(patch) =>
                        setForm((prev) => (prev ? { ...prev, ...patch } : prev))
                      }
                      editable={editable}
                      isVendorCredit={selectedIsVendorCredit}
                      heldRetainageCents={heldRetainageCents}
                      onReleaseRetainage={releaseHeldRetainage}
                      isPending={isPending}
                    />

                    {selectedBill.project_id && !selectedIsVendorCredit && !editing ? <PayableWaivers key={selectedBill.id} billId={selectedBill.id} /> : null}

                    {selectedIsVendorCredit && !editing ? (
                      <RecordSection label="Apply credit">
                        {creditWorkspace ? (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">
                                Available
                              </span>
                              <span className="font-mono font-medium tabular-nums">
                                {formatMoneyFromCents(
                                  creditWorkspace.availableCents,
                                )}
                              </span>
                            </div>
                            {!creditWorkspace.approved ? (
                              <p className="border border-warning/30 bg-warning/10 p-3 text-xs text-muted-foreground">
                                Approve this vendor credit before applying it.
                              </p>
                            ) : null}
                            {creditWorkspace.approved &&
                            creditWorkspace.availableCents > 0 ? (
                              <>
                                <Select
                                  value={creditTargetBillId}
                                  onValueChange={(value) => {
                                    const bill = creditWorkspace.bills.find(
                                      (item) => item.id === value,
                                    );
                                    setCreditTargetBillId(value);
                                    setCreditAmount(
                                      bill
                                        ? (
                                            Math.min(
                                              bill.balanceCents,
                                              creditWorkspace.availableCents,
                                            ) / 100
                                          ).toFixed(2)
                                        : "",
                                    );
                                  }}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Choose an open bill" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {creditWorkspace.bills.map((bill) => (
                                      <SelectItem key={bill.id} value={bill.id}>
                                        {bill.projectName} ·{" "}
                                        {bill.billNumber || bill.label} ·{" "}
                                        {formatMoneyFromCents(
                                          bill.balanceCents,
                                        )}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <div className="flex gap-2">
                                  <Input
                                    value={creditAmount}
                                    onChange={(event) =>
                                      setCreditAmount(event.target.value)
                                    }
                                    inputMode="decimal"
                                    placeholder="Amount"
                                  />
                                  <Button
                                    disabled={isPending || !creditTargetBill}
                                    onClick={() => {
                                      if (!creditTargetBill) return;
                                      const amountCents = Math.round(
                                        Number(creditAmount) * 100,
                                      );
                                      if (
                                        !Number.isInteger(amountCents) ||
                                        amountCents <= 0 ||
                                        amountCents >
                                          creditTargetBill.balanceCents ||
                                        amountCents >
                                          creditWorkspace.availableCents
                                      ) {
                                        toast.error(
                                          "Enter an amount within the available credit and bill balance",
                                        );
                                        return;
                                      }
                                      startTransition(async () => {
                                        const result =
                                          await applyVendorCreditAction({
                                            creditBillId: selectedBill.id,
                                            billId: creditTargetBill.id,
                                            amountCents,
                                            idempotencyKey: crypto.randomUUID(),
                                          });
                                        if (!result.success) {
                                          toast.error(result.error);
                                          return;
                                        }
                                        toast.success("Vendor credit applied");
                                        setCreditTargetBillId("");
                                        setCreditAmount("");
                                        const refreshed =
                                          await getVendorCreditApplicationWorkspaceAction(
                                            selectedBill.id,
                                          );
                                        if (refreshed.success)
                                          setCreditWorkspace(refreshed.data);
                                        onChanged();
                                      });
                                    }}
                                  >
                                    Apply
                                  </Button>
                                </div>
                              </>
                            ) : creditWorkspace.bills.length === 0 &&
                              creditWorkspace.availableCents > 0 ? (
                              <p className="text-xs text-muted-foreground">
                                No approved open bills for this vendor.
                              </p>
                            ) : null}
                            {creditWorkspace.applications.length > 0 ? (
                              <p className="text-xs text-muted-foreground">
                                Applied{" "}
                                {formatMoneyFromCents(
                                  creditWorkspace.appliedCents,
                                )}{" "}
                                across {creditWorkspace.applications.length}{" "}
                                bill
                                {creditWorkspace.applications.length === 1
                                  ? ""
                                  : "s"}
                                .
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Loading available bills…
                          </p>
                        )}
                      </RecordSection>
                    ) : null}
                  </div>
                ) : null}
                {recordTab === "accounting" ? (
                  <div
                    role="tabpanel"
                    id="payable-panel-accounting"
                    aria-labelledby="payable-tab-accounting"
                  >
                    <FinancialRecordAccounting
                      defaultOpen
                      type="vendor_bill"
                      id={selectedBill.id}
                      version={selectedBill.updated_at}
                    />
                  </div>
                ) : null}

                {recordTab === "activity" ? (
                  <div
                    role="tabpanel"
                    id="payable-panel-activity"
                    aria-labelledby="payable-tab-activity"
                  >
                    <RecordSection label="Bill history">
                      {auditLoading ? (
                        <p
                          role="status"
                          className="mb-4 text-sm text-muted-foreground"
                        >
                          Loading history…
                        </p>
                      ) : null}
                      {auditError ? (
                        <p
                          role="alert"
                          className="mb-4 text-sm text-destructive"
                        >
                          History could not be loaded. Reopen Activity to retry.
                        </p>
                      ) : null}
                      <PayableTimeline
                        bill={selectedBill}
                        runMembership={runMembership}
                        accountingEnabled={accountingSyncEnabled}
                        accountingProvider={accountingProvider}
                        accountingProviderName={accountingProviderName}
                        billSync={
                          accountingSyncByBillId[selectedBill.id] ?? null
                        }
                        paymentSync={
                          paymentSyncByBillId[selectedBill.id] ?? null
                        }
                        auditTrail={auditTrail}
                      />
                    </RecordSection>
                  </div>
                ) : null}

                {recordTab === "accounting" && accountingSyncEnabled ? (
                  <RecordSection label={providerName}>
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="microlabel">Bill</span>
                          <AccountingSyncBadge
                            status={effectiveSyncStatus ?? "not_synced"}
                            error={effectiveSyncError}
                            externalId={effectiveExternalId}
                            provider={accountingProvider}
                            providerLabel={accountingProviderName}
                          />
                          <span className="microlabel">Bill payment</span>
                          <AccountingSyncBadge
                            status={
                              paymentSyncByBillId[selectedBill.id]?.status ??
                              "not_synced"
                            }
                            error={paymentSyncByBillId[selectedBill.id]?.error}
                            externalId={
                              paymentSyncByBillId[selectedBill.id]?.externalId
                            }
                            provider={
                              paymentSyncByBillId[selectedBill.id]?.provider ??
                              accountingProvider
                            }
                            providerLabel={accountingProviderName}
                            syncedAt={
                              paymentSyncByBillId[selectedBill.id]?.syncedAt
                            }
                          />
                        </div>
                        <div className="flex items-center gap-4">
                          {effectiveExternalId &&
                          accountingProvider === "qbo" ? (
                            <a
                              href={
                                qboTxnUrl(
                                  selectedIsVendorCredit
                                    ? "vendorcredit"
                                    : "bill",
                                  effectiveExternalId,
                                ) ?? undefined
                              }
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              Open in {providerName}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : null}
                          {!selectedIsReassignablePayable ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground"
                              disabled={
                                isPending || effectiveSyncStatus === "synced"
                              }
                              onClick={syncToAccounting}
                            >
                              Sync now
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {effectiveSyncStatus === "error" && effectiveSyncError ? (
                        <p className="text-xs font-medium text-destructive">
                          {effectiveSyncError}
                        </p>
                      ) : null}
                      {!selectedBill.qbo_vendor_id ? (
                        <p className="text-xs text-muted-foreground">
                          No {providerName} vendor is linked to{" "}
                          {vendorLabel(selectedBill)} yet. Link or create one
                          from the vendor record before syncing.
                        </p>
                      ) : null}
                    </div>
                  </RecordSection>
                ) : null}
              </div>
            </div>
          </div>
          {editing && !payViewOpen ? (
            <div className="shrink-0 border-t border-border/60 bg-background px-5 py-4 sm:px-10">
              <div className="mx-auto flex max-w-[720px] items-center justify-between gap-4">
                <span role="status" className="text-sm text-muted-foreground">
                  {!canEdit
                    ? "This bill can no longer be edited."
                    : isDirty
                      ? "Unsaved changes"
                      : "Editing bill"}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    className="rounded-lg"
                    disabled={isPending}
                    onClick={() => {
                      setForm(baseline);
                      setPendingVendor(null);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="rounded-lg"
                    disabled={isPending || !isDirty || !canEdit}
                    onClick={saveDetails}
                  >
                    {isPending ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <div
            className={cn("min-h-0 flex-1", !payViewOpen && "hidden")}
            inert={!payViewOpen}
          >
            {sidePane === "review" ? (
              <PayableReviewView
                bill={selectedBill}
                open={sidePane === "review"}
                holds={evaluation}
                onClose={() => setSidePane(null)}
                onDecided={onChanged}
              />
            ) : (
              <PayablePayView
                bill={selectedBill}
                open={sidePane === "pay"}
                balanceCents={balanceCents}
                onClose={() => setSidePane(null)}
                onSubmitted={onChanged}
              />
            )}
          </div>
        </div>
      </PayableDetailShell>

      <Sheet open={vendorEditorOpen} onOpenChange={setVendorEditorOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col p-0 sm:max-w-xl"
        >
          <SheetHeader className="border-b bg-muted/30 px-6 py-5">
            <SheetTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              Vendor details
            </SheetTitle>
            <SheetDescription>
              Update the Arc vendor profile and its accounting vendor link.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {vendorEditorLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Loading vendor...
              </div>
            ) : vendorEditorCompany ? (
              <CompanyForm
                company={vendorEditorCompany}
                onSubmitted={() => {
                  setVendorEditorOpen(false);
                  onChanged();
                }}
                onCancel={() => setVendorEditorOpen(false)}
              />
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">
                This payable is not linked to an Arc vendor yet.
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Reassign {selectedIsVendorCredit ? "vendor credit" : "bill"}
            </DialogTitle>
            <DialogDescription>
              Move this whole {selectedIsVendorCredit ? "credit" : "bill"} to
              another project. To split it across projects instead, change the
              projects on its lines.
            </DialogDescription>
          </DialogHeader>
          <Select
            value={reassignProjectId}
            onValueChange={setReassignProjectId}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                isPending ||
                reassignBlockedBySplit ||
                !reassignProjectId ||
                reassignProjectId === selectedBill.project_id
              }
              onClick={reassignPayable}
            >
              {isPending ? "Moving..." : "Reassign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The edits in this payable have not been saved. Discard them and
              leave this bill?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Where the coding came from, so an approver knows how hard to look. Quiet text
 * for a confident machine, warning tone only when the confidence is low; a
 * human-coded bill says nothing at all.
 */
function CodingProvenance({ bill }: { bill: VendorBillSummary }) {
  const source = bill.coding_source;
  const raw = bill.coding_confidence;
  const percent =
    typeof raw === "number" ? Math.round(raw <= 1 ? raw * 100 : raw) : null;
  const low = percent !== null && percent < 50;
  const parts: string[] = [];
  if (source === "ai") {
    parts.push(
      `Coded by AI${percent !== null ? ` · ${percent}% confidence` : ""}${low ? " — review the allocation" : ""}`,
    );
  } else if (source === "rule" || source === "learned") {
    parts.push(
      `Coded from a learned rule${percent !== null ? ` · ${percent}% confidence` : ""}`,
    );
  }
  // Where the numbers came from matters as much as where the codes did: a
  // low-confidence scan is the approver's cue to check the document pane.
  if (bill.extraction_confidence)
    parts.push(`Scanned with ${bill.extraction_confidence} confidence`);
  if (parts.length === 0) return null;
  const lowExtraction = bill.extraction_confidence === "low";
  return (
    <p
      className={cn(
        "mb-2 text-xs",
        low || lowExtraction
          ? "font-medium text-warning"
          : "text-muted-foreground",
      )}
    >
      {parts.join(" · ")}
    </p>
  );
}

/**
 * What the invoice's lines bill against the commitment. Advisory evidence, so
 * it states the exceptions and stays quiet when everything reconciles — an
 * approver should only have to read this when there is something to read.
 */
function LineMatchEvidence({ bill }: { bill: VendorBillSummary }) {
  const assessment = bill.line_match;
  if (!assessment) return null;
  const { rollup } = assessment;
  const exceptions = assessment.lines.filter(
    (line) => line.matchKind === "unmatched" || line.overCommitmentLine,
  );
  const remainingCents = Math.max(
    0,
    rollup.revisedCommitmentCents - rollup.projectedTotalCents,
  );
  const hasProblem = exceptions.length > 0 || rollup.overCommitmentCents > 0;

  return (
    <div className="mb-2 space-y-1 text-xs">
      <p
        className={cn(
          hasProblem ? "font-medium text-warning" : "text-muted-foreground",
        )}
      >
        {rollup.overCommitmentCents > 0
          ? `Bills ${formatLineMatchCents(rollup.projectedTotalCents)} against a ${formatLineMatchCents(rollup.revisedCommitmentCents)} commitment — ${formatLineMatchCents(rollup.overCommitmentCents)} over`
          : `Bills ${formatLineMatchCents(rollup.projectedTotalCents)} of ${formatLineMatchCents(rollup.revisedCommitmentCents)} committed — ${formatLineMatchCents(remainingCents)} remaining`}
      </p>
      {exceptions.map((line, index) => (
        <p
          key={`${line.commitmentLineId ?? "unmatched"}-${index}`}
          className="text-muted-foreground"
        >
          <span className="text-foreground">
            {line.invoiceLine.description}
          </span>
          {line.commitmentLineNumber
            ? ` · line ${line.commitmentLineNumber}`
            : " · no matching commitment line"}
          {line.note ? ` — ${line.note}` : ""}
        </p>
      ))}
      {assessment.notes.map((note) => (
        <p key={note} className="text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * What every other lot of this house plan was billed for the same trade.
 * Silent unless a cost code is genuinely out of line with its plan-mates, and
 * each claim carries its own arithmetic — the comparison basis and the sample
 * count — so an approver can check it rather than take it on faith. Paying more
 * than the plan usually does is worth a second look; paying less is not, so only
 * the former takes the warning tone.
 */
function EvenFlowPriceEvidence({
  assessment,
}: {
  assessment: EvenFlowPriceAssessment | null;
}) {
  if (!assessment || assessment.claims.length === 0) return null;
  return (
    <div className="mb-2 space-y-1 text-xs">
      {assessment.claims.map((claim) => (
        <p
          key={claim.costCodeId}
          className={cn(
            claim.direction === "above"
              ? "font-medium text-warning"
              : "text-muted-foreground",
          )}
        >
          {claim.claim}
        </p>
      ))}
    </div>
  );
}

/**
 * Whether the work this invoice bills for has reached the calendar. Checked
 * only where a schedule item carries the bill's own cost code, and quiet unless
 * the bill lands well ahead of the trade's scheduled start.
 */
function ScheduleCrosscheckEvidence({
  assessment,
}: {
  assessment: BillScheduleAssessment | null;
}) {
  if (!assessment || assessment.findings.length === 0) return null;
  return (
    <div className="mb-2 space-y-1 text-xs">
      {assessment.findings.map((finding) => (
        <p key={finding.scheduleItemId} className="font-medium text-warning">
          {finding.claim}
        </p>
      ))}
    </div>
  );
}

function formatLineMatchCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function mapAttachment(link: FileLinkWithFile): AttachedFile {
  return {
    id: link.file.id,
    linkId: link.id,
    file_name: link.file.file_name,
    mime_type: link.file.mime_type,
    size_bytes: link.file.size_bytes,
    download_url: link.file.download_url,
    thumbnail_url: link.file.thumbnail_url,
    created_at: link.created_at,
    link_role: link.link_role,
  };
}

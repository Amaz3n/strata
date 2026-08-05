"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Layers,
  MoreHorizontal,
  Pencil,
  Receipt,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { type AttachedFile } from "@/components/files"
import { CompanyForm } from "@/components/companies/company-form"
import { WorkspaceShell } from "@/components/financials/workspace/workspace-shell"
import { WorkspaceListPanel } from "@/components/financials/workspace/workspace-list-panel"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import { getCompanyAction } from "@/app/(app)/companies/actions"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions"
import {
  ensureProjectVendorCompanyForPayableAction,
  reassignProjectPayableAction,
  syncProjectVendorBillToAccountingAction,
  updateProjectVendorBillStatusAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import { qboTxnUrl } from "@/lib/integrations/accounting/qbo/links"
import type { FileLinkWithFile } from "@/lib/services/file-links"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { AccountingSyncState } from "@/lib/services/accounting-sync-state"
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import type { PayableRunMembership } from "@/lib/services/org-payables"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"
import {
  getPayableSyncBlockReason,
  isVendorCredit,
  payableHeldRetainageCents,
  payableOutstandingCents,
} from "@/lib/financials/payables-rules"
import type { BudgetLineOption, Company, CostCode } from "@/lib/types"
import {
  filterPayables,
  payableQueueCounts,
  type PayableQueue,
} from "./payables-filters"
import { PayableDocumentPane } from "./payable-document-pane"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import { dueDateClassName, getDueState, vendorLabel } from "./payables-ui"
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
} from "./workspace/payable-form"
import { PayableHoldsPanel } from "./workspace/payable-holds"
import { PayablePayView } from "./workspace/payable-pay-view"
import { PayableReviewView } from "./workspace/payable-review-view"
import { PayableTimeline } from "./workspace/payable-timeline"
import { PayableVendorCard } from "./workspace/payable-vendor-card"
import {
  PayableLinesEditor,
  supportsBillableCosts,
  type ProjectOption,
} from "./workspace/payable-lines-editor"

import { unwrapAction } from "@/lib/action-result"

type QBOAccountOption = {
  id: string
  name: string
  fullyQualifiedName?: string
}

interface PayablesWorkspaceProps {
  /**
   * The project the workspace was opened from. Omitted on the org-wide payables
   * desk, where each payable answers to its own project instead.
   */
  projectId?: string
  bills: VendorBillSummary[]
  selectedBillId: string | null
  onSelectBill: (billId: string | null) => void
  costCodes: CostCode[]
  budgetLines?: BudgetLineOption[]
  costCodesEnabled: boolean
  projects: ProjectOption[]
  accountingEnabled: boolean
  accountingProvider?: string | null
  accountingProviderName?: string | null
  accountingSyncByBillId?: Record<string, AccountingSyncState>
  qboExpenseAccounts: QBOAccountOption[]
  qboApAccounts: QBOAccountOption[]
  qboDefaults: { expenseAccountId?: string; apAccountId?: string }
  onChanged: () => void
  /** Server hold evaluations by bill id — the release gate's own verdict. */
  holdEvaluations?: Record<string, PaymentHoldEvaluation>
  /** Whether this org has the electronic payment rail configured. */
  railOpen?: boolean
  paymentReadinessByCompanyId?: Record<string, CompanyPaymentReadinessStatus>
  runMembershipByBillId?: Record<string, PayableRunMembership>
  /** Whether the viewer is designated to approve payment runs in this org. */
  viewerMayApproveRuns?: boolean
}

const STAGE_BADGES: Record<PayableStage, { label: string; className: string }> =
  {
    credit: {
      label: "Credit",
      className: "border-border text-muted-foreground",
    },
    review: {
      label: "Needs approval",
      className: "border-warning/25 bg-warning/10 text-warning",
    },
    in_run: {
      label: "In payment run",
      className: "border-primary/25 bg-primary/10 text-primary",
    },
    payable: {
      label: "Approved",
      className: "border-border bg-accent text-accent-foreground",
    },
    paid: {
      label: "Paid",
      className: "border-success/25 bg-success/10 text-success",
    },
  }

export function PayablesWorkspace({
  projectId,
  bills,
  selectedBillId,
  onSelectBill,
  costCodes,
  budgetLines = [],
  costCodesEnabled,
  projects,
  accountingEnabled,
  accountingProvider = null,
  accountingProviderName = "accounting",
  accountingSyncByBillId = {},
  qboExpenseAccounts,
  qboApAccounts,
  qboDefaults,
  holdEvaluations = {},
  railOpen = false,
  paymentReadinessByCompanyId = {},
  runMembershipByBillId = {},
  viewerMayApproveRuns = false,
  onChanged,
}: PayablesWorkspaceProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [search, setSearch] = useState("")
  const [queueFilter, setQueueFilter] = useState<PayableQueue>("all")

  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [vendorEditorOpen, setVendorEditorOpen] = useState(false)
  const [vendorEditorCompanyId, setVendorEditorCompanyId] = useState<
    string | null
  >(null)
  const [vendorEditorCompany, setVendorEditorCompany] = useState<
    (Company & { contacts?: unknown[] }) | null
  >(null)
  const [vendorEditorLoading, setVendorEditorLoading] = useState(false)

  const [reassignOpen, setReassignOpen] = useState(false)
  const [reassignProjectId, setReassignProjectId] = useState("")

  /** Which secondary pane the slider is showing, if any. */
  const [sidePane, setSidePane] = useState<"pay" | "review" | null>(null)
  const payViewOpen = sidePane !== null
  const [paymentFormOpen, setPaymentFormOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("check")
  const [paymentRef, setPaymentRef] = useState("")
  const [paymentDate, setPaymentDate] = useState(() =>
    format(new Date(), "yyyy-MM-dd"),
  )

  /** Post-approval bills open read-only; editing is an explicit decision. */
  const [amending, setAmending] = useState(false)

  // Overrides recorded from this workspace refresh the evaluation immediately,
  // without waiting for the parent surface to reload its hold map.
  const [localHolds, setLocalHolds] = useState<
    Record<string, PaymentHoldEvaluation>
  >({})

  // Bills we've just synced locally. The server marks a bill "pending" on approve and relies
  // on an async worker to flip it to "synced", so the badge can lag behind a manual sync that
  // already succeeded. We optimistically show "synced" until the refreshed data catches up.
  const [optimisticSyncedBillIds, setOptimisticSyncedBillIds] = useState<
    Set<string>
  >(new Set())
  const clearOptimisticSync = (billId: string) =>
    setOptimisticSyncedBillIds((prev) => {
      if (!prev.has(billId)) return prev
      const next = new Set(prev)
      next.delete(billId)
      return next
    })

  const [discardOpen, setDiscardOpen] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<
    string | null | undefined
  >(undefined)
  const approveShortcutRef = useRef<(() => void) | null>(null)

  const selectedBill = useMemo(
    () => bills.find((bill) => bill.id === selectedBillId) ?? null,
    [bills, selectedBillId],
  )
  // Mutations are keyed by bill; the project only decides which pages get revalidated.
  // Org-wide there is no page project, so the payable's own project stands in.
  const contextProjectId = projectId ?? selectedBill?.project_id ?? ""
  const selectedIsVendorCredit = selectedBill
    ? isVendorCredit(selectedBill)
    : false
  // Payables imported from QuickBooks (credits or regular bills) can be split
  // across projects at the line level, while Reassign moves the whole payable.
  const selectedIsReassignablePayable = selectedBill
    ? selectedIsVendorCredit || selectedBill.imported_from_qbo === true
    : false

  const runMembership = selectedBill
    ? runMembershipByBillId[selectedBill.id]
    : undefined
  const stage: PayableStage = selectedBill
    ? payableStage(selectedBill, runMembership)
    : "review"
  const evaluation = selectedBill
    ? (localHolds[selectedBill.id] ?? holdEvaluations[selectedBill.id])
    : undefined
  const blocked = (evaluation?.blockingCount ?? 0) > 0
  const readiness = selectedBill?.company_id
    ? paymentReadinessByCompanyId[selectedBill.company_id]
    : undefined
  const canPayElectronically =
    railOpen && readiness === "ready" && !selectedIsVendorCredit

  const filtered = useMemo(
    () =>
      filterPayables(bills, { search, queue: queueFilter, costCodesEnabled }),
    [bills, search, queueFilter, costCodesEnabled],
  )
  const counts = useMemo(
    () => payableQueueCounts(bills, costCodesEnabled),
    [bills, costCodesEnabled],
  )

  const sortedCostCodes = useMemo(
    () => (costCodesEnabled ? sortCostCodes(costCodes) : []),
    [costCodes, costCodesEnabled],
  )
  const defaultBillable = useCallback(
    (lineProjectId?: string | null) =>
      !selectedIsVendorCredit &&
      supportsBillableCosts(
        projects.find((project) => project.id === lineProjectId)?.billingModel,
      ),
    [projects, selectedIsVendorCredit],
  )
  const getExpenseAccountName = (id?: string) =>
    qboExpenseAccounts.find((account) => account.id === id)?.name
  const getApAccountName = (id?: string) =>
    qboApAccounts.find((account) => account.id === id)?.name

  const baseline = useMemo(
    () =>
      selectedBill
        ? toFormState(selectedBill, {
            costCodesEnabled,
            qboDefaults,
            defaultBillable,
          })
        : null,
    [selectedBill, costCodesEnabled, qboDefaults, defaultBillable],
  )
  const [form, setForm] = useState<PayableFormState | null>(null)

  // Fields stay editable while the payable is still being reviewed; after
  // approval the record is locked and reopened only by an explicit Amend.
  const editable =
    Boolean(form) &&
    (stage === "review" ||
      stage === "credit" ||
      (stage === "payable" && amending))

  const isDirty = Boolean(form && baseline && formIsDirty(form, baseline))

  const requestSelectBill = useCallback(
    (billId: string | null) => {
      if (isDirty) {
        setPendingSelection(billId)
        setDiscardOpen(true)
        return
      }
      onSelectBill(billId)
    },
    [isDirty, onSelectBill],
  )

  const confirmDiscard = () => {
    const next = pendingSelection === undefined ? null : pendingSelection
    setDiscardOpen(false)
    setPendingSelection(undefined)
    onSelectBill(next)
  }

  // Keyboard triage: j/k move through the rail, a approves pending bills.
  // (Escape-to-close is owned by WorkspaceShell.)
  useEffect(() => {
    if (!selectedBill) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName?.toLowerCase()
      const isTextEntry =
        tagName === "input" ||
        tagName === "textarea" ||
        target?.getAttribute("role") === "combobox"
      if (isTextEntry || event.metaKey || event.ctrlKey || event.altKey) return
      // No triage shortcuts mid-payment — the pay pane owns the keyboard.
      if (payViewOpenRef.current) return
      if (event.key === "j" || event.key === "k") {
        const index = filtered.findIndex((bill) => bill.id === selectedBill.id)
        const next =
          event.key === "j" ? filtered[index + 1] : filtered[index - 1]
        if (next) requestSelectBill(next.id)
      }
      if (
        event.key.toLowerCase() === "a" &&
        billStatus(selectedBill) === "pending" &&
        !selectedIsVendorCredit
      ) {
        approveShortcutRef.current?.()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [filtered, requestSelectBill, selectedBill, selectedIsVendorCredit])

  const payViewOpenRef = useRef(payViewOpen)
  payViewOpenRef.current = payViewOpen

  // Reset the workspace whenever the selected bill (or its baseline) changes.
  useEffect(() => {
    setForm(baseline)
    setAmending(false)
    setSidePane(null)
    setPaymentFormOpen(false)
    setPaymentAmount("")
    setPaymentMethod(selectedBill?.payment_method ?? "check")
    setPaymentRef(selectedBill?.payment_reference ?? "")
    setPaymentDate(format(new Date(), "yyyy-MM-dd"))
    setReassignProjectId(selectedBill?.project_id ?? "")
  }, [baseline, selectedBill])

  // Load attachments for the selected bill.
  useEffect(() => {
    if (!selectedBill) {
      setAttachments([])
      return
    }
    let cancelled = false
    setAttachmentsLoading(true)
    listAttachmentsAction("vendor_bill", selectedBill.id)
      .then((links) => {
        if (cancelled) return
        setAttachments(links.map(mapAttachment))
      })
      .catch((error) =>
        console.error("Failed to load vendor bill attachments", error),
      )
      .finally(() => {
        if (!cancelled) setAttachmentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedBill])

  useEffect(() => {
    const companyId = selectedBill?.company_id ?? vendorEditorCompanyId
    if (!vendorEditorOpen || !companyId) {
      if (!vendorEditorOpen) {
        setVendorEditorCompany(null)
        setVendorEditorCompanyId(null)
      }
      return
    }
    let cancelled = false
    setVendorEditorLoading(true)
    getCompanyAction(companyId)
      .then((result) => {
        if (!cancelled) setVendorEditorCompany(result.company)
      })
      .catch((error) => toast.error((error as Error).message))
      .finally(() => {
        if (!cancelled) setVendorEditorLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedBill?.company_id, vendorEditorCompanyId, vendorEditorOpen])

  if (!selectedBill || !form) return null

  const effectiveSyncStatus =
    optimisticSyncedBillIds.has(selectedBill.id) &&
    selectedBill.qbo_sync_status !== "error"
      ? "synced"
      : accountingSyncByBillId[selectedBill.id]?.status ?? selectedBill.qbo_sync_status
  const effectiveSyncError = accountingSyncByBillId[selectedBill.id]?.error ?? selectedBill.qbo_sync_error
  const effectiveExternalId = accountingSyncByBillId[selectedBill.id]?.externalId ?? selectedBill.qbo_id

  const refreshAttachments = async () => {
    const links = await listAttachmentsAction("vendor_bill", selectedBill.id)
    setAttachments(links.map(mapAttachment))
  }

  const handleAttach = async (files: File[], linkRole?: string) => {
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", contextProjectId)
      formData.append("category", "financials")
      const uploaded = unwrapAction(await uploadFileAction(formData))
      unwrapAction(
        await attachFileAction(
          uploaded.id,
          "vendor_bill",
          selectedBill.id,
          contextProjectId,
          linkRole,
        ),
      )
    }
    await refreshAttachments()
  }

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId))
    await refreshAttachments()
  }

  const billTotalCents = selectedBill.total_cents ?? 0
  const balanceCents = payableOutstandingCents(selectedBill)
  const heldRetainageCents = payableHeldRetainageCents(selectedBill)
  const distinctSplitProjects = Array.from(
    new Set(form.splitLines.map((line) => line.projectId).filter(Boolean)),
  )
  const reassignBlockedBySplit =
    selectedIsReassignablePayable && distinctSplitProjects.length > 1

  const currentStatus = billStatus(selectedBill)

  const handleSelectCompany = (company: Company) => {
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      try {
        const result = unwrapAction(
          await updateProjectVendorBillStatusAction(
            contextProjectId,
            selectedBill.id,
            {
              status: currentStatus,
              expected_updated_at: selectedBill.updated_at,
              company_id: company.id,
            },
          ),
        )
        if (!result.success) {
          toast.error(result.error)
          return
        }
        toast.success("Vendor updated")
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const setStatus = (status: "approved" | "partial" | "paid") => {
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      try {
        const amountCents = paymentAmount.trim()
          ? (parseDollarsToCents(paymentAmount) ?? undefined)
          : undefined
        const isPayment = status === "paid" || status === "partial"
        const result = unwrapAction(
          await updateProjectVendorBillStatusAction(
            contextProjectId,
            selectedBill.id,
            {
              status,
              expected_updated_at: selectedBill.updated_at,
              qbo_expense_account_id:
                form.qboExpenseAccountId || qboDefaults.expenseAccountId,
              qbo_expense_account_name: getExpenseAccountName(
                form.qboExpenseAccountId || qboDefaults.expenseAccountId,
              ),
              payment_method: isPayment ? paymentMethod : undefined,
              payment_reference: isPayment
                ? paymentRef || undefined
                : undefined,
              payment_date: isPayment ? paymentDate : undefined,
              payment_amount_cents:
                isPayment && amountCents ? amountCents : undefined,
            },
          ),
        )
        if (!result.success) {
          toast.error(result.error)
          return
        }
        toast.success(
          status === "approved" ? "Approved for payment" : "Payment recorded",
        )
        setPaymentFormOpen(false)
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  approveShortcutRef.current = () => {
    if (!blocked) setStatus("approved")
  }

  const saveDetails = () => {
    const retainagePercent = form.retainage.trim()
      ? Number(form.retainage)
      : undefined
    if (
      form.retainage.trim() &&
      (retainagePercent === undefined ||
        !Number.isFinite(retainagePercent) ||
        retainagePercent < 0)
    ) {
      toast.error("Invalid retainage percentage")
      return
    }
    const actualLines = form.splitLines.map((line) => ({
      project_id: line.projectId || selectedBill.project_id,
      cost_code_id: costCodesEnabled ? line.costCodeId || null : null,
      budget_line_id: costCodesEnabled ? null : line.budgetLineId || null,
      description: line.description.trim() || form.billNumber || "Vendor bill",
      amount_cents: parseDollarsToCents(line.amountDollars),
      billable_to_customer: line.billableToCustomer,
      qbo_expense_account_id:
        line.qboExpenseAccountId || form.qboExpenseAccountId || undefined,
      qbo_expense_account_name: getExpenseAccountName(
        line.qboExpenseAccountId || form.qboExpenseAccountId,
      ),
      qbo_ap_account_id:
        line.qboApAccountId || form.qboApAccountId || undefined,
      qbo_ap_account_name: getApAccountName(
        line.qboApAccountId || form.qboApAccountId,
      ),
    }))
    const hasInvalidLine = actualLines.some(
      (line) =>
        !line.project_id ||
        (costCodesEnabled && !line.cost_code_id) ||
        line.amount_cents == null ||
        (selectedIsVendorCredit
          ? line.amount_cents > 0
          : line.amount_cents < 0),
    )
    if (hasInvalidLine) {
      toast.error(
        costCodesEnabled
          ? "Each line needs a project, cost code, and amount."
          : "Each line needs a project and amount.",
      )
      return
    }
    const splitTotalCents = actualLines.reduce(
      (sum, line) => sum + (line.amount_cents ?? 0),
      0,
    )
    if (splitTotalCents !== billTotalCents) {
      toast.error(
        `Lines (${formatMoneyFromCents(splitTotalCents)}) must equal the bill total (${formatMoneyFromCents(billTotalCents)})`,
      )
      return
    }
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      try {
        const result = unwrapAction(
          await updateProjectVendorBillStatusAction(
            contextProjectId,
            selectedBill.id,
            {
              status: currentStatus,
              expected_updated_at: selectedBill.updated_at,
              bill_number: form.billNumber.trim() || undefined,
              bill_date: form.billDate || undefined,
              due_date: form.dueDate || null,
              actual_lines: actualLines.map((line) => ({
                ...line,
                amount_cents: line.amount_cents ?? 0,
              })),
              retainage_percent: retainagePercent,
              lien_waiver_status: normalizeLienWaiverStatus(form.lienWaiver),
              qbo_expense_account_id: form.qboExpenseAccountId || undefined,
              qbo_expense_account_name: getExpenseAccountName(
                form.qboExpenseAccountId,
              ),
              qbo_ap_account_id: form.qboApAccountId || undefined,
              qbo_ap_account_name: getApAccountName(form.qboApAccountId),
            },
          ),
        )
        if (!result.success) {
          toast.error(result.error)
          return
        }
        toast.success("Payable saved")
        setAmending(false)
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const releaseRetainage = () => {
    if (heldRetainageCents <= 0) return
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      const result = unwrapAction(
        await updateProjectVendorBillStatusAction(
          contextProjectId,
          selectedBill.id,
          {
            status: currentStatus,
            expected_updated_at: selectedBill.updated_at,
            retainage_percent: 0,
          },
        ),
      )
      if (result.success) {
        setForm((prev) => (prev ? { ...prev, retainage: "0" } : prev))
        toast.success("Retainage released")
        onChanged()
      } else {
        toast.error(result.error)
      }
    })
  }

  const reassignPayable = () => {
    if (
      !selectedIsReassignablePayable ||
      !reassignProjectId ||
      reassignProjectId === selectedBill.project_id
    )
      return
    if (reassignBlockedBySplit) {
      toast.error(
        "Reassign is only available when all line items are assigned to one project.",
      )
      return
    }
    startTransition(async () => {
      const result = unwrapAction(
        await reassignProjectPayableAction(
          contextProjectId,
          selectedBill.id,
          reassignProjectId,
        ),
      )
      if (result.success) {
        toast.success(
          selectedIsVendorCredit
            ? "Vendor credit reassigned"
            : "Bill reassigned",
        )
        setReassignOpen(false)
        // From a project workbench the payable has left the page it was opened from,
        // so follow it. Org-wide it is still on the desk — stay put and refresh.
        if (projectId)
          router.push(
            `/projects/${result.projectId}/financials/payables?bill=${selectedBill.id}`,
          )
        onChanged()
      } else {
        toast.error(result.error)
      }
    })
  }

  const syncToAccounting = () => {
    const reason = getPayableSyncBlockReason(selectedBill)
    if (reason) {
      toast.error(reason)
      if (!selectedBill.qbo_vendor_id) openVendorEditor()
      return
    }
    startTransition(async () => {
      unwrapAction(
        await syncProjectVendorBillToAccountingAction(
          contextProjectId,
          selectedBill.id,
        ),
      )
      setOptimisticSyncedBillIds((prev) => new Set(prev).add(selectedBill.id))
      toast.success(`Synced to ${accountingProviderName ?? "accounting"}`)
      onChanged()
    })
  }

  const openVendorEditor = () => {
    if (selectedBill.company_id) {
      setVendorEditorCompanyId(selectedBill.company_id)
      setVendorEditorOpen(true)
      return
    }
    startTransition(async () => {
      try {
        const company = unwrapAction(
          await ensureProjectVendorCompanyForPayableAction(
            contextProjectId,
            selectedBill.id,
          ),
        )
        setVendorEditorCompany(company)
        setVendorEditorCompanyId(company.id)
        setVendorEditorOpen(true)
        onChanged()
      } catch (error) {
        toast.error("This payable is not linked to an Arc vendor yet.", {
          description: (error as Error).message,
        })
      }
    })
  }

  const parseDate = (value?: string) => {
    if (!value) return undefined
    const parsed = new Date(`${value}T00:00:00`)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }

  const stageBadge =
    stage === "payable" && currentStatus === "partial"
      ? {
          label: "Partly paid",
          className: "border-primary/25 bg-primary/10 text-primary",
        }
      : STAGE_BADGES[stage]
  // The viewer is a designated approver, this run is pending, and they did not
  // prepare it — the one case where the workspace has an approval to offer.
  const awaitingViewerApproval = Boolean(
    runMembership &&
    viewerMayApproveRuns &&
    runMembership.runStatus === "pending_approval" &&
    !runMembership.preparedByViewer,
  )
  const showRecordPayment =
    !selectedIsVendorCredit &&
    (stage === "payable" || (currentStatus === "paid" && balanceCents > 0)) &&
    !runMembership

  const listPanel = (
    <WorkspaceListPanel<VendorBillSummary, PayableQueue>
      title="Payables"
      onBack={() => requestSelectBill(null)}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search vendor, bill..."
      queues={[
        { key: "all", label: "All", count: counts.all },
        { key: "overdue", label: "Late", count: counts.overdue },
        { key: "due_soon", label: "Soon", count: counts.due_soon },
        { key: "needs_review", label: "Review", count: counts.needs_review },
        { key: "payable", label: "Pay", count: counts.payable },
        { key: "paid", label: "Paid", count: counts.paid },
      ]}
      activeQueue={queueFilter}
      onQueueChange={setQueueFilter}
      items={filtered}
      getKey={(bill) => bill.id}
      isActive={(bill) => bill.id === selectedBill.id}
      onSelect={(bill) => requestSelectBill(bill.id)}
      emptyLabel="No payables match."
      renderRow={(bill) => {
        const rowHolds =
          (localHolds[bill.id] ?? holdEvaluations[bill.id])?.holds.filter(
            (hold) => !hold.overridden,
          ) ?? []
        const rowRun = runMembershipByBillId[bill.id]
        return (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">
                {vendorLabel(bill)}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {formatMoneyFromCents(
                  bill.project_amount_cents ?? bill.total_cents ?? 0,
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className={dueDateClassName(bill.due_date, bill.status)}>
                {bill.due_date
                  ? getDueState(bill.due_date, bill.status).label
                  : "No due date"}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {rowRun ? (
                  <span className="font-medium text-primary">In run</span>
                ) : null}
                {bill.is_shared ? (
                  <Layers className="h-3 w-3 shrink-0 text-primary" />
                ) : null}
              </span>
            </div>
            {rowHolds.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {rowHolds.slice(0, 2).map((hold) => (
                  <span
                    key={hold.kind}
                    className={cn(
                      "border px-1.5 py-0.5 text-[10px] font-medium",
                      hold.level === "block"
                        ? "border-destructive/30 bg-destructive/10 text-destructive"
                        : "border-warning/30 bg-warning/10 text-warning",
                    )}
                  >
                    {hold.kind.replaceAll("_", " ")}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )
      }}
    />
  )

  const documentPane = (
    <PayableDocumentPane
      attachments={attachments}
      loading={attachmentsLoading}
      onAttach={handleAttach}
      onDetach={handleDetach}
      projectId={contextProjectId}
    />
  )

  return (
    <>
      <WorkspaceShell
        open
        onClose={() =>
          payViewOpen ? setSidePane(null) : requestSelectBill(null)
        }
        listPanel={listPanel}
        documentPane={documentPane}
      >
        {/*
          The center pane is a two-view slider: the bill record, and the payment
          flow that slides in over it when Pay is pressed. Both stay mounted so
          in-progress form state survives peeking at the other view.
        */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "flex h-full w-[200%] transition-transform duration-300 ease-out motion-reduce:transition-none",
              payViewOpen && "-translate-x-1/2",
            )}
          >
            <div
              className="flex h-full w-1/2 min-w-0 flex-col"
              aria-hidden={payViewOpen}
              {...(payViewOpen ? { inert: true } : {})}
            >
              {/* ————— Header: what this is, and where it stands ————— */}
              <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4">
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 md:hidden"
                    onClick={() => requestSelectBill(null)}
                    title="Back"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <h2 className="min-w-0 truncate text-lg font-semibold leading-tight">
                    {selectedIsVendorCredit
                      ? selectedBill.bill_number
                        ? `Vendor credit ${selectedBill.bill_number}`
                        : "Vendor credit"
                      : selectedBill.bill_number
                        ? `Bill ${selectedBill.bill_number}`
                        : "Payable"}
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {accountingEnabled ? (
                    <AccountingSyncBadge
                      status={effectiveSyncStatus ?? "not_synced"}
                      error={selectedBill.qbo_sync_error}
                      externalId={selectedBill.qbo_id}
                    />
                  ) : null}
                  <Badge
                    variant="outline"
                    className={cn("font-normal", stageBadge.className)}
                  >
                    {stageBadge.label}
                  </Badge>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">More actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      {accountingEnabled && !selectedIsReassignablePayable ? (
                        <DropdownMenuItem
                          disabled={
                            isPending || effectiveSyncStatus === "synced"
                          }
                          onClick={syncToAccounting}
                        >
                          Sync to {accountingProviderName ?? "accounting"}
                        </DropdownMenuItem>
                      ) : null}
                      {selectedIsReassignablePayable ? (
                        <DropdownMenuItem
                          disabled={reassignBlockedBySplit}
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
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* ————— Money: the four numbers that matter ————— */}
                <div className="border-b px-4 py-4 sm:px-6">
                  {selectedIsVendorCredit ? (
                    <div className="flex flex-wrap items-end justify-between gap-4">
                      <div>
                        <p className="microlabel">Credit amount</p>
                        <p className="mt-1 font-mono text-2xl font-medium tabular-nums tracking-tight">
                          {formatMoneyFromCents(billTotalCents)}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Reduces project cost
                        {accountingEnabled ? ` · managed in ${accountingProviderName ?? "accounting"}` : ""}
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                      <div>
                        <p className="microlabel">Total</p>
                        <p className="mt-1 font-mono text-2xl font-medium tabular-nums tracking-tight">
                          {formatMoneyFromCents(billTotalCents)}
                        </p>
                      </div>
                      <div>
                        <p className="microlabel">Paid</p>
                        <p className="mt-1 font-mono text-lg font-medium tabular-nums text-success">
                          {formatMoneyFromCents(selectedBill.paid_cents ?? 0)}
                        </p>
                      </div>
                      <div>
                        <p className="microlabel">Retained</p>
                        <p className="mt-1 font-mono text-lg font-medium tabular-nums text-muted-foreground">
                          {formatMoneyFromCents(heldRetainageCents)}
                        </p>
                      </div>
                      <div>
                        <p className="microlabel">Balance</p>
                        <p
                          className={cn(
                            "mt-1 font-mono text-lg font-medium tabular-nums",
                            balanceCents > 0
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatMoneyFromCents(balanceCents)}
                        </p>
                      </div>
                    </div>
                  )}

                  {selectedBill.over_budget ? (
                    <div className="mt-3 border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                      This payable exceeds the linked commitment. Review the
                      contract balance before approval.
                    </div>
                  ) : null}
                </div>

                <div className="space-y-8 px-4 py-6 sm:px-6">
                  {/* ————— The one thing to do right now ————— */}
                  {stage === "review" ? (
                    <section className="space-y-3">
                      {evaluation ? (
                        <PayableHoldsPanel
                          billId={selectedBill.id}
                          evaluation={evaluation}
                          onOverridden={(next) =>
                            setLocalHolds((prev) => ({
                              ...prev,
                              [selectedBill.id]: next,
                            }))
                          }
                        />
                      ) : null}
                      <Button
                        className="group h-11 w-full justify-between"
                        disabled={isPending || blocked}
                        onClick={() =>
                          canPayElectronically
                            ? setSidePane("pay")
                            : setStatus("approved")
                        }
                      >
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4" />
                          {blocked
                            ? "Blocked by payment holds"
                            : canPayElectronically
                              ? `Submit for approval · ${formatMoneyFromCents(billTotalCents)}`
                              : `Approve for payment · ${formatMoneyFromCents(billTotalCents)}`}
                        </span>
                        {!blocked ? (
                          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                        ) : null}
                      </Button>
                      {canPayElectronically ? (
                        <p className="text-xs text-muted-foreground">
                          You&apos;ll choose the amount and the account it comes
                          from next; an approver releases it.
                        </p>
                      ) : null}
                    </section>
                  ) : null}

                  {stage === "in_run" && runMembership ? (
                    <section
                      className={cn(
                        "flex items-center justify-between gap-3 border p-4",
                        awaitingViewerApproval
                          ? "border-primary/30 bg-primary/5"
                          : "bg-card",
                      )}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {awaitingViewerApproval
                            ? "This payment is waiting for your approval"
                            : runMembership.preparedByViewer
                              ? "You submitted this payment"
                              : "This bill is in a payment run"}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {awaitingViewerApproval
                            ? `${formatMoneyFromCents(runMembership.totalDebitCents)} debit, ready for you to review and approve.`
                            : runMembership.preparedByViewer
                              ? "You cannot approve your own run — it is with your designated approvers now."
                              : `It cannot be edited or paid another way while the run is ${runMembership.runStatus.replaceAll("_", " ")}.`}
                        </p>
                      </div>
                      {awaitingViewerApproval ? (
                        <Button
                          size="sm"
                          className="shrink-0"
                          onClick={() => setSidePane("review")}
                        >
                          Review &amp; approve
                        </Button>
                      ) : (
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                        >
                          <a href="/payables/payment-runs">View run</a>
                        </Button>
                      )}
                    </section>
                  ) : null}

                  {showRecordPayment ? (
                    <section className="space-y-3">
                      {evaluation ? (
                        <PayableHoldsPanel
                          billId={selectedBill.id}
                          evaluation={evaluation}
                          onOverridden={(next) =>
                            setLocalHolds((prev) => ({
                              ...prev,
                              [selectedBill.id]: next,
                            }))
                          }
                        />
                      ) : null}
                      <div className="flex flex-col gap-2 sm:flex-row">
                        {canPayElectronically ? (
                          <Button
                            className="h-11 flex-1 justify-between"
                            disabled={blocked}
                            onClick={() => setSidePane("pay")}
                          >
                            <span className="flex items-center gap-2">
                              <Receipt className="h-4 w-4" />
                              {blocked
                                ? "Payment blocked by holds"
                                : `Pay ${formatMoneyFromCents(balanceCents)} by ACH`}
                            </span>
                            {!blocked ? (
                              <ArrowRight className="h-4 w-4" />
                            ) : null}
                          </Button>
                        ) : null}
                        <Button
                          variant={canPayElectronically ? "outline" : "default"}
                          className="h-11 flex-1"
                          disabled={blocked}
                          onClick={() => setPaymentFormOpen((open) => !open)}
                        >
                          {canPayElectronically
                            ? "Record external payment"
                            : blocked
                              ? "Payment blocked by holds"
                              : "Record payment"}
                        </Button>
                      </div>
                      {railOpen &&
                      !canPayElectronically &&
                      !selectedIsVendorCredit ? (
                        <p className="text-xs text-muted-foreground">
                          {readiness === "verifying"
                            ? "This vendor is verifying their bank account — ACH will be available once verification completes."
                            : "This vendor cannot be paid electronically yet. Invite them from the vendor card below."}
                        </p>
                      ) : null}

                      {paymentFormOpen ? (
                        <div className="space-y-4 border bg-card p-4">
                          <div className="microlabel">
                            Record a payment made outside Arc
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-1.5">
                              <Label className="microlabel">Amount</Label>
                              <div className="relative">
                                <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs text-muted-foreground">
                                  $
                                </span>
                                <Input
                                  className="h-10 pl-7 font-semibold"
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
                                <SelectTrigger className="h-10 w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="check">Check</SelectItem>
                                  <SelectItem value="ach">ACH</SelectItem>
                                  <SelectItem value="card">
                                    Credit card
                                  </SelectItem>
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
                                      "h-10 w-full justify-start text-left text-sm font-semibold",
                                      !paymentDate && "text-muted-foreground",
                                    )}
                                  >
                                    <CalendarDays className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate">
                                      {paymentDate && parseDate(paymentDate)
                                        ? format(parseDate(paymentDate)!, "PPP")
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
                              <Label className="microlabel">{paymentMethod === "check" ? "Check # / joint payees" : "Reference"}</Label>
                              <Input
                                className="h-10"
                                placeholder={paymentMethod === "check" ? "Check #; include every joint payee" : "Transaction ID"}
                                value={paymentRef}
                                onChange={(event) =>
                                  setPaymentRef(event.target.value)
                                }
                              />
                            </div>
                          </div>
                          <Button
                            className="h-10 w-full"
                            disabled={isPending || blocked}
                            onClick={() => setStatus("paid")}
                          >
                            {isPending ? "Recording…" : "Post payment"}
                          </Button>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  {/* ————— Evidence trail ————— */}
                  <PayableTimeline
                    bill={selectedBill}
                    runMembership={runMembership}
                    accountingEnabled={accountingEnabled}
                  />

                  {/* ————— Vendor ————— */}
                  <section className="border bg-card p-4">
                    <PayableVendorCard
                      bill={selectedBill}
                      accountingEnabled={accountingEnabled}
                      railOpen={railOpen}
                      readiness={readiness}
                      onSelectCompany={handleSelectCompany}
                      onEditVendor={openVendorEditor}
                      onInvited={onChanged}
                    />
                  </section>

                  {/* ————— Details: editable while under review, locked after ————— */}
                  <section className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="microlabel">
                        {selectedIsVendorCredit
                          ? "Credit details"
                          : "Bill details"}
                      </h3>
                      {stage === "payable" && !amending ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                          onClick={() => setAmending(true)}
                        >
                          <Pencil className="h-3 w-3" />
                          Amend
                        </Button>
                      ) : null}
                    </div>

                    {editable ? (
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-1.5">
                          <Label className="microlabel">
                            {selectedIsVendorCredit
                              ? "Credit #"
                              : "Invoice / bill #"}
                          </Label>
                          <Input
                            value={form.billNumber}
                            onChange={(event) =>
                              setForm((prev) =>
                                prev
                                  ? { ...prev, billNumber: event.target.value }
                                  : prev,
                              )
                            }
                            placeholder="e.g. INV-12345"
                            className="h-10 text-sm font-semibold"
                          />
                        </div>
                        <div className="flex flex-col space-y-1.5">
                          <Label className="microlabel">Invoice date</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "h-10 w-full justify-start text-left text-sm font-semibold",
                                  !form.billDate && "text-muted-foreground",
                                )}
                              >
                                <CalendarDays className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">
                                  {form.billDate && parseDate(form.billDate)
                                    ? format(parseDate(form.billDate)!, "PPP")
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
                                selected={parseDate(form.billDate)}
                                onSelect={(date) =>
                                  setForm((prev) =>
                                    prev
                                      ? {
                                          ...prev,
                                          billDate: date
                                            ? format(date, "yyyy-MM-dd")
                                            : "",
                                        }
                                      : prev,
                                  )
                                }
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                        <div className="flex flex-col space-y-1.5">
                          <Label className="microlabel">Due date</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "h-10 w-full justify-start text-left text-sm font-semibold",
                                  !form.dueDate && "text-muted-foreground",
                                )}
                              >
                                <CalendarDays className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">
                                  {form.dueDate && parseDate(form.dueDate)
                                    ? format(parseDate(form.dueDate)!, "PPP")
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
                                selected={parseDate(form.dueDate)}
                                onSelect={(date) =>
                                  setForm((prev) =>
                                    prev
                                      ? {
                                          ...prev,
                                          dueDate: date
                                            ? format(date, "yyyy-MM-dd")
                                            : "",
                                        }
                                      : prev,
                                  )
                                }
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                      </div>
                    ) : (
                      <div className="grid gap-4 border p-3 sm:grid-cols-3">
                        <div>
                          <p className="microlabel">
                            {selectedIsVendorCredit
                              ? "Credit #"
                              : "Invoice / bill #"}
                          </p>
                          <p className="mt-1 text-sm font-semibold">
                            {selectedBill.bill_number ?? "—"}
                          </p>
                        </div>
                        <div>
                          <p className="microlabel">Invoice date</p>
                          <p className="mt-1 text-sm tabular-nums">
                            {selectedBill.bill_date
                              ? format(
                                  parseDate(selectedBill.bill_date)!,
                                  "MMM d, yyyy",
                                )
                              : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="microlabel">Due date</p>
                          <p className="mt-1 text-sm tabular-nums">
                            {selectedBill.due_date
                              ? format(
                                  parseDate(selectedBill.due_date)!,
                                  "MMM d, yyyy",
                                )
                              : "—"}
                          </p>
                        </div>
                      </div>
                    )}
                  </section>

                  {/* ————— Shared-across-projects affordance ————— */}
                  {selectedBill.is_shared &&
                  selectedBill.shared_projects &&
                  selectedBill.shared_projects.length > 1 ? (
                    <div className="space-y-2 border bg-card p-4">
                      <div className="microlabel flex items-center gap-2">
                        <Layers className="h-3.5 w-3.5 text-primary" />
                        Shared across {selectedBill.shared_projects.length}{" "}
                        projects
                      </div>
                      <div className="space-y-1">
                        {selectedBill.shared_projects.map((share) => {
                          const isCurrent = share.id === contextProjectId
                          return (
                            <div
                              key={share.id}
                              className="flex items-center justify-between gap-2 text-sm"
                            >
                              <button
                                type="button"
                                disabled={isCurrent}
                                onClick={() =>
                                  router.push(
                                    `/projects/${share.id}/financials/payables?bill=${selectedBill.id}`,
                                  )
                                }
                                className={cn(
                                  "truncate text-left",
                                  isCurrent
                                    ? "font-semibold"
                                    : "text-primary hover:underline",
                                )}
                              >
                                {share.name ??
                                  projects.find(
                                    (project) => project.id === share.id,
                                  )?.name ??
                                  "Project"}
                                {isCurrent ? " (this project)" : ""}
                              </button>
                              <span className="shrink-0 tabular-nums">
                                {formatMoneyFromCents(share.amount_cents)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* ————— Allocation ————— */}
                  <PayableLinesEditor
                    lines={form.splitLines}
                    onLinesChange={(updater) =>
                      setForm((prev) =>
                        prev
                          ? { ...prev, splitLines: updater(prev.splitLines) }
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
                    qboExpenseAccounts={qboExpenseAccounts}
                    qboApAccounts={qboApAccounts}
                    billTotalCents={billTotalCents}
                    fallbackProjectId={selectedBill.project_id}
                    defaultDescription={form.billNumber || "Vendor bill"}
                    headerQboExpenseAccountId={form.qboExpenseAccountId}
                    headerQboApAccountId={form.qboApAccountId}
                    defaultBillable={defaultBillable}
                  />

                  {/* ————— Terms: retainage & waiver ————— */}
                  {!selectedIsVendorCredit ? (
                    <section className="space-y-4">
                      <h3 className="microlabel">Retention & waiver</h3>
                      <div className="grid grid-cols-2 gap-6">
                        <div className="space-y-1.5">
                          <Label className="microlabel">Retainage %</Label>
                          {editable ? (
                            <Input
                              type="number"
                              step="0.1"
                              value={form.retainage}
                              onChange={(event) =>
                                setForm((prev) =>
                                  prev
                                    ? { ...prev, retainage: event.target.value }
                                    : prev,
                                )
                              }
                              placeholder="0"
                              className="h-10 font-semibold"
                            />
                          ) : (
                            <p className="text-sm font-semibold tabular-nums">
                              {selectedBill.retainage_percent != null
                                ? `${selectedBill.retainage_percent}%`
                                : "—"}
                            </p>
                          )}
                          {heldRetainageCents > 0 ? (
                            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>
                                {formatMoneyFromCents(heldRetainageCents)} held
                              </span>
                              <Button
                                type="button"
                                variant="link"
                                className="h-auto p-0 text-xs"
                                disabled={isPending}
                                onClick={releaseRetainage}
                              >
                                Release
                              </Button>
                            </div>
                          ) : null}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="microlabel">Lien waiver</Label>
                          {editable ? (
                            <Select
                              value={form.lienWaiver}
                              onValueChange={(value) =>
                                setForm((prev) =>
                                  prev ? { ...prev, lienWaiver: value } : prev,
                                )
                              }
                            >
                              <SelectTrigger className="h-10 w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="not_required">
                                  Not required
                                </SelectItem>
                                <SelectItem value="requested">
                                  Requested
                                </SelectItem>
                                <SelectItem value="received">
                                  Received
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <p className="text-sm font-semibold capitalize">
                              {normalizeLienWaiverStatus(
                                selectedBill.lien_waiver_status,
                              ).replaceAll("_", " ")}
                            </p>
                          )}
                        </div>
                      </div>
                    </section>
                  ) : null}

                  {/* ————— Accounting: an outcome, not a workflow ————— */}
                  {accountingEnabled ? (
                    <section className="space-y-2 border-t pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="microlabel">{accountingProviderName ?? "Accounting"}</span>
                          <AccountingSyncBadge
                            status={effectiveSyncStatus ?? "not_synced"}
                            error={effectiveSyncError}
                            externalId={effectiveExternalId}
                          />
                        </div>
                        <div className="flex items-center gap-3">
                          {effectiveExternalId && accountingProvider === "qbo" ? (
                            <a
                              href={qboTxnUrl(isVendorCredit(selectedBill) ? "vendorcredit" : "bill", effectiveExternalId) ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                            >
                              Open in {accountingProviderName ?? "accounting"}{" "}
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
                        <p className="text-[11px] font-medium text-destructive">
                          {effectiveSyncError}
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              </div>

              {/* ————— Footer: document actions only ————— */}
              <div className="flex items-center justify-between gap-3 border-t bg-muted/10 px-4 py-3 sm:px-6">
                <span className="text-xs text-muted-foreground">
                  {isDirty ? "Unsaved changes" : ""}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => requestSelectBill(null)}
                  >
                    Close
                  </Button>
                  {editable ? (
                    <Button
                      disabled={isPending || !isDirty}
                      onClick={saveDetails}
                    >
                      {isPending ? "Saving..." : "Save changes"}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div
              className="h-full w-1/2 min-w-0"
              aria-hidden={!payViewOpen}
              {...(!payViewOpen ? { inert: true } : {})}
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
        </div>
      </WorkspaceShell>

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
                  setVendorEditorOpen(false)
                  onChanged()
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
  )
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
  }
}

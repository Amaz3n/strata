"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronsUpDown,
  ExternalLink,
  Layers,
  MoreHorizontal,
  Plus,
  Receipt,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { type AttachedFile } from "@/components/files"
import { CompanyForm } from "@/components/companies/company-form"
import { WorkspaceShell } from "@/components/financials/workspace/workspace-shell"
import { WorkspaceListPanel } from "@/components/financials/workspace/workspace-list-panel"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import { getCompanyAction, listCompaniesAction } from "@/app/(app)/companies/actions"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions"
import {
  ensureProjectVendorCompanyForPayableAction,
  reassignProjectPayableAction,
  syncProjectVendorBillToQBOAction,
  updateProjectVendorBillStatusAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import { qboTxnUrl } from "@/lib/integrations/accounting/qbo/links"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import {
  getPayableSyncBlockReason,
  isVendorCredit,
  payableHeldRetainageCents,
  payableOutstandingCents,
} from "@/lib/financials/payables-rules"
import type { BudgetLineOption, Company, ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import { filterPayables, payableQueueCounts, type PayableQueue } from "./payables-filters"
import { PayableDocumentPane } from "./payable-document-pane"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import { billBadge, dueDateClassName, getDueState, vendorLabel, vendorLinkBadge } from "./payables-ui"
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

import { unwrapAction } from "@/lib/action-result"

type QBOAccountOption = { id: string; name: string; fullyQualifiedName?: string }
type ProjectBillingModel = "fixed_price" | "cost_plus_percent" | "cost_plus_fixed_fee" | "cost_plus_gmp" | "time_and_materials"
type ProjectOption = { id: string; name: string; billingModel: ProjectBillingModel }

function supportsBillableCosts(billingModel?: ProjectBillingModel) {
  return Boolean(billingModel && billingModel !== "fixed_price")
}

interface PayablesWorkspaceProps {
  projectId: string
  bills: VendorBillSummary[]
  selectedBillId: string | null
  onSelectBill: (billId: string | null) => void
  costCodes: CostCode[]
  budgetLines?: BudgetLineOption[]
  costCodesEnabled: boolean
  projects: ProjectOption[]
  accountingEnabled: boolean
  qboExpenseAccounts: QBOAccountOption[]
  qboApAccounts: QBOAccountOption[]
  qboDefaults: { expenseAccountId?: string; apAccountId?: string }
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  onChanged: () => void
}

type SplitLine = {
  id: string
  projectId: string
  costCodeId: string
  budgetLineId: string
  description: string
  amountDollars: string
  qboExpenseAccountId?: string
  qboApAccountId?: string
  billableToCustomer: boolean
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
  qboExpenseAccounts,
  qboApAccounts,
  qboDefaults,
  complianceRules,
  complianceStatusByCompanyId,
  onChanged,
}: PayablesWorkspaceProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [search, setSearch] = useState("")
  const [queueFilter, setQueueFilter] = useState<PayableQueue>("all")

  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [vendorEditorOpen, setVendorEditorOpen] = useState(false)
  const [vendorEditorCompanyId, setVendorEditorCompanyId] = useState<string | null>(null)
  const [vendorEditorCompany, setVendorEditorCompany] = useState<(Company & { contacts?: any[] }) | null>(null)
  const [vendorEditorLoading, setVendorEditorLoading] = useState(false)

  const [companies, setCompanies] = useState<Company[]>([])
  const [loadingCompanies, setLoadingCompanies] = useState(false)
  const [isChangingVendor, setIsChangingVendor] = useState(false)
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false)
  const [searchVendor, setSearchVendor] = useState("")
  const [creditProjectId, setCreditProjectId] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoadingCompanies(true)
    listCompaniesAction()
      .then((rows) => {
        if (!cancelled) {
          setCompanies(
            rows.filter(
              (company) =>
                company.company_type === "subcontractor" ||
                company.company_type === "supplier" ||
                company.company_type === "other"
            )
          )
        }
      })
      .catch((error) => console.error("Failed to load vendors", error))
      .finally(() => {
        if (!cancelled) setLoadingCompanies(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const normalizeName = (value: string) => {
    return value.trim().replace(/\s+/g, " ").toLowerCase()
  }

  const visibleCompanies = useMemo(() => {
    return companies.filter(
      (company) =>
        !searchVendor.trim() ||
        normalizeName(company.name).includes(normalizeName(searchVendor))
    )
  }, [companies, searchVendor])

  const handleSelectCompany = (company: Company) => {
    if (!selectedBill) return
    setVendorPickerOpen(false)
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      try {
        const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
          status: selectedBill.status as any,
          expected_updated_at: selectedBill.updated_at,
          company_id: company.id,
        }))
        if (!result.success) {
          toast.error(result.error)
          return
        }
        toast.success("Vendor updated")
        setIsChangingVendor(false)
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("check")
  const [paymentRef, setPaymentRef] = useState("")
  const [paymentDate, setPaymentDate] = useState(format(new Date(), "yyyy-MM-dd"))
  const [retainage, setRetainage] = useState("")
  const [lienWaiver, setLienWaiver] = useState("not_required")
  const [qboExpenseAccountId, setQboExpenseAccountId] = useState("")
  const [qboApAccountId, setQboApAccountId] = useState("")
  const [splitLines, setSplitLines] = useState<SplitLine[]>([])

  // Bills we've just synced locally. The server marks a bill "pending" on approve and relies
  // on an async worker to flip it to "synced", so the badge can lag behind a manual sync that
  // already succeeded. We optimistically show "synced" until the refreshed data catches up, and
  // drop the flag whenever an edit re-marks the bill pending.
  const [optimisticSyncedBillIds, setOptimisticSyncedBillIds] = useState<Set<string>>(new Set())
  const clearOptimisticSync = (billId: string) =>
    setOptimisticSyncedBillIds((prev) => {
      if (!prev.has(billId)) return prev
      const next = new Set(prev)
      next.delete(billId)
      return next
    })

  const [billNumber, setBillNumber] = useState("")
  const [billDate, setBillDate] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [discardOpen, setDiscardOpen] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<string | null | undefined>(undefined)
  const approveShortcutRef = useRef<(() => void) | null>(null)

  const selectedBill = useMemo(
    () => bills.find((bill) => bill.id === selectedBillId) ?? null,
    [bills, selectedBillId],
  )
  const selectedIsVendorCredit = selectedBill ? isVendorCredit(selectedBill) : false
  // Payables imported from QuickBooks (credits or regular bills) can be split
  // across projects at the line level, while Reassign moves the whole payable.
  const selectedIsReassignablePayable = selectedBill
    ? selectedIsVendorCredit || selectedBill.imported_from_qbo === true
    : false

  const filtered = useMemo(
    () => filterPayables(bills, { search, queue: queueFilter, costCodesEnabled, accountingEnabled }),
    [accountingEnabled, bills, search, queueFilter, costCodesEnabled],
  )
  const counts = useMemo(
    () => payableQueueCounts(bills, costCodesEnabled, accountingEnabled),
    [accountingEnabled, bills, costCodesEnabled],
  )

  const sortedCostCodes = useMemo(
    () => (costCodesEnabled ? [...costCodes].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")) : []),
    [costCodes, costCodesEnabled],
  )
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? "Project"
  const defaultBillableToCustomer = useCallback(
    (lineProjectId?: string | null) =>
      !selectedIsVendorCredit && supportsBillableCosts(projects.find((project) => project.id === lineProjectId)?.billingModel),
    [projects, selectedIsVendorCredit],
  )
  const getExpenseAccountName = (id?: string) => qboExpenseAccounts.find((account) => account.id === id)?.name
  const getApAccountName = (id?: string) => qboApAccounts.find((account) => account.id === id)?.name

  const isDirty = useMemo(() => {
    if (!selectedBill) return false
    const currentLines = splitLines.map((line) => ({
      projectId: line.projectId,
      costCodeId: line.costCodeId,
      budgetLineId: line.budgetLineId,
      description: line.description,
      amountDollars: line.amountDollars,
      qboExpenseAccountId: line.qboExpenseAccountId ?? "",
      qboApAccountId: line.qboApAccountId ?? "",
      billableToCustomer: line.billableToCustomer,
    }))
    const baselineLines = (selectedBill.actual_lines && selectedBill.actual_lines.length > 0
      ? selectedBill.actual_lines.map((line) => ({
          projectId: line.project_id ?? selectedBill.project_id,
          costCodeId: line.cost_code_id ?? "",
          budgetLineId: line.budget_line_id ?? "",
          description: line.description ?? selectedBill.bill_number ?? "Vendor bill",
          amountDollars: ((line.amount_cents ?? 0) / 100).toFixed(2),
          qboExpenseAccountId: line.qbo_expense_account_id ?? selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
          qboApAccountId: line.qbo_ap_account_id ?? selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
          billableToCustomer: line.billable_to_customer === true,
        }))
      : [
          {
            projectId: selectedBill.project_id,
            costCodeId: costCodesEnabled ? selectedBill.actual_cost_code_id ?? sortedCostCodes[0]?.id ?? "" : "",
            budgetLineId: "",
            description: selectedBill.bill_number ?? "Vendor bill",
            amountDollars: ((selectedBill.total_cents ?? 0) / 100).toFixed(2),
            qboExpenseAccountId: selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
            qboApAccountId: selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
            billableToCustomer: defaultBillableToCustomer(selectedBill.project_id),
          },
        ])
    return (
      billNumber !== (selectedBill.bill_number ?? "") ||
      billDate !== (selectedBill.bill_date ?? "") ||
      dueDate !== (selectedBill.due_date ?? "") ||
      retainage !== (selectedBill.retainage_percent != null ? String(selectedBill.retainage_percent) : "") ||
      lienWaiver !== normalizeLienWaiverStatus(selectedBill.lien_waiver_status) ||
      qboExpenseAccountId !== (selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "") ||
      qboApAccountId !== (selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "") ||
      JSON.stringify(currentLines) !== JSON.stringify(baselineLines)
    )
  }, [
    billDate,
    billNumber,
    costCodesEnabled,
    dueDate,
    lienWaiver,
    qboApAccountId,
    qboDefaults.apAccountId,
    qboDefaults.expenseAccountId,
    qboExpenseAccountId,
    retainage,
    selectedBill,
    defaultBillableToCustomer,
    sortedCostCodes,
    splitLines,
  ])

  const requestSelectBill = useCallback((billId: string | null) => {
    if (isDirty) {
      setPendingSelection(billId)
      setDiscardOpen(true)
      return
    }
    onSelectBill(billId)
  }, [isDirty, onSelectBill])

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
      const isTextEntry = tagName === "input" || tagName === "textarea" || target?.getAttribute("role") === "combobox"
      if (isTextEntry || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "j" || event.key === "k") {
        const index = filtered.findIndex((bill) => bill.id === selectedBill.id)
        const next = event.key === "j" ? filtered[index + 1] : filtered[index - 1]
        if (next) requestSelectBill(next.id)
      }
      if (event.key.toLowerCase() === "a" && selectedBill.status === "pending" && !selectedIsVendorCredit) {
        approveShortcutRef.current?.()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [filtered, requestSelectBill, selectedBill, selectedIsVendorCredit])

  // Initialise the editable form whenever the selected bill changes.
  useEffect(() => {
    if (!selectedBill) return
    setIsChangingVendor(false)
    setSearchVendor("")
    setPaymentAmount("")
    setPaymentMethod(selectedBill.payment_method ?? "check")
    setPaymentRef(selectedBill.payment_reference ?? "")
    setPaymentDate(format(new Date(), "yyyy-MM-dd"))
    setRetainage(selectedBill.retainage_percent != null ? String(selectedBill.retainage_percent) : "")
    setLienWaiver(normalizeLienWaiverStatus(selectedBill.lien_waiver_status))
    setQboExpenseAccountId(selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "")
    setQboApAccountId(selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "")
    setBillNumber(selectedBill.bill_number ?? "")
    setBillDate(selectedBill.bill_date ?? "")
    setDueDate(selectedBill.due_date ?? "")
    setCreditProjectId(selectedBill.project_id)

    const existing = selectedBill.actual_lines ?? []
    setSplitLines(
      existing.length > 0
        ? existing.map((line) => ({
            id: line.id ?? crypto.randomUUID(),
            projectId: line.project_id ?? selectedBill.project_id,
            costCodeId: line.cost_code_id ?? "",
            budgetLineId: line.budget_line_id ?? "",
            description: line.description ?? selectedBill.bill_number ?? "Vendor bill",
            amountDollars: ((line.amount_cents ?? 0) / 100).toFixed(2),
            qboExpenseAccountId: line.qbo_expense_account_id ?? selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
            qboApAccountId: line.qbo_ap_account_id ?? selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
            billableToCustomer: line.billable_to_customer === true,
          }))
        : [
            {
              id: crypto.randomUUID(),
              projectId: selectedBill.project_id,
              costCodeId: costCodesEnabled ? selectedBill.actual_cost_code_id ?? sortedCostCodes[0]?.id ?? "" : "",
              budgetLineId: "",
              description: selectedBill.bill_number ?? "Vendor bill",
              amountDollars: ((selectedBill.total_cents ?? 0) / 100).toFixed(2),
              qboExpenseAccountId: selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
              qboApAccountId: selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
              billableToCustomer: defaultBillableToCustomer(selectedBill.project_id),
            },
          ],
    )
  }, [selectedBill, sortedCostCodes, qboDefaults, costCodesEnabled, defaultBillableToCustomer])

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
      .catch((error) => console.error("Failed to load vendor bill attachments", error))
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

  if (!selectedBill) return null

  const effectiveSyncStatus =
    optimisticSyncedBillIds.has(selectedBill.id) && selectedBill.qbo_sync_status !== "error"
      ? "synced"
      : selectedBill.qbo_sync_status

  const refreshAttachments = async () => {
    const links = await listAttachmentsAction("vendor_bill", selectedBill.id)
    setAttachments(links.map(mapAttachment))
  }

  const handleAttach = async (files: File[], linkRole?: string) => {
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", "financials")
      const uploaded = unwrapAction(await uploadFileAction(formData))
      unwrapAction(await attachFileAction(uploaded.id, "vendor_bill", selectedBill.id, projectId, linkRole))
    }
    await refreshAttachments()
  }

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId))
    await refreshAttachments()
  }

  const distinctSplitProjects = Array.from(new Set(splitLines.map((line) => line.projectId).filter(Boolean)))
  const isSplitAcrossProjects = distinctSplitProjects.length > 1
  const reassignBlockedBySplit = selectedIsReassignablePayable && isSplitAcrossProjects

  const splitTotalCents = splitLines.reduce((sum, line) => sum + (dollarsToCents(line.amountDollars) ?? 0), 0)
  const billTotalCents = selectedBill.total_cents ?? 0
  const splitsBalanced = splitTotalCents === billTotalCents

  const paymentBlockReason = getPaymentBlockReason({ bill: selectedBill, complianceRules, complianceStatusByCompanyId })

  const setStatus = (status: "approved" | "partial" | "paid") => {
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      try {
        const amountCents = paymentAmount.trim() ? Math.round(Number(paymentAmount) * 100) : undefined
        const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
          status,
          expected_updated_at: selectedBill.updated_at,
          qbo_expense_account_id: qboExpenseAccountId || qboDefaults.expenseAccountId,
          qbo_expense_account_name: getExpenseAccountName(qboExpenseAccountId || qboDefaults.expenseAccountId),
          payment_method: status === "paid" || status === "partial" ? paymentMethod : undefined,
          payment_reference: status === "paid" || status === "partial" ? paymentRef || undefined : undefined,
          payment_date: status === "paid" || status === "partial" ? paymentDate : undefined,
          payment_amount_cents: status === "paid" || status === "partial" ? amountCents : undefined,
        }))
        if (!result.success) {
          toast.error(result.error)
          return
        }
        toast.success("Bill updated")
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  approveShortcutRef.current = () => setStatus("approved")

  const saveDetails = () => {
    const retainagePercent = retainage.trim() ? Number(retainage) : undefined
    if (retainage.trim() && (retainagePercent === undefined || !Number.isFinite(retainagePercent) || retainagePercent < 0)) {
      toast.error("Invalid retainage percentage")
      return
    }
    const actualLines = splitLines.map((line) => ({
      project_id: line.projectId || selectedBill.project_id,
      cost_code_id: costCodesEnabled ? line.costCodeId || null : null,
      budget_line_id: costCodesEnabled ? null : line.budgetLineId || null,
      description: line.description.trim() || billNumber || "Vendor bill",
      amount_cents: dollarsToCents(line.amountDollars),
      billable_to_customer: line.billableToCustomer,
      qbo_expense_account_id: line.qboExpenseAccountId || qboExpenseAccountId || undefined,
      qbo_expense_account_name: getExpenseAccountName(line.qboExpenseAccountId || qboExpenseAccountId),
      qbo_ap_account_id: line.qboApAccountId || qboApAccountId || undefined,
      qbo_ap_account_name: getApAccountName(line.qboApAccountId || qboApAccountId),
    }))
    const hasInvalidLine = actualLines.some(
      (line) =>
        !line.project_id ||
        (costCodesEnabled && !line.cost_code_id) ||
        line.amount_cents == null ||
        (selectedIsVendorCredit ? line.amount_cents > 0 : line.amount_cents < 0),
    )
    if (hasInvalidLine) {
      toast.error(costCodesEnabled ? "Each split needs a project, cost code, and amount." : "Each split needs a project and amount.")
      return
    }
    if (splitTotalCents !== billTotalCents) {
      toast.error(`Splits (${formatMoneyFromCents(splitTotalCents)}) must equal the bill total (${formatMoneyFromCents(billTotalCents)})`)
      return
    }
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      try {
        const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
          status: selectedBill.status as any,
          expected_updated_at: selectedBill.updated_at,
          bill_number: billNumber.trim() || undefined,
          bill_date: billDate || undefined,
          due_date: dueDate || null,
          actual_lines: actualLines.map((line) => ({ ...line, amount_cents: line.amount_cents! })),
          retainage_percent: retainagePercent,
          lien_waiver_status: normalizeLienWaiverStatus(lienWaiver) as any,
          qbo_expense_account_id: qboExpenseAccountId || undefined,
          qbo_expense_account_name: getExpenseAccountName(qboExpenseAccountId),
          qbo_ap_account_id: qboApAccountId || undefined,
          qbo_ap_account_name: getApAccountName(qboApAccountId),
        }))
        if (!result.success) {
          toast.error(result.error)
          return
        }
        toast.success("Payable saved")
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const releaseRetainage = () => {
    if (!selectedBill || payableHeldRetainageCents(selectedBill) <= 0) return
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
        status: selectedBill.status as any,
        expected_updated_at: selectedBill.updated_at,
        retainage_percent: 0,
      }))
      if (result.success) {
        setRetainage("0")
        toast.success("Retainage released")
        onChanged()
      } else {
        toast.error(result.error)
      }
    })
  }

  const reassignPayable = () => {
    if (!selectedBill || !selectedIsReassignablePayable || !creditProjectId || creditProjectId === selectedBill.project_id) return
    if (reassignBlockedBySplit) {
      toast.error("Reassign is only available when all line items are assigned to one project.")
      return
    }
    startTransition(async () => {
      const result = unwrapAction(await reassignProjectPayableAction(projectId, selectedBill.id, creditProjectId))
      if (result.success) {
        toast.success(selectedIsVendorCredit ? "Vendor credit reassigned" : "Bill reassigned")
        router.push(`/projects/${result.projectId}/financials/payables?bill=${selectedBill.id}`)
        onChanged()
      } else {
        toast.error(result.error)
      }
    })
  }

  const syncToQbo = () => {
    const reason = getPayableSyncBlockReason(selectedBill)
    if (reason) {
      toast.error(reason)
      if (!selectedBill.qbo_vendor_id) openVendorEditor()
      return
    }
    startTransition(async () => {
      unwrapAction(await syncProjectVendorBillToQBOAction(projectId, selectedBill.id))
      setOptimisticSyncedBillIds((prev) => new Set(prev).add(selectedBill.id))
      toast.success("Synced to QuickBooks")
      onChanged()
    })
  }

  const balanceCents = payableOutstandingCents(selectedBill)

  const parseDate = (str?: string) => {
    if (!str) return undefined
    const d = new Date(`${str}T00:00:00`)
    return isNaN(d.getTime()) ? undefined : d
  }

  const openVendorEditor = () => {
    if (selectedBill.company_id) {
      setVendorEditorCompanyId(selectedBill.company_id)
      setVendorEditorOpen(true)
      return
    }
    startTransition(async () => {
      try {
        const company = unwrapAction(await ensureProjectVendorCompanyForPayableAction(projectId, selectedBill.id))
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
        { key: "ready", label: accountingEnabled ? "Ready" : "Pay", count: counts.ready },
        { key: "synced", label: accountingEnabled ? "Synced" : "Paid", count: counts.synced },
      ]}
      activeQueue={queueFilter}
      onQueueChange={setQueueFilter}
      items={filtered}
      getKey={(bill) => bill.id}
      isActive={(bill) => bill.id === selectedBill.id}
      onSelect={(bill) => requestSelectBill(bill.id)}
      emptyLabel="No payables match."
      renderRow={(bill) => (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{vendorLabel(bill)}</span>
            <span className="shrink-0 text-sm font-semibold tabular-nums">
              {formatMoneyFromCents(bill.project_amount_cents ?? bill.total_cents ?? 0)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className={dueDateClassName(bill.due_date, bill.status)}>
              {bill.due_date
                ? getDueState(bill.due_date, bill.status).label.replace(new RegExp(`, ${new Date().getFullYear()}$`), "")
                : "No due date"}
            </span>
            {bill.is_shared ? <Layers className="h-3 w-3 shrink-0 text-primary" /> : null}
          </div>
        </>
      )}
    />
  )

  const documentPane = (
    <PayableDocumentPane
      attachments={attachments}
      loading={attachmentsLoading}
      onAttach={handleAttach}
      onDetach={handleDetach}
      projectId={projectId}
    />
  )

  return (
    <>
      <WorkspaceShell open onClose={() => requestSelectBill(null)} listPanel={listPanel} documentPane={documentPane}>
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={() => requestSelectBill(null)} title="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold leading-tight">
                {selectedIsVendorCredit
                  ? selectedBill.bill_number
                    ? `Vendor credit ${selectedBill.bill_number}`
                    : "Vendor credit"
                  : selectedBill.bill_number
                    ? `Bill ${selectedBill.bill_number}`
                    : "Payable"}
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                {vendorLabel(selectedBill)}
                {selectedBill.commitment_title ? ` • ${selectedBill.commitment_title}` : ""}
                {selectedBill.over_budget ? " • Over commitment" : ""}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {billBadge(selectedBill.status)}
            <AccountingSyncBadge status={effectiveSyncStatus ?? "not_synced"} error={selectedBill.qbo_sync_error} />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 py-6 sm:px-6">
          {/* Amount summary */}
          <section className="space-y-3 border bg-card p-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="microlabel">Total amount</p>
                <p className="mt-1 font-mono text-2xl font-medium tabular-nums tracking-tight">{formatMoneyFromCents(billTotalCents)}</p>
              </div>
              {selectedIsVendorCredit ? (
                <div className="text-right text-xs text-muted-foreground">
                  <p className="microlabel">Vendor credit</p>
                  <p className="mt-1">Reduces project cost · managed in QuickBooks</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-x-6 text-right">
                  <span className="microlabel">Paid</span>
                  <span className="microlabel">Retained</span>
                  <span className="microlabel">Balance</span>
                  <span className="mt-1 font-mono text-sm font-medium tabular-nums text-success">{formatMoneyFromCents(selectedBill.paid_cents ?? 0)}</span>
                  <span className="mt-1 font-mono text-sm font-medium tabular-nums text-muted-foreground">{formatMoneyFromCents(payableHeldRetainageCents(selectedBill))}</span>
                  <span className={cn("mt-1 font-mono text-sm font-medium tabular-nums", balanceCents > 0 ? "text-foreground" : "text-muted-foreground")}>{formatMoneyFromCents(balanceCents)}</span>
                </div>
              )}
            </div>

            {selectedBill.over_budget ? (
              <div className="border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                This payable exceeds the linked commitment. Review the contract balance before approval.
              </div>
            ) : null}

            {selectedBill.commitment_id && (selectedBill.commitment_total_cents ?? 0) > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                <span className="truncate">{selectedBill.commitment_title ?? "Commitment"}</span>
                <span className="font-mono tabular-nums">
                  Billed {formatMoneyFromCents(selectedBill.commitment_billed_cents ?? 0)} of {formatMoneyFromCents(selectedBill.commitment_total_cents)}
                  {" · "}
                  <span
                    className={cn(
                      (selectedBill.commitment_total_cents ?? 0) - (selectedBill.commitment_billed_cents ?? 0) < 0 && "font-medium text-destructive",
                    )}
                  >
                    {formatMoneyFromCents((selectedBill.commitment_total_cents ?? 0) - (selectedBill.commitment_billed_cents ?? 0))} remaining
                  </span>
                </span>
              </div>
            ) : null}

            {selectedBill.approved_at ? (
              <div className="border-t pt-3 text-xs text-muted-foreground">
                Approved {format(new Date(selectedBill.approved_at), "MMM d, yyyy")} {selectedBill.approved_by ? `by ${selectedBill.approved_by}` : ""}
              </div>
            ) : null}

            {accountingEnabled && (
              <div className="border-t pt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="microlabel">Sync status</span>
                  <AccountingSyncBadge status={effectiveSyncStatus ?? "not_synced"} error={selectedBill.qbo_sync_error} externalId={selectedBill.qbo_id} />
                  {selectedBill.qbo_id ? (
                    <a href={qboTransactionUrl(selectedBill)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      Open in QuickBooks <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
                {selectedBill.qbo_sync_status === "error" && selectedBill.qbo_sync_error ? (
                  <span className="text-destructive font-medium text-[11px] truncate max-w-sm" title={selectedBill.qbo_sync_error}>
                    {selectedBill.qbo_sync_error}
                  </span>
                ) : null}
              </div>
            )}
          </section>

          <div className="flex items-start justify-between gap-3 border bg-card p-4">
            {isChangingVendor ? (
              <div className="flex-1 space-y-3">
                <Label className="microlabel">Change Vendor</Label>
                <div className="flex items-center gap-2">
                  <Popover open={vendorPickerOpen} onOpenChange={setVendorPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" role="combobox" className="h-9 flex-1 justify-between px-3 text-left text-xs font-semibold">
                        <span className="truncate">
                          {selectedBill.company_name ?? vendorLabel(selectedBill)}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                      <Command shouldFilter={false}>
                        <CommandInput value={searchVendor} onValueChange={setSearchVendor} placeholder="Search Arc vendors..." />
                        <CommandList className="max-h-72 overflow-y-auto">
                          <CommandEmpty>{loadingCompanies ? "Loading vendors..." : "No matching Arc vendors."}</CommandEmpty>
                          <CommandGroup heading="Arc vendors">
                            {visibleCompanies.map((company) => {
                              const selected = company.id === selectedBill.company_id
                              return (
                                <CommandItem key={company.id} value={company.name} onSelect={() => handleSelectCompany(company)}>
                                  <Check className={cn("size-4 mr-2", selected ? "opacity-100" : "opacity-0")} />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium">{company.name}</span>
                                    <span className="block truncate text-[10px] text-muted-foreground">
                                      {company.qbo_vendor_id ? `QBO: ${company.qbo_vendor_name ?? "Linked"}` : "No QBO vendor linked"}
                                    </span>
                                  </span>
                                </CommandItem>
                              )
                            })}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <Button variant="ghost" size="sm" onClick={() => setIsChangingVendor(false)} className="h-9 text-xs">
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="min-w-0">
                <Label className="microlabel">Vendor</Label>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-base font-semibold">{selectedBill.company_name ?? vendorLabel(selectedBill)}</span>
                  {accountingEnabled ? vendorLinkBadge(selectedBill) : null}
                </div>
                {accountingEnabled ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedBill.qbo_vendor_id
                      ? `QuickBooks: ${selectedBill.qbo_vendor_name ?? "Linked vendor"}`
                      : "No QuickBooks vendor linked yet. Link or create one before syncing."}
                  </p>
                ) : null}
              </div>
            )}
            {!isChangingVendor && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0">
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Vendor actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={openVendorEditor}>
                    Edit vendor details
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setIsChangingVendor(true)}>
                    Change vendor
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {/* Bill Details Section (Editable) */}
          <section className="space-y-4 border bg-card p-4">
            <h3 className="microlabel">{selectedIsVendorCredit ? "Credit details" : "Bill details"}</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="microlabel">{selectedIsVendorCredit ? "Credit #" : "Invoice / Bill #"}</Label>
                <Input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} placeholder="e.g. INV-12345" className="h-10 text-sm font-semibold" />
              </div>
              <div className="space-y-1.5 flex flex-col">
                <Label className="microlabel">Invoice Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-10 w-full justify-start text-left font-semibold text-sm",
                        !billDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarDays className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {billDate && parseDate(billDate) ? format(parseDate(billDate)!, "PPP") : "Pick a date"}
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={parseDate(billDate)}
                      onSelect={(date) => setBillDate(date ? format(date, "yyyy-MM-dd") : "")}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-1.5 flex flex-col">
                <Label className="microlabel">Due Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-10 w-full justify-start text-left font-semibold text-sm",
                        !dueDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarDays className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {dueDate && parseDate(dueDate) ? format(parseDate(dueDate)!, "PPP") : "Pick a date"}
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={parseDate(dueDate)}
                      onSelect={(date) => setDueDate(date ? format(date, "yyyy-MM-dd") : "")}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </section>

          {/* Shared-across-projects affordance */}
          {selectedBill.is_shared && selectedBill.shared_projects && selectedBill.shared_projects.length > 1 ? (
            <div className="space-y-2 border bg-card p-4">
              <div className="microlabel flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-primary" />
                Shared across {selectedBill.shared_projects.length} projects
              </div>
              <div className="space-y-1">
                {selectedBill.shared_projects.map((share) => {
                  const isCurrent = share.id === projectId
                  return (
                    <div key={share.id} className="flex items-center justify-between gap-2 text-sm">
                      <button
                        type="button"
                        disabled={isCurrent}
                        onClick={() => router.push(`/projects/${share.id}/financials/payables?bill=${selectedBill.id}`)}
                        className={cn("truncate text-left", isCurrent ? "font-semibold" : "text-primary hover:underline")}
                      >
                        {share.name ?? projectName(share.id)}
                        {isCurrent ? " (this project)" : ""}
                      </button>
                      <span className="shrink-0 tabular-nums">{formatMoneyFromCents(share.amount_cents)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}

          {/* Workflow actions */}
          {!selectedIsVendorCredit && selectedBill.status === "pending" ? (
            <Button variant="outline" className="group h-11 w-full justify-between" disabled={isPending} onClick={() => setStatus("approved")}>
              <span className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                Approve for payment
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Button>
          ) : null}

          {/* Payment Details */}
          {!selectedIsVendorCredit && selectedBill.payments.length > 0 ? (
            <div className="space-y-4 border bg-card p-4">
              <div className="microlabel flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                Payment history
              </div>
              <div className="divide-y border bg-background">
                {selectedBill.payments.map((payment) => (
                  <div key={payment.id} className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {payment.vendor_credit_applied ? "Vendor credit applied" : payment.provider === "qbo" ? "QuickBooks payment" : "Payment"}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {payment.received_at ? format(new Date(payment.received_at), "MMM d, yyyy") : "No date"}
                        {payment.reference ? ` • ${payment.reference}` : ""}
                        {payment.qbo_id ? ` • QBO ${payment.qbo_id}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono font-medium tabular-nums text-success">
                      {formatMoneyFromCents(payment.amount_cents)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {!selectedIsVendorCredit &&
          selectedBill.payments.length === 0 &&
          (selectedBill.status === "paid" || selectedBill.status === "partial") ? (
            <div className="space-y-4 border bg-card p-4">
              <div className="microlabel flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                Payment details
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <span className="microlabel">Amount paid</span>
                  <p className="font-mono text-sm font-medium tabular-nums text-success">{formatMoneyFromCents(selectedBill.paid_cents ?? billTotalCents)}</p>
                </div>
                <div className="space-y-1">
                  <span className="microlabel">Method</span>
                  <p className="text-sm font-semibold capitalize">{selectedBill.payment_method || "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="microlabel">Reference</span>
                  <p className="text-sm font-semibold">{selectedBill.payment_reference || "—"}</p>
                </div>
              </div>
            </div>
          ) : null}

          {!selectedIsVendorCredit && (selectedBill.status === "approved" || selectedBill.status === "partial" || (selectedBill.status === "paid" && balanceCents > 0)) ? (
            <div className="space-y-4 border bg-card p-4">
              <div className="microlabel flex items-center gap-2">
                <Receipt className="h-3.5 w-3.5 text-primary" />
                Record payment
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="microlabel">Amount</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs text-muted-foreground">$</span>
                    <Input className="h-10 pl-7 font-semibold" placeholder="0.00" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="microlabel">Method</Label>
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                    <SelectTrigger className="h-10 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="check">Check</SelectItem>
                      <SelectItem value="ach">ACH</SelectItem>
                      <SelectItem value="credit_card">Credit card</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5 flex flex-col">
                <Label className="microlabel">Payment Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn("h-10 w-full justify-start text-left font-semibold text-sm", !paymentDate && "text-muted-foreground")}
                    >
                      <CalendarDays className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {paymentDate && parseDate(paymentDate) ? format(parseDate(paymentDate)!, "PPP") : "Pick a date"}
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={parseDate(paymentDate)}
                      onSelect={(date) => setPaymentDate(date ? format(date, "yyyy-MM-dd") : "")}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-1.5">
                <Label className="microlabel">Reference</Label>
                <Input className="h-10" placeholder="Check # or transaction ID" value={paymentRef} onChange={(event) => setPaymentRef(event.target.value)} />
              </div>
              <Button className="h-10 w-full" disabled={isPending || Boolean(paymentBlockReason)} onClick={() => setStatus("paid")}>
                {isPending ? "Processing..." : paymentBlockReason ? `Blocked: ${paymentBlockReason}` : "Post payment"}
              </Button>
            </div>
          ) : null}

          {/* Allocation / cost splits (Line Items) */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="microlabel">Line items</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() =>
                  setSplitLines((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      projectId: selectedBill.project_id,
                      costCodeId: costCodesEnabled ? sortedCostCodes[0]?.id ?? "" : "",
                      budgetLineId: prev[0]?.budgetLineId ?? "",
                      description: billNumber || "Vendor bill",
                      amountDollars: "0.00",
                      qboExpenseAccountId: qboExpenseAccountId,
                      qboApAccountId: qboApAccountId,
                      billableToCustomer: defaultBillableToCustomer(selectedBill.project_id),
                    },
                  ])
                }
              >
                <Plus className="mr-1 h-3 w-3" />
                Add line item
              </Button>
            </div>

            {isSplitAcrossProjects ? (
              <div className="flex items-center gap-2 border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-foreground">
                <Layers className="h-3.5 w-3.5 text-primary" />
                Split across {distinctSplitProjects.length} projects — one {selectedIsVendorCredit ? "credit" : "bill"}, one payment{selectedIsVendorCredit ? "." : ", synced to QuickBooks."}
              </div>
            ) : null}

            <div className="space-y-3">
              {splitLines.map((line) => (
                <div key={line.id} className="relative space-y-3 border bg-card p-4">
                  {/* Top row: Project and Amount */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="microlabel mb-1 block">Project</Label>
                      <Select
                        value={line.projectId}
                        onValueChange={(value) =>
                          setSplitLines((prev) =>
                            prev.map((item) =>
                              item.id === line.id
                                ? {
                                    ...item,
                                    projectId: value,
                                    billableToCustomer:
                                      supportsBillableCosts(
                                        projects.find((project) => project.id === value)?.billingModel,
                                      )
                                        ? item.billableToCustomer
                                        : false,
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select project" /></SelectTrigger>
                        <SelectContent>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id} className="text-xs">{project.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedIsReassignablePayable ? (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Change line projects to split this QuickBooks {selectedIsVendorCredit ? "credit" : "bill"}; use Reassign below only to move the whole unsplit {selectedIsVendorCredit ? "credit" : "bill"}.
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <Label className="microlabel mb-1 block">Amount</Label>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs text-muted-foreground">$</span>
                          <Input
                            value={line.amountDollars}
                            inputMode="decimal"
                            className="h-9 pl-7 font-semibold tabular-nums text-xs"
                            onChange={(event) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, amountDollars: event.target.value } : item)))}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-muted-foreground hover:text-destructive shrink-0"
                          disabled={splitLines.length === 1}
                          onClick={() => setSplitLines((prev) => prev.filter((item) => item.id !== line.id))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Second row: Cost Code / Budget line & Description */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {costCodesEnabled ? (
                      <div>
                        <Label className="microlabel mb-1 block">Cost Code</Label>
                        <Select
                          value={line.costCodeId}
                          onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, costCodeId: value } : item)))}
                        >
                          <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select cost code" /></SelectTrigger>
                          <SelectContent>
                            {sortedCostCodes.map((code) => (
                              <SelectItem key={code.id} value={code.id} className="text-xs">
                                {code.code ? `${code.code} - ${code.name}` : code.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : budgetLines.length > 0 ? (
                      <div>
                        <Label className="microlabel mb-1 block">Budget line</Label>
                        <Select
                          value={line.budgetLineId || "__none__"}
                          onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, budgetLineId: value === "__none__" ? "" : value } : item)))}
                        >
                          <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select budget line" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__" className="text-xs">Unassigned</SelectItem>
                            {budgetLines.map((bl) => (
                              <SelectItem key={bl.id} value={bl.id} className="text-xs">
                                {bl.description?.trim() || "Untitled line"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}

                    <div className={cn(!costCodesEnabled && budgetLines.length === 0 && "sm:col-span-2")}>
                      <Label className="microlabel mb-1 block">Description</Label>
                      <Input
                        value={line.description}
                        placeholder="Split description..."
                        className="h-9 text-xs"
                        onChange={(event) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, description: event.target.value } : item)))}
                      />
                    </div>
                  </div>

                  {!selectedIsVendorCredit && supportsBillableCosts(projects.find((project) => project.id === line.projectId)?.billingModel) ? (
                    <div className="flex items-center justify-between gap-4 border bg-muted/20 px-3 py-2.5">
                      <div className="min-w-0">
                        <Label htmlFor={`billable-${line.id}`} className="text-xs font-semibold">
                          Billable to customer
                        </Label>
                        <p className="text-[11px] text-muted-foreground">
                          Include this cost in customer billing and mark it billable in QuickBooks.
                        </p>
                      </div>
                      <Switch
                        id={`billable-${line.id}`}
                        checked={line.billableToCustomer}
                        onCheckedChange={(checked) =>
                          setSplitLines((prev) =>
                            prev.map((item) => (item.id === line.id ? { ...item, billableToCustomer: checked } : item)),
                          )
                        }
                      />
                    </div>
                  ) : null}

                  {/* Third row: QuickBooks Coding (if accounting enabled) */}
                  {accountingEnabled && (
                    <div className="border-t pt-3 mt-3 space-y-3">
                      <div className="microlabel">QuickBooks line coding</div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <Label className="microlabel mb-1 block">QBO Category</Label>
                          <Select
                            value={line.qboExpenseAccountId || ""}
                            onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, qboExpenseAccountId: value } : item)))}
                          >
                            <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select category" /></SelectTrigger>
                            <SelectContent>
                              {qboExpenseAccounts.map((account) => (
                                <SelectItem key={account.id} value={account.id} className="text-xs">{account.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div>
                          <Label className="microlabel mb-1 block">QBO AP Account</Label>
                          <Select
                            value={line.qboApAccountId || ""}
                            onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, qboApAccountId: value } : item)))}
                          >
                            <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select AP account" /></SelectTrigger>
                            <SelectContent>
                              {qboApAccounts.map((account) => (
                                <SelectItem key={account.id} value={account.id} className="text-xs">{account.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className={cn("flex items-center justify-between border px-3 py-2 text-xs font-medium tabular-nums", splitsBalanced ? "border-success/20 bg-success/10 text-success" : "border-warning/20 bg-warning/10 text-warning")}>
              <span>Allocated {formatMoneyFromCents(splitTotalCents)} of {formatMoneyFromCents(billTotalCents)}</span>
              <span>{splitsBalanced ? "Balanced" : `${formatMoneyFromCents(billTotalCents - splitTotalCents)} unallocated`}</span>
            </div>
          </section>

          {/* Terms */}
          {!selectedIsVendorCredit ? <div className="grid grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <Label className="microlabel">Retainage %</Label>
              <Input type="number" step="0.1" value={retainage} onChange={(event) => setRetainage(event.target.value)} placeholder="0" className="h-10 font-semibold" />
              {payableHeldRetainageCents(selectedBill) > 0 ? (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{formatMoneyFromCents(payableHeldRetainageCents(selectedBill))} held</span>
                  <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={releaseRetainage}>
                    Release
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label className="microlabel">Lien waiver</Label>
              <Select value={lienWaiver} onValueChange={setLienWaiver}>
                <SelectTrigger className="h-10 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="not_required">Not required</SelectItem>
                  <SelectItem value="requested">Requested</SelectItem>
                  <SelectItem value="received">Received</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div> : null}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-3 border-t bg-muted/10 px-4 py-3 sm:px-6">
          {selectedIsReassignablePayable ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">Assigned project</span>
              <Select value={creditProjectId} onValueChange={setCreditProjectId} disabled={reassignBlockedBySplit}>
                <SelectTrigger className="h-9 max-w-xs">
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
              <Button
                variant="outline"
                disabled={isPending || reassignBlockedBySplit || !creditProjectId || creditProjectId === selectedBill.project_id}
                onClick={reassignPayable}
              >
                {isPending ? "Moving..." : "Reassign"}
              </Button>
              {reassignBlockedBySplit ? (
                <span className="truncate text-[11px] text-muted-foreground">
                  Reassign is available when all lines are on one project.
                </span>
              ) : null}
            </div>
          ) : (
            <Button variant="ghost" disabled={isPending || effectiveSyncStatus === "synced"} onClick={syncToQbo}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Sync to QuickBooks
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => requestSelectBill(null)}>Close</Button>
            <Button disabled={isPending} onClick={saveDetails}>{isPending ? "Saving..." : "Save changes"}</Button>
          </div>
        </div>
      </WorkspaceShell>

      <Sheet open={vendorEditorOpen} onOpenChange={setVendorEditorOpen}>
        <SheetContent side="right" mobileFullscreen className="flex flex-col p-0 sm:max-w-xl">
          <SheetHeader className="border-b bg-muted/30 px-6 py-5">
            <SheetTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              Vendor details
            </SheetTitle>
            <SheetDescription>
              Update the Arc vendor profile and its QuickBooks vendor link.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {vendorEditorLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading vendor...</div>
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

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The edits in this payable have not been saved. Discard them and leave this bill?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscard}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function mapAttachment(link: any): AttachedFile {
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

function dollarsToCents(input: string) {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

function qboTransactionUrl(bill: VendorBillSummary) {
  return qboTxnUrl(isVendorCredit(bill) ? "vendorcredit" : "bill", bill.qbo_id)
}

function normalizeLienWaiverStatus(status?: string | null) {
  if (status === "requested" || status === "received" || status === "not_required") return status
  if (status === "pending") return "requested"
  return "not_required"
}

function getPaymentBlockReason({
  bill,
  complianceRules,
  complianceStatusByCompanyId,
}: {
  bill: VendorBillSummary
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
}) {
  if (!complianceRules.block_payment_on_missing_docs) return null
  const reasons: string[] = []
  const complianceStatus = bill.company_id ? complianceStatusByCompanyId[bill.company_id] : null
  if (complianceStatus && !complianceStatus.is_compliant) {
    const missingCount =
      (complianceStatus.missing?.length ?? 0) + (complianceStatus.expired?.length ?? 0) + (complianceStatus.pending_review?.length ?? 0)
    reasons.push(missingCount > 0 ? `${missingCount} compliance item${missingCount === 1 ? "" : "s"}` : "Compliance")
  }
  if (complianceRules.require_lien_waiver && bill.lien_waiver_status !== "received") {
    reasons.push("Lien waiver")
  }
  return reasons.length > 0 ? reasons.join(" + ") : null
}

"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
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
  GripVertical,
  Layers,
  MoreHorizontal,
  Plus,
  Receipt,
  Search,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
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
import { getCompanyAction, listCompaniesAction } from "@/app/(app)/companies/actions"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions"
import {
  ensureProjectVendorCompanyForPayableAction,
  reassignProjectVendorCreditAction,
  syncProjectVendorBillToQBOAction,
  updateProjectVendorBillStatusAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { isVendorCredit, payableOutstandingCents } from "@/lib/financials/payables-rules"
import type { Company, ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import { filterPayables, payableQueueCounts, type PayableQueue } from "./payables-filters"
import { PayableDocumentPane } from "./payable-document-pane"

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
        await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
          status: selectedBill.status as any,
          company_id: company.id,
        })
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

  const [rightPaneWidth, setRightPaneWidth] = useState(550)
  const [isDraggingBorder, setIsDraggingBorder] = useState(false)

  const startDragging = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDraggingBorder(true)
  }

  useEffect(() => {
    if (!isDraggingBorder) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX
      const minWidth = 280
      const maxWidth = Math.min(850, window.innerWidth * 0.6)
      
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setRightPaneWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      setIsDraggingBorder(false)
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)

    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [isDraggingBorder])

  const selectedBill = useMemo(
    () => bills.find((bill) => bill.id === selectedBillId) ?? null,
    [bills, selectedBillId],
  )
  const selectedIsVendorCredit = selectedBill ? isVendorCredit(selectedBill) : false

  const filtered = useMemo(
    () => filterPayables(bills, { search, queue: queueFilter, costCodesEnabled }),
    [bills, search, queueFilter, costCodesEnabled],
  )
  const counts = useMemo(() => payableQueueCounts(bills, costCodesEnabled), [bills, costCodesEnabled])

  const sortedCostCodes = useMemo(
    () => (costCodesEnabled ? [...costCodes].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")) : []),
    [costCodes, costCodesEnabled],
  )
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? "Project"
  const getExpenseAccountName = (id?: string) => qboExpenseAccounts.find((account) => account.id === id)?.name
  const getApAccountName = (id?: string) => qboApAccounts.find((account) => account.id === id)?.name

  // Hide immersive chrome (mobile bottom nav) while the workspace is open.
  useEffect(() => {
    if (typeof window === "undefined" || !selectedBill) return
    window.dispatchEvent(new CustomEvent("arc-immersive-view", { detail: { active: true } }))
    return () => {
      window.dispatchEvent(new CustomEvent("arc-immersive-view", { detail: { active: false } }))
    }
  }, [selectedBill])

  // Close on Escape.
  useEffect(() => {
    if (!selectedBill) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSelectBill(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedBill, onSelectBill])

  // Initialise the editable form whenever the selected bill changes.
  useEffect(() => {
    if (!selectedBill) return
    setIsChangingVendor(false)
    setSearchVendor("")
    setPaymentAmount("")
    setPaymentMethod(selectedBill.payment_method ?? "check")
    setPaymentRef(selectedBill.payment_reference ?? "")
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
              description: selectedBill.bill_number ?? "Vendor bill",
              amountDollars: ((selectedBill.total_cents ?? 0) / 100).toFixed(2),
              qboExpenseAccountId: selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
              qboApAccountId: selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
              billableToCustomer: false,
            },
          ],
    )
  }, [selectedBill, sortedCostCodes, qboDefaults, costCodesEnabled])

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
      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "vendor_bill", selectedBill.id, projectId, linkRole)
    }
    await refreshAttachments()
  }

  const handleDetach = async (linkId: string) => {
    await detachFileLinkAction(linkId)
    await refreshAttachments()
  }

  const distinctSplitProjects = Array.from(new Set(splitLines.map((line) => line.projectId).filter(Boolean)))
  const isSplitAcrossProjects = distinctSplitProjects.length > 1

  const splitTotalCents = splitLines.reduce((sum, line) => sum + (dollarsToCents(line.amountDollars) ?? 0), 0)
  const billTotalCents = selectedBill.total_cents ?? 0
  const splitsBalanced = splitTotalCents === billTotalCents

  const paymentBlockReason = getPaymentBlockReason({ bill: selectedBill, complianceRules, complianceStatusByCompanyId })

  const setStatus = (status: "approved" | "partial" | "paid") => {
    clearOptimisticSync(selectedBill.id)
    startTransition(async () => {
      try {
        const amountCents = paymentAmount.trim() ? Math.round(Number(paymentAmount) * 100) : undefined
        await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
          status,
          qbo_expense_account_id: qboExpenseAccountId || qboDefaults.expenseAccountId,
          qbo_expense_account_name: getExpenseAccountName(qboExpenseAccountId || qboDefaults.expenseAccountId),
          payment_method: status === "paid" || status === "partial" ? paymentMethod : undefined,
          payment_reference: status === "paid" || status === "partial" ? paymentRef || undefined : undefined,
          payment_amount_cents: status === "paid" || status === "partial" ? amountCents : undefined,
        })
        toast.success("Bill updated")
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const saveDetails = () => {
    const retainagePercent = retainage.trim() ? Number(retainage) : undefined
    if (retainage.trim() && (retainagePercent === undefined || !Number.isFinite(retainagePercent) || retainagePercent < 0)) {
      toast.error("Invalid retainage percentage")
      return
    }
    const actualLines = splitLines.map((line) => ({
      project_id: line.projectId || selectedBill.project_id,
      cost_code_id: costCodesEnabled ? line.costCodeId || null : null,
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
        await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
          status: selectedBill.status as any,
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
        })
        toast.success("Payable saved")
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const reassignCredit = () => {
    if (!selectedBill || !selectedIsVendorCredit || !creditProjectId || creditProjectId === selectedBill.project_id) return
    startTransition(async () => {
      try {
        const result = await reassignProjectVendorCreditAction(projectId, selectedBill.id, creditProjectId)
        toast.success("Vendor credit reassigned")
        router.push(`/projects/${result.projectId}/financials/payables?bill=${selectedBill.id}`)
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
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
      const result = await syncProjectVendorBillToQBOAction(projectId, selectedBill.id)
      if (result.success) {
        setOptimisticSyncedBillIds((prev) => new Set(prev).add(selectedBill.id))
        toast.success("Synced to QuickBooks")
      } else {
        clearOptimisticSync(selectedBill.id)
        toast.error(result.error ?? "QuickBooks sync failed")
      }
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
        const company = await ensureProjectVendorCompanyForPayableAction(projectId, selectedBill.id)
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

  return (
    <div className="fixed inset-0 z-50 flex bg-background">
      {/* LEFT: payables list */}
      <aside className="hidden w-[300px] shrink-0 flex-col border-r bg-muted/10 md:flex">
        <button
          type="button"
          onClick={() => onSelectBill(null)}
          className="flex h-16 shrink-0 items-center gap-2 border-b px-4 text-left hover:bg-muted/50 transition-colors w-full group"
          title="Back to payables"
        >
          <ArrowLeft className="h-4 w-4 text-muted-foreground group-hover:-translate-x-0.5 transition-transform" />
          <span className="text-sm font-semibold">Payables</span>
        </button>
        <div className="border-b px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search vendor, bill..." className="h-9 pl-8" />
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1">
            {([
              { key: "all", label: "All" },
              { key: "needs_review", label: "Review" },
              { key: "ready", label: "Ready" },
              { key: "synced", label: "Synced" },
            ] as const).map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setQueueFilter(chip.key)}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                  queueFilter === chip.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {chip.label}
                <span className="tabular-nums opacity-70">{counts[chip.key]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.map((bill) => {
            const amount = bill.project_amount_cents ?? bill.total_cents ?? 0
            const active = bill.id === selectedBill.id
            return (
              <button
                key={bill.id}
                type="button"
                onClick={() => onSelectBill(bill.id)}
                className={cn(
                  "flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left transition-colors",
                  active ? "bg-primary/10" : "hover:bg-muted/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{vendorLabel(bill)}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMoneyFromCents(amount)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate">{bill.due_date ? `Due ${format(new Date(`${bill.due_date}T00:00:00`), "MMM d")}` : "No due date"}</span>
                  {bill.is_shared ? <Layers className="h-3 w-3 shrink-0 text-indigo-500" /> : null}
                </div>
              </button>
            )
          })}
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">No payables match.</div>
          ) : null}
        </div>
      </aside>

      {/* CENTER: overview / edit */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={() => onSelectBill(null)} title="Back">
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
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {billBadge(selectedBill.status)}
            {qboBadge(effectiveSyncStatus, selectedBill.qbo_sync_error)}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 py-6 sm:px-6">
          {/* Amount hero */}
          <div className="rounded-xl border bg-muted/10 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total amount</p>
                <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight">{formatMoneyFromCents(billTotalCents)}</p>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-right">
                {selectedIsVendorCredit ? (
                  <>
                    <span className="col-span-2 text-[10px] font-bold uppercase tracking-widest text-violet-700">Reduces project cost</span>
                    <span className="col-span-2 text-sm font-semibold text-muted-foreground">Managed in QuickBooks</span>
                  </>
                ) : (
                  <>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Paid</span>
                    <span className="text-sm font-semibold tabular-nums text-emerald-600">{formatMoneyFromCents(selectedBill.paid_cents ?? 0)}</span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Balance</span>
                    <span className="text-sm font-semibold tabular-nums text-amber-600">{formatMoneyFromCents(balanceCents)}</span>
                  </>
                )}
              </div>
            </div>

            {accountingEnabled && (
              <div className="border-t pt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Sync status:</span>
                  {qboBadge(effectiveSyncStatus, selectedBill.qbo_sync_error)}
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
          </div>

          <div className="flex items-start justify-between gap-3 rounded-xl border bg-muted/5 p-4">
            {isChangingVendor ? (
              <div className="flex-1 space-y-3">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Change Vendor</Label>
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
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Vendor</Label>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-base font-semibold">{selectedBill.company_name ?? vendorLabel(selectedBill)}</span>
                  {accountingEnabled ? qboVendorLinkBadge(selectedBill) : null}
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
          <section className="space-y-4 rounded-xl border bg-muted/5 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{selectedIsVendorCredit ? "Credit details" : "Bill details"}</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{selectedIsVendorCredit ? "Credit #" : "Invoice / Bill #"}</Label>
                <Input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} placeholder="e.g. INV-12345" className="h-10 text-sm font-semibold" />
              </div>
              <div className="space-y-1.5 flex flex-col">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Invoice Date</Label>
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
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Due Date</Label>
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
            <div className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-900/40 dark:bg-indigo-950/20">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                <Layers className="h-3.5 w-3.5" />
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
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Approve for payment
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Button>
          ) : null}

          {/* Payment Details */}
          {!selectedIsVendorCredit && selectedBill.payments.length > 0 ? (
            <div className="space-y-4 rounded-xl border border-emerald-100 bg-emerald-50/30 p-5 dark:border-emerald-900/30 dark:bg-emerald-950/10">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Payment history
              </div>
              <div className="divide-y rounded-lg border bg-background">
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
                    <span className="shrink-0 font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
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
            <div className="space-y-4 rounded-xl border border-emerald-100 bg-emerald-50/30 p-5 dark:border-emerald-900/30 dark:bg-emerald-950/10">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Payment details
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount paid</span>
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">{formatMoneyFromCents(selectedBill.paid_cents ?? billTotalCents)}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Method</span>
                  <p className="text-sm font-semibold capitalize">{selectedBill.payment_method || "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Reference</span>
                  <p className="text-sm font-semibold">{selectedBill.payment_reference || "—"}</p>
                </div>
              </div>
            </div>
          ) : null}

          {!selectedIsVendorCredit && (selectedBill.status === "approved" || selectedBill.status === "partial") ? (
            <div className="space-y-4 rounded-xl border border-blue-100 bg-blue-50/30 p-5 dark:border-blue-900/30 dark:bg-blue-950/10">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                <Receipt className="h-3.5 w-3.5" />
                Record payment
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs text-muted-foreground">$</span>
                    <Input className="h-10 pl-7 font-semibold" placeholder="0.00" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Method</Label>
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
              <div className="space-y-1.5">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Reference</Label>
                <Input className="h-10" placeholder="Check # or transaction ID" value={paymentRef} onChange={(event) => setPaymentRef(event.target.value)} />
              </div>
              <Button className="h-10 w-full bg-blue-600 hover:bg-blue-700" disabled={isPending || Boolean(paymentBlockReason)} onClick={() => setStatus("paid")}>
                {isPending ? "Processing..." : paymentBlockReason ? `Blocked: ${paymentBlockReason}` : "Post payment"}
              </Button>
            </div>
          ) : null}

          {/* Allocation / cost splits (Line Items) */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Line items</h3>
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
                      description: billNumber || "Vendor bill",
                      amountDollars: "0.00",
                      qboExpenseAccountId: qboExpenseAccountId,
                      qboApAccountId: qboApAccountId,
                      billableToCustomer: false,
                    },
                  ])
                }
              >
                <Plus className="mr-1 h-3 w-3" />
                Add line item
              </Button>
            </div>

            {isSplitAcrossProjects ? (
              <div className="flex items-center gap-2 rounded-md bg-indigo-50 px-3 py-1.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300">
                <Layers className="h-3.5 w-3.5" />
                Split across {distinctSplitProjects.length} projects — one bill, one payment, synced to QuickBooks.
              </div>
            ) : null}

            <div className="space-y-3">
              {splitLines.map((line) => (
                <div key={line.id} className="space-y-3 rounded-xl border bg-background p-4 shadow-sm relative">
                  {/* Top row: Project and Amount */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Project</Label>
                      <Select
                        value={line.projectId}
                        disabled={selectedIsVendorCredit}
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
                      {selectedIsVendorCredit ? (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Use Reassign below to move the full QuickBooks credit safely.
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount</Label>
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

                  {/* Second row: Cost Code & Description */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {costCodesEnabled && (
                      <div>
                        <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Cost Code</Label>
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
                    )}

                    <div className={cn(!costCodesEnabled && "sm:col-span-2")}>
                      <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Description</Label>
                      <Input
                        value={line.description}
                        placeholder="Split description..."
                        className="h-9 text-xs"
                        onChange={(event) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, description: event.target.value } : item)))}
                      />
                    </div>
                  </div>

                  {!selectedIsVendorCredit ? (
                    <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2.5">
                      <div className="min-w-0">
                        <Label htmlFor={`billable-${line.id}`} className="text-xs font-semibold">
                          Billable to customer
                        </Label>
                        <p className="text-[11px] text-muted-foreground">
                          {supportsBillableCosts(projects.find((project) => project.id === line.projectId)?.billingModel)
                            ? "Include this cost in customer billing and mark it billable in QuickBooks."
                            : "Available only for cost-plus and time-and-materials projects."}
                        </p>
                      </div>
                      <Switch
                        id={`billable-${line.id}`}
                        checked={
                          supportsBillableCosts(projects.find((project) => project.id === line.projectId)?.billingModel) &&
                          line.billableToCustomer
                        }
                        disabled={
                          !supportsBillableCosts(projects.find((project) => project.id === line.projectId)?.billingModel)
                        }
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
                      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">QuickBooks Line Coding</div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <Label className="mb-1 block text-[9px] font-bold uppercase tracking-widest text-muted-foreground">QBO Category</Label>
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
                          <Label className="mb-1 block text-[9px] font-bold uppercase tracking-widest text-muted-foreground">QBO AP Account</Label>
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

            <div className={cn("flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium", splitsBalanced ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300")}>
              <span>Allocated {formatMoneyFromCents(splitTotalCents)} of {formatMoneyFromCents(billTotalCents)}</span>
              <span>{splitsBalanced ? "Balanced" : `${formatMoneyFromCents(billTotalCents - splitTotalCents)} unallocated`}</span>
            </div>
          </section>

          {/* Terms */}
          {!selectedIsVendorCredit ? <div className="grid grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Retainage %</Label>
              <Input type="number" step="0.1" value={retainage} onChange={(event) => setRetainage(event.target.value)} placeholder="0" className="h-10 font-semibold" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Lien waiver</Label>
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
          {selectedIsVendorCredit ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">Assigned project</span>
              <Select value={creditProjectId} onValueChange={setCreditProjectId}>
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
                disabled={isPending || !creditProjectId || creditProjectId === selectedBill.project_id}
                onClick={reassignCredit}
              >
                {isPending ? "Moving..." : "Reassign"}
              </Button>
            </div>
          ) : (
            <Button variant="ghost" disabled={isPending || effectiveSyncStatus === "synced"} onClick={syncToQbo}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Sync to QuickBooks
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onSelectBill(null)}>Close</Button>
            <Button disabled={isPending} onClick={saveDetails}>{isPending ? "Saving..." : "Save changes"}</Button>
          </div>
        </div>
      </main>

      {/* Draggable Divider */}
      <div
        className={cn(
          "hidden lg:block w-[1px] cursor-col-resize hover:bg-primary/50 transition-colors select-none relative z-30 bg-border",
          isDraggingBorder && "bg-primary"
        )}
        onMouseDown={startDragging}
      >
        {/* Invisible wider hover area for easy dragging */}
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize z-30" />
        
        {/* Drag handle button (circle) */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex h-8 w-8 cursor-col-resize items-center justify-center rounded-full border bg-background shadow-md hover:bg-muted select-none z-40">
          <GripVertical className="h-5 w-5 text-muted-foreground" />
        </div>
      </div>

      {/* RIGHT: document viewer */}
      <aside
        style={{ width: `${rightPaneWidth}px` }}
        className="hidden shrink-0 lg:block bg-background"
      >
        <PayableDocumentPane
          attachments={attachments}
          loading={attachmentsLoading}
          onAttach={handleAttach}
          onDetach={handleDetach}
          projectId={projectId}
        />
      </aside>

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
    </div>
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

function vendorLabel(bill: VendorBillSummary) {
  return bill.qbo_vendor_name ?? bill.company_name ?? "No vendor"
}

function qboVendorLinkBadge(bill: VendorBillSummary) {
  if (bill.qbo_vendor_id) {
    return (
      <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/10 text-[10px] font-bold uppercase text-emerald-700">
        QBO linked
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-[10px] font-bold uppercase text-amber-700">
      QBO needed
    </Badge>
  )
}



function formatMoneyFromCents(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function dollarsToCents(input: string) {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

function qboTransactionUrl(bill: VendorBillSummary) {
  if (!bill.qbo_id) return null
  const page = isVendorCredit(bill) ? "vendorcredit" : "bill"
  return `https://qbo.intuit.com/app/${page}?txnId=${encodeURIComponent(bill.qbo_id)}`
}

function normalizeLienWaiverStatus(status?: string | null) {
  if (status === "requested" || status === "received" || status === "not_required") return status
  if (status === "pending") return "requested"
  return "not_required"
}

function getPayableSyncBlockReason(bill: VendorBillSummary) {
  if (isVendorCredit(bill)) return "Imported vendor credits are read-only in QuickBooks."
  if (bill.status === "pending") return "Approve the payable before syncing it to QuickBooks."
  if (!bill.qbo_vendor_id) return "Link this Arc vendor to QuickBooks before syncing."
  const hasLineExpenseCoding =
    (bill.actual_lines?.length ?? 0) > 0 && bill.actual_lines!.every((line) => Boolean(line.qbo_expense_account_id))
  if (!bill.qbo_expense_account_id && !hasLineExpenseCoding) return "Choose a QuickBooks account before syncing this payable."
  return null
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

function billBadge(status?: string) {
  const normalized = (status ?? "pending").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    paid: { label: "Paid", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    partial: { label: "Partial", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
    approved: { label: "Approved", tone: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20" },
    pending: { label: "Pending", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
  }
  const config = map[normalized] ?? map.pending
  return <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-tight ${config.tone}`}>{config.label}</Badge>
}

function qboBadge(status?: string, error?: string) {
  const normalized = (status ?? "not_synced").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    synced: { label: "Synced to QuickBooks", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    pending: { label: "Pending Sync", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
    error: { label: "Sync Error", tone: "bg-destructive/10 text-destructive border-destructive/20" },
    needs_review: { label: "Requires Review", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
    skipped: { label: "Sync Disabled", tone: "bg-muted text-muted-foreground border-border" },
    not_synced: { label: "Not Synced", tone: "bg-muted text-muted-foreground border-border" },
  }
  const config = map[normalized] ?? map.not_synced
  return <Badge variant="outline" title={error} className={`text-[10px] font-bold uppercase tracking-tight ${config.tone}`}>{config.label}</Badge>
}

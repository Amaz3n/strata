"use client"

import Link from "next/link"

import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react"
import { format } from "date-fns"
import {
  Check,
  ChevronDown,
  CreditCard,
  Landmark,
  Loader2,
  Paperclip,
  Receipt,
  Upload,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { listVendorCompaniesAction } from "@/app/(app)/companies/actions"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import {
  getPayableBatchSetupAction,
  getPayableVendorProfileAction,
  recordExtractionCorrectionAction,
} from "@/app/(app)/payables/actions"
import {
  createProjectVendorBillAction,
  getPayableCreationContextAction,
  listProjectCommitmentsForPayablesAction,
  previewPayableLineMatchAction,
  suggestPayableCreationCodingAction,
  type PayableCreationCodingSuggestion,
} from "@/app/(app)/projects/[id]/payables/actions"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { AttachedFile } from "@/components/files"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DateField } from "@/components/ui/date-field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { DocumentRegion, ProvenanceField } from "@/lib/ai/field-provenance"
import { unwrapAction } from "@/lib/action-result"
import type { InvoiceLineForMatch, PayableLineMatchAssessment } from "@/lib/financials/payable-line-match"
import { quoteApDisbursementFee, type ApFeePolicy } from "@/lib/payments/fee-engine"
import { estimateSettlement, type ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"
import type { VendorPayableProfile } from "@/lib/services/companies"
import type { CommitmentSummary } from "@/lib/services/commitments"
import type { PaymentApprovalRouting } from "@/lib/services/payment-approvers"
import type { Company, CostCode, BudgetLineOption } from "@/lib/types"
import { cn } from "@/lib/utils"

import { PayableApprovalRoute } from "./workspace/payable-approval-route"
import { PayableLinesEditor, type ProjectOption } from "./workspace/payable-lines-editor"
import { PayableVendorCard } from "./workspace/payable-vendor-card"
import { PayableVendorProfileDialog } from "./workspace/payable-vendor-profile-dialog"
import { parseDollarsToCents, type SplitLine } from "./workspace/payable-form"
import { PayableDocumentPane } from "./payable-document-pane"

const NO_COMMITMENT = "__no_commitment__"
const NO_PROJECT = ""

/** How the money leaves when the builder pays the vendor themselves. */
const EXTERNAL_PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH from your own bank" },
  { value: "wire", label: "Wire" },
  { value: "card", label: "Credit card" },
  { value: "other", label: "Other" },
] as const

type ExternalPaymentMethod = (typeof EXTERNAL_PAYMENT_METHODS)[number]["value"]

function isExternalPaymentMethod(value: string): value is ExternalPaymentMethod {
  return EXTERNAL_PAYMENT_METHODS.some((method) => method.value === value)
}

type AccountOption = { id: string; name: string }
type FundingSourceOption = { id: string; label: string; isDefault: boolean }
type CreationContext = {
  costCodesEnabled: boolean
  budgetLines: BudgetLineOption[]
  costCodes: CostCode[]
  accounting: {
    enabled: boolean
    provider: string | null
    providerName: string | null
    expenseAccounts: AccountOption[]
    apAccounts: AccountOption[]
    dimensions: Array<{ key: string; label: string; values: AccountOption[] }>
    defaults: { expenseAccountId?: string; apAccountId?: string }
  }
  taxJurisdictions: Array<{ id: string; name: string; use_tax_rate_micros: number }>
}

interface PayableCreateWorkspaceProps {
  projectId?: string
  projects?: ProjectOption[]
  initialFile?: File | null
  initialCompanyId?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * When the scan knows where on the page a value came from, the label itself
 * frames it in the document pane. A bookkeeper checking a total should not have
 * to hunt for it, and being able to see the ink behind a number is what makes an
 * auto-filled field trustworthy rather than merely convenient.
 *
 * The label stays typographically consistent with every other field; scanned
 * provenance is a quiet click target rather than a badge or special text style.
 */
function FieldLabel({
  children,
  onLocate,
}: {
  children: ReactNode
  onLocate?: () => void
}) {
  return (
    <Label className="mb-1.5 block text-[13px] font-medium text-foreground">
      {onLocate ? (
        <button
          type="button"
          onClick={onLocate}
          title="Show where this was read from"
          className="transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {children}
        </button>
      ) : (
        children
      )}
    </Label>
  )
}

export function PayableCreateWorkspace({
  projectId,
  projects = [],
  initialFile = null,
  initialCompanyId = null,
  open,
  onOpenChange,
  onSuccess,
}: PayableCreateWorkspaceProps) {
  const [isPending, startTransition] = useTransition()
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? NO_PROJECT)
  const [context, setContext] = useState<CreationContext | null>(null)
  const [loadingContext, setLoadingContext] = useState(false)
  const [contextError, setContextError] = useState(false)
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([])
  const [loadingCommitments, setLoadingCommitments] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [companies, setCompanies] = useState<Company[]>([])
  const [loadingCompanies, setLoadingCompanies] = useState(false)

  const [commitmentId, setCommitmentId] = useState(NO_COMMITMENT)
  const [companyId, setCompanyId] = useState(initialCompanyId ?? "")
  const [vendorName, setVendorName] = useState("")
  const [taxJurisdictionId, setTaxJurisdictionId] = useState("none")
  const [taxIncludedDollars, setTaxIncludedDollars] = useState("")
  const [useTaxDollars, setUseTaxDollars] = useState("")
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false)
  // The card replaces the picker once a vendor is on the payable; this forces
  // the picker back for the one case that matters — the scan matched the wrong
  // vendor and the person entering the bill has to overrule it.
  const [changingVendor, setChangingVendor] = useState(false)
  const [vendorProfile, setVendorProfile] = useState<VendorPayableProfile | null>(null)
  const [loadingVendorProfile, setLoadingVendorProfile] = useState(false)
  const [editVendorOpen, setEditVendorOpen] = useState(false)
  const [billNumber, setBillNumber] = useState("")
  const [amountDollars, setAmountDollars] = useState("")
  const [billDate, setBillDate] = useState(format(new Date(), "yyyy-MM-dd"))
  const [dueDate, setDueDate] = useState("")
  const [description, setDescription] = useState("")
  const [retainage, setRetainage] = useState("")
  const [lienWaiver, setLienWaiver] = useState("not_required")
  // Who moves the money. Arc's rail prices a fee and routes for approval; paying
  // it yourself does neither, so the choice has to be made here rather than
  // assumed — most builders pay some vendors by check forever.
  // Starts on the path that always works. Arc Pay is only offered once the org
  // actually has a funding account behind it — defaulting to a rail that is not
  // switched on would mark every new payable as rail-bound and then refuse to
  // let anyone pay it by check.
  const [paymentChannel, setPaymentChannel] = useState<"arc" | "external">("external")
  const [paymentChannelTouched, setPaymentChannelTouched] = useState(false)
  const [externalMethod, setExternalMethod] = useState<ExternalPaymentMethod>("check")
  const [apFeePolicy, setApFeePolicy] = useState<ApFeePolicy | null>(null)
  const [approvalRouting, setApprovalRouting] = useState<PaymentApprovalRouting | null>(null)
  const [settlementWindow, setSettlementWindow] = useState<ProviderSettlementWindow | null>(null)
  const [paymentSetupError, setPaymentSetupError] = useState<string | null>(null)
  const [fundingSources, setFundingSources] = useState<FundingSourceOption[]>([])
  const [fundingSourceId, setFundingSourceId] = useState("")
  const [paymentSchedule, setPaymentSchedule] = useState<"on_approval" | "scheduled">("on_approval")
  const [scheduledPaymentDate, setScheduledPaymentDate] = useState("")
  const [paymentMemo, setPaymentMemo] = useState("")
  const [preferredApproverIds, setPreferredApproverIds] = useState<string[]>([])
  const [requiredPaymentApprovals, setRequiredPaymentApprovals] = useState(1)
  const [requesterMayApprove, setRequesterMayApprove] = useState(false)

  useEffect(() => {
    if (open && initialCompanyId) setCompanyId(initialCompanyId)
  }, [initialCompanyId, open])

  const [file, setFile] = useState<File | null>(null)
  const [scannedFileId, setScannedFileId] = useState<string | null>(null)
  const scannedFileProject = useRef<string>("")
  const scanGeneration = useRef(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const [aiFields, setAiFields] = useState<Set<string>>(() => new Set())
  // Where the scan read each field from, and which one the pane is framing.
  const [provenance, setProvenance] = useState<Partial<Record<ProvenanceField, DocumentRegion>>>({})
  const [highlight, setHighlight] = useState<DocumentRegion | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [lines, setLines] = useState<SplitLine[]>([])
  const [codingSuggestion, setCodingSuggestion] = useState<PayableCreationCodingSuggestion | null>(null)
  const [isSuggestingCoding, setIsSuggestingCoding] = useState(false)
  const codingGeneration = useRef(0)
  // What the scan read, kept so a human's edits can be learned from on submit.
  const scannedRead = useRef<{ billNumber: string | null; totalDollars: number | null; lineCount: number } | null>(null)
  const lastAutoSuggestionKey = useRef("")
  // The scanned lines, kept in match shape so they can be checked against a
  // commitment the moment one is chosen — before any coding is entered.
  const [scannedLines, setScannedLines] = useState<InvoiceLineForMatch[]>([])
  const [lineMatch, setLineMatch] = useState<PayableLineMatchAssessment | null>(null)
  const lastLineMatchKey = useRef("")

  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const selectedCompany = companyId ? companies.find((company) => company.id === companyId) ?? null : null
  const selectedCommitment = commitmentId === NO_COMMITMENT
    ? null
    : commitments.find((commitment) => commitment.id === commitmentId) ?? null
  const scanState = useRef({ companies, context, selectedProjectId, selectedProject, vendorName, companyId, billNumber, amountDollars, billDate, dueDate, description, lines })
  scanState.current = { companies, context, selectedProjectId, selectedProject, vendorName, companyId, billNumber, amountDollars, billDate, dueDate, description, lines }
  useEffect(() => () => { scanGeneration.current += 1 }, [])
  const amountCents = parseDollarsToCents(amountDollars) ?? 0
  const splitTotalCents = lines.reduce((sum, line) => sum + (parseDollarsToCents(line.amountDollars) ?? 0), 0)
  const balanced = lines.length > 0 && splitTotalCents === amountCents
  const coreValid = Boolean(billNumber.trim() && amountCents > 0 && billDate && companyId)
  const readyValid = coreValid && balanced && (
    paymentChannel === "external" || paymentSchedule === "on_approval" || Boolean(scheduledPaymentDate)
  ) && (
    paymentChannel === "external" || !approvalRouting?.rosterConfigured || preferredApproverIds.length >= requiredPaymentApprovals
  )
  const busy = isPending || isUploading || isScanning
  const paymentAmountCents = Math.max(0, amountCents - Math.round(amountCents * (Number(retainage) || 0) / 100))
  const paymentQuote = apFeePolicy && paymentAmountCents > 0
    ? quoteApDisbursementFee({ vendorAmountCents: paymentAmountCents, policy: apFeePolicy })
    : null
  const plannedPaymentDate = paymentSchedule === "scheduled" && scheduledPaymentDate
    ? scheduledPaymentDate
    : format(new Date(), "yyyy-MM-dd")
  /** Whether this org can actually pay on the rail right now. */
  const arcPayAvailable = fundingSources.length > 0
  const settlementEstimate = paymentChannel === "arc" && settlementWindow
    ? estimateSettlement({ initiatedOn: plannedPaymentDate, window: settlementWindow })
    : null
  const readablePaymentDate = (value: string) =>
    format(new Date(`${value}T00:00:00`), "MMM d, yyyy")

  const visibleCompanies = companies.filter(
    (company) => !vendorName.trim() || normalizeName(company.name).includes(normalizeName(vendorName)),
  )
  const exactCompany = vendorName.trim()
    ? companies.find((company) => normalizeName(company.name) === normalizeName(vendorName))
    : null
  const previewAttachments = useMemo<AttachedFile[]>(() => {
    if (!file || !previewUrl) return []
    return [{
      id: `local-${file.name}-${file.lastModified}`,
      linkId: "local-invoice",
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      download_url: previewUrl,
      created_at: new Date(file.lastModified).toISOString(),
      link_role: "invoice",
    }]
  }, [file, previewUrl])

  useEffect(() => {
    if (!open) return
    setLoadingCompanies(true)
    listVendorCompaniesAction()
      .then(setCompanies)
      .catch(() => toast.error("Could not load vendors"))
      .finally(() => setLoadingCompanies(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    getPayableBatchSetupAction({ includeEligibleBills: false }).then((result) => {
      if (cancelled) return
      if (!result.success) {
        setPaymentSetupError(result.error)
        return
      }
      setPaymentSetupError(null)
      setApFeePolicy(result.data.feePolicy)
      setApprovalRouting(result.data.routing)
      setRequiredPaymentApprovals(result.data.requiredApprovals)
      setRequesterMayApprove(result.data.requesterMayApprove)
      setSettlementWindow(result.data.settlementWindow)
      setFundingSources(result.data.fundingSources)
      // Arc Pay becomes the default only when it is genuinely available, and
      // never over a choice the user has already made.
      if (result.data.fundingSources.length > 0) {
        setPaymentChannel((current) => (paymentChannelTouched ? current : "arc"))
      }
      setFundingSourceId((current) => current || (
        result.data.fundingSources.find((source) => source.isDefault) ?? result.data.fundingSources[0]
      )?.id || "")
      setPreferredApproverIds((current) => current.length > 0
        ? current
        : result.data.routing.approvers
          .filter((approver) => approver.permitted && (result.data.requesterMayApprove || approver.userId !== result.data.routing.viewerUserId))
          .map((approver) => approver.userId))
    })
    return () => { cancelled = true }
  }, [open])

  // The vendor's standing with this org, loaded when a vendor lands on the
  // payable — by scan match, by picker, or by commitment.
  useEffect(() => {
    if (!open || !companyId) {
      setVendorProfile(null)
      return
    }
    let cancelled = false
    setLoadingVendorProfile(true)
    void getPayableVendorProfileAction(companyId)
      .then((result) => {
        if (cancelled) return
        // Advisory only: a vendor whose history this person cannot read must
        // never stand between them and entering the bill.
        setVendorProfile(result.success ? result.data : null)
      })
      .finally(() => {
        if (!cancelled) setLoadingVendorProfile(false)
      })
    return () => { cancelled = true }
  }, [companyId, open])

  useEffect(() => {
    if (!vendorName.trim() || companyId) return
    const exact = companies.find((company) => normalizeName(company.name) === normalizeName(vendorName))
    if (exact) setCompanyId(exact.id)
  }, [companies, companyId, vendorName])

  useEffect(() => {
    if (!open) {
      setCommitments([])
      setContext(null)
      return
    }
    let cancelled = false
    setLoadingCommitments(true)
    setLoadingContext(true)
    setContextError(false)
    void Promise.all([
      selectedProjectId ? listProjectCommitmentsForPayablesAction(selectedProjectId) : Promise.resolve([]),
      getPayableCreationContextAction(selectedProjectId || null),
    ]).then(([nextCommitments, nextContext]) => {
      if (cancelled) return
      setCommitments(nextCommitments)
      setContext(nextContext as CreationContext)
    }).catch(() => {
      if (!cancelled) {
        setContextError(true)
        toast.error("Could not load payable coding options")
      }
    }).finally(() => {
      if (!cancelled) {
        setLoadingCommitments(false)
        setLoadingContext(false)
      }
    })
    return () => { cancelled = true }
  }, [open, selectedProjectId])

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (!open || !initialFile) return
    void handleFileSelected(initialFile)
    // The initial file is an event payload, not form state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile])

  useEffect(() => {
    if (!context || lines.length > 0) return
    setLines([{
      id: crypto.randomUUID(),
      projectId: selectedProjectId,
      costCodeId: "",
      budgetLineId: "",
      description: description || "Vendor bill",
      amountDollars: amountDollars || "0.00",
      qboExpenseAccountId: context.accounting.defaults.expenseAccountId ?? "",
      qboApAccountId: context.accounting.defaults.apAccountId ?? "",
      accountingDimensions: {},
      billableToCustomer: Boolean(selectedProject && selectedProject.billingModel !== "fixed_price"),
    }])
  }, [amountDollars, context, description, lines.length, selectedProject?.billingModel, selectedProjectId])

  useEffect(() => {
    if (lines.length !== 1) return
    setLines((current) => current.map((line) => ({
      ...line,
      projectId: selectedProjectId,
      amountDollars: amountDollars || "0.00",
      description: description || line.description || "Vendor bill",
    })))
  }, [amountDollars, description, selectedProjectId])

  useEffect(() => {
    if (!open || !context || (!companyId && aiFields.size === 0)) return
    if (!vendorName.trim() && !description.trim()) return
    const key = [selectedProjectId, companyId, vendorName, description].join("|")
    if (lastAutoSuggestionKey.current === key) return
    lastAutoSuggestionKey.current = key
    const timeout = window.setTimeout(() => void runCodingSuggestion(), 450)
    return () => window.clearTimeout(timeout)
    // runCodingSuggestion intentionally follows this stable input key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiFields.size, companyId, context, description, open, selectedProjectId, vendorName])

  /**
   * Check the scanned lines against the commitment as soon as both exist. The
   * commitment is often chosen after the scan (the vendor match picks it), so
   * this watches both rather than firing once at the end of the scan.
   */
  useEffect(() => {
    if (!open || scannedLines.length === 0 || commitmentId === NO_COMMITMENT || amountCents <= 0) {
      return
    }
    const key = [commitmentId, amountCents, scannedLines.length].join("|")
    if (lastLineMatchKey.current === key) return
    lastLineMatchKey.current = key
    let cancelled = false
    void (async () => {
      const result = await previewPayableLineMatchAction({
        commitmentId,
        billTotalCents: amountCents,
        invoiceLines: scannedLines,
      })
      // Advisory: a failed check is silent. It must never stand between a
      // bookkeeper and entering a bill.
      if (cancelled || !result.success) return
      setLineMatch(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [amountCents, commitmentId, open, scannedLines])

  function applyVendor(value: string) {
    setVendorName(value)
    const exact = companies.find((company) => normalizeName(company.name) === normalizeName(value))
    setCompanyId(exact?.id ?? "")
    const matchingCommitment = commitments.find(
      (commitment) => commitment.company_name && normalizeName(commitment.company_name) === normalizeName(value),
    )
    if (matchingCommitment) {
      setCommitmentId(matchingCommitment.id)
      setCompanyId(matchingCommitment.company_id ?? exact?.id ?? "")
      if (matchingCommitment.retainage_percent != null) setRetainage(String(matchingCommitment.retainage_percent))
    }
    if (exact) applyCompanyPaymentDefaults(exact)
  }

  function applyCompanyPaymentDefaults(company: Company) {
    if (company.default_payment_method === "arc_pay") {
      if (arcPayAvailable) setPaymentChannel("arc")
      return
    }
    if (company.default_payment_method) {
      setPaymentChannel("external")
      setExternalMethod(company.default_payment_method)
    }
  }

  function selectCompany(company: Company) {
    setCompanyId(company.id)
    setVendorName(company.name)
    const matchingCommitment = commitments.find((commitment) => commitment.company_id === company.id)
    if (matchingCommitment) {
      setCommitmentId(matchingCommitment.id)
      if (matchingCommitment.retainage_percent != null) setRetainage(String(matchingCommitment.retainage_percent))
    }
    applyCompanyPaymentDefaults(company)
    setVendorPickerOpen(false)
    setChangingVendor(false)
  }

  function createVendor() {
    const name = vendorName.trim()
    if (!name) return
    setVendorPickerOpen(false)
    setChangingVendor(false)
    setEditVendorOpen(true)
  }

  function refreshVendorProfile(nextCompanyId = companyId) {
    if (!nextCompanyId) return
    void getPayableVendorProfileAction(nextCompanyId).then((result) => {
      if (result.success) setVendorProfile(result.data)
    })
  }

  /**
   * Returns a handler only when the scan actually placed the field, so a label
   * never offers to show evidence that does not exist. Clicking the
   * already-framed field clears the frame — a toggle, so a reviewer can put the
   * document back the way they found it.
   */
  function locate(field: ProvenanceField) {
    const region = provenance[field]
    if (!region) return undefined
    return () => setHighlight((current) => (current === region ? null : region))
  }

  function handleCommitmentChange(value: string) {
    setCommitmentId(value)
    if (value === NO_COMMITMENT) return
    const commitment = commitments.find((item) => item.id === value)
    if (!commitment) return
    setCompanyId(commitment.company_id ?? "")
    setVendorName(commitment.company_name ?? vendorName)
    if (commitment.retainage_percent != null) setRetainage(String(commitment.retainage_percent))
  }

  function handleProjectChange(value: string) {
    setSelectedProjectId(value)
    setCommitmentId(NO_COMMITMENT)
    setLines([])
    setCodingSuggestion(null)
    setProjectPickerOpen(false)
  }

  async function handleFileSelected(nextFile: File | null) {
    const generation = ++scanGeneration.current
    const before = scanState.current
    setScannedFileId(null)
    setIsScanning(false)
    setFile(nextFile)
    setAiFields(new Set())
    setProvenance({})
    setHighlight(null)
    if (!nextFile) return
    setIsScanning(true)
    try {
      const formData = new FormData()
      formData.append("invoice", nextFile)
      if (selectedProjectId) formData.append("projectId", selectedProjectId)
      if (companyId) formData.append("companyId", companyId)
      const response = await fetch("/api/payables/extract", { method: "POST", body: formData })
      const result = await response.json() as { ok: boolean; fileId?: string; error: string; data: import("@/lib/services/document-extraction").ExtractedPayableInvoice }
      if (generation !== scanGeneration.current || before.selectedProjectId !== scanState.current.selectedProjectId) return
      if (!response.ok) throw new Error(result.error)
      setScannedFileId(result.fileId ?? null)
      scannedFileProject.current = before.selectedProjectId
      const latest = scanState.current
      const untouched = (key: "vendorName" | "companyId" | "billNumber" | "amountDollars" | "billDate" | "dueDate" | "description" | "lines") => latest[key] === before[key]
      if (!result.ok) {
        toast.error(result.error, { description: "The invoice is still attached. You can enter the details manually." })
        return
      }
      const data = result.data
      scannedRead.current = data.billable
        ? { billNumber: data.billNumber, totalDollars: data.totalDollars, lineCount: data.lines.length }
        : null

      // A statement or lien waiver is not a payable. Say so instead of quietly
      // filling the form with numbers that would create a duplicate liability.
      if (!data.billable) {
        toast.warning("This does not look like an invoice", {
          description: data.notes[0] ?? "Review the document before entering it as a payable.",
        })
        return
      }

      const filled = new Set<string>()
      // The scan matches the vendor against the org's list, so an exact-name
      // miss ("ABC Plumbing LLC" vs "ABC Plumbing") no longer loses the link.
      if (data.vendorId && untouched("vendorName") && untouched("companyId")) {
        const known = latest.companies.find((company) => company.id === data.vendorId)
        if (known) { setVendorName(known.name); setCompanyId(known.id); filled.add("vendor") }
      }
      if (!filled.has("vendor") && data.vendorName && untouched("vendorName") && untouched("companyId")) { setVendorName(data.vendorName); setCompanyId(data.vendorId ?? ""); filled.add("vendor") }
      if (data.billNumber && untouched("billNumber")) { setBillNumber(data.billNumber); filled.add("billNumber") }
      if (data.totalDollars !== null && untouched("amountDollars")) { setAmountDollars(data.totalDollars.toFixed(2)); filled.add("amount") }
      if (data.billDate && untouched("billDate")) { setBillDate(data.billDate); filled.add("billDate") }
      if (data.dueDate && untouched("dueDate")) { setDueDate(data.dueDate); filled.add("dueDate") }
      if (data.description && untouched("description")) { setDescription(data.description); filled.add("description") }

      // Every billed line the scan found becomes a real split, so a 14-line
      // invoice arrives coded-and-splittable instead of as one lump sum the
      // bookkeeper has to re-type. A single-line invoice keeps the existing
      // one-line behaviour, which the amount-sync effect below still owns.
      const emptyInitialLine = before.lines.length === 0 && latest.lines.length === 1 &&
        !latest.lines[0].costCodeId && !latest.lines[0].budgetLineId &&
        (latest.lines[0].amountDollars === "0.00" || latest.lines[0].amountDollars === "") &&
        (latest.lines[0].description === "Vendor bill" || latest.lines[0].description === "")
      if (data.lines.length > 1 && latest.selectedProjectId && (untouched("lines") || emptyInitialLine) && untouched("amountDollars")) {
        setLines(data.lines.map((line) => ({
          id: crypto.randomUUID(),
          projectId: selectedProjectId,
          costCodeId: "",
          budgetLineId: "",
          description: line.description || "Vendor bill",
          amountDollars: (line.amountCents / 100).toFixed(2),
          qboExpenseAccountId: latest.context?.accounting.defaults.expenseAccountId ?? "",
          qboApAccountId: latest.context?.accounting.defaults.apAccountId ?? "",
          accountingDimensions: {},
          billableToCustomer: selectedProject?.billingModel !== "fixed_price",
        })))
        filled.add("lines")
      }

      setScannedLines(
        data.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPriceCents: line.unitPriceCents,
          amountCents: line.amountCents,
        })),
      )
      setAiFields(filled)
      setProvenance(data.provenance)

      const lineNote = data.lines.length > 1 ? ` · ${data.lines.length} lines` : ""
      if (data.duplicateSuspected) {
        // A warning, never a block: the create path used to hard-reject on a
        // bill-number collision, which is wrong when a vendor legitimately
        // reissues a number.
        toast.warning(`Possible duplicate${lineNote}`, {
          description: data.duplicateReason ?? "A similar payable already exists.",
        })
      } else if (data.sumMismatch) {
        toast.warning(`Invoice read${lineNote} · lines do not match the total`, {
          description: "Review the amounts before saving.",
        })
      } else {
        toast.success(`Invoice read${lineNote}`)
      }
    } catch (error) {
      if (generation === scanGeneration.current) toast.error((error as Error).message)
    } finally {
      if (generation === scanGeneration.current) setIsScanning(false)
    }
  }

  function handleFileDrag(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    setIsDraggingFile(event.type === "dragenter" || event.type === "dragover")
  }

  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    setIsDraggingFile(false)
    void handleFileSelected(event.dataTransfer.files?.[0] ?? null)
  }

  /**
   * Coding arrives on its own: the learned vendor rule first, the model only
   * when this vendor is genuinely a new case. Silent by design — the coding
   * lands in the fields below, which is the only report anyone needed.
   */
  async function runCodingSuggestion() {
    if (!vendorName.trim() && !description.trim()) return
    const generation = ++codingGeneration.current
    const before = scanState.current
    setIsSuggestingCoding(true)
    try {
      const suggestion = unwrapAction(await suggestPayableCreationCodingAction({
        projectId: selectedProjectId || null,
        companyId: companyId || null,
        vendorName: selectedCompany?.name ?? vendorName,
        description,
      }))
      const latest = scanState.current
      if (!suggestion || generation !== codingGeneration.current ||
        latest.selectedProjectId !== before.selectedProjectId || latest.companyId !== before.companyId ||
        latest.vendorName !== before.vendorName || latest.description !== before.description) return
      setCodingSuggestion(suggestion)
      setLines((current) => current.map((line, index) => index === 0 && line.id === before.lines[0]?.id ? {
        ...line,
        costCodeId: line.costCodeId === before.lines[0].costCodeId ? suggestion.costCodeId ?? line.costCodeId : line.costCodeId,
        budgetLineId: line.budgetLineId === before.lines[0].budgetLineId ? suggestion.budgetLineId ?? line.budgetLineId : line.budgetLineId,
        qboExpenseAccountId: line.qboExpenseAccountId === before.lines[0].qboExpenseAccountId ? suggestion.expenseAccountId ?? line.qboExpenseAccountId : line.qboExpenseAccountId,
        qboApAccountId: line.qboApAccountId === before.lines[0].qboApAccountId ? suggestion.apAccountId ?? line.qboApAccountId : line.qboApAccountId,
      } : line))
    } catch {
      // A missed suggestion is a form the person fills in themselves, which is
      // where they started. Never a toast for it.
    } finally {
      if (generation === codingGeneration.current) setIsSuggestingCoding(false)
    }
  }

  function resetForm() {
    codingGeneration.current += 1
    setIsSuggestingCoding(false)
    scanGeneration.current += 1
    setScannedFileId(null)
    setSelectedProjectId(projectId ?? NO_PROJECT)
    setContext(null)
    setCommitments([])
    setProjectPickerOpen(false)
    setCommitmentId(NO_COMMITMENT)
    setCompanyId("")
    setVendorName("")
    setBillNumber("")
    setAmountDollars("")
    setBillDate(format(new Date(), "yyyy-MM-dd"))
    setDueDate("")
    setDescription("")
    setRetainage("")
    setLienWaiver("not_required")
    setPaymentChannel("external")
    setPaymentChannelTouched(false)
    setExternalMethod("check")
    setFundingSourceId("")
    setPaymentSchedule("on_approval")
    setScheduledPaymentDate("")
    setPaymentMemo("")
    setPreferredApproverIds([])
    setRequiredPaymentApprovals(1)
    setFile(null)
    setAiFields(new Set())
    setLines([])
    setCodingSuggestion(null)
    setVendorProfile(null)
    setChangingVendor(false)
    lastAutoSuggestionKey.current = ""
  }

  function close() {
    if (busy) return
    onOpenChange(false)
    resetForm()
  }

  function submit(creationState: "draft" | "ready") {
    if (!coreValid || (creationState === "ready" && !readyValid) || !context) return
    startTransition(async () => {
      try {
        let fileId: string | null = scannedFileProject.current === selectedProjectId ? scannedFileId : null
        if (file && !fileId) {
          setIsUploading(true)
          const formData = new FormData()
          formData.append("file", file)
          if (selectedProjectId) formData.append("projectId", selectedProjectId)
          formData.append("category", "financials")
          const uploaded = unwrapAction(await uploadFileAction(formData))
          fileId = uploaded.id
          setIsUploading(false)
        }
        const expenseAccountName = (id: string) => context.accounting.expenseAccounts.find((account) => account.id === id)?.name
        const apAccountName = (id: string) => context.accounting.apAccounts.find((account) => account.id === id)?.name
        const read = scannedRead.current
        const result = unwrapAction(await createProjectVendorBillAction(selectedProjectId || null, {
          creation_state: creationState,
          commitment_id: commitmentId === NO_COMMITMENT ? null : commitmentId,
          company_id: companyId || undefined,
          vendor_name: selectedCompany?.name ?? (vendorName.trim() || undefined),
          bill_number: billNumber.trim(),
          total_cents: amountCents,
          bill_date: billDate,
          tax_jurisdiction_id: taxJurisdictionId === "none" ? null : taxJurisdictionId,
          tax_included_cents: parseDollarsToCents(taxIncludedDollars) ?? 0,
          use_tax_accrued_cents: parseDollarsToCents(useTaxDollars) ?? 0,
          due_date: dueDate || undefined,
          description: description.trim() || undefined,
          file_id: fileId,
          actual_lines: creationState === "draft" && !balanced ? undefined : lines.map((line) => ({
            project_id: selectedProjectId || null,
            cost_code_id: line.costCodeId || null,
            budget_line_id: line.budgetLineId || null,
            description: line.description.trim() || description.trim() || `Bill ${billNumber.trim()}`,
            amount_cents: parseDollarsToCents(line.amountDollars) ?? 0,
            billable_to_customer: selectedProjectId ? line.billableToCustomer : false,
            ...(context.accounting.provider === "arc_books" ? { arc_books_gl_account_id: line.qboExpenseAccountId || undefined } : { qbo_expense_account_id: line.qboExpenseAccountId || undefined }),
            qbo_expense_account_name: context.accounting.provider === "arc_books" ? undefined : expenseAccountName(line.qboExpenseAccountId),
            qbo_ap_account_id: context.accounting.provider === "arc_books" ? undefined : line.qboApAccountId || undefined,
            qbo_ap_account_name: context.accounting.provider === "arc_books" ? undefined : apAccountName(line.qboApAccountId),
            accounting_dimensions: line.accountingDimensions,
          })),
          retainage_percent: selectedProjectId && retainage ? Number(retainage) : undefined,
          lien_waiver_status: selectedProjectId ? lienWaiver : "not_required",
          payment_channel: paymentChannel,
          preferred_payment_method: paymentChannel === "arc" ? "ach" : externalMethod,
          payment_memo: paymentChannel === "arc" ? paymentMemo.trim() || null : null,
          preferred_funding_source_id: paymentChannel === "arc" ? fundingSourceId || null : null,
          payment_schedule: paymentChannel === "arc" ? paymentSchedule : "on_approval",
          scheduled_payment_date: paymentChannel === "arc" && paymentSchedule === "scheduled" ? scheduledPaymentDate || null : null,
          preferred_approver_ids: paymentChannel === "arc" ? preferredApproverIds : [],
          coding_source: codingSuggestion?.source ?? "manual",
          coding_confidence: codingSuggestion?.confidence,
        }))
        if (!result.success) {
          toast.error(result.error)
          return
        }
        // Close the learning loop: what the scan read vs what the human filed.
        // Fire-and-forget — the payable is already created either way.
        if (read && companyId) {
          void recordExtractionCorrectionAction({
            companyId,
            read,
            corrected: {
              billNumber: billNumber.trim() || null,
              totalDollars: amountCents / 100,
              lineCount: lines.length,
            },
          })
        }

        toast.success(creationState === "draft" ? "Payable saved as draft" : "Payable created and ready for review")
        onOpenChange(false)
        resetForm()
        onSuccess?.()
      } catch (error) {
        toast.error((error as Error).message)
      } finally {
        setIsUploading(false)
      }
    })
  }

  const currentProjectOptions = selectedProject
    ? [selectedProject]
    : selectedProjectId
      ? [{ id: selectedProjectId, name: "Current project", billingModel: "fixed_price" as const }]
      : []
  // Approved change orders are part of the contract, so the ceiling this bill is
  // measured against is the revised total, not what was originally signed.
  const commitmentCeilingCents = selectedCommitment?.revised_total_cents ?? selectedCommitment?.total_cents
  const commitmentAfterBill = (selectedCommitment?.billed_cents ?? 0) + amountCents
  const commitmentOver = Boolean(commitmentCeilingCents && commitmentAfterBill > commitmentCeilingCents)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent
        showCloseButton={false}
        className="!fixed !inset-0 !top-0 !left-0 grid h-[100dvh] max-h-none w-[100vw] max-w-none grid-rows-[4rem_minmax(0,1fr)_4rem] !translate-x-0 !translate-y-0 gap-0 overflow-hidden border-0 p-0 sm:!max-w-none"
      >
        <DialogTitle className="sr-only">Create payable</DialogTitle>
        <DialogDescription className="sr-only">Review the invoice, code the cost, and prepare payment details.</DialogDescription>

        <header className="flex h-16 shrink-0 items-center justify-between border-b bg-background px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={close} disabled={busy}>
              <X className="size-4" />
              <span className="sr-only">Close payable workspace</span>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-base font-semibold tracking-tight">New payable</h1>
                <Badge variant="outline" className="hidden font-normal text-muted-foreground sm:inline-flex">Draft until created</Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {selectedProject?.name ?? "Choose a project"}{selectedCompany ? ` · ${selectedCompany.name}` : ""}
              </p>
            </div>
          </div>
        </header>

        <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-2">
          <section className="relative hidden min-h-0 flex-col border-r bg-muted/20 lg:flex">
            <div
              className={cn("relative min-h-0 flex-1", isDraggingFile && "bg-primary/5")}
              onDragEnter={handleFileDrag}
              onDragOver={handleFileDrag}
              onDragLeave={handleFileDrag}
              onDrop={handleFileDrop}
            >
              {file && previewAttachments.length > 0 ? (
                <PayableDocumentPane
                  attachments={previewAttachments}
                  invoiceOnly
                  highlight={highlight}
                  scanning={isScanning}
                  onReplace={async (nextFile) => handleFileSelected(nextFile)}
                  onDetach={async () => handleFileSelected(null)}
                  className="h-full"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="group flex h-full w-full flex-col items-center justify-center gap-4 px-10 text-center transition-colors hover:bg-muted/30"
                >
                  <span className="flex size-14 items-center justify-center rounded-full border bg-background transition-transform duration-150 group-active:scale-95">
                    <Upload className="size-6 text-muted-foreground" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium">Drop an invoice here</span>
                    <span className="mt-1 block text-xs text-muted-foreground">PDF, JPG, PNG, WebP, or HEIC · up to 10 MB</span>
                  </span>
                  <span className="text-xs font-medium text-primary">Choose document</span>
                </button>
              )}
              {isDraggingFile ? (
                <div className="pointer-events-none absolute inset-4 flex items-center justify-center border-2 border-dashed border-primary bg-background/90 text-sm font-medium text-primary">
                  <span className="relative">Drop to read this invoice</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="flex min-h-0 flex-col bg-background">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
                <div className="desk-rise space-y-8">
                  <div className="flex justify-end lg:hidden">
                    <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                      <Paperclip className="mr-2 size-4" /> {file ? "Replace" : "Attach"}
                    </Button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <FieldLabel onLocate={locate("vendor_name")}>Vendor</FieldLabel>
                        {selectedCompany && !changingVendor ? (
                          <PayableVendorCard
                            name={selectedCompany.name}
                            profile={vendorProfile}
                            loading={loadingVendorProfile}
                            onChangeVendor={() => { setChangingVendor(true); setVendorPickerOpen(true) }}
                            onEditVendor={() => setEditVendorOpen(true)}
                            onPaymentInvited={() => refreshVendorProfile(selectedCompany.id)}
                          />
                        ) : (
                          <Popover open={vendorPickerOpen} onOpenChange={(next) => { setVendorPickerOpen(next); if (!next && selectedCompany) setChangingVendor(false) }} modal>
                            <PopoverTrigger asChild>
                              <Button type="button" variant="outline" role="combobox" className="h-10 w-full justify-between px-3 font-normal">
                                <span className={cn("truncate", !selectedCompany && !vendorName && "text-muted-foreground")}>{selectedCompany?.name ?? (vendorName || "Choose vendor")}</span>
                                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                              <Command shouldFilter={false}>
                                <CommandInput value={vendorName} onValueChange={applyVendor} placeholder="Search vendors…" />
                                <CommandList
                                  className="max-h-[min(18rem,var(--radix-popover-content-available-height))] overflow-y-scroll overscroll-contain [scrollbar-gutter:stable]"
                                  onWheel={(event) => event.stopPropagation()}
                                  onTouchMove={(event) => event.stopPropagation()}
                                >
                                  <CommandEmpty>{loadingCompanies ? "Loading vendors…" : "No matching vendor"}</CommandEmpty>
                                  <CommandGroup heading="Vendors">
                                    {visibleCompanies.map((company) => (
                                      <CommandItem key={company.id} value={company.name} onSelect={() => selectCompany(company)}>
                                        <Check className={cn("size-4", company.id === companyId ? "opacity-100" : "opacity-0")} />
                                        <span className="min-w-0 flex-1 truncate">{company.name}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                  {vendorName.trim().length >= 2 && !exactCompany ? (
                                    <CommandGroup heading="New vendor">
                                      <CommandItem value={`create-${vendorName}`} onSelect={createVendor}>
                                        <Receipt className="size-4" />
                                        Add “{vendorName.trim()}” as a vendor
                                      </CommandItem>
                                    </CommandGroup>
                                  ) : null}
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        )}
                        {!selectedCompany && vendorName.trim().length >= 2 ? (
                          <button
                            type="button"
                            onClick={createVendor}
                            className="mt-2 flex w-full items-center justify-between gap-4 border bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/35"
                          >
                            <span>
                              <span className="block text-sm font-medium">New vendor detected</span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Add the profile, contacts, compliance, tax, and Arc Pay details.
                              </span>
                            </span>
                            <span className="shrink-0 text-xs font-medium text-primary">Add vendor</span>
                          </button>
                        ) : null}
                      </div>

                      <div className="min-w-0">
                        <FieldLabel>Project</FieldLabel>
                        {projectId ? (
                          <Input value={selectedProject?.name ?? "Current project"} readOnly className="h-10 w-full min-w-0 truncate bg-muted/30" />
                        ) : (
                          <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen} modal>
                            <PopoverTrigger asChild>
                              <Button type="button" variant="outline" role="combobox" aria-expanded={projectPickerOpen} className="h-10 w-full min-w-0 justify-between px-3 font-normal">
                                <span className="min-w-0 truncate">{selectedProject?.name ?? "Overhead / no project"}</span>
                                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                              <Command>
                                <CommandInput placeholder="Search projects…" />
                                <CommandList
                                  className="max-h-[min(18rem,var(--radix-popover-content-available-height))] overflow-y-scroll overscroll-contain [scrollbar-gutter:stable]"
                                  onWheel={(event) => event.stopPropagation()}
                                  onTouchMove={(event) => event.stopPropagation()}
                                >
                                  <CommandEmpty>No projects found.</CommandEmpty>
                                  <CommandGroup heading="Allocation">
                                    <CommandItem value="Overhead no project" onSelect={() => handleProjectChange(NO_PROJECT)}>
                                      <Check className={cn("size-4 shrink-0", !selectedProjectId ? "opacity-100" : "opacity-0")} />
                                      <span className="min-w-0 truncate">Overhead / no project</span>
                                    </CommandItem>
                                    {projects.map((project) => (
                                      <CommandItem key={project.id} value={project.name} onSelect={() => handleProjectChange(project.id)}>
                                        <Check className={cn("size-4 shrink-0", project.id === selectedProjectId ? "opacity-100" : "opacity-0")} />
                                        <span className="min-w-0 truncate">{project.name}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        )}
                      </div>

                      <div>
                        <FieldLabel>Commitment</FieldLabel>
                        <Select value={commitmentId} onValueChange={handleCommitmentChange} disabled={!selectedProjectId || loadingCommitments}>
                          <SelectTrigger className="h-10 w-full min-w-0 [&>span]:min-w-0 [&>span]:truncate"><SelectValue placeholder={loadingCommitments ? "Loading commitments…" : "No commitment"} /></SelectTrigger>
                          <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]">
                            <SelectItem value={NO_COMMITMENT}>No commitment</SelectItem>
                            {commitments.map((commitment) => <SelectItem key={commitment.id} value={commitment.id}><span className="block truncate">{commitment.title}</span></SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>

                      {selectedCommitment ? (
                        <div className={cn("sm:col-span-2 flex items-center justify-between border px-3 py-2 text-xs", commitmentOver ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted/20 text-muted-foreground")}>
                          <span>{formatMoneyFromCents(selectedCommitment.billed_cents ?? 0)} billed of {formatMoneyFromCents(commitmentCeilingCents ?? 0)}</span>
                          <span className="font-medium tabular-nums">After invoice {formatMoneyFromCents(commitmentAfterBill)}</span>
                        </div>
                      ) : null}

                      <div>
                        <FieldLabel onLocate={locate("bill_number")}>Invoice number</FieldLabel>
                        <Input value={billNumber} onChange={(event) => setBillNumber(event.target.value)} placeholder="INV-1048" className="h-10" />
                      </div>
                      <div>
                        <FieldLabel onLocate={locate("total")}>Invoice total</FieldLabel>
                        <div className="relative">
                          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">$</span>
                          <Input value={amountDollars} onChange={(event) => setAmountDollars(event.target.value.replace(/[^\d.,]/g, ""))} inputMode="decimal" placeholder="0.00" className="h-10 pl-7 tabular-nums" />
                        </div>
                      </div>
                      <div>
                        <FieldLabel onLocate={locate("bill_date")}>Invoice date</FieldLabel>
                        <DateField value={billDate} onChange={setBillDate} placeholder="Choose invoice date" />
                      </div>
                      <div>
                        <FieldLabel onLocate={locate("due_date")}>Due date</FieldLabel>
                        <DateField value={dueDate} onChange={setDueDate} placeholder="Choose due date" clearable />
                      </div>
                      <div className="sm:col-span-2">
                        <FieldLabel>Memo</FieldLabel>
                        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Work, materials, or billing period…" rows={3} />
                      </div>
                      {context?.taxJurisdictions.length ? (
                        <>
                          <div>
                            <FieldLabel>Tax jurisdiction</FieldLabel>
                            <Select value={taxJurisdictionId} onValueChange={setTaxJurisdictionId}><SelectTrigger className="h-10"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No tax jurisdiction</SelectItem>{context.taxJurisdictions.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div><FieldLabel>Tax on vendor bill</FieldLabel><Input value={taxIncludedDollars} onChange={(event) => setTaxIncludedDollars(event.target.value.replace(/[^\d.,]/g, ""))} inputMode="decimal" placeholder="0.00" /></div>
                            <div><FieldLabel>Use tax to accrue</FieldLabel><Input value={useTaxDollars} onChange={(event) => setUseTaxDollars(event.target.value.replace(/[^\d.,]/g, ""))} inputMode="decimal" placeholder="0.00" /></div>
                          </div>
                        </>
                      ) : null}
                  </div>

                  <div className="space-y-6 border-t pt-8">
                    {isSuggestingCoding ? (
                      <div className="flex items-center gap-3 border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                        <Loader2 className="size-4 animate-spin text-primary" /> Coding this invoice…
                      </div>
                    ) : null}

                    {lineMatch ? <CreateLineMatchEvidence assessment={lineMatch} /> : null}

                    {loadingContext ? (
                      <div className="space-y-3" aria-label="Loading coding options">
                        <div className="h-20 animate-pulse bg-muted" />
                        <div className="h-44 animate-pulse bg-muted" />
                      </div>
                    ) : contextError ? (
                      <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        Coding options could not be loaded. Reselect the project, or save a draft.
                      </div>
                    ) : context ? (
                      <PayableLinesEditor
                        lines={lines}
                        onLinesChange={(updater) => { setLines(updater); setCodingSuggestion(null) }}
                        locked={false}
                        isVendorCredit={false}
                        isReassignable={false}
                        projects={currentProjectOptions}
                        costCodes={context.costCodes}
                        costCodesEnabled={context.costCodesEnabled}
                        budgetLines={context.budgetLines}
                        accountingEnabled={context.accounting.enabled}
                        accountingProviderName={context.accounting.providerName}
                        accountingDimensions={context.accounting.dimensions}
                        qboExpenseAccounts={context.accounting.expenseAccounts}
                        qboApAccounts={context.accounting.provider === "arc_books" ? [] : context.accounting.apAccounts}
                        billTotalCents={amountCents}
                        fallbackProjectId={selectedProjectId}
                        defaultDescription={description || "Vendor bill"}
                        headerQboExpenseAccountId={lines[0]?.qboExpenseAccountId ?? context.accounting.defaults.expenseAccountId ?? ""}
                        headerQboApAccountId={lines[0]?.qboApAccountId ?? context.accounting.defaults.apAccountId ?? ""}
                        defaultBillable={() => selectedProject?.billingModel !== "fixed_price"}
                      />
                    ) : null}

                  </div>

                  <div className="space-y-6 border-t pt-8">

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <FieldLabel>Payment method</FieldLabel>
                        <div className="grid border sm:grid-cols-2">
                          <button type="button" aria-pressed={paymentChannel === "arc"} disabled={!arcPayAvailable} onClick={() => { setPaymentChannelTouched(true); setPaymentChannel("arc") }} className={cn("flex items-start gap-3 px-4 py-3 text-left transition-colors sm:border-r", paymentChannel === "arc" ? "bg-primary/10" : "hover:bg-muted/30", !arcPayAvailable && "cursor-not-allowed opacity-50")}>
                            <Landmark className={cn("mt-0.5 size-4 shrink-0", paymentChannel === "arc" ? "text-primary" : "text-muted-foreground")} />
                            <span className="min-w-0"><span className="block text-sm font-medium">Pay with Arc Pay</span><span className="mt-0.5 block text-xs text-muted-foreground">{arcPayAvailable ? "Secure bank transfer with approval controls" : "A verified funding account is required"}</span></span>
                            <Check className={cn("ml-auto size-4 shrink-0 text-primary", paymentChannel === "arc" ? "opacity-100" : "opacity-0")} />
                          </button>
                          <button type="button" aria-pressed={paymentChannel === "external"} onClick={() => { setPaymentChannelTouched(true); setPaymentChannel("external") }} className={cn("flex items-start gap-3 border-t px-4 py-3 text-left transition-colors sm:border-t-0", paymentChannel === "external" ? "bg-primary/10" : "hover:bg-muted/30")}>
                            <CreditCard className={cn("mt-0.5 size-4 shrink-0", paymentChannel === "external" ? "text-primary" : "text-muted-foreground")} />
                            <span className="min-w-0"><span className="block text-sm font-medium">Builder-managed payment</span><span className="mt-0.5 block text-xs text-muted-foreground">Record a check, wire, card, or bank payment</span></span>
                            <Check className={cn("ml-auto size-4 shrink-0 text-primary", paymentChannel === "external" ? "opacity-100" : "opacity-0")} />
                          </button>
                        </div>
                        {!arcPayAvailable ? <Link href="/settings/payments" className="mt-2 inline-block text-xs text-primary underline underline-offset-2">Connect a funding account in Settings</Link> : null}
                      </div>
                      {paymentChannel === "external" ? (
                        <div>
                          <FieldLabel>External payment type</FieldLabel>
                          <Select
                            value={externalMethod}
                            onValueChange={(value) => { if (isExternalPaymentMethod(value)) setExternalMethod(value) }}
                          >
                            <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {EXTERNAL_PAYMENT_METHODS.map((method) => (
                                <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <FieldLabel>Pay from account</FieldLabel>
                            <Select value={fundingSourceId} onValueChange={setFundingSourceId} disabled={fundingSources.length === 0}>
                              <SelectTrigger className="h-10 w-full min-w-0 overflow-hidden [&>span]:min-w-0 [&>span]:truncate">
                                <SelectValue placeholder={fundingSources.length === 0 ? "No funding account available" : "Choose funding account"} />
                              </SelectTrigger>
                              <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]">
                                {fundingSources.map((source) => (
                                  <SelectItem key={source.id} value={source.id}>
                                    <span className="block truncate">{source.label}{source.isDefault ? " · Default" : ""}</span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="min-w-0">
                            <FieldLabel>Send payment to</FieldLabel>
                            <div className="flex h-10 w-full min-w-0 items-center truncate border bg-muted/20 px-3 text-sm">
                              <span className="block truncate">{vendorProfile?.payoutBankLast4
                                ? `${vendorProfile.payoutBankName ?? "Verified bank"} ending in ${vendorProfile.payoutBankLast4}`
                                : "Vendor payout account not available"}</span>
                            </div>
                            {selectedCompany && vendorProfile && !["ready", "suspended", "revoked"].includes(vendorProfile.paymentReadiness) ? (
                              <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-warning">
                                <span>Not set up for Arc Pay</span>
                                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setEditVendorOpen(true)}>
                                  Invite vendor
                                </button>
                              </div>
                            ) : null}
                          </div>
                          <div className="sm:col-span-2">
                            <FieldLabel>ACH payment memo</FieldLabel>
                            <Input value={paymentMemo} onChange={(event) => setPaymentMemo(event.target.value.slice(0, 140))} placeholder={billNumber ? `Invoice ${billNumber}` : "Invoice or remittance note"} className="h-10" maxLength={140} />
                            <p className="mt-1.5 text-xs text-muted-foreground">Included in Arc’s remittance record and forwarded to the payment provider.</p>
                          </div>
                          <div className="sm:col-span-2">
                            <FieldLabel>Payment schedule</FieldLabel>
                            <div className="grid border sm:grid-cols-2">
                              <button
                                type="button"
                                aria-pressed={paymentSchedule === "on_approval"}
                                onClick={() => setPaymentSchedule("on_approval")}
                                className={cn(
                                  "px-3 py-2.5 text-left text-sm transition-colors sm:border-r",
                                  paymentSchedule === "on_approval" ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/30",
                                )}
                              >
                                <span className="block font-medium">Release after approval</span>
                                <span className="mt-0.5 block text-xs">Eligible for the next payment run.</span>
                              </button>
                              <button
                                type="button"
                                aria-pressed={paymentSchedule === "scheduled"}
                                onClick={() => setPaymentSchedule("scheduled")}
                                className={cn(
                                  "border-t px-3 py-2.5 text-left text-sm transition-colors sm:border-t-0",
                                  paymentSchedule === "scheduled" ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/30",
                                )}
                              >
                                <span className="block font-medium">Schedule a release date</span>
                                <span className="mt-0.5 block text-xs">Approval will not release it early.</span>
                              </button>
                            </div>
                            {paymentSchedule === "scheduled" ? (
                              <DateField
                                value={scheduledPaymentDate}
                                onChange={setScheduledPaymentDate}
                                placeholder="Choose payment date"
                                min={format(new Date(), "yyyy-MM-dd")}
                                className="mt-2"
                              />
                            ) : null}
                            {settlementEstimate ? (
                              <p className="mt-2 text-xs text-muted-foreground">
                                Payment date {readablePaymentDate(plannedPaymentDate)} · estimated arrival {readablePaymentDate(settlementEstimate.vendorReceivesEarliest)}–{readablePaymentDate(settlementEstimate.vendorReceivesLatest)}
                              </p>
                            ) : null}
                          </div>
                        </>
                      )}
                      {selectedProjectId ? (
                        <>
                          <div className="min-w-0">
                            <FieldLabel>Retainage</FieldLabel>
                            <div className="relative">
                              <Input value={retainage} onChange={(event) => setRetainage(event.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="0" className="h-10 pr-8 tabular-nums" />
                              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">%</span>
                            </div>
                          </div>
                          <div className="min-w-0">
                            <FieldLabel>Lien waiver</FieldLabel>
                            <Select value={lienWaiver} onValueChange={setLienWaiver}>
                              <SelectTrigger className="h-10 w-full min-w-0 overflow-hidden [&>span]:min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
                              <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]">
                                <SelectItem value="not_required">Not required</SelectItem>
                                <SelectItem value="requested">Request from vendor</SelectItem>
                                <SelectItem value="received">Received</SelectItem>
                              </SelectContent>
                            </Select>
                            {lienWaiver === "requested" ? <p className="mt-1.5 text-xs text-muted-foreground">Arc will send the vendor a secure waiver-signing request when this payable is created.</p> : null}
                          </div>
                        </>
                      ) : (
                        <div className="sm:col-span-2 border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                          Overhead payables skip retainage, lien waivers, and construction compliance holds.
                        </div>
                      )}
                    </div>

                    <div className="border bg-muted/20 px-4 py-4">
                      <PayableApprovalRoute
                        channel={paymentChannel}
                        externalMethod={externalMethod}
                        routing={approvalRouting}
                        amountCents={paymentAmountCents}
                        requiredApprovals={requiredPaymentApprovals}
                        requesterMayApprove={requesterMayApprove}
                        unavailableReason={paymentSetupError ? "by your org’s payment approvers — your role cannot see who they are" : null}
                        selectedApproverIds={preferredApproverIds}
                        onSelectedApproverIdsChange={setPreferredApproverIds}
                      />
                    </div>

                    {/* Arc's fees only exist when Arc moves the money. */}
                    {paymentChannel === "arc" ? (
                      <div className="border px-4 py-3">
                        {paymentQuote ? (
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-xs text-muted-foreground">Vendor receives</p>
                              <p className="mt-0.5 text-base font-semibold tabular-nums">{formatMoneyFromCents(paymentQuote.vendorAmountCents)}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-muted-foreground">
                                Arc fee {formatMoneyFromCents(paymentQuote.platformFeeCents)}
                                {paymentQuote.processorFeeCents > 0 ? ` · Processing ${formatMoneyFromCents(paymentQuote.processorFeeCents)}` : ""}
                              </p>
                              <p className="mt-0.5 text-sm font-medium tabular-nums">
                                Total debit {formatMoneyFromCents(paymentQuote.vendorAmountCents + paymentQuote.processorFeeCents + paymentQuote.platformFeeCents)}
                              </p>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">{paymentSetupError ?? "Enter an invoice amount to preview the Arc Pay transfer and fees."}</p>
                        )}
                        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                          The funding account, vendor’s verified payment destination, fees, and approval route are confirmed before payment is submitted. Creating this payable does not move money.
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer className="flex h-16 shrink-0 items-center justify-end border-t bg-background px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="button" variant="outline" onClick={() => submit("draft")} disabled={!coreValid || busy || !context}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save draft
            </Button>
            <Button type="button" onClick={() => submit("ready")} disabled={!readyValid || busy || !context}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Create payable
            </Button>
          </div>
        </footer>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
          className="hidden"
          onChange={(event) => void handleFileSelected(event.target.files?.[0] ?? null)}
        />

        {/* The invoice is the best moment to fix the vendor record that controls
            whether this bill can be approved and paid. */}
        <PayableVendorProfileDialog
          open={editVendorOpen}
          onOpenChange={setEditVendorOpen}
          company={selectedCompany ?? undefined}
          initialName={vendorName.trim() || undefined}
          profile={vendorProfile}
          onPaymentInvited={() => refreshVendorProfile(selectedCompany?.id)}
          onSaved={(saved) => {
            setCompanies((current) => {
              const next = current.some((company) => company.id === saved.id)
                ? current.map((company) => company.id === saved.id ? saved : company)
                : [...current, saved]
              return next.sort((left, right) => left.name.localeCompare(right.name))
            })
            selectCompany(saved)
            refreshVendorProfile(saved.id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * What the scanned lines bill against the commitment, checked before the
 * payable is saved. Silent when everything reconciles — the point is to catch
 * a line the commitment does not cover while the invoice is still on screen.
 */
function CreateLineMatchEvidence({ assessment }: { assessment: PayableLineMatchAssessment }) {
  const { rollup } = assessment
  const exceptions = assessment.lines.filter((line) => line.matchKind === "unmatched" || line.overCommitmentLine)
  if (exceptions.length === 0 && rollup.overCommitmentCents === 0) return null
  const money = (cents: number) =>
    (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

  return (
    <div className="space-y-1 border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs">
      <p className="font-medium text-warning">
        {rollup.overCommitmentCents > 0
          ? `This bill takes the commitment ${money(rollup.overCommitmentCents)} over its approved value`
          : `${exceptions.length} line${exceptions.length === 1 ? "" : "s"} do not match the commitment`}
      </p>
      {exceptions.map((line, index) => (
        <p key={`${line.commitmentLineId ?? "unmatched"}-${index}`} className="text-muted-foreground">
          <span className="text-foreground">{line.invoiceLine.description}</span>
          {line.commitmentLineNumber ? ` · line ${line.commitmentLineNumber}` : " · no matching commitment line"}
          {line.note ? ` — ${line.note}` : ""}
        </p>
      ))}
    </div>
  )
}

"use client"

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { addDays, format, parse } from "date-fns"
import { AlertTriangle, CalendarIcon, Check, ChevronDown, Copy, CreditCard, Landmark, Pencil, Plus, Search, Trash2, UserRound, X } from "lucide-react"
import NumberFlow from "@number-flow/react"
import { toast } from "sonner"

import type { Address, ChangeOrder, Contact, CostCode, Invoice, Project } from "@/lib/types"
import { invoiceInputSchema, type InvoiceInput } from "@/lib/validation/invoices"
import {
  createQBOIncomeAccountAction,
  createQboCustomerAction,
  generateInvoicePdfAction,
  getInvoiceComposerContextAction,
  requestInvoiceApprovalAction,
  decideInvoiceApprovalAction,
  searchQboCustomersAction,
  type InvoiceComposerContext,
} from "@/app/(app)/invoices/actions"
import type { NewInvoiceKind } from "@/lib/financials/invoice-destinations"
import { invoicePaymentMethods, paymentMethodLabels, type ArcInvoiceDocumentData, type ArcInvoiceLine } from "./arc-invoice-document"
import { attachFileAction, detachFileLinkAction, listAttachmentsAction, uploadFileAction } from "@/app/(app)/documents/actions"
import type { AttachedFile } from "@/components/files"
import { InvoiceAttachmentsField } from "./invoice-attachments-field"
import { isInvoiceAttachment } from "@/lib/invoices/attachment-roles"
import { Switch } from "@/components/ui/switch"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { generateInvoiceFromCostsAction } from "@/app/(app)/projects/[id]/financials/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { buildPartyDetailsBlock, parsePartyDetailsBlock } from "@/lib/invoices/party-details"
import { calculateInvoiceTotals, deriveManualRetainageCents } from "@/lib/financials/invoice-totals"
import { UnbilledCostsPicker, type CostSelection } from "@/components/invoices/unbilled-costs-picker"
import { unwrapAction } from "@/lib/action-result"
import { usePageTitle } from "@/components/layout/page-title-context"
import { getProjectPosture } from "@/lib/product-tier"
import { getReceivablesPosturePolicy } from "@/lib/receivables/policy"
import { groupCostCodesByStandard } from "@/lib/cost-code-groups"
import { accountingProviderLabel } from "@/components/accounting/provider-label"
import { cn } from "@/lib/utils"

type BillingSource = "manual" | "draw" | "change_order" | "from_costs"

type ComposerLine = {
  id: string
  description: string
  quantity: string
  unit: string
  unit_cost: string
  taxable: boolean
  tax_rate_percent: string
  cost_code_id: string | null
  qbo_income_account_id: string | null
  qbo_income_account_name: string | null
  arc_books_gl_account_id: string | null
  arc_books_gl_account_name: string | null
  billable_cost_ids?: string[]
  cost_cents?: number | null
  markup_cents?: number | null
  markup_percent?: number | null
}

type DiscountType = "percent" | "fixed"
type InvoiceKind = "standard" | "earnest_deposit" | "closing"

type DrawOption = {
  id: string
  project_id: string
  draw_number: number
  title: string
  description: string | null
  amount_cents: number
  due_date: string | null
  status: string
}

type QBOIncomeAccountOption = { id: string; name: string; fullyQualifiedName?: string }
type QBOCustomerOption = { id: string; name: string; email?: string | null; billingAddress?: string | null }
type QboDiagnostics = { connectionLastError: string | null; refreshFailureCount: number; accountLoadWarning: string | null }
type TaxJurisdictionOption = { id: string; name: string; sales_tax_rate_micros: number; effective_from: string; effective_through: string | null }

export type AutosaveState = "idle" | "saving" | "saved" | "error"

/** What the composer's rail needs to know about the document to say whether it can go out. */
export interface InvoiceEditorSnapshot {
  totalCents: number
  dueDate: string
  issueDate: string
  recipients: string[]
  approvalStatus: NonNullable<Invoice["approval_status"]>
  /** The form can be saved as it stands. */
  complete: boolean
  dirty: boolean
  recoverySaved: boolean
  problems: Array<{ field: string; message: string }>
  /** Every line carries the accounting code the connected provider requires. */
  coded: boolean
  invoiceId: string | null
  /** The document as the customer would receive it right now. */
  preview: { data: ArcInvoiceDocumentData; lines: ArcInvoiceLine[] }
}

/** The editor's imperative surface — the rail drives it, the editor owns the document. */
export interface InvoiceEditorHandle {
  /** Flush the draft to the server and return its id. Throws when the form is incomplete. */
  persist: () => Promise<string>
  saveDraft: () => Promise<string>
  focusField: (field: string) => void
  discard: () => Promise<void>
  resumeSaving: () => void
  requestApproval: () => Promise<void>
  approve: () => Promise<void>
  downloadPdf: () => Promise<void>
}

function formatMoney(dollars: number) {
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatAddressBlock(value?: string | null) {
  if (!value) return ""
  return value
    .split(/\n|,/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

function contactBillingAddress(address?: Address) {
  if (!address) return ""
  return formatAddressBlock(address.formatted || [address.street1, address.street2, [address.city, address.state, address.postal_code].filter(Boolean).join(" "), address.country].filter(Boolean).join("\n"))
}

function lineTaxRateOverride(line: any): string {
  const raw = line.tax_rate_percent ?? (line.metadata as Record<string, any> | undefined)?.tax_rate_percent
  return raw == null ? "" : String(raw)
}

function toLineState(invoice?: Invoice | null): ComposerLine[] {
  const rawLines = invoice?.lines ?? (invoice?.metadata?.lines as any[] | undefined) ?? []
  const lines = Array.isArray(rawLines)
    ? rawLines.filter((line: any) => {
        const unit = String(line.unit ?? "").toLowerCase()
        const systemKind = (line.metadata as Record<string, any> | undefined)?.system_generated_kind
        return unit !== "retainage" && systemKind !== "retainage_hold"
      })
    : []
  if (!Array.isArray(lines) || lines.length === 0) {
    return [blankLine()]
  }
  return lines.map((line: any) => ({
    id: crypto.randomUUID(),
    description: String(line.description ?? ""),
    quantity: String(line.quantity ?? 1),
    unit: String(line.unit ?? "ea"),
    unit_cost: String(((line.unit_cost_cents ?? 0) / 100).toFixed(2)),
    taxable: line.taxable !== false,
    tax_rate_percent: lineTaxRateOverride(line),
    cost_code_id: line.cost_code_id ?? null,
    qbo_income_account_id:
      (line.qbo_income_account_id as string | null | undefined) ??
      ((line.metadata as Record<string, any> | undefined)?.qbo_income_account_id as string | null | undefined) ??
      null,
    qbo_income_account_name:
      (line.qbo_income_account_name as string | null | undefined) ??
      ((line.metadata as Record<string, any> | undefined)?.qbo_income_account_name as string | null | undefined) ??
      null,
    arc_books_gl_account_id:
      (line.arc_books_gl_account_id as string | null | undefined) ??
      ((line.metadata as Record<string, any> | undefined)?.arc_books_gl_account_id as string | null | undefined) ??
      null,
    arc_books_gl_account_name:
      (line.arc_books_gl_account_name as string | null | undefined) ??
      ((line.metadata as Record<string, any> | undefined)?.arc_books_gl_account_name as string | null | undefined) ??
      null,
  }))
}

function blankLine(): ComposerLine {
  return {
    id: crypto.randomUUID(),
    description: "",
    quantity: "1",
    unit: "ea",
    unit_cost: "",
    taxable: true,
    tax_rate_percent: "",
    cost_code_id: null,
    qbo_income_account_id: null,
    qbo_income_account_name: null,
    arc_books_gl_account_id: null,
    arc_books_gl_account_name: null,
  }
}

function parseDate(dateStr: string): Date | undefined {
  if (!dateStr) return undefined
  try {
    return parse(dateStr, "yyyy-MM-dd", new Date())
  } catch {
    return undefined
  }
}

function linesFromChangeOrder(changeOrder: ChangeOrder): ComposerLine[] {
  if (Array.isArray(changeOrder.lines) && changeOrder.lines.length > 0) {
    return changeOrder.lines.map((line) => ({
      id: crypto.randomUUID(),
      description: line.description ?? "",
      quantity: String(line.quantity ?? 1),
      unit: String(line.unit ?? "ea"),
      unit_cost: ((line.unit_cost_cents ?? 0) / 100).toFixed(2),
      taxable: line.taxable !== false,
      tax_rate_percent: "",
      cost_code_id: line.cost_code_id ?? null,
      qbo_income_account_id: (line as Record<string, any>).qbo_income_account_id ?? null,
      qbo_income_account_name: (line as Record<string, any>).qbo_income_account_name ?? null,
      arc_books_gl_account_id: (line as Record<string, any>).arc_books_gl_account_id ?? null,
      arc_books_gl_account_name: (line as Record<string, any>).arc_books_gl_account_name ?? null,
    }))
  }
  return [
    {
      id: crypto.randomUUID(),
      description: changeOrder.title,
      quantity: "1",
      unit: "co",
      unit_cost: (((changeOrder.total_cents ?? 0) / 100) || 0).toFixed(2),
      taxable: true,
      tax_rate_percent: "",
      cost_code_id: null,
      qbo_income_account_id: null,
      qbo_income_account_name: null,
      arc_books_gl_account_id: null,
      arc_books_gl_account_name: null,
    },
  ]
}

function formatQboAccountLabel(account?: QBOIncomeAccountOption | null) {
  if (!account) return ""
  return account.fullyQualifiedName ?? account.name
}

function openPdfBase64(pdfBase64: string, fileName?: string) {
  if (typeof window === "undefined") return
  const binary = atob(pdfBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: "application/pdf" })
  const objectUrl = URL.createObjectURL(blob)
  const popup = window.open(objectUrl, "_blank", "noopener,noreferrer")
  if (!popup) {
    const link = document.createElement("a")
    link.href = objectUrl
    link.download = fileName || "invoice.pdf"
    document.body.appendChild(link)
    link.click()
    link.remove()
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

type AttachmentLink = Awaited<ReturnType<typeof listAttachmentsAction>>[number]

function mapAttachmentLink(link: AttachmentLink): AttachedFile {
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

/** Net terms a bookkeeper actually uses; anything else is typed as a date. */
const TERM_PRESETS = [
  { days: 0, label: "Due on receipt" },
  { days: 7, label: "Net 7" },
  { days: 15, label: "Net 15" },
  { days: 30, label: "Net 30" },
  { days: 45, label: "Net 45" },
  { days: 60, label: "Net 60" },
]

function DatePicker({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const date = parseDate(value)
  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 w-full items-center gap-1.5 rounded-none border border-transparent px-2 text-sm transition-colors hover:border-input",
            className,
          )}
        >
          <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("flex-1 text-right tabular-nums", !date && "text-muted-foreground")}>
            {date ? format(date, "MMM d, yyyy") : "Pick date"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            if (d) {
              onChange(format(d, "yyyy-MM-dd"))
              setOpen(false)
            }
          }}
          defaultMonth={date}
        />
      </PopoverContent>
    </Popover>
  )
}

function AnimatedCurrency({ cents, className }: { cents: number; className?: string }) {
  return <NumberFlow value={cents / 100} format={{ style: "currency", currency: "USD" }} willChange className={className} />
}

interface QboLineAccountPickerProps {
  valueId: string | null
  valueLabel: string | null
  accounts: QBOIncomeAccountOption[]
  onSelect: (account: { id: string | null; name: string | null }) => void
  onCreateAccount?: (name: string) => Promise<QBOIncomeAccountOption>
  triggerClassName?: string
  ariaLabel?: string
  invalid?: boolean
  id?: string
}

function QboLineAccountPicker({ valueId, valueLabel, accounts, onSelect, onCreateAccount, triggerClassName, ariaLabel, invalid, id }: QboLineAccountPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)

  const selectedAccount = valueId ? accounts.find((account) => account.id === valueId) ?? null : null
  const displayLabel = selectedAccount ? formatQboAccountLabel(selectedAccount) : valueId ? valueLabel ?? valueId : "Pick account"
  const normalizedQuery = query.trim()
  const hasExactMatch = accounts.some((account) => {
    const lowerQuery = normalizedQuery.toLowerCase()
    return account.name.toLowerCase() === lowerQuery || (account.fullyQualifiedName ?? "").toLowerCase() === lowerQuery
  })
  const showCreate = Boolean(onCreateAccount) && normalizedQuery.length > 0 && !hasExactMatch

  const selectAccount = (account: QBOIncomeAccountOption) => {
    onSelect({ id: account.id, name: formatQboAccountLabel(account) })
    setOpen(false)
    setQuery("")
  }

  const handleCreate = async () => {
    if (!showCreate || creating || !onCreateAccount) return
    setCreating(true)
    try {
      const created = await onCreateAccount(normalizedQuery)
      selectAccount(created)
    } catch {
      // The caller reports the provider error; keep the picker open for retry.
    } finally {
      setCreating(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-5 max-w-[140px] items-center rounded-none px-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground",
            triggerClassName,
          )}
          id={id}
          title={displayLabel}
          aria-label={ariaLabel}
          data-invalid={invalid || undefined}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[min(300px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg p-0" align="start">
        <Command className="h-auto min-h-0 rounded-lg border-0 shadow-none">
          <CommandInput placeholder="Search account..." value={query} onValueChange={setQuery} />
          <CommandList className="min-h-0 max-h-[min(320px,50dvh)] overflow-y-auto overscroll-contain touch-pan-y">
            <CommandEmpty>No matching accounts.</CommandEmpty>
            <CommandGroup heading="Accounts">
              {accounts.map((account) => {
                const label = formatQboAccountLabel(account)
                return (
                  <CommandItem key={account.id} value={`${label} ${account.id}`} onSelect={() => selectAccount(account)}>
                    <span className="truncate">{label}</span>
                    <Check className={cn("ml-auto h-3.5 w-3.5", valueId === account.id ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                )
              })}
              {valueId && !selectedAccount && (
                <CommandItem
                  value={`saved-${valueId}`}
                  onSelect={() => {
                    onSelect({ id: valueId, name: valueLabel ?? valueId })
                    setOpen(false)
                    setQuery("")
                  }}
                >
                  <span className="truncate">Saved account ({valueLabel ?? valueId})</span>
                  <Check className="ml-auto h-3.5 w-3.5 opacity-100" />
                </CommandItem>
              )}
            </CommandGroup>
            {showCreate && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Create">
                  <CommandItem value={`create-${normalizedQuery}`} onSelect={handleCreate} disabled={creating}>
                    {creating ? (
                      <>
                        <Spinner className="mr-2 h-3.5 w-3.5" />
                        Creating...
                      </>
                    ) : (
                      `Create "${normalizedQuery}"`
                    )}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface InvoiceDocumentEditorProps {
  /** The persisted draft (null for a brand-new, not-yet-created invoice). */
  initialInvoice: Invoice | null
  projectId: string
  projects: Project[]
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null; logoUrl?: string | null }
  contacts?: Contact[]
  initialCustomerId?: string
  costCodes?: CostCode[]
  enableApprovedCostsSource?: boolean
  duplicateFrom?: Invoice | null
  initialSourceChangeOrder?: ChangeOrder | null
  initialSourceChangeOrderId?: string
  /** Reserved invoice number for a brand-new draft (with its reservation id). */
  reservation?: { number: string; reservationId: string | null } | null
  /**
   * Billing sources and accounting context. `undefined` while the host is still
   * loading them (the form paints anyway), `null` to have the editor fetch them
   * itself, or the loaded context.
   */
  context?: InvoiceComposerContext | null
  /** What kind of document a brand-new draft is, when the posture has more than one. */
  initialKind?: NewInvoiceKind
  /** Current autosave state, shown quietly in the header. */
  autosaveState?: AutosaveState
  /** Create the draft on first meaningful edit. Returns the persisted invoice. */
  onCreateDraft: (input: InvoiceInput) => Promise<Invoice>
  /** Debounced autosave for an existing editable draft. */
  onAutosave: (invoiceId: string, input: InvoiceInput) => Promise<Invoice>
  onAutosaveStateChange?: (state: AutosaveState) => void
  onSnapshotChange?: (snapshot: InvoiceEditorSnapshot) => void
  recoveryKey?: string
  onRecoveredDraft?: (id: string) => void
}

export const InvoiceDocumentEditor = forwardRef<InvoiceEditorHandle, InvoiceDocumentEditorProps>(function InvoiceDocumentEditor({
  initialInvoice,
  projectId,
  projects,
  builderInfo,
  contacts = [],
  initialCustomerId,
  costCodes = [],
  enableApprovedCostsSource = false,
  duplicateFrom = null,
  initialSourceChangeOrder = null,
  initialSourceChangeOrderId,
  reservation = null,
  context,
  initialKind,
  autosaveState = "idle",
  onCreateDraft,
  onAutosave,
  onAutosaveStateChange,
  onSnapshotChange,
  recoveryKey,
  onRecoveredDraft,
}, ref) {
  const { productTier } = usePageTitle()

  const seed = initialInvoice ?? duplicateFrom ?? null
  const initialCustomer = !seed && initialCustomerId
    ? contacts.find((contact) => contact.id === initialCustomerId) ?? null
    : null
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? projects[0] ?? null, [projects, projectId])
  const projectName = project?.name ?? "Project"
  const productPosture = getProjectPosture(project?.property_type, productTier)
  const receivablesPolicy = getReceivablesPosturePolicy(productPosture)

  // ── Form state (seeded once on mount) ──────────────────────────────────────
  const [invoiceNumber, setInvoiceNumber] = useState(initialInvoice?.invoice_number ?? reservation?.number ?? "")
  const [title, setTitle] = useState(seed?.title ?? projectName)
  const [issueDate, setIssueDate] = useState(seed?.issue_date ?? format(new Date(), "yyyy-MM-dd"))
  const [dueDate, setDueDate] = useState(seed?.due_date ?? format(addDays(new Date(), 15), "yyyy-MM-dd"))
  const [paymentTermsDays, setPaymentTermsDays] = useState<number>((seed?.metadata?.payment_terms_days as number) ?? 15)
  const [invoiceKind, setInvoiceKind] = useState<InvoiceKind>(
    seed?.metadata?.invoice_kind === "earnest_deposit" || seed?.metadata?.invoice_kind === "closing"
      ? seed.metadata.invoice_kind
      : initialKind && initialKind !== "standard"
        ? initialKind
        : receivablesPolicy.supportsClosingInvoices
          ? "closing"
          : "standard",
  )
  const [customerId, setCustomerId] = useState<string>(
    (seed?.metadata?.customer_id as string | undefined) ?? initialCustomer?.id ?? "none",
  )
  const [selectedQboCustomer, setSelectedQboCustomer] = useState<QBOCustomerOption | null>(
    seed?.metadata?.qbo_customer_id
      ? {
          id: String(seed.metadata.qbo_customer_id),
          name: String(seed.metadata.qbo_customer_name ?? seed.customer_name ?? ""),
          email: seed.metadata.customer_email ? String(seed.metadata.customer_email) : null,
        }
      : null,
  )
  const [customerDetails, setCustomerDetails] = useState(
    buildPartyDetailsBlock({
      name: seed?.customer_name ?? String(seed?.metadata?.customer_name ?? initialCustomer?.full_name ?? ""),
      email: String(seed?.metadata?.customer_email ?? initialCustomer?.email ?? ""),
      address: formatAddressBlock(String(seed?.metadata?.customer_address ?? initialCustomer?.address?.formatted ?? "")),
    }),
  )
  const [fromDetails, setFromDetails] = useState(
    buildPartyDetailsBlock({
      name: String(seed?.metadata?.from_name ?? builderInfo?.name ?? "Arc Builder"),
      email: String(seed?.metadata?.from_email ?? builderInfo?.email ?? ""),
      address: formatAddressBlock(String(seed?.metadata?.from_address ?? builderInfo?.address ?? "")),
    }),
  )
  const [notes, setNotes] = useState(typeof seed?.notes === "string" ? seed.notes : "")
  const [memo, setMemo] = useState(typeof seed?.metadata?.memo === "string" ? seed.metadata.memo : "")
  const [paymentMethods, setPaymentMethods] = useState(() => invoicePaymentMethods(seed?.metadata))
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const [taxRate, setTaxRate] = useState<number>(seed?.totals?.tax_rate ?? ((seed?.metadata?.tax_rate as number) ?? 0))
  const [taxJurisdictionId, setTaxJurisdictionId] = useState<string>(String(seed?.metadata?.tax_jurisdiction_id ?? "none"))
  const [discountType, setDiscountType] = useState<DiscountType | null>(seed?.totals?.discount_type ?? null)
  const [discountValue, setDiscountValue] = useState<string>(
    seed?.totals?.discount_value != null ? String(seed.totals.discount_value) : "",
  )
  const [lines, setLines] = useState<ComposerLine[]>(() => {
    if (initialInvoice) return toLineState(initialInvoice)
    if (duplicateFrom) return toLineState(duplicateFrom)
    if (initialSourceChangeOrder) return linesFromChangeOrder(initialSourceChangeOrder)
    return [blankLine()]
  })
  const [sourceDrawId, setSourceDrawId] = useState<string>((seed?.metadata?.source_draw_id as string | undefined) ?? "none")
  const [sourceChangeOrderId, setSourceChangeOrderId] = useState<string>(
    (seed?.metadata?.source_change_order_id as string | undefined) ?? initialSourceChangeOrder?.id ?? "none",
  )

  const [costPickerOpen, setCostPickerOpen] = useState(false)
  const [approvedCostsLoading, setApprovedCostsLoading] = useState(false)
  const [, setApprovalBusy] = useState(false)
  const [approvalStatus, setApprovalStatus] = useState<NonNullable<Invoice["approval_status"]>>(
    initialInvoice?.approval_status ?? (receivablesPolicy.approvalMode === "required_review" ? "draft" : "not_required"),
  )
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)

  // ── Context (draws / change orders / QBO) ──────────────────────────────────
  const [drawOptions, setDrawOptions] = useState<DrawOption[]>([])
  const [changeOrderOptions, setChangeOrderOptions] = useState<ChangeOrder[]>([])
  const [defaultIncomeAccountId, setDefaultIncomeAccountId] = useState<string | null>(null)
  const [recoverySaved, setRecoverySaved] = useState(false)
  const [editRevision, setEditRevision] = useState(0)
  const [canCreateIncomeAccount, setCanCreateIncomeAccount] = useState(false)
  const [qboConnected, setQboConnected] = useState(false)
  const [qboIncomeAccounts, setQboIncomeAccounts] = useState<QBOIncomeAccountOption[]>([])
  const [qboDiagnostics, setQboDiagnostics] = useState<QboDiagnostics | null>(null)
  const [accountingProvider, setAccountingProvider] = useState<string | null>(null)
  const [accountingProviderName, setAccountingProviderName] = useState<string | null>(null)
  const [taxJurisdictions, setTaxJurisdictions] = useState<TaxJurisdictionOption[]>([])
  const [contextLoading, setContextLoading] = useState(false)

  // Live QBO customer typeahead.
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [customerQuery, setCustomerQuery] = useState("")
  const [customerResults, setCustomerResults] = useState<QBOCustomerOption[]>([])
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false)
  const [creatingQboCustomer, setCreatingQboCustomer] = useState(false)
  const customerManuallyChosenRef = useRef(Boolean(seed?.customer_name || seed?.metadata?.qbo_customer_id || initialCustomer))
  const initialSourceAppliedRef = useRef(Boolean(initialSourceChangeOrder))

  // ── Autosave plumbing ──────────────────────────────────────────────────────
  const invoiceIdRef = useRef<string | null>(initialInvoice?.id ?? null)
  const reservationIdRef = useRef<string | null>(reservation?.reservationId ?? null)
  const savedSnapshotRef = useRef<string>("")
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightSaveRef = useRef<Promise<void> | null>(null)
  const dirtyRef = useRef(false)
  const revisionRef = useRef(0)
  const recoveryBaseRef = useRef(initialInvoice?.updated_at)
  const recoveryLoadedRef = useRef(false)
  const skipRecoveryWriteRef = useRef(false)
  // Once the invoice is sent it becomes immutable — block any further autosave (incl. the
  // unmount flush) so we don't push a draft payload over an issued invoice.
  const committedRef = useRef(false)
  // Always holds the latest savable payload so the debounce timer (which captures an older
  // closure) never persists stale form state.
  const latestPayloadRef = useRef<InvoiceInput | null>(null)

  const setAutosave = useCallback(
    (state: AutosaveState) => onAutosaveStateChange?.(state),
    [onAutosaveStateChange],
  )

  // The reserved number is fetched async and usually lands after this component mounts —
  // adopt it (and its reservation id) unless the user already typed a number or a draft exists.
  const invoiceNumberTouchedRef = useRef(false)
  useEffect(() => {
    if (!reservation || initialInvoice || invoiceIdRef.current || invoiceNumberTouchedRef.current) return
    reservationIdRef.current = reservation.reservationId
    setInvoiceNumber((current) => (current.trim() ? current : reservation.number))
  }, [reservation, initialInvoice])

  // Recipients arrive pre-filtered by party roles (listBillableContacts) — no type columns here.
  const financialContacts = useMemo(
    () => [...contacts].sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? "")),
    [contacts],
  )
  const arcCustomerOptions = useMemo(
    () => financialContacts.map((c) => ({ value: c.id, label: c.full_name, detail: c.email ?? "Arc contact" })),
    [financialContacts],
  )
  const costCodeGroups = useMemo(
    () => groupCostCodesByStandard(costCodes, productPosture),
    [costCodes, productPosture],
  )

  const hasCostLines = useMemo(() => lines.some((line) => (line.billable_cost_ids?.length ?? 0) > 0), [lines])

  const lineTotals = useMemo(() => {
    const normalized = lines.map((line) => {
      const quantity = Number(line.quantity)
      const unitCost = Number(line.unit_cost)
      const override = Number(line.tax_rate_percent)
      return {
        quantity: Number.isFinite(quantity) ? quantity : 0,
        unit_cost_cents: Number.isFinite(unitCost) ? Math.round(unitCost * 100) : 0,
        taxable: Boolean(line.taxable),
        tax_rate_percent: line.tax_rate_percent.trim() !== "" && Number.isFinite(override) ? override : null,
      }
    })
    const discountNumber = Number(discountValue)
    const discount =
      discountType && Number.isFinite(discountNumber) && discountNumber > 0
        ? { type: discountType, value: discountNumber }
        : null
    const totals = calculateInvoiceTotals(normalized, taxRate, discount)
    return { subtotal: totals.subtotal_cents, discount: totals.discount_cents ?? 0, tax: totals.tax_cents, total: totals.total_cents }
  }, [discountType, discountValue, lines, taxRate])

  const retainagePercent = Number(project?.billing_contract?.retainage_percent ?? project?.retainage_percent ?? 0)
  const retainageAppliesToFee = Boolean(project?.billing_contract?.retainage_applies_to_fee ?? false)
  // Mirrors the server: retainage only applies to manual/draw/change-order invoices on
  // retainage-bearing postures — approved-cost invoices carry none on this path.
  const retainageCents =
    receivablesPolicy.supportsRetainage && !hasCostLines
      ? deriveManualRetainageCents(
          lines.map((line) => ({
            quantity: Number(line.quantity) || 0,
            unit_cost_cents: Math.round((Number(line.unit_cost) || 0) * 100),
            unit: line.unit,
            description: line.description,
          })),
          retainagePercent,
          retainageAppliesToFee,
        )
      : 0
  const netInvoiceTotal = lineTotals.total - retainageCents

  const showCustomerSelector = customerDetails.trim().length === 0
  const nativeBooks = accountingProvider === "arc_books"
  const accountSelectionEnabled = nativeBooks || qboConnected
  const showQboAccountColumn = accountSelectionEnabled || contextLoading
  const showCostCodeColumn = costCodes.length > 0
  const showQboWarning = Boolean(
    accountSelectionEnabled && (qboIncomeAccounts.length === 0 || qboDiagnostics?.accountLoadWarning || qboDiagnostics?.connectionLastError),
  )
  const providerName = accountingProviderLabel(accountingProvider, accountingProviderName)
  const showQboCustomerPicker = showCustomerSelector && qboConnected

  // ── Payload builder (shared by autosave + send) ────────────────────────────
  const buildPayload = useCallback(
    (issue?: boolean, recipientEmail?: string): InvoiceInput | null => {
      if (!invoiceNumber.trim() || title.trim().length < 3) return null

      const parsedLines = lines.map((line) => {
        const selectedAccountId = nativeBooks ? line.arc_books_gl_account_id : line.qbo_income_account_id
        const savedAccountName = nativeBooks ? line.arc_books_gl_account_name : line.qbo_income_account_name
        const selectedLineAccount = qboIncomeAccounts.find((a) => a.id === selectedAccountId)
        const selectedAccountName = selectedLineAccount?.fullyQualifiedName ?? selectedLineAccount?.name ?? savedAccountName ?? undefined
        const overrideRate = Number(line.tax_rate_percent)
        return {
          cost_code_id: line.cost_code_id || undefined,
          description: line.description.trim(),
          quantity: Number(line.quantity),
          unit: line.unit.trim() || "ea",
          unit_cost: Number(line.unit_cost),
          taxable: line.taxable,
          tax_rate_percent: line.tax_rate_percent.trim() !== "" && Number.isFinite(overrideRate) ? overrideRate : undefined,
          qbo_income_account_id: nativeBooks ? undefined : selectedAccountId || undefined,
          qbo_income_account_name: nativeBooks ? undefined : selectedAccountName,
          arc_books_gl_account_id: nativeBooks ? selectedAccountId || undefined : undefined,
          arc_books_gl_account_name: nativeBooks ? selectedAccountName : undefined,
          billable_cost_ids: line.billable_cost_ids,
          cost_cents: line.cost_cents ?? undefined,
          markup_cents: line.markup_cents ?? undefined,
          markup_percent: line.markup_percent ?? undefined,
        }
      })

      const validLines = parsedLines.every(
        (line) =>
          line.description &&
          Number.isFinite(line.quantity) &&
          line.quantity > 0 &&
          Number.isFinite(line.unit_cost),
      )
      if (!validLines || parsedLines.length === 0) return null

      const parsedCustomer = parsePartyDetailsBlock(customerDetails)
      const parsedFrom = parsePartyDetailsBlock(fromDetails)
      // Recipients accept a comma/semicolon-separated list — real jobs bill owner + lender + architect.
      const emails = (recipientEmail ?? parsedCustomer.email)
        .split(/[,;]+/)
        .map((value) => value.trim())
        .filter((value) => value.includes("@"))
      const derivedSourceType: BillingSource = hasCostLines
        ? "from_costs"
        : sourceDrawId !== "none"
          ? "draw"
          : sourceChangeOrderId !== "none"
            ? "change_order"
            : "manual"
      const sendToClient = issue === true

      const payload = {
        project_id: projectId,
        invoice_number: invoiceNumber.trim(),
        customer_id: customerId === "none" || customerId.startsWith("qbo:") ? undefined : customerId,
        customer_name: parsedCustomer.name.trim() || selectedQboCustomer?.name || undefined,
        customer_address: parsedCustomer.address.trim() || undefined,
        qbo_customer_id: selectedQboCustomer?.id ?? null,
        qbo_customer_name: selectedQboCustomer?.name ?? null,
        from_name: parsedFrom.name.trim() || undefined,
        from_email: parsedFrom.email.trim() || undefined,
        from_address: parsedFrom.address.trim() || undefined,
        reservation_id: reservationIdRef.current ?? undefined,
        title: title.trim(),
        // Intent, not state: the server decides what issuing makes the invoice.
        issue: sendToClient,
        issue_date: issueDate || undefined,
        due_date: dueDate || undefined,
        notes: notes.trim() || undefined,
        tax_rate: taxRate,
        tax_jurisdiction_id: taxJurisdictionId === "none" ? null : taxJurisdictionId,
        tax_jurisdiction_name: taxJurisdictions.find((item) => item.id === taxJurisdictionId)?.name ?? null,
        discount_type: discountType && Number(discountValue) > 0 ? discountType : undefined,
        discount_value: discountType && Number(discountValue) > 0 ? Number(discountValue) : undefined,
        lines: parsedLines,
        sent_to_emails: sendToClient && emails.length > 0 ? emails : undefined,
        payment_terms_days: paymentTermsDays,
        source_type: derivedSourceType,
        source_draw_id: sourceDrawId !== "none" ? sourceDrawId : undefined,
        source_change_order_id: sourceChangeOrderId !== "none" ? sourceChangeOrderId : undefined,
        qbo_income_account_id: null,
        qbo_income_account_name: null,
        metadata: {
          invoice_kind:
            receivablesPolicy.supportsClosingInvoices || receivablesPolicy.supportsBuyerDeposits ? invoiceKind : "standard",
          memo: memo.trim() || null,
          payment_methods: paymentMethods,
        },
      }
      return invoiceInputSchema.safeParse(payload).success ? payload : null
    },
    [
      customerDetails,
      customerId,
      nativeBooks,
      discountType,
      discountValue,
      dueDate,
      fromDetails,
      hasCostLines,
      invoiceNumber,
      invoiceKind,
      issueDate,
      lines,
      memo,
      notes,
      paymentMethods,
      paymentTermsDays,
      projectId,
      receivablesPolicy,
      qboIncomeAccounts,
      selectedQboCustomer,
      sourceChangeOrderId,
      sourceDrawId,
      taxRate,
      taxJurisdictionId,
      taxJurisdictions,
      title,
    ],
  )

  // Keep the latest savable payload in a ref for the debounce timer to read.
  useEffect(() => {
    latestPayloadRef.current = buildPayload()
  }, [buildPayload])

  // Persist the current form if it's savable and something changed since the last save.
  // Approved-cost invoices are one-shot on the server (updateInvoice rejects them), so they
  // only persist on an explicit Save/Send — never from the debounce timer.
  const flushSave = useCallback(async (options?: { explicit?: boolean }) => {
    if (committedRef.current) return
    // Let an in-flight save settle, then continue with the latest payload so an
    // explicit flush never returns with newer edits still unsaved.
    if (inFlightSaveRef.current) {
      try { await inFlightSaveRef.current } catch { /* Explicit retries use the latest form below. */ }
    }
    if (committedRef.current) return
    const payload = latestPayloadRef.current
    if (!payload) {
      if (options?.explicit) throw new Error("Complete the highlighted fields. Your unfinished work is kept in this browser tab.")
      return
    }
    const savingRevision = revisionRef.current
    const isFromCosts = payload.source_type === "from_costs"
    if (isFromCosts && (invoiceIdRef.current || !options?.explicit)) return
    const snapshot = JSON.stringify(payload)
    if (snapshot === savedSnapshotRef.current) {
      dirtyRef.current = false
      return
    }
    setAutosave("saving")
    let saveFailed = false
    const save = (async () => {
      try {
        const saved = invoiceIdRef.current
          ? await onAutosave(invoiceIdRef.current, payload)
          : await onCreateDraft(payload)
        invoiceIdRef.current = saved.id
        // The reservation is consumed once the draft exists.
        reservationIdRef.current = null
        savedSnapshotRef.current = snapshot
        recoveryBaseRef.current = saved.updated_at
        if (recoveryKey) {
          try {
            const raw = sessionStorage.getItem(recoveryKey)
            if (raw) sessionStorage.setItem(recoveryKey, JSON.stringify({ ...JSON.parse(raw), invoiceId: saved.id, baseUpdatedAt: saved.updated_at }))
          } catch { setRecoverySaved(false) }
        }
        dirtyRef.current = revisionRef.current !== savingRevision
        setEditRevision(revisionRef.current)
        // A persisted approved-cost invoice is controlled by the cost ledger from here on.
        if (isFromCosts) committedRef.current = true
        setAutosave("saved")
      } catch (error) {
        saveFailed = true
        setAutosave("error")
        toast.error("Could not save invoice", { description: error instanceof Error ? error.message : "Please retry." })
        if (options?.explicit) throw error
      }
    })()
    inFlightSaveRef.current = save
    try {
      await save
    } finally {
      inFlightSaveRef.current = null
      // A change landed while we were saving — reschedule.
      if (!saveFailed && dirtyRef.current && !committedRef.current) scheduleSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPayload, onAutosave, onCreateDraft, setAutosave, recoveryKey])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void flushSave()
    }, 2000)
  }, [flushSave])

  const markDirty = useCallback(() => {
    if (receivablesPolicy.approvalMode === "required_review" && approvalStatus !== "draft") {
      setApprovalStatus("draft")
    }
    setAutosave("idle")
    revisionRef.current += 1
    setEditRevision(revisionRef.current)
    scheduleSave()
  }, [approvalStatus, receivablesPolicy.approvalMode, scheduleSave, setAutosave])

  // Flush pending edits on unmount so nothing is lost when the user navigates away.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (dirtyRef.current) void flushSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Billing sources + accounting context. The page starts this on the server;
  // only a caller without a page (a sheet) still asks the action.
  useEffect(() => {
    if (context === undefined) return
    let cancelled = false
    setContextLoading(true)
    const source: Promise<InvoiceComposerContext> = context
      ? Promise.resolve(context)
      : getInvoiceComposerContextAction(projectId).then((actionResult) => unwrapAction(actionResult))
    source
      .then((result) => {
        if (cancelled) return
        setDrawOptions(result.draws ?? [])
        setChangeOrderOptions(result.changeOrders ?? [])
        setQboConnected(Boolean(result.qboConnected))
        setCanCreateIncomeAccount(Boolean(result.canCreateIncomeAccount))
        setDefaultIncomeAccountId(result.qboDefaultIncomeAccountId ?? null)
        if (!initialInvoice && !duplicateFrom && !dirtyRef.current && result.qboDefaultIncomeAccountId) {
          const account = result.qboIncomeAccounts.find((entry) => entry.id === result.qboDefaultIncomeAccountId)
          if (account) setLines((prev) => prev.map((line) => line.qbo_income_account_id || line.arc_books_gl_account_id ? line :
            result.accountingProvider === "arc_books"
              ? { ...line, arc_books_gl_account_id: account.id, arc_books_gl_account_name: formatQboAccountLabel(account) }
              : { ...line, qbo_income_account_id: account.id, qbo_income_account_name: formatQboAccountLabel(account) }))
        }
        setQboIncomeAccounts(result.qboIncomeAccounts ?? [])
        setQboDiagnostics((result.qboDiagnostics as QboDiagnostics | undefined) ?? null)
        setAccountingProvider(result.accountingProvider ?? null)
        setAccountingProviderName(result.accountingProviderName ?? null)
        setTaxJurisdictions((result.taxJurisdictions as TaxJurisdictionOption[] | undefined) ?? [])
        if (initialSourceChangeOrderId && !initialSourceAppliedRef.current) {
          const co = (result.changeOrders ?? []).find((c) => c.id === initialSourceChangeOrderId)
          if (co) {
            initialSourceAppliedRef.current = true
            setSourceChangeOrderId(co.id)
            setLines(linesFromChangeOrder(co))
          }
        }
        // Pre-select the project default QBO customer only when nothing is chosen yet.
        if (!initialInvoice && result.qboConnected && !customerManuallyChosenRef.current && result.defaultQboCustomer?.id) {
          const def = result.defaultQboCustomer
          setSelectedQboCustomer({ id: def.id, name: def.name, email: null })
          setCustomerDetails(buildPartyDetailsBlock({ name: def.name, email: "", address: "" }))
        }
        // Org default terms/note apply once, only to a brand-new blank draft.
        if (!initialInvoice && !duplicateFrom && !dirtyRef.current) {
          const days = Number(result.settings?.defaultPaymentTermsDays ?? 15)
          setPaymentTermsDays(days)
          const base = issueDate ? parse(issueDate, "yyyy-MM-dd", new Date()) : new Date()
          setDueDate(format(addDays(base, days), "yyyy-MM-dd"))
          const defaultNote = String(result.settings?.defaultInvoiceNote ?? "")
          setNotes((current) => (current.trim() ? current : defaultNote))
        }
      })
      .catch((error) => {
        if (!cancelled) toast.error("Unable to load billing sources", { description: (error as Error).message })
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, context])


  // Live QBO customer search.
  useEffect(() => {
    if (!qboConnected || !customerPickerOpen) return
    let cancelled = false
    setCustomerSearchLoading(true)
    const handle = setTimeout(() => {
      searchQboCustomersAction(customerQuery, projectId)
        .then((result) => {
          if (!cancelled) setCustomerResults(unwrapAction(result).customers ?? [])
        })
        .catch(() => {
          if (!cancelled) setCustomerResults([])
        })
        .finally(() => {
          if (!cancelled) setCustomerSearchLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [qboConnected, customerPickerOpen, customerQuery, projectId])

  // Keep customer selection consistent when the details block is cleared.
  useEffect(() => {
    if (customerDetails.trim().length === 0) {
      if (customerId !== "none") setCustomerId("none")
      if (selectedQboCustomer) setSelectedQboCustomer(null)
    }
  }, [customerDetails, customerId, selectedQboCustomer])

  // ── Handlers ────────────────────────────────────────────────────────────────
  const updateLine = (lineId: string, key: keyof ComposerLine, value: string | boolean | null) => {
    markDirty()
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, [key]: value } : line)))
  }
  const addLine = () => {
    markDirty()
    setLines((prev) => [...prev, blankLine()])
  }
  const removeLine = (lineId: string) => {
    if (lines.length === 1) return
    markDirty()
    setLines((prev) => prev.filter((line) => line.id !== lineId))
  }
  const appendLines = (incoming: ComposerLine[]) => {
    if (incoming.length === 0) return
    markDirty()
    setLines((prev) => {
      const kept = prev.filter((line) => line.description.trim() !== "" || line.unit_cost.trim() !== "")
      return [...kept, ...incoming]
    })
  }

  const handleIssueDateChange = (value: string) => {
    markDirty()
    setIssueDate(value)
    const base = parseDate(value)
    if (base && Number.isFinite(paymentTermsDays) && paymentTermsDays >= 0) setDueDate(format(addDays(base, paymentTermsDays), "yyyy-MM-dd"))
  }
  const handleDueDateChange = (value: string) => {
    markDirty()
    setDueDate(value)
    const issue = parseDate(issueDate)
    const due = parseDate(value)
    if (issue && due) setPaymentTermsDays(Math.max(0, Math.round((due.getTime() - issue.getTime()) / 86_400_000)))
  }
  const handleTermsChange = (days: number) => {
    markDirty()
    setPaymentTermsDays(days)
    const base = parseDate(issueDate)
    if (base && Number.isFinite(days) && days >= 0) setDueDate(format(addDays(base, days), "yyyy-MM-dd"))
  }

  const applyDrawToInvoice = (drawId: string) => {
    const draw = drawOptions.find((option) => option.id === drawId)
    if (!draw) return
    setSourceDrawId(drawId)
    if (draw.due_date && draw.due_date !== dueDate) setDueDate(draw.due_date)
    appendLines([
      {
        id: crypto.randomUUID(),
        description: draw.title,
        quantity: "1",
        unit: "draw",
        unit_cost: ((draw.amount_cents ?? 0) / 100).toFixed(2),
        taxable: false,
        tax_rate_percent: "",
        cost_code_id: null,
        qbo_income_account_id: null,
        qbo_income_account_name: null,
        arc_books_gl_account_id: null,
        arc_books_gl_account_name: null,
      },
    ])
  }

  const applyChangeOrderToInvoice = (changeOrderId: string) => {
    const changeOrder = changeOrderOptions.find((option) => option.id === changeOrderId)
    if (!changeOrder) return
    setSourceChangeOrderId(changeOrderId)
    appendLines(linesFromChangeOrder(changeOrder))
  }

  const handleCostSelection = async (selection: CostSelection) => {
    setApprovedCostsLoading(true)
    try {
      const result = unwrapAction(
        await generateInvoiceFromCostsAction({
          projectId,
          dateRange: selection.dateRange,
          billableCostIds: selection.billableCostIds,
          groupBy: selection.groupBy,
          includeAllowanceVariances: false,
          dryRun: true,
        }),
      )
      const previewLines = result.invoicePreview?.lines ?? []
      if (previewLines.length === 0) {
        toast.info("Nothing billable in the selected costs")
        return
      }
      appendLines(
        previewLines.map((line: any) => ({
          id: crypto.randomUUID(),
          description: String(line.description ?? "Costs"),
          quantity: "1",
          unit: "LS",
          unit_cost: (Number(line.billable_cents ?? 0) / 100).toFixed(2),
          taxable: false,
          tax_rate_percent: "",
          cost_code_id: line.cost_code_id ?? null,
          qbo_income_account_id: null,
          qbo_income_account_name: null,
          arc_books_gl_account_id: null,
          arc_books_gl_account_name: null,
          billable_cost_ids: Array.isArray(line.billable_cost_ids) ? line.billable_cost_ids : [],
          cost_cents: Number(line.cost_cents ?? 0),
          markup_cents: Number(line.markup_cents ?? 0),
          markup_percent: typeof line.markup_percent === "number" ? line.markup_percent : null,
        })),
      )
      toast.success(`Added ${previewLines.length} cost ${previewLines.length === 1 ? "line" : "lines"}`)
    } catch (error: any) {
      toast.error("Could not add costs", { description: error?.message ?? "Try again." })
      throw error
    } finally {
      setApprovedCostsLoading(false)
    }
  }

  const selectContact = (contactId: string) => {
    customerManuallyChosenRef.current = true
    markDirty()
    setCustomerId(contactId)
    setSelectedQboCustomer(null)
    const contact = financialContacts.find((item) => item.id === contactId)
    if (contact) {
      setCustomerDetails(
        buildPartyDetailsBlock({ name: contact.full_name, email: contact.email ?? "", address: contactBillingAddress(contact.address) }),
      )
    }
  }

  const selectQboCustomer = (customer: QBOCustomerOption) => {
    customerManuallyChosenRef.current = true
    markDirty()
    setCustomerId("none")
    setSelectedQboCustomer(customer)
    setCustomerPickerOpen(false)
    setCustomerDetails(
      buildPartyDetailsBlock({ name: customer.name, email: customer.email ?? "", address: formatAddressBlock(customer.billingAddress ?? "") }),
    )
  }

  const handleCreateQboCustomer = async () => {
    const name = customerQuery.trim()
    if (!name || creatingQboCustomer) return
    setCreatingQboCustomer(true)
    try {
      const created = unwrapAction(await createQboCustomerAction({ name, projectId }))
      selectQboCustomer(created)
      setCustomerQuery("")
      toast.success(`Created "${created.name}" in ${providerName}`)
    } catch (error: any) {
      toast.error(`Couldn't create customer in ${providerName}`, { description: error?.message ?? "Try again." })
    } finally {
      setCreatingQboCustomer(false)
    }
  }

  const handleCreateQboIncomeAccount = useCallback(async (name: string): Promise<QBOIncomeAccountOption> => {
    const created = unwrapAction(await createQBOIncomeAccountAction(name, projectId))
    const normalized: QBOIncomeAccountOption = { id: created.id, name: created.name, fullyQualifiedName: created.fullyQualifiedName }
    setQboIncomeAccounts((prev) => {
      const next = [...prev]
      const existingIndex = next.findIndex((account) => account.id === normalized.id)
      if (existingIndex >= 0) {
        next[existingIndex] = normalized
        return next
      }
      return [...next, normalized].sort((a, b) => formatQboAccountLabel(a).localeCompare(formatQboAccountLabel(b)))
    })
    return normalized
  }, [projectId])

  /**
   * Persist, then hand the draft to the review step. Line-level accounting coding
   * is checked here rather than at issue time so the person is standing in front
   * of the lines when they are told which one is missing an account.
   */
  // Attachments hang off the persisted draft, so the first one persists it.
  useEffect(() => {
    const invoiceId = initialInvoice?.id
    if (!invoiceId) return
    let cancelled = false
    listAttachmentsAction("invoice", invoiceId)
      .then((links) => {
        if (!cancelled) setAttachments(links.filter(isInvoiceAttachment).map(mapAttachmentLink))
      })
      .catch(() => null)
    return () => {
      cancelled = true
    }
  }, [initialInvoice?.id])

  const handleAttach = async (files: File[], linkRole?: string) => {
    setAttachmentsBusy(true)
    try {
      const invoiceId = await ensurePersistedDraft()
      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", projectId)
        formData.append("category", "financials")
        const uploaded = unwrapAction(await uploadFileAction(formData))
        unwrapAction(await attachFileAction(uploaded.id, "invoice", invoiceId, projectId, linkRole))
      }
      setAttachments((await listAttachmentsAction("invoice", invoiceId)).filter(isInvoiceAttachment).map(mapAttachmentLink))
    } catch (error) {
      toast.error("Could not attach the file", { description: error instanceof Error ? error.message : "Please try again." })
    } finally {
      setAttachmentsBusy(false)
    }
  }

  const handleDetach = async (linkId: string) => {
    const invoiceId = invoiceIdRef.current
    if (!invoiceId) return
    unwrapAction(await detachFileLinkAction(linkId))
    setAttachments((await listAttachmentsAction("invoice", invoiceId)).filter(isInvoiceAttachment).map(mapAttachmentLink))
  }

  const linesCoded = !(accountSelectionEnabled && qboIncomeAccounts.length > 0 && lines.some((line) => !(nativeBooks ? line.arc_books_gl_account_id : line.qbo_income_account_id)))

  const persistForSend = async () => {
    setSubmitAttempted(true)
    if (!buildPayload()) throw new Error("Fix the highlighted fields first")
    if (!linesCoded) throw new Error(`Pick a ${providerName} account for every line item`)
    return ensurePersistedDraft()
  }

  const ensurePersistedDraft = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    await flushSave({ explicit: true })
    if (dirtyRef.current && !committedRef.current) await flushSave({ explicit: true })
    let invoiceId = invoiceIdRef.current
    if (!invoiceId) {
      const payload = buildPayload()
      if (!payload) throw new Error("Complete the invoice before requesting approval")
      const created = await onCreateDraft(payload)
      invoiceId = created.id
      invoiceIdRef.current = created.id
      reservationIdRef.current = null
    }
    return invoiceId
  }

  const handleRequestApproval = async () => {
    setApprovalBusy(true)
    try {
      const invoiceId = await ensurePersistedDraft()
      const invoice = unwrapAction(await requestInvoiceApprovalAction(invoiceId))
      setApprovalStatus(invoice?.approval_status ?? "pending")
      dirtyRef.current = false
      toast.success("Owner billing sent for approval")
    } catch (error) {
      toast.error("Could not request approval", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setApprovalBusy(false)
    }
  }

  const handleApprove = async () => {
    setApprovalBusy(true)
    try {
      const invoiceId = await ensurePersistedDraft()
      const invoice = unwrapAction(await decideInvoiceApprovalAction(invoiceId, "approved"))
      setApprovalStatus(invoice?.approval_status ?? "approved")
      toast.success("Owner billing approved", { description: "It is ready to issue." })
    } catch (error) {
      toast.error("Could not approve invoice", {
        description: error instanceof Error ? error.message : "A different approver may be required.",
      })
    } finally {
      setApprovalBusy(false)
    }
  }

  const handleDownloadPdf = async () => {
    if (generatingPdf) return
    setGeneratingPdf(true)
    try {
      if (dirtyRef.current || !invoiceIdRef.current) await flushSave({ explicit: true })
      const invoiceId = invoiceIdRef.current
      if (!invoiceId) {
        toast.error("Add a line item before downloading a PDF")
        return
      }
      const result = unwrapAction(await generateInvoicePdfAction(invoiceId, { persistToArc: false }))
      if (result.pdfBase64) openPdfBase64(result.pdfBase64, result.fileName)
    } catch (error: any) {
      toast.error("Failed to generate PDF", { description: error?.message ?? "Please try again." })
    } finally {
      setGeneratingPdf(false)
    }
  }

  // ── Rendering helpers ───────────────────────────────────────────────────────
  const noSpinner =
    "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"

  const linkedDraw = sourceDrawId !== "none" ? drawOptions.find((d) => d.id === sourceDrawId) ?? null : null
  const linkedChangeOrder = sourceChangeOrderId !== "none" ? changeOrderOptions.find((c) => c.id === sourceChangeOrderId) ?? null : null

  useImperativeHandle(ref, () => ({
    persist: persistForSend,
    saveDraft: async () => {
      setSubmitAttempted(true)
      if (!buildPayload()) throw new Error("Complete the highlighted fields before saving to Arc.")
      return ensurePersistedDraft()
    },
    focusField: (field) => {
      setSubmitAttempted(true)
      const lineId = field.match(/^invoice-(?:description|quantity|price|account|tax)-(.+)$/)?.[1]
      if (lineId) {
        setCollapsedLineIds((current) => {
          if (!current.has(lineId)) return current
          const next = new Set(current)
          next.delete(lineId)
          return next
        })
      }
      requestAnimationFrame(() => {
        const element = document.getElementById(field)
        element?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" })
        const target = element?.matches("input,textarea,button") ? element : element?.querySelector<HTMLElement>("[aria-invalid='true']") ?? element?.querySelector<HTMLElement>("input,textarea,button")
        ;(target as HTMLElement | null)?.focus({ preventScroll: true })
      })
    },
    discard: async () => {
      committedRef.current = true
      dirtyRef.current = false
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      try { await inFlightSaveRef.current } catch { /* Discard still stops failed saves. */ }
    },
    resumeSaving: () => {
      committedRef.current = false
      dirtyRef.current = true
      setEditRevision((value) => value + 1)
    },
    requestApproval: handleRequestApproval,
    approve: handleApprove,
    downloadPdf: handleDownloadPdf,
  }))

  // Keep unfinished fields in this signed-in user's browser tab. This is a
  // recovery copy, not an issued invoice or a substitute for a server save.
  useLayoutEffect(() => {
    if (!recoveryKey || recoveryLoadedRef.current) return
    recoveryLoadedRef.current = true
    skipRecoveryWriteRef.current = true
    try {
      const raw = sessionStorage.getItem(recoveryKey)
      if (!raw) return
      const saved = JSON.parse(raw)
      if (saved.version !== 1 || !Array.isArray(saved.lines) || !saved.lines.every((line: ComposerLine) =>
        line && [line.id, line.description, line.quantity, line.unit, line.unit_cost, line.tax_rate_percent].every((value) => typeof value === "string"))) return
      // Don't restore stale edits over a newer server revision.
      if (initialInvoice && saved.baseUpdatedAt !== initialInvoice.updated_at) {
        toast.info("A newer draft was loaded from Arc. The previous recovery copy was not applied.")
        return
      }
      setLines(saved.lines)
      setShowTax(saved.taxRate > 0 || saved.taxJurisdictionId !== "none" || saved.lines.some((line: ComposerLine) => line.tax_rate_percent.trim() !== ""))
      for (const [key, setter] of Object.entries({ title: setTitle, issueDate: setIssueDate, dueDate: setDueDate, customerDetails: setCustomerDetails, fromDetails: setFromDetails, notes: setNotes, memo: setMemo, discountValue: setDiscountValue, sourceDrawId: setSourceDrawId, sourceChangeOrderId: setSourceChangeOrderId, customerId: setCustomerId, taxJurisdictionId: setTaxJurisdictionId })) {
        if (typeof saved[key] === "string") setter(saved[key])
      }
      recoveryBaseRef.current = saved.baseUpdatedAt
      if (saved.invoiceNumberTouched && typeof saved.invoiceNumber === "string") { setInvoiceNumber(saved.invoiceNumber); invoiceNumberTouchedRef.current = true }
      if (typeof saved.invoiceId === "string") {
        invoiceIdRef.current = saved.invoiceId
        setInvoiceNumber(saved.invoiceNumber)
        onRecoveredDraft?.(saved.invoiceId)
      }
      if (typeof saved.taxRate === "number") setTaxRate(saved.taxRate)
      if (typeof saved.paymentTermsDays === "number") setPaymentTermsDays(saved.paymentTermsDays)
      if ([null, "percent", "fixed"].includes(saved.discountType)) setDiscountType(saved.discountType)
      if (["standard", "earnest_deposit", "closing"].includes(saved.invoiceKind)) setInvoiceKind(saved.invoiceKind)
      if (typeof saved.paymentMethods?.ach === "boolean" && typeof saved.paymentMethods?.card === "boolean") setPaymentMethods(saved.paymentMethods)
      if (saved.selectedQboCustomer?.id) setSelectedQboCustomer(saved.selectedQboCustomer)
      customerManuallyChosenRef.current = true
      initialSourceAppliedRef.current = true
      markDirty()
      setRecoverySaved(true)
      toast.info("Restored your unfinished invoice from this browser tab")
    } catch { setRecoverySaved(false) }
    // Restore once per mounted editor; the composer scopes its key by user/project/document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryKey])

  useEffect(() => {
    if (!recoveryKey || !recoveryLoadedRef.current || committedRef.current) return
    if (skipRecoveryWriteRef.current) { skipRecoveryWriteRef.current = false; return }
    if (!dirtyRef.current) return
    try {
      sessionStorage.setItem(recoveryKey, JSON.stringify({
        version: 1, baseUpdatedAt: recoveryBaseRef.current, invoiceId: invoiceIdRef.current,
        invoiceNumberTouched: invoiceNumberTouchedRef.current, invoiceNumber, title, issueDate, dueDate,
        customerDetails, customerId, selectedQboCustomer, fromDetails, notes, memo, lines,
        paymentMethods, paymentTermsDays, taxRate, taxJurisdictionId, discountType, discountValue,
        sourceDrawId, sourceChangeOrderId, invoiceKind,
      }))
      setRecoverySaved(true)
    } catch { setRecoverySaved(false) }
  }, [recoveryKey, initialInvoice?.updated_at, invoiceNumber, title, issueDate, dueDate, customerDetails, customerId, selectedQboCustomer, fromDetails, notes, memo, lines, paymentMethods, paymentTermsDays, taxRate, taxJurisdictionId, discountType, discountValue, sourceDrawId, sourceChangeOrderId, invoiceKind, editRevision])

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current && !committedRef.current) { event.preventDefault(); event.returnValue = "" }
    }
    window.addEventListener("beforeunload", protect)
    return () => window.removeEventListener("beforeunload", protect)
  }, [])

  // Tell the rail what the document says, whenever it changes.
  const parsedRecipients = useMemo(
    () =>
      parsePartyDetailsBlock(customerDetails)
        .email.split(/[,;]+/)
        .map((value) => value.trim())
        .filter((value) => value.includes("@")),
    [customerDetails],
  )
  // The document, exactly as the customer would get it, from the form as it
  // stands. Same mapper the PDF and the portal use, so the preview cannot lie.
  const preview = useMemo<InvoiceEditorSnapshot["preview"]>(() => {
    const customer = parsePartyDetailsBlock(customerDetails)
    const from = parsePartyDetailsBlock(fromDetails)
    const previewLines: ArcInvoiceLine[] = lines
      .filter((line) => line.description.trim() || line.unit_cost.trim())
      .map((line) => {
        const quantity = Number(line.quantity) || 0
        const unitCostCents = Math.round((Number(line.unit_cost) || 0) * 100)
        return {
          description: line.description,
          quantity,
          unit: line.unit,
          unitCostCents,
          lineTotalCents: Math.round(quantity * unitCostCents),
        }
      })
    if (retainageCents > 0) {
      previewLines.push({
        description: `Retainage held (${retainagePercent}%)`,
        quantity: 1,
        unit: "retainage",
        unitCostCents: -retainageCents,
        lineTotalCents: -retainageCents,
      })
    }
    const discountNumber = Number(discountValue)
    return {
      data: {
        invoiceNumber: invoiceNumber,
        projectName: title.trim() || projectName,
        paymentMethods: paymentMethodLabels(paymentMethods),
        logoUrl: builderInfo?.logoUrl ?? null,
        issueDate,
        dueDate,
        fromLines: [from.name, from.email, from.address],
        billToLines: [customer.name || (selectedQboCustomer?.name ?? ""), customer.email, customer.address],
        notes,
        payUrl: null,
        subtotalCents: lineTotals.subtotal,
        taxCents: lineTotals.tax,
        totalCents: netInvoiceTotal,
        taxRate: taxRate > 0 ? taxRate : null,
        discountCents: lineTotals.discount > 0 ? lineTotals.discount : null,
        discountPercent: discountType === "percent" && Number.isFinite(discountNumber) && discountNumber > 0 ? discountNumber : null,
      },
      lines: previewLines,
    }
  }, [
    builderInfo?.logoUrl,
    customerDetails,
    discountType,
    discountValue,
    dueDate,
    fromDetails,
    invoiceNumber,
    issueDate,
    lineTotals,
    lines,
    netInvoiceTotal,
    notes,
    paymentMethods,
    projectName,
    retainageCents,
    retainagePercent,
    selectedQboCustomer?.name,
    taxRate,
    title,
  ])

  const fieldProblems = useMemo(() => {
    const problems: Array<{ field: string; message: string }> = []
    if (!invoiceNumber.trim()) problems.push({ field: "invoice-number", message: "Add an invoice number." })
    if (title.trim().length < 3) problems.push({ field: "invoice-title", message: "Add an invoice title (at least 3 characters)." })
    lines.forEach((line, index) => {
      if (!line.description.trim()) problems.push({ field: `invoice-description-${line.id}`, message: `Item ${index + 1}: add a description.` })
      if (!Number.isFinite(Number(line.quantity)) || Number(line.quantity) < 0.01) problems.push({ field: `invoice-quantity-${line.id}`, message: `Item ${index + 1}: quantity must be at least 0.01.` })
      if (!Number.isFinite(Number(line.unit_cost))) problems.push({ field: `invoice-price-${line.id}`, message: `Item ${index + 1}: enter a valid price.` })
      if (accountSelectionEnabled && qboIncomeAccounts.length > 0 && !(nativeBooks ? line.arc_books_gl_account_id : line.qbo_income_account_id)) problems.push({ field: `invoice-account-${line.id}`, message: `Item ${index + 1}: choose an income account.` })
      if (line.tax_rate_percent && (!Number.isFinite(Number(line.tax_rate_percent)) || Number(line.tax_rate_percent) < 0 || Number(line.tax_rate_percent) > 20)) problems.push({ field: `invoice-tax-${line.id}`, message: `Item ${index + 1}: tax must be between 0 and 20%.` })
    })
    if (!dueDate) problems.push({ field: "invoice-due-date", message: "Choose a due date." })
    return problems
  }, [invoiceNumber, title, lines, accountSelectionEnabled, qboIncomeAccounts.length, nativeBooks, dueDate])

  useEffect(() => {
    onSnapshotChange?.({
      totalCents: netInvoiceTotal,
      dueDate,
      issueDate,
      recipients: parsedRecipients,
      approvalStatus,
      complete: Boolean(buildPayload()),
      dirty: dirtyRef.current,
      recoverySaved,
      problems: fieldProblems,
      coded: linesCoded,
      invoiceId: invoiceIdRef.current,
      preview,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [netInvoiceTotal, dueDate, issueDate, parsedRecipients, approvalStatus, buildPayload, linesCoded, autosaveState, preview, editRevision, recoverySaved, fieldProblems])

  const costSummary = useMemo(() => {
    const costLines = lines.filter((line) => (line.billable_cost_ids?.length ?? 0) > 0)
    if (costLines.length === 0) return null
    const costCount = costLines.reduce((sum, line) => sum + (line.billable_cost_ids?.length ?? 0), 0)
    const totalBillableCents = costLines.reduce(
      (sum, line) => sum + Math.round((Number(line.quantity) || 0) * (Number(line.unit_cost) || 0) * 100),
      0,
    )
    return { costCount, totalBillableCents }
  }, [lines])

  const [focusLineId, setFocusLineId] = useState<string | null>(null)
  const [collapsedLineIds, setCollapsedLineIds] = useState<Set<string>>(() => new Set())
  const [showDiscount, setShowDiscount] = useState(Boolean(discountType && Number(discountValue) > 0))
  const [showTax, setShowTax] = useState(taxRate > 0 || taxJurisdictionId !== "none" || lines.some((line) => line.tax_rate_percent.trim() !== ""))
  const [billingDetailsOpen, setBillingDetailsOpen] = useState(false)

  const addItem = () => {
    const line = blankLine()
    const defaultAccount = qboIncomeAccounts.find((entry) => entry.id === defaultIncomeAccountId)
    const accountId = defaultAccount?.id
    const accountName = defaultAccount ? formatQboAccountLabel(defaultAccount) : null
    if (nativeBooks) { line.arc_books_gl_account_id = accountId ?? null; line.arc_books_gl_account_name = accountName ?? null }
    else { line.qbo_income_account_id = accountId ?? null; line.qbo_income_account_name = accountName ?? null }
    markDirty()
    setLines((prev) => [...prev, line])
    setCollapsedLineIds((current) => {
      const next = new Set(current)
      next.delete(line.id)
      return next
    })
    setFocusLineId(line.id)
  }
  const removeItem = (lineId: string) => {
    markDirty()
    const removed = lines.find((line) => line.id === lineId)
    const remaining = lines.filter((line) => line.id !== lineId)
    const nextLines = remaining.length ? remaining : [blankLine()]
    const removedIndex = lines.findIndex((line) => line.id === lineId)
    const nextItem = nextLines.slice(removedIndex).find((line) => line.unit !== "credit")
      ?? [...nextLines].reverse().find((line) => line.unit !== "credit")
    setLines(nextLines)
    setCollapsedLineIds((current) => {
      const next = new Set(current)
      next.delete(lineId)
      return next
    })
    setFocusLineId(nextItem?.id ?? null)
    if (removed) toast("Item removed", { className: "rounded-none", duration: 10000, action: { label: "Undo", onClick: () => {
      markDirty()
      setLines((current) => {
        if (current.some((line) => line.id === removed.id)) return current
        const restored = [...current]
        // Remove only the untouched placeholder created by this removal.
        if (!remaining.length && restored.length === 1 && restored[0].id === nextLines[0].id && !restored[0].description && !restored[0].unit_cost) restored.splice(0, 1)
        restored.splice(Math.min(removedIndex, restored.length), 0, removed)
        return restored
      })
      setFocusLineId(removed.id)
    } } })
  }
  const duplicateItem = (line: ComposerLine) => {
    if (line.billable_cost_ids?.length) return
    const copy = { ...line, id: crypto.randomUUID() }
    markDirty()
    setLines((current) => {
      const next = [...current]
      next.splice(current.findIndex((entry) => entry.id === line.id) + 1, 0, copy)
      return next
    })
    setCollapsedLineIds((current) => {
      const next = new Set(current)
      next.delete(copy.id)
      return next
    })
    setFocusLineId(copy.id)
  }
  // Deposits and credits are negative lines on the invoice; they read as
  // adjustments under the totals, not as items.
  const creditLines = lines.filter((line) => line.unit === "credit")
  const itemLines = lines.filter((line) => line.unit !== "credit")
  const addCredit = () => {
    markDirty()
    setLines((prev) => [
      ...prev,
      { ...blankLine(), description: "Less deposit received", unit: "credit", taxable: false, unit_cost: "" },
    ])
  }
  const customer = parsePartyDetailsBlock(customerDetails)
  const hasCustomer = customerDetails.trim().length > 0
  const invoiceLabel =
    invoiceKind === "earnest_deposit" && receivablesPolicy.supportsBuyerDeposits
      ? "Deposit request"
      : invoiceKind === "closing" && receivablesPolicy.supportsClosingInvoices
        ? "Closing statement"
        : "Invoice"
  const fieldLabel = "text-xs font-medium text-muted-foreground"
  const sectionTitle = "text-base font-semibold tracking-tight"

  return (
    <div className="mx-auto w-full max-w-2xl space-y-10 px-6 py-8 sm:px-8">
      {showQboWarning ? (
        <div
          className={cn(
            "flex items-start gap-2 border px-3 py-2 text-xs font-medium",
            qboDiagnostics?.connectionLastError
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-warning/30 bg-warning/10 text-warning",
          )}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>
              {qboDiagnostics?.connectionLastError
                ? `Arc can't reach ${providerName} right now, so income accounts can't be picked. You can still save this invoice — it will sync once the connection is repaired.`
                : qboDiagnostics?.accountLoadWarning
                  ? nativeBooks
                    ? "Arc Books couldn't load active income accounts from its chart."
                    : `Arc reached ${providerName} but couldn't read your income accounts.`
                  : `${providerName} is connected, but it has no income accounts to bill into.`}
            </span>
            <Link href={nativeBooks ? "/books/chart" : "/settings/integrations"} className="font-medium underline underline-offset-2">
              {nativeBooks ? "Review chart of accounts" : "Fix the accounting connection"}
            </Link>
          </span>
        </div>
      ) : null}

      {/* ── Details ── */}
      <section className="space-y-5">
        <h2 className={sectionTitle}>Details</h2>

        <div className="space-y-2">
          <p className="text-sm font-medium">Who are you billing?</p>
          {hasCustomer ? (
            <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {(customer.name || selectedQboCustomer?.name || "?").trim().charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{customer.name || selectedQboCustomer?.name || "Unnamed"}</p>
                <p className="mt-1 break-all text-sm text-muted-foreground">{customer.email || "Add a billing email"}</p>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{customer.address || "No billing address added"}</p>
              </div>
              {selectedQboCustomer ? (
                <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
                  <Check className="h-3 w-3" />
                  {providerName}
                </Badge>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setBillingDetailsOpen((value) => !value)}
                className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                {billingDetailsOpen ? <Check className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
                {billingDetailsOpen ? "Done" : "Edit"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  markDirty()
                  setCustomerDetails("")
                  setCustomerId("none")
                  setSelectedQboCustomer(null)
                  setBillingDetailsOpen(false)
                }}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Clear customer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : showQboCustomerPicker ? (
            <Popover open={customerPickerOpen} onOpenChange={setCustomerPickerOpen} modal>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="h-10 w-full justify-start font-normal text-muted-foreground">
                  <Search className="mr-2 h-4 w-4 shrink-0 opacity-60" />
                  Search {providerName} customers…
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[300px] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput placeholder={`Search ${providerName} customers…`} value={customerQuery} onValueChange={setCustomerQuery} />
                  <CommandList>
                    {customerSearchLoading ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                        <Spinner className="h-3.5 w-3.5" /> Searching…
                      </div>
                    ) : null}
                    {!customerSearchLoading && customerResults.length === 0 ? <CommandEmpty>No {providerName} customers found.</CommandEmpty> : null}
                    {customerResults.length > 0 ? (
                      <CommandGroup>
                        {customerResults.map((entry) => (
                          <CommandItem key={entry.id} value={entry.id} onSelect={() => selectQboCustomer(entry)}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{entry.name}</span>
                              {entry.email ? <span className="text-xs text-muted-foreground">{entry.email}</span> : null}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ) : null}
                    {customerQuery.trim().length > 0 ? (
                      <>
                        <CommandSeparator />
                        <CommandGroup>
                          <CommandItem value={`__create_${customerQuery}`} onSelect={handleCreateQboCustomer} disabled={creatingQboCustomer}>
                            {creatingQboCustomer ? <Spinner className="mr-2 h-3.5 w-3.5" /> : <Plus className="mr-2 h-3.5 w-3.5" />}
                            Create &ldquo;{customerQuery.trim()}&rdquo; in {providerName}
                          </CommandItem>
                        </CommandGroup>
                      </>
                    ) : null}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          ) : (
            <Select
              value={customerId}
              onValueChange={(value) => {
                if (value === "none") return
                selectContact(value)
              }}
            >
              <SelectTrigger className="h-10 w-full bg-transparent text-sm data-[placeholder]:text-muted-foreground">
                <span className="flex items-center gap-2 truncate">
                  <UserRound className="h-4 w-4 shrink-0 opacity-60" />
                  <SelectValue placeholder={contextLoading && arcCustomerOptions.length === 0 ? "Loading customers…" : "Choose a customer"} />
                </span>
              </SelectTrigger>
              <SelectContent>
                {arcCustomerOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.detail}</span>
                    </span>
                  </SelectItem>
                ))}
                {arcCustomerOptions.length === 0 && !contextLoading ? (
                  <SelectItem value="none" disabled>
                    No billable contacts on this project yet
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          )}
          {!hasCustomer ? (
            <button
              type="button"
              onClick={() => setBillingDetailsOpen((value) => !value)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className={cn("h-3.5 w-3.5 transition-transform", billingDetailsOpen && "rotate-45")} />
              Enter billing details by hand
            </button>
          ) : null}
          {billingDetailsOpen ? (
            <Textarea
              value={customerDetails}
              onChange={(event) => {
                customerManuallyChosenRef.current = true
                markDirty()
                setCustomerDetails(event.target.value)
              }}
              placeholder={"Name\nemail@customer.com\nBilling address"}
              className="min-h-[96px] text-sm leading-relaxed"
            />
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <label className="space-y-1">
            <span className={fieldLabel}>Invoice #</span>
            <Input
              id="invoice-number"
              value={invoiceNumber}
              onChange={(event) => {
                invoiceNumberTouchedRef.current = true
                markDirty()
                setInvoiceNumber(event.target.value)
              }}
              placeholder={!initialInvoice && !reservation ? "Reserving…" : "—"}
              aria-invalid={submitAttempted && !invoiceNumber.trim() ? true : undefined}
              className={cn("h-9 font-mono text-sm tabular-nums", submitAttempted && !invoiceNumber.trim() && "border-destructive/60")}
            />
          </label>
          <label className="space-y-1">
            <span className={fieldLabel}>Issue date</span>
            <DatePicker value={issueDate} onChange={handleIssueDateChange} className="h-9 border-input" />
          </label>
          <label id="invoice-due-date" className="space-y-1">
            <span className={fieldLabel}>Due date</span>
            <DatePicker value={dueDate} onChange={handleDueDateChange} className="h-9 border-input" />
          </label>
          <label className="space-y-1">
            <span className={fieldLabel}>Terms</span>
            <Select
              value={TERM_PRESETS.some((preset) => preset.days === paymentTermsDays) ? String(paymentTermsDays) : "custom"}
              onValueChange={(value) => {
                if (value === "custom") return
                handleTermsChange(Number(value))
              }}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TERM_PRESETS.map((preset) => (
                  <SelectItem key={preset.days} value={String(preset.days)}>
                    {preset.label}
                  </SelectItem>
                ))}
                {TERM_PRESETS.some((preset) => preset.days === paymentTermsDays) ? null : (
                  <SelectItem value="custom">Net {paymentTermsDays}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </label>
        </div>

        {receivablesPolicy.supportsBuyerDeposits || receivablesPolicy.supportsClosingInvoices ? (
          <label className="block space-y-1">
            <span className={fieldLabel}>Document</span>
            <Select
              value={invoiceKind}
              onValueChange={(value) => {
                markDirty()
                setInvoiceKind(value as InvoiceKind)
              }}
            >
              <SelectTrigger className="h-9 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="earnest_deposit">Buyer deposit</SelectItem>
                <SelectItem value="closing">Closing invoice</SelectItem>
                <SelectItem value="standard">Other invoice</SelectItem>
              </SelectContent>
            </Select>
          </label>
        ) : null}

        <label className="block space-y-1">
          <span className={fieldLabel}>Invoice title <span className="font-normal normal-case tracking-normal">· shown to the customer</span></span>
          <Input id="invoice-title" value={title} onChange={(event) => { markDirty(); setTitle(event.target.value) }} placeholder={`${projectName} — progress billing`} aria-invalid={submitAttempted && title.trim().length < 3 || undefined} className="h-10 rounded-md text-sm" />
        </label>
      </section>

      {/* ── Items ── */}
      <section id="invoice-items" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className={sectionTitle}>{invoiceLabel === "Invoice" ? "Items" : invoiceLabel}</h2>
          {contextLoading || approvedCostsLoading ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Loading sources…
            </span>
          ) : null}
        </div>

        {linkedDraw || linkedChangeOrder || costSummary ? (
          <div className="flex flex-wrap items-center gap-2">
            {linkedDraw ? (
              <Badge variant="secondary" className="h-6 gap-1.5 pr-1 text-xs">
                Draw {linkedDraw.draw_number} — {linkedDraw.title}
                <button type="button" onClick={() => { markDirty(); setSourceDrawId("none") }} className="p-0.5 hover:bg-foreground/10" aria-label="Unlink draw">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ) : null}
            {linkedChangeOrder ? (
              <Badge variant="secondary" className="h-6 gap-1.5 pr-1 text-xs">
                {linkedChangeOrder.title}
                <button type="button" onClick={() => { markDirty(); setSourceChangeOrderId("none") }} className="p-0.5 hover:bg-foreground/10" aria-label="Unlink change order">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ) : null}
            {costSummary ? (
              <Badge variant="secondary" className="h-6 text-xs">
                {costSummary.costCount} {costSummary.costCount === 1 ? "cost" : "costs"} · {formatMoney(costSummary.totalBillableCents / 100)}
              </Badge>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-3">
          {itemLines.map((line, lineIndex) => {
            const quantityNumber = Number(line.quantity)
            const amount = (Number.isFinite(quantityNumber) ? quantityNumber : 0) * (Number(line.unit_cost) || 0)
            const selectedCostCode = costCodes.find((code) => code.id === line.cost_code_id)
            const descriptionInvalid = submitAttempted && !line.description.trim()
            const quantityInvalid = submitAttempted && (!Number.isFinite(quantityNumber) || quantityNumber < 0.01)
            const priceInvalid = submitAttempted && !Number.isFinite(Number(line.unit_cost))
            const selectedAccountId = nativeBooks ? line.arc_books_gl_account_id : line.qbo_income_account_id
            const selectedAccountName = nativeBooks ? line.arc_books_gl_account_name : line.qbo_income_account_name
            const accountMissing = submitAttempted && accountSelectionEnabled && qboIncomeAccounts.length > 0 && !selectedAccountId
            const codingFields = [showCostCodeColumn, showQboAccountColumn, showTax].filter(Boolean).length
            return (
              <div
                key={line.id}
                id={`invoice-line-${line.id}`}
                role="group"
                aria-label={`Item ${lineIndex + 1}`}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey) {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!event.repeat) addItem()
                  }
                }}
                className="group/line rounded-none border border-border/80 bg-background shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-border focus-within:border-primary/40 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_8%,transparent)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-reduce:transition-none"
              >
                <div className="flex items-center gap-3 px-4 pt-3">
                  {line.billable_cost_ids?.length ? <span className="text-xs text-muted-foreground">From approved costs</span> : null}
                  {!collapsedLineIds.has(line.id) ? <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setCollapsedLineIds((current) => {
                        const next = new Set(current)
                        if (next.has(line.id)) next.delete(line.id)
                        else next.add(line.id)
                        return next
                      })}
                      aria-expanded={!collapsedLineIds.has(line.id)}
                    >
                      {collapsedLineIds.has(line.id) ? "Edit" : <><Check className="mr-1 h-3.5 w-3.5" />Done</>}
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8 rounded-md text-muted-foreground" disabled={Boolean(line.billable_cost_ids?.length)} title={line.billable_cost_ids?.length ? "Linked costs can only be billed once" : "Duplicate item"} onClick={() => duplicateItem(line)} aria-label={`Duplicate item ${lineIndex + 1}`}><Copy className="size-3.5" /></Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => removeItem(line.id)} aria-label={`Remove item ${lineIndex + 1}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div> : null}
                </div>
                {collapsedLineIds.has(line.id) ? (
                  <div className="flex items-center gap-3 px-4 pb-3 pt-2 text-left text-sm">
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left font-medium transition-colors hover:text-primary"
                      onClick={() => setCollapsedLineIds((current) => {
                        const next = new Set(current)
                        next.delete(line.id)
                        return next
                      })}
                      aria-label={`Edit item ${lineIndex + 1}`}
                    >
                      {line.description || "Untitled item"}
                    </button>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">Qty {line.quantity || "0"}</span>
                    <span className="relative flex min-w-[8rem] shrink-0 items-center justify-end">
                      <span className="font-semibold tabular-nums transition-[opacity,transform] duration-150 group-hover/line:translate-y-1 group-hover/line:opacity-0 group-focus-within/line:translate-y-1 group-focus-within/line:opacity-0 motion-reduce:transition-none">
                        <AnimatedCurrency cents={Math.round(amount * 100)} />
                      </span>
                      <span className="pointer-events-none absolute right-0 flex translate-y-1 items-center gap-0.5 opacity-0 transition-[opacity,transform] duration-150 group-hover/line:pointer-events-auto group-hover/line:translate-y-0 group-hover/line:opacity-100 group-focus-within/line:pointer-events-auto group-focus-within/line:translate-y-0 group-focus-within/line:opacity-100 motion-reduce:transition-none">
                        <Button type="button" variant="ghost" size="icon" className="size-7 rounded-md text-muted-foreground" onClick={() => setCollapsedLineIds((current) => { const next = new Set(current); next.delete(line.id); return next })} aria-label={`Edit item ${lineIndex + 1}`}><Pencil className="size-3.5" /></Button>
                        <Button type="button" variant="ghost" size="icon" className="size-7 rounded-md text-muted-foreground" disabled={Boolean(line.billable_cost_ids?.length)} title={line.billable_cost_ids?.length ? "Linked costs can only be billed once" : "Duplicate item"} onClick={() => duplicateItem(line)} aria-label={`Duplicate item ${lineIndex + 1}`}><Copy className="size-3.5" /></Button>
                        <Button type="button" variant="ghost" size="icon" className="size-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => removeItem(line.id)} aria-label={`Remove item ${lineIndex + 1}`}><Trash2 className="size-3.5" /></Button>
                      </span>
                    </span>
                  </div>
                ) : (
                <div className="px-4 pb-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_56px_96px_112px]">
                  <label className="col-span-2 block space-y-1 sm:col-span-1">
                    <span className={fieldLabel}>Description</span>
                    <Input
                      ref={(node) => {
                        if (node && focusLineId === line.id) {
                          node.focus()
                          setFocusLineId(null)
                        }
                      }}
                      id={`invoice-description-${line.id}`}
                      value={line.description}
                      onChange={(event) => updateLine(line.id, "description", event.target.value)}
                      placeholder="What is being billed"
                      aria-invalid={descriptionInvalid || undefined}
                      className={cn("h-10 rounded-md bg-background text-sm", descriptionInvalid && "border-destructive/60")}
                    />
                  </label>

                  <label className="space-y-1">
                    <span className={fieldLabel}>Qty</span>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      id={`invoice-quantity-${line.id}`}
                      value={line.quantity}
                      onChange={(event) => updateLine(line.id, "quantity", event.target.value)}
                      aria-invalid={quantityInvalid || undefined}
                      className={cn("h-10 rounded-md bg-background text-right text-sm tabular-nums", noSpinner, quantityInvalid && "border-destructive/60")}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className={fieldLabel}>Unit price</span>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      id={`invoice-price-${line.id}`}
                      value={line.unit_cost}
                      onChange={(event) => updateLine(line.id, "unit_cost", event.target.value)}
                      placeholder="0.00"
                      aria-invalid={priceInvalid || undefined}
                      className={cn("h-10 rounded-md bg-background text-right text-sm tabular-nums", noSpinner, priceInvalid && "border-destructive/60")}
                    />
                  </label>
                  <div className="col-span-2 space-y-1 sm:col-span-1">
                    <span className={fieldLabel}>Amount</span>
                    <div className="flex h-10 items-center justify-end rounded-md border border-border/60 bg-muted/30 px-3 text-sm font-semibold tabular-nums">
                      <AnimatedCurrency cents={Math.round(amount * 100)} />
                    </div>
                  </div>
                </div>

                {/* Coding follows the active ledger: Arc Books chart accounts when
                    Arc is authoritative, provider accounts when an integration is. */}
                {codingFields > 0 ? (
                  <div className="mt-4 border-t border-border/60 pt-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                    {showCostCodeColumn ? (
                      <label className="space-y-1">
                        <span className={fieldLabel}>Cost code</span>
                        <Select value={line.cost_code_id ?? "none"} onValueChange={(value) => updateLine(line.id, "cost_code_id", value === "none" ? null : value)}>
                          <SelectTrigger className="h-10 w-full rounded-md bg-background text-sm">
                            <SelectValue placeholder="—">{selectedCostCode ? `${selectedCostCode.code} — ${selectedCostCode.name}` : "No cost code"}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No cost code</SelectItem>
                            {costCodeGroups.map((group) => (
                              <SelectGroup key={group.standard}>
                                <SelectLabel>{group.label}</SelectLabel>
                                {group.codes.map((code) => (
                                  <SelectItem key={code.id} value={code.id}>
                                    {code.code} — {code.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                    ) : null}
                    {showQboAccountColumn ? (
                      <div className="space-y-1">
                        <span className={fieldLabel}>Income account</span>
                        {contextLoading && !qboConnected ? (
                          <p className="flex h-10 items-center text-sm text-muted-foreground">Loading…</p>
                        ) : (
                          <QboLineAccountPicker
                            id={`invoice-account-${line.id}`}
                            ariaLabel={`Item ${lineIndex + 1}: Income account`}
                            invalid={accountMissing}
                            valueId={selectedAccountId}
                            valueLabel={selectedAccountName}
                            accounts={qboIncomeAccounts}
                            onSelect={({ id, name }) => {
                              markDirty()
                              setLines((prev) => prev.map((entry) => entry.id === line.id
                                ? nativeBooks
                                  ? { ...entry, arc_books_gl_account_id: id, arc_books_gl_account_name: name }
                                  : { ...entry, qbo_income_account_id: id, qbo_income_account_name: name }
                                : entry))
                            }}
                            onCreateAccount={!canCreateIncomeAccount ? undefined : async (name) => {
                              try {
                                return await handleCreateQboIncomeAccount(name)
                              } catch (error: any) {
                                toast.error(`Could not create ${providerName} account`, { description: error?.message ?? "Please try again." })
                                throw error
                              }
                            }}
                            triggerClassName={cn(
                              "h-10 w-full max-w-none justify-between rounded-md border border-input bg-background px-3 text-sm",
                              selectedAccountId ? "text-foreground" : "text-muted-foreground",
                              accountMissing && "border-destructive/60 text-destructive",
                            )}
                          />
                        )}
                        {selectedAccountId && lines.some((entry) => !(nativeBooks ? entry.arc_books_gl_account_id : entry.qbo_income_account_id)) ? (
                          <button type="button" className="text-xs text-primary hover:underline" onClick={() => {
                            markDirty()
                            setLines((prev) => prev.map((entry) => (nativeBooks ? entry.arc_books_gl_account_id : entry.qbo_income_account_id) ? entry : nativeBooks
                              ? { ...entry, arc_books_gl_account_id: selectedAccountId, arc_books_gl_account_name: selectedAccountName }
                              : { ...entry, qbo_income_account_id: selectedAccountId, qbo_income_account_name: selectedAccountName }))
                          }}>Apply to uncoded items</button>
                        ) : null}
                      </div>
                    ) : null}
                    {showTax ? (
                      <div className={cn("space-y-1", codingFields % 2 === 1 && "sm:col-span-2")}>
                        <span className={fieldLabel}>Tax</span>
                        <div className="flex h-10 items-center gap-3 rounded-md border border-input bg-background px-3">
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox checked={line.taxable} onCheckedChange={(checked) => updateLine(line.id, "taxable", checked === true)} className="size-4 shadow-none" />
                            Taxable
                          </label>
                          <Input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            max="20"
                            step="0.01"
                            disabled={!line.taxable}
                            id={`invoice-tax-${line.id}`}
                      value={line.tax_rate_percent}
                            onChange={(event) => updateLine(line.id, "tax_rate_percent", event.target.value)}
                            placeholder={taxRate > 0 ? `${taxRate}%` : "rate"}
                            aria-label="Tax rate override"
                            className={cn("ml-auto h-7 w-16 border-0 bg-transparent px-1 text-right text-sm tabular-nums shadow-none", noSpinner)}
                          />
                        </div>
                      </div>
                    ) : null}
                    </div>
                  </div>
                ) : null}

                {accountMissing ? <p className="mt-2 text-xs text-destructive">Choose an income account for this item.</p> : null}
                </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" onClick={addItem} title="Add item · Ctrl / ⌘ + Shift + Enter" className="flex h-9 items-center gap-2 rounded-md border border-dashed border-border px-3 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary">
            <Plus className="h-4 w-4" />
            Add item
            <kbd className="hidden rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground sm:inline-flex">⌘⇧↵</kbd>
          </button>
          {enableApprovedCostsSource || drawOptions.length > 0 || changeOrderOptions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex items-center gap-1.5 text-sm font-medium transition-colors hover:text-primary">
                  <Plus className="h-4 w-4" />
                  Add from…
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                {enableApprovedCostsSource ? <DropdownMenuItem onSelect={() => setCostPickerOpen(true)}>Approved costs…</DropdownMenuItem> : null}
                {drawOptions.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Draws</DropdownMenuLabel>
                    {drawOptions.map((draw) => (
                      <DropdownMenuItem key={draw.id} onSelect={() => applyDrawToInvoice(draw.id)}>
                        Draw {draw.draw_number} — {draw.title}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
                {changeOrderOptions.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Change orders</DropdownMenuLabel>
                    {changeOrderOptions.map((changeOrder) => (
                      <DropdownMenuItem key={changeOrder.id} onSelect={() => applyChangeOrderToInvoice(changeOrder.id)}>
                        {changeOrder.title}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        {/*
          The totals are the adjustments. A discount, tax or a credit is a row
          in the same column of numbers it changes, edited where it is read,
          and added from one small menu at the bottom of that column.
        */}
        <div className="ml-auto w-full max-w-sm text-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="font-mono tabular-nums">{formatMoney(lineTotals.subtotal / 100)}</span>
          </div>

          {showDiscount ? (
            <div className="flex items-center justify-between gap-2 py-1 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Discount</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  autoFocus={!discountValue}
                  value={discountValue}
                  onChange={(event) => {
                    markDirty()
                    setDiscountValue(event.target.value)
                  }}
                  aria-label="Discount amount"
                  className={cn("h-7 w-20 px-2 text-right text-sm tabular-nums", noSpinner)}
                />
                <div className="flex border text-[11px]">
                  {(["percent", "fixed"] as DiscountType[]).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => {
                        markDirty()
                        setDiscountType(kind)
                      }}
                      className={cn("h-7 w-7 transition-colors", (discountType ?? "percent") === kind ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}
                    >
                      {kind === "percent" ? "%" : "$"}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    markDirty()
                    setDiscountValue("")
                    setDiscountType(null)
                    setShowDiscount(false)
                  }}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Remove discount"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <span className="font-mono tabular-nums">{lineTotals.discount > 0 ? `-${formatMoney(lineTotals.discount / 100)}` : "—"}</span>
            </div>
          ) : null}

          {showTax ? (
            <div className="flex items-center justify-between gap-2 py-1 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-muted-foreground">Tax</span>
                {taxJurisdictions.length > 0 ? (
                  <Select
                    value={taxJurisdictionId}
                    onValueChange={(value) => {
                      markDirty()
                      setTaxJurisdictionId(value)
                      const jurisdiction = taxJurisdictions.find((item) => item.id === value)
                      if (jurisdiction) setTaxRate(jurisdiction.sales_tax_rate_micros / 10000)
                    }}
                  >
                    <SelectTrigger className="h-7 max-w-[11rem] text-xs">
                      <SelectValue placeholder="Jurisdiction" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No jurisdiction</SelectItem>
                      {taxJurisdictions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name} · {(item.sales_tax_rate_micros / 10000).toFixed(3)}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <Input
                  type="number"
                  min="0"
                  max="20"
                  step="0.01"
                  autoFocus={taxRate === 0}
                  value={taxRate}
                  onChange={(event) => {
                    markDirty()
                    setTaxRate(Number(event.target.value || 0))
                  }}
                  aria-label="Tax rate percent"
                  className={cn("h-7 w-16 px-2 text-right text-sm tabular-nums", noSpinner)}
                />
                <span className="text-xs text-muted-foreground">%</span>
                <button
                  type="button"
                  onClick={() => {
                    markDirty()
                    setTaxRate(0)
                    setTaxJurisdictionId("none")
                    setShowTax(false)
                  }}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Remove tax"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <span className="font-mono tabular-nums">{formatMoney(lineTotals.tax / 100)}</span>
            </div>
          ) : null}

          {creditLines.map((line) => (
            <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-1 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
              <div className="flex min-w-0 items-center gap-1.5">
                <Input
                  id={`invoice-description-${line.id}`}
                  value={line.description}
                  onChange={(event) => updateLine(line.id, "description", event.target.value)}
                  aria-label="Credit label"
                  className="h-7 min-w-0 flex-1 px-2 text-sm"
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={String(Math.abs(Number(line.unit_cost) || 0) || "")}
                  onChange={(event) => updateLine(line.id, "unit_cost", event.target.value ? String(-Math.abs(Number(event.target.value))) : "")}
                  id={`invoice-price-${line.id}`}
                  aria-label="Credit amount"
                  className={cn("h-7 w-24 px-2 text-right text-sm tabular-nums", noSpinner)}
                />
                <button type="button" onClick={() => removeItem(line.id)} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Remove credit">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {accountSelectionEnabled ? <QboLineAccountPicker
                id={`invoice-account-${line.id}`}
                ariaLabel="Credit income account"
                valueId={nativeBooks ? line.arc_books_gl_account_id : line.qbo_income_account_id}
                valueLabel={nativeBooks ? line.arc_books_gl_account_name : line.qbo_income_account_name}
                accounts={qboIncomeAccounts}
                onSelect={({ id, name }) => {
                  markDirty()
                  setLines((prev) => prev.map((entry) => entry.id !== line.id ? entry : nativeBooks
                    ? { ...entry, arc_books_gl_account_id: id, arc_books_gl_account_name: name }
                    : { ...entry, qbo_income_account_id: id, qbo_income_account_name: name }))
                }}
                triggerClassName="h-8 max-w-[200px] border border-input px-2 text-xs"
              /> : null}
              <span className="font-mono tabular-nums">-{formatMoney(Math.abs(Number(line.unit_cost) || 0))}</span>
            </div>
          ))}

          {retainageCents > 0 ? (
            <div className="flex items-center justify-between py-1.5 text-warning">
              <span>Retainage held ({retainagePercent}%)</span>
              <span className="font-mono tabular-nums">-{formatMoney(retainageCents / 100)}</span>
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t py-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                  <Plus className="h-3.5 w-3.5" />
                  Discount, tax or credit
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem
                  disabled={showDiscount}
                  onSelect={() => {
                    if (!discountType) setDiscountType("percent")
                    setShowDiscount(true)
                  }}
                >
                  Discount
                </DropdownMenuItem>
                <DropdownMenuItem disabled={showTax} onSelect={() => setShowTax(true)}>
                  Sales tax
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={addCredit}>Deposit or credit received</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-xs text-muted-foreground">Amount due</span>
          </div>
          <div className="flex items-center justify-between pb-1 text-base font-semibold">
            <span />
            <AnimatedCurrency cents={netInvoiceTotal} className="font-mono tabular-nums" />
          </div>
        </div>
      </section>

      {/* ── Attachments (folded: most invoices carry none) ── */}
      <Accordion type="single" collapsible defaultValue={memo ? "memo" : undefined} className="border">
        <AccordionItem value="attachments" className="border-0">
          <AccordionTrigger className="px-4 py-3 text-sm font-semibold hover:no-underline">
            <span className="flex items-center gap-2">
              Attachments
              {attachments.length > 0 ? (
                <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">{attachments.length}</span>
              ) : null}
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4">
            <p className="mb-3 text-xs text-muted-foreground">Backup that travels with the invoice — receipts, waivers, signed change orders. Never printed on it.</p>
            <InvoiceAttachmentsField
              attachments={attachments}
              busy={attachmentsBusy}
              canAttach={Boolean(buildPayload())}
              onAttach={handleAttach}
              onDetach={handleDetach}
            />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="memo" className="border-0 border-t">
          <AccordionTrigger className="px-4 py-3 text-sm font-medium hover:no-underline">
            <span className="flex items-center gap-2">
              Internal memo
              <span className="text-xs font-normal text-muted-foreground">Only your team sees this</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-4 pb-4">
            <Textarea
              value={memo}
              onChange={(event) => { markDirty(); setMemo(event.target.value) }}
              placeholder="Notes for your accounting team…"
              className="min-h-20 rounded-md text-sm"
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* ── Payment ── */}
      <section className="space-y-4">
        <h2 className={sectionTitle}>Payment</h2>
        <Accordion type="multiple" className="border">
          <AccordionItem value="methods" className="border-0">
            <AccordionTrigger className="px-4 py-3 text-sm font-medium hover:no-underline">
              <span className="flex min-w-0 items-center gap-2">
                Online payment methods
                <span className="truncate text-xs font-normal text-muted-foreground">
                  {paymentMethodLabels(paymentMethods).join(" · ") || "None — bank instructions only"}
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-0 pb-0">
<div className="divide-y border">
          {(
            [
              { key: "ach" as const, label: "Bank transfer (ACH)", detail: "Lowest fee; settles in a few business days", Icon: Landmark },
              { key: "card" as const, label: "Card", detail: "Instant; the card fee is shown to the payer before they pay", Icon: CreditCard },
            ] as const
          ).map(({ key, label, detail, Icon }) => (
            <label key={key} className="flex cursor-pointer items-center gap-3 px-4 py-3">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{detail}</span>
              </span>
              <Switch
                checked={paymentMethods[key]}
                onCheckedChange={(checked) => {
                  markDirty()
                  setPaymentMethods((current) => ({ ...current, [key]: checked }))
                }}
                aria-label={label}
              />
            </label>
          ))}
        </div>

            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="details" className="border-0 border-t">
            <AccordionTrigger className="px-4 py-3 text-sm font-medium hover:no-underline">
              Payment details
            </AccordionTrigger>
            <AccordionContent className="space-y-2 px-4 pb-4">
              <p className="text-xs text-muted-foreground">
                Printed at the bottom of the invoice: bank instructions, references, anything the {receivablesPolicy.customerLabel.toLowerCase()} needs to pay.
              </p>
              <Textarea
                value={notes}
                onChange={(event) => {
                  markDirty()
                  setNotes(event.target.value)
                }}
                className="min-h-[96px] text-sm"
                placeholder={"Bank transfer (ACH / Wire)\nBank name, account and routing…"}
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>

      <UnbilledCostsPicker open={costPickerOpen} onOpenChange={setCostPickerOpen} projectId={projectId} costCodesEnabled={showCostCodeColumn} onConfirm={handleCostSelection} />

    </div>
  )
})

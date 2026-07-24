"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { addDays, format, parse } from "date-fns"
import { CalendarIcon, Check, ChevronDown, Download, Loader2, Plus, Search, Send, UserRound, X } from "lucide-react"
import NumberFlow from "@number-flow/react"
import { toast } from "sonner"

import type { ChangeOrder, Contact, CostCode, Invoice, Project } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import {
  createQBOIncomeAccountAction,
  createQboCustomerAction,
  generateInvoicePdfAction,
  getInvoiceComposerContextAction,
  searchQboCustomersAction,
} from "@/app/(app)/invoices/actions"
import { generateInvoiceFromCostsAction } from "@/app/(app)/projects/[id]/financials/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
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
import { calculateInvoiceTotals, deriveRetainageCents } from "@/lib/financials/invoice-totals"
import { UnbilledCostsPicker, type CostSelection } from "@/components/invoices/unbilled-costs-picker"
import { unwrapAction } from "@/lib/action-result"
import { useProductTerminology } from "@/components/layout/use-product-terminology"
import { usePageTitle } from "@/components/layout/page-title-context"
import { getProjectPosture } from "@/lib/product-tier"
import { groupCostCodesByStandard } from "@/lib/cost-code-groups"
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
  billable_cost_ids?: string[]
  cost_cents?: number | null
  markup_cents?: number | null
  markup_percent?: number | null
}

type DiscountType = "percent" | "fixed"

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

export type AutosaveState = "idle" | "saving" | "saved" | "error"

/** Scroll wrapper for the document fields. */
function DocumentScroller({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">{children}</div>
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

/* Ghost input — borderless by default, shows border on hover/focus */
function GhostInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      className={cn(
        "border-transparent bg-transparent shadow-none transition-colors hover:border-input focus:border-input",
        className,
      )}
      {...props}
    />
  )
}

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
  onCreateAccount: (name: string) => Promise<QBOIncomeAccountOption>
  triggerClassName?: string
}

function QboLineAccountPicker({ valueId, valueLabel, accounts, onSelect, onCreateAccount, triggerClassName }: QboLineAccountPickerProps) {
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
  const showCreate = normalizedQuery.length > 0 && !hasExactMatch

  const selectAccount = (account: QBOIncomeAccountOption) => {
    onSelect({ id: account.id, name: formatQboAccountLabel(account) })
    setOpen(false)
    setQuery("")
  }

  const handleCreate = async () => {
    if (!showCreate || creating) return
    setCreating(true)
    try {
      const created = await onCreateAccount(normalizedQuery)
      selectAccount(created)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-5 max-w-[140px] items-center rounded-none px-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground",
            triggerClassName,
          )}
          title={displayLabel}
        >
          <span className="truncate">{displayLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[300px] overflow-hidden p-0" align="start">
        <Command>
          <CommandInput placeholder="Search QBO account..." value={query} onValueChange={setQuery} />
          <CommandList className="max-h-64 overscroll-contain" onWheelCapture={(event) => event.stopPropagation()}>
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

interface InvoiceEditableDocumentProps {
  /** The persisted draft (null for a brand-new, not-yet-created invoice). */
  initialInvoice: Invoice | null
  projectId: string
  projects: Project[]
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  contacts?: Contact[]
  costCodes?: CostCode[]
  enableApprovedCostsSource?: boolean
  duplicateFrom?: Invoice | null
  initialSourceChangeOrder?: ChangeOrder | null
  initialSourceChangeOrderId?: string
  /** Reserved invoice number for a brand-new draft (with its reservation id). */
  reservation?: { number: string; reservationId: string | null } | null
  /** Current autosave state, shown quietly in the header. */
  autosaveState?: AutosaveState
  /** Create the draft on first meaningful edit. Returns the persisted invoice. */
  onCreateDraft: (input: InvoiceInput) => Promise<Invoice>
  /** Debounced autosave for an existing editable draft. */
  onAutosave: (invoiceId: string, input: InvoiceInput) => Promise<Invoice>
  /** Explicit publish. Returns the sent invoice. */
  onSend: (invoiceId: string, input: InvoiceInput, recipientEmail: string) => Promise<Invoice>
  onAutosaveStateChange?: (state: AutosaveState) => void
}

export function InvoiceEditableDocument({
  initialInvoice,
  projectId,
  projects,
  builderInfo,
  contacts = [],
  costCodes = [],
  enableApprovedCostsSource = false,
  duplicateFrom = null,
  initialSourceChangeOrder = null,
  initialSourceChangeOrderId,
  reservation = null,
  autosaveState = "idle",
  onCreateDraft,
  onAutosave,
  onSend,
  onAutosaveStateChange,
}: InvoiceEditableDocumentProps) {
  const terms = useProductTerminology()
  const { productTier } = usePageTitle()

  const seed = initialInvoice ?? duplicateFrom ?? null
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? projects[0] ?? null, [projects, projectId])
  const projectName = project?.name ?? "Project"

  // ── Form state (seeded once on mount) ──────────────────────────────────────
  const [invoiceNumber, setInvoiceNumber] = useState(initialInvoice?.invoice_number ?? reservation?.number ?? "")
  const [title, setTitle] = useState(seed?.title ?? projectName)
  const [issueDate, setIssueDate] = useState(seed?.issue_date ?? format(new Date(), "yyyy-MM-dd"))
  const [dueDate, setDueDate] = useState(seed?.due_date ?? format(addDays(new Date(), 15), "yyyy-MM-dd"))
  const [paymentTermsDays, setPaymentTermsDays] = useState<number>((seed?.metadata?.payment_terms_days as number) ?? 15)
  const [customerId, setCustomerId] = useState<string>(
    (seed?.metadata?.customer_id as string | undefined) ?? "none",
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
      name: seed?.customer_name ?? String(seed?.metadata?.customer_name ?? ""),
      email: String(seed?.metadata?.customer_email ?? ""),
      address: formatAddressBlock(String(seed?.metadata?.customer_address ?? "")),
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
  const [taxRate, setTaxRate] = useState<number>(seed?.totals?.tax_rate ?? ((seed?.metadata?.tax_rate as number) ?? 0))
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

  const [editingTax, setEditingTax] = useState(false)
  const [editingDiscount, setEditingDiscount] = useState(false)
  const [depositDialogOpen, setDepositDialogOpen] = useState(false)
  const [depositAmount, setDepositAmount] = useState("")
  const [depositMemo, setDepositMemo] = useState("Less deposit received")
  const [costPickerOpen, setCostPickerOpen] = useState(false)
  const [approvedCostsLoading, setApprovedCostsLoading] = useState(false)
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false)
  const [sendRecipient, setSendRecipient] = useState("")
  const [sending, setSending] = useState(false)
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)

  // ── Context (draws / change orders / QBO) ──────────────────────────────────
  const [drawOptions, setDrawOptions] = useState<DrawOption[]>([])
  const [changeOrderOptions, setChangeOrderOptions] = useState<ChangeOrder[]>([])
  const [qboConnected, setQboConnected] = useState(false)
  const [qboIncomeAccounts, setQboIncomeAccounts] = useState<QBOIncomeAccountOption[]>([])
  const [qboDiagnostics, setQboDiagnostics] = useState<QboDiagnostics | null>(null)
  const [contextLoading, setContextLoading] = useState(false)

  // Live QBO customer typeahead.
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [customerQuery, setCustomerQuery] = useState("")
  const [customerResults, setCustomerResults] = useState<QBOCustomerOption[]>([])
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false)
  const [creatingQboCustomer, setCreatingQboCustomer] = useState(false)
  const customerManuallyChosenRef = useRef(Boolean(seed?.customer_name || seed?.metadata?.qbo_customer_id))
  const initialSourceAppliedRef = useRef(Boolean(initialSourceChangeOrder))

  // ── Autosave plumbing ──────────────────────────────────────────────────────
  const invoiceIdRef = useRef<string | null>(initialInvoice?.id ?? null)
  const reservationIdRef = useRef<string | null>(reservation?.reservationId ?? null)
  const savedSnapshotRef = useRef<string>("")
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)
  const dirtyRef = useRef(false)
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

  const financialContacts = useMemo(
    () =>
      [...contacts]
        .sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""))
        .filter((c) => c.contact_type === "client" || c.contact_type === "consultant"),
    [contacts],
  )
  const arcCustomerOptions = useMemo(
    () => financialContacts.map((c) => ({ value: c.id, label: c.full_name, detail: c.email ?? "Arc contact" })),
    [financialContacts],
  )
  const costCodeGroups = useMemo(
    () => groupCostCodesByStandard(costCodes, getProjectPosture(project?.property_type, productTier)),
    [costCodes, productTier, project?.property_type],
  )

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
  const retainageCents = deriveRetainageCents(lineTotals.subtotal, lineTotals.discount, retainagePercent)
  const netInvoiceTotal = lineTotals.total - retainageCents

  const showCustomerSelector = customerDetails.trim().length === 0
  const showQboAccountColumn = qboConnected || contextLoading
  const showCostCodeColumn = costCodes.length > 0
  const showQboWarning = Boolean(
    qboConnected && (qboIncomeAccounts.length === 0 || qboDiagnostics?.accountLoadWarning || qboDiagnostics?.connectionLastError),
  )
  const showQboCustomerPicker = showCustomerSelector && qboConnected
  const showArcCustomerPicker = showCustomerSelector && !qboConnected && (arcCustomerOptions.length > 0 || contextLoading)
  const showCustomerPicker = showQboCustomerPicker || showArcCustomerPicker

  // ── Payload builder (shared by autosave + send) ────────────────────────────
  const buildPayload = useCallback(
    (statusOverride?: InvoiceInput["status"], recipientEmail?: string): InvoiceInput | null => {
      if (!invoiceNumber.trim() || title.trim().length < 3) return null

      const parsedLines = lines.map((line) => {
        const selectedLineAccount = qboIncomeAccounts.find((a) => a.id === line.qbo_income_account_id)
        const overrideRate = Number(line.tax_rate_percent)
        return {
          cost_code_id: line.cost_code_id || undefined,
          description: line.description.trim(),
          quantity: Number(line.quantity),
          unit: line.unit.trim() || "ea",
          unit_cost: Number(line.unit_cost),
          taxable: line.taxable,
          tax_rate_percent: line.tax_rate_percent.trim() !== "" && Number.isFinite(overrideRate) ? overrideRate : undefined,
          qbo_income_account_id: line.qbo_income_account_id || undefined,
          qbo_income_account_name:
            selectedLineAccount?.fullyQualifiedName ?? selectedLineAccount?.name ?? line.qbo_income_account_name ?? undefined,
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
      const email = (recipientEmail ?? parsedCustomer.email).trim()
      const hasCostLines = lines.some((line) => (line.billable_cost_ids?.length ?? 0) > 0)
      const derivedSourceType: BillingSource = hasCostLines
        ? "from_costs"
        : sourceDrawId !== "none"
          ? "draw"
          : sourceChangeOrderId !== "none"
            ? "change_order"
            : "manual"
      const sendToClient = statusOverride === "sent"

      return {
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
        status: statusOverride ?? "draft",
        issue_date: issueDate || undefined,
        due_date: dueDate || undefined,
        notes: notes.trim() || undefined,
        client_visible: sendToClient,
        tax_rate: taxRate,
        discount_type: discountType && Number(discountValue) > 0 ? discountType : undefined,
        discount_value: discountType && Number(discountValue) > 0 ? Number(discountValue) : undefined,
        lines: parsedLines,
        sent_to_emails: sendToClient && email ? [email] : undefined,
        payment_terms_days: paymentTermsDays,
        source_type: derivedSourceType,
        source_draw_id: sourceDrawId !== "none" ? sourceDrawId : undefined,
        source_change_order_id: sourceChangeOrderId !== "none" ? sourceChangeOrderId : undefined,
        qbo_income_account_id: null,
        qbo_income_account_name: null,
      }
    },
    [
      customerDetails,
      customerId,
      discountType,
      discountValue,
      dueDate,
      fromDetails,
      invoiceNumber,
      issueDate,
      lines,
      notes,
      paymentTermsDays,
      projectId,
      qboIncomeAccounts,
      selectedQboCustomer,
      sourceChangeOrderId,
      sourceDrawId,
      taxRate,
      title,
    ],
  )

  // Keep the latest savable payload in a ref for the debounce timer to read.
  useEffect(() => {
    latestPayloadRef.current = buildPayload()
  }, [buildPayload])

  // Persist the current form if it's savable and something changed since the last save.
  const flushSave = useCallback(async () => {
    if (inFlightRef.current || committedRef.current) return
    const payload = latestPayloadRef.current ?? buildPayload()
    if (!payload) return
    const snapshot = JSON.stringify(payload)
    if (snapshot === savedSnapshotRef.current) {
      dirtyRef.current = false
      return
    }
    inFlightRef.current = true
    setAutosave("saving")
    try {
      const saved = invoiceIdRef.current
        ? await onAutosave(invoiceIdRef.current, payload)
        : await onCreateDraft(payload)
      invoiceIdRef.current = saved.id
      // The reservation is consumed once the draft exists.
      reservationIdRef.current = null
      savedSnapshotRef.current = snapshot
      dirtyRef.current = false
      setAutosave("saved")
    } catch (error) {
      setAutosave("error")
      toast.error("Autosave failed", { description: error instanceof Error ? error.message : "Changes are kept locally." })
    } finally {
      inFlightRef.current = false
      // A change landed while we were saving — reschedule.
      if (dirtyRef.current) scheduleSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPayload, onAutosave, onCreateDraft, setAutosave])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void flushSave()
    }, 2000)
  }, [flushSave])

  const markDirty = useCallback(() => {
    scheduleSave()
  }, [scheduleSave])

  // Flush pending edits on unmount so nothing is lost when the user navigates away.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (dirtyRef.current) void flushSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load billing sources + QBO context for the project.
  useEffect(() => {
    let cancelled = false
    setContextLoading(true)
    getInvoiceComposerContextAction(projectId)
      .then((actionResult) => {
        if (cancelled) return
        const result = unwrapAction(actionResult)
        setDrawOptions(result.draws ?? [])
        setChangeOrderOptions(result.changeOrders ?? [])
        setQboConnected(Boolean(result.qboConnected))
        setQboIncomeAccounts(result.qboIncomeAccounts ?? [])
        setQboDiagnostics((result.qboDiagnostics as QboDiagnostics | undefined) ?? null)
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
  }, [projectId])


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
      },
    ])
  }

  const applyChangeOrderToInvoice = (changeOrderId: string) => {
    const changeOrder = changeOrderOptions.find((option) => option.id === changeOrderId)
    if (!changeOrder) return
    setSourceChangeOrderId(changeOrderId)
    appendLines(linesFromChangeOrder(changeOrder))
  }

  const applyDepositCredit = () => {
    const amount = Number(depositAmount.replace(/[$,\s]/g, ""))
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a deposit amount greater than zero")
      return
    }
    appendLines([
      {
        id: crypto.randomUUID(),
        description: depositMemo.trim() || "Less deposit received",
        quantity: "1",
        unit: "credit",
        unit_cost: (-amount).toFixed(2),
        taxable: false,
        tax_rate_percent: "",
        cost_code_id: null,
        qbo_income_account_id: null,
        qbo_income_account_name: null,
      },
    ])
    setDepositDialogOpen(false)
    setDepositAmount("")
    setDepositMemo("Less deposit received")
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
        buildPartyDetailsBlock({ name: contact.full_name, email: contact.email ?? "", address: formatAddressBlock(contact.address?.formatted ?? "") }),
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
      toast.success(`Created "${created.name}" in QuickBooks`)
    } catch (error: any) {
      toast.error("Couldn't create customer in QuickBooks", { description: error?.message ?? "Try again." })
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

  const validateForSend = (): boolean => {
    setSubmitAttempted(true)
    const payload = buildPayload("sent", sendRecipient)
    if (!payload) {
      toast.error("Fix the highlighted fields before sending")
      return false
    }
    if (qboConnected && qboIncomeAccounts.length > 0 && lines.some((line) => !line.qbo_income_account_id)) {
      toast.error("Pick a QuickBooks account for every line item")
      return false
    }
    return true
  }

  const handleSendClick = () => {
    setSubmitAttempted(true)
    const payload = buildPayload()
    if (!payload) {
      toast.error("Fix the highlighted fields before sending")
      return
    }
    setSendRecipient(parsePartyDetailsBlock(customerDetails).email.trim())
    setSendConfirmOpen(true)
  }

  const handleConfirmSend = async () => {
    if (!validateForSend()) return
    const payload = buildPayload("sent", sendRecipient)
    if (!payload) return
    setSending(true)
    // Make sure the latest edits are persisted before we flip to sent.
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    try {
      let invoiceId = invoiceIdRef.current
      if (!invoiceId) {
        const created = await onCreateDraft(buildPayload() as InvoiceInput)
        invoiceId = created.id
        invoiceIdRef.current = created.id
        reservationIdRef.current = null
      }
      await onSend(invoiceId, payload, sendRecipient)
      committedRef.current = true
      dirtyRef.current = false
      setSendConfirmOpen(false)
    } catch (error) {
      toast.error("Could not send invoice", { description: error instanceof Error ? error.message : "Please try again." })
    } finally {
      setSending(false)
    }
  }

  const handleDownloadPdf = async () => {
    if (generatingPdf) return
    setGeneratingPdf(true)
    try {
      if (dirtyRef.current || !invoiceIdRef.current) await flushSave()
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
  const lineGridTemplate = [
    showQboAccountColumn ? "150px" : null,
    showCostCodeColumn ? "120px" : null,
    "minmax(0, 1fr)",
    "72px",
    "120px",
    "120px",
    "44px",
  ]
    .filter(Boolean)
    .join(" ")
  const headerLabel = "text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70"
  const ghostTrigger =
    "h-full w-full justify-start rounded-none border border-transparent bg-transparent px-2 text-sm shadow-none transition-colors hover:border-input focus:ring-0 focus-visible:ring-0 [&>svg]:size-3.5 [&>svg]:opacity-40"
  const noSpinner =
    "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"

  const linkedDraw = sourceDrawId !== "none" ? drawOptions.find((d) => d.id === sourceDrawId) ?? null : null
  const linkedChangeOrder = sourceChangeOrderId !== "none" ? changeOrderOptions.find((c) => c.id === sourceChangeOrderId) ?? null : null

  const autosaveLabel =
    autosaveState === "saving" ? "Saving…" : autosaveState === "saved" ? "Saved" : autosaveState === "error" ? "Save failed" : ""

  const handleSaveDraft = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    void flushSave()
  }

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


  return (
    <>
      {(linkedDraw || linkedChangeOrder || costSummary || contextLoading || approvedCostsLoading) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 shrink-0">
          {linkedDraw && (
            <Badge variant="secondary" className="h-6 gap-1.5 pr-1 text-xs">
              Draw {linkedDraw.draw_number} — {linkedDraw.title}
              <button type="button" onClick={() => { markDirty(); setSourceDrawId("none") }} className="p-0.5 hover:bg-foreground/10" aria-label="Unlink draw">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {linkedChangeOrder && (
            <Badge variant="secondary" className="h-6 gap-1.5 pr-1 text-xs">
              {linkedChangeOrder.title}
              <button type="button" onClick={() => { markDirty(); setSourceChangeOrderId("none") }} className="p-0.5 hover:bg-foreground/10" aria-label="Unlink change order">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {costSummary && (
            <Badge variant="secondary" className="h-6 text-xs">
              {costSummary.costCount} {costSummary.costCount === 1 ? "cost" : "costs"} · {formatMoney(costSummary.totalBillableCents / 100)}
            </Badge>
          )}
          {(contextLoading || approvedCostsLoading) && (
            <Badge variant="outline" className="h-6 gap-1.5 text-xs">
              <Spinner className="size-3" />
              Loading…
            </Badge>
          )}
        </div>
      )}
      {showQboWarning && (
        <div className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          {qboDiagnostics?.accountLoadWarning || qboDiagnostics?.connectionLastError || "QuickBooks is connected, but no income accounts were found."}
        </div>
      )}

      {/* Document body */}
      <DocumentScroller>
        <div className="flex items-start justify-between gap-8">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Invoice</h1>
            <GhostInput
              value={title}
              onChange={(e) => { markDirty(); setTitle(e.target.value) }}
              placeholder="Invoice title"
              aria-label="Invoice title"
              className={cn("-mx-2 mt-1 h-7 w-full max-w-sm px-2 text-sm text-muted-foreground", submitAttempted && title.trim().length < 3 && "border-destructive/60")}
            />
            {title !== projectName && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{projectName}</p>}
          </div>
          <div className="shrink-0">
            <div className="grid grid-cols-[auto_9rem] items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-right text-muted-foreground">Invoice #</span>
              <GhostInput
                value={invoiceNumber}
                onChange={(e) => { markDirty(); setInvoiceNumber(e.target.value) }}
                placeholder="—"
                className={cn("h-7 w-full px-2 text-right text-sm tabular-nums", submitAttempted && !invoiceNumber.trim() && "border-destructive/60")}
              />
              <span className="text-right text-muted-foreground">Issued</span>
              <DatePicker value={issueDate} onChange={handleIssueDateChange} />
              <span className="text-right text-muted-foreground">Due</span>
              <DatePicker value={dueDate} onChange={handleDueDateChange} />
              <span className="text-right text-muted-foreground">Net</span>
              <GhostInput
                type="number"
                inputMode="numeric"
                min="0"
                max="365"
                value={paymentTermsDays}
                onChange={(e) => handleTermsChange(Number(e.target.value || 0))}
                className={cn("h-7 w-full px-2 text-right text-sm tabular-nums", noSpinner)}
              />
            </div>
          </div>
        </div>

        {/* From / Bill to */}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="border border-border/60 p-4">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">From</p>
            <Textarea
              value={fromDetails}
              onChange={(e) => { markDirty(); setFromDetails(e.target.value) }}
              placeholder={"Business name\nemail@company.com\nAddress"}
              className="mt-2 min-h-[124px] border-transparent bg-transparent text-sm shadow-none hover:border-input focus:border-input transition-colors leading-relaxed"
            />
          </div>
          <div className="border border-border/60 p-4">
            <div className="flex h-5 items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Bill To</p>
              {!showCustomerSelector && (
                <div className="flex items-center gap-2">
                  {selectedQboCustomer && (
                    <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
                      <Check className="h-3 w-3" />
                      QuickBooks
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => { markDirty(); setCustomerDetails(""); setCustomerId("none"); setSelectedQboCustomer(null) }}
                    className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Change
                  </button>
                </div>
              )}
            </div>

            {showQboCustomerPicker && (
              <Popover open={customerPickerOpen} onOpenChange={setCustomerPickerOpen} modal>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 h-9 w-full justify-start rounded-none border-input bg-transparent text-sm font-normal text-muted-foreground shadow-none transition-colors hover:bg-muted/40"
                  >
                    <Search className="mr-2 h-3.5 w-3.5 shrink-0 opacity-60" />
                    Search QuickBooks customers…
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[300px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search QuickBooks customers…" value={customerQuery} onValueChange={setCustomerQuery} />
                    <CommandList>
                      {customerSearchLoading && (
                        <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                          <Spinner className="h-3.5 w-3.5" /> Searching…
                        </div>
                      )}
                      {!customerSearchLoading && customerResults.length === 0 && <CommandEmpty>No QuickBooks customers found.</CommandEmpty>}
                      {customerResults.length > 0 && (
                        <CommandGroup>
                          {customerResults.map((customer) => (
                            <CommandItem key={customer.id} value={customer.id} onSelect={() => selectQboCustomer(customer)}>
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">{customer.name}</span>
                                {customer.email && <span className="text-xs text-muted-foreground">{customer.email}</span>}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                      {customerQuery.trim().length > 0 && (
                        <>
                          <CommandSeparator />
                          <CommandGroup>
                            <CommandItem value={`__create_${customerQuery}`} onSelect={handleCreateQboCustomer} disabled={creatingQboCustomer}>
                              {creatingQboCustomer ? <Spinner className="mr-2 h-3.5 w-3.5" /> : <Plus className="mr-2 h-3.5 w-3.5" />}
                              Create &ldquo;{customerQuery.trim()}&rdquo; in QuickBooks
                            </CommandItem>
                          </CommandGroup>
                        </>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}

            {showArcCustomerPicker && (
              <Select
                value={customerId}
                onValueChange={(value) => {
                  if (value === "none") {
                    setCustomerId("none")
                    setCustomerDetails("")
                    return
                  }
                  selectContact(value)
                }}
              >
                <SelectTrigger className="mt-2 h-9 rounded-none border-input bg-transparent text-sm shadow-none transition-colors hover:bg-muted/40 data-[placeholder]:text-muted-foreground">
                  <span className="flex items-center gap-2 truncate">
                    <UserRound className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    <SelectValue placeholder="Select a customer" />
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
                  {contextLoading && (
                    <SelectItem value="__loading_contacts" disabled>
                      Loading customers...
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            )}

            <Textarea
              value={customerDetails}
              onChange={(e) => { customerManuallyChosenRef.current = true; markDirty(); setCustomerDetails(e.target.value) }}
              placeholder={showCustomerPicker ? "…or enter billing details manually" : "Name\nemail@customer.com\nBilling address"}
              className={cn(
                "mt-2 border-transparent bg-transparent text-sm leading-relaxed shadow-none transition-colors hover:border-input focus:border-input",
                showCustomerPicker ? "min-h-[80px]" : "min-h-[124px]",
              )}
            />
          </div>
        </div>

        {/* Line items */}
        <div className="mt-6">
          <div className="overflow-hidden border border-border/60">
            <div className="grid items-center gap-x-2 border-b border-border/60 bg-muted/30 px-3 py-2" style={{ gridTemplateColumns: lineGridTemplate }}>
              {showQboAccountColumn && <span className={cn(headerLabel, "pl-2")}>Account</span>}
              {showCostCodeColumn && <span className={cn(headerLabel, "pl-2")}>Cost code</span>}
              <span className={cn(headerLabel, "pl-2")}>Description</span>
              <span className={cn(headerLabel, "text-center")}>Qty</span>
              <span className={cn(headerLabel, "pr-2 text-right")}>Price</span>
              <span className={cn(headerLabel, "pr-2 text-right")}>Amount</span>
              <span className={cn(headerLabel, "text-center")}>Tax</span>
            </div>
            <div className="divide-y divide-border/50">
              {lines.map((line) => {
                const selectedCostCode = costCodes.find((c) => c.id === line.cost_code_id)
                const lineAmount = (Number(line.quantity) || 0) * (Number(line.unit_cost) || 0)
                const quantityNumber = Number(line.quantity)
                const descriptionInvalid = submitAttempted && !line.description.trim()
                const quantityInvalid = submitAttempted && (!Number.isFinite(quantityNumber) || quantityNumber <= 0)
                const priceInvalid = submitAttempted && !Number.isFinite(Number(line.unit_cost))
                const accountMissing = submitAttempted && qboConnected && qboIncomeAccounts.length > 0 && !line.qbo_income_account_id
                return (
                  <div key={line.id} className="group relative grid min-h-[46px] items-stretch gap-x-2 px-3 transition-colors hover:bg-muted/20" style={{ gridTemplateColumns: lineGridTemplate }}>
                    {showQboAccountColumn &&
                      (contextLoading && !qboConnected ? (
                        <div className="flex items-center px-2 text-sm text-muted-foreground">Loading…</div>
                      ) : (
                        <QboLineAccountPicker
                          valueId={line.qbo_income_account_id}
                          valueLabel={line.qbo_income_account_name}
                          accounts={qboIncomeAccounts}
                          onSelect={({ id, name }) => {
                            markDirty()
                            setLines((prev) => prev.map((c) => (c.id === line.id ? { ...c, qbo_income_account_id: id, qbo_income_account_name: name } : c)))
                          }}
                          onCreateAccount={async (name) => {
                            try {
                              return await handleCreateQboIncomeAccount(name)
                            } catch (error: any) {
                              toast.error("Could not create QBO account", { description: error?.message ?? "Please try again." })
                              throw error
                            }
                          }}
                          triggerClassName={cn(ghostTrigger, "max-w-none", line.qbo_income_account_id ? "text-foreground" : "text-muted-foreground", accountMissing && "border-destructive/60 text-destructive")}
                        />
                      ))}
                    {showCostCodeColumn && (
                      <Select value={line.cost_code_id ?? "none"} onValueChange={(value) => updateLine(line.id, "cost_code_id", value === "none" ? null : value)}>
                        <SelectTrigger
                          title={selectedCostCode ? `${selectedCostCode.code} — ${selectedCostCode.name}` : undefined}
                          className={cn(ghostTrigger, selectedCostCode ? "text-foreground" : "text-muted-foreground")}
                        >
                          <SelectValue placeholder="—">{selectedCostCode ? selectedCostCode.code : "—"}</SelectValue>
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
                    )}
                    <GhostInput
                      value={line.description}
                      onChange={(e) => updateLine(line.id, "description", e.target.value)}
                      placeholder="Description"
                      aria-invalid={descriptionInvalid || undefined}
                      className={cn("h-full rounded-none px-2 text-sm font-medium", descriptionInvalid && "border-destructive/60")}
                    />
                    <GhostInput
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.id, "quantity", e.target.value)}
                      aria-invalid={quantityInvalid || undefined}
                      className={cn("h-full rounded-none px-2 text-center text-sm tabular-nums", noSpinner, quantityInvalid && "border-destructive/60")}
                    />
                    <GhostInput
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={line.unit_cost}
                      onChange={(e) => updateLine(line.id, "unit_cost", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && lines[lines.length - 1]?.id === line.id) {
                          e.preventDefault()
                          addLine()
                        }
                      }}
                      placeholder="0.00"
                      aria-invalid={priceInvalid || undefined}
                      className={cn("h-full rounded-none px-2 text-right text-sm tabular-nums", noSpinner, priceInvalid && "border-destructive/60")}
                    />
                    <div className="flex items-center justify-end pr-2 text-sm font-semibold tabular-nums">{formatMoney(lineAmount)}</div>
                    <div className="flex items-center justify-center">
                      <Popover modal>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Tax settings for ${line.description || "line item"}`}
                            className={cn(
                              "inline-flex h-6 min-w-[28px] items-center justify-center rounded-none border border-transparent px-1 text-[11px] tabular-nums transition-colors hover:border-input",
                              line.taxable ? "text-foreground" : "text-muted-foreground/60",
                            )}
                          >
                            {!line.taxable ? "—" : line.tax_rate_percent.trim() !== "" ? `${line.tax_rate_percent}%` : "✓"}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-56 space-y-3 p-3" align="end">
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox checked={line.taxable} onCheckedChange={(checked) => updateLine(line.id, "taxable", checked === true)} className="size-4 rounded-[2px] shadow-none" />
                            Taxable
                          </label>
                          <div className="space-y-1">
                            <label className="text-xs text-muted-foreground" htmlFor={`tax-override-${line.id}`}>
                              Rate override % (blank = invoice rate{taxRate > 0 ? `, ${taxRate}%` : ""})
                            </label>
                            <Input
                              id={`tax-override-${line.id}`}
                              type="number"
                              inputMode="decimal"
                              min="0"
                              max="20"
                              step="0.01"
                              disabled={!line.taxable}
                              value={line.tax_rate_percent}
                              onChange={(event) => updateLine(line.id, "tax_rate_percent", event.target.value)}
                              placeholder={taxRate > 0 ? String(taxRate) : "0"}
                              className={cn("h-8 text-sm tabular-nums", noSpinner)}
                            />
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(line.id)}
                      disabled={lines.length === 1}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-none p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 disabled:hidden"
                      aria-label="Remove line"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 rounded-none border-dashed text-xs font-medium" onClick={addLine}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add line
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 rounded-none text-xs font-medium text-muted-foreground">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add from…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
                {enableApprovedCostsSource && <DropdownMenuItem onSelect={() => setCostPickerOpen(true)}>Unbilled costs…</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => setDepositDialogOpen(true)}>Deposit / credit…</DropdownMenuItem>
                {drawOptions.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Draws</DropdownMenuLabel>
                    {drawOptions.map((draw) => (
                      <DropdownMenuItem key={draw.id} onSelect={() => applyDrawToInvoice(draw.id)}>
                        Draw {draw.draw_number} — {draw.title}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
                {changeOrderOptions.length > 0 && (
                  <>
                    {drawOptions.length === 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Change orders</DropdownMenuLabel>
                    {changeOrderOptions.map((co) => (
                      <DropdownMenuItem key={co.id} onSelect={() => applyChangeOrderToInvoice(co.id)}>
                        {co.title}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Notes + totals */}
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-6 items-start">
          <div className="border border-border/60 p-4 min-h-[100px]">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-2">Payment details</p>
            <Textarea
              value={notes}
              onChange={(e) => { markDirty(); setNotes(e.target.value) }}
              className="border-none shadow-none bg-transparent p-0 resize-none text-sm min-h-[72px] focus-visible:ring-0"
              placeholder="Bank instructions, ACH/wire details, references, and payment notes..."
            />
          </div>
          <div className="border border-border/60 p-4 w-56">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">{formatMoney(lineTotals.subtotal / 100)}</span>
              </div>
              <div className="flex items-center justify-between">
                {editingDiscount ? (
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Disc.</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={discountValue}
                      onChange={(e) => { markDirty(); setDiscountValue(e.target.value); if (!discountType) setDiscountType("percent") }}
                      onBlur={() => setEditingDiscount(false)}
                      onKeyDown={(e) => e.key === "Enter" && setEditingDiscount(false)}
                      autoFocus
                      className="h-5 w-14 border-b border-foreground/30 bg-transparent text-center text-sm tabular-nums outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => { markDirty(); setDiscountType((current) => (current === "fixed" ? "percent" : "fixed")) }}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="Toggle discount type"
                    >
                      {discountType === "fixed" ? "$" : "%"}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { if (!discountType) setDiscountType("percent"); setEditingDiscount(true) }}
                    className="text-muted-foreground hover:text-foreground transition-colors text-left"
                  >
                    {lineTotals.discount > 0 ? `Discount${discountType === "percent" ? ` (${discountValue}%)` : ""}` : "Discount"}
                  </button>
                )}
                <span className="tabular-nums">{lineTotals.discount > 0 ? `-${formatMoney(lineTotals.discount / 100)}` : formatMoney(0)}</span>
              </div>
              <div className="flex items-center justify-between">
                {editingTax ? (
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Tax (</span>
                    <input
                      type="number"
                      min="0"
                      max="20"
                      step="0.01"
                      value={taxRate}
                      onChange={(e) => { markDirty(); setTaxRate(Number(e.target.value || 0)) }}
                      onBlur={() => setEditingTax(false)}
                      onKeyDown={(e) => e.key === "Enter" && setEditingTax(false)}
                      autoFocus
                      className="w-12 h-5 text-sm bg-transparent border-b border-foreground/30 outline-none text-center tabular-nums"
                    />
                    <span className="text-muted-foreground">%)</span>
                  </div>
                ) : (
                  <button type="button" onClick={() => setEditingTax(true)} className="text-muted-foreground hover:text-foreground transition-colors text-left">
                    Tax{taxRate > 0 ? ` (${taxRate}%)` : ""}
                  </button>
                )}
                <span className="tabular-nums">{formatMoney(lineTotals.tax / 100)}</span>
              </div>
              {retainageCents > 0 ? (
                <div className="flex items-center justify-between text-warning">
                  <span>Retainage held ({retainagePercent}%)</span>
                  <span className="tabular-nums">-{formatMoney(retainageCents / 100)}</span>
                </div>
              ) : null}
              <div className="flex items-center justify-between border-t pt-2 mt-2 text-base font-semibold">
                <span>Amount due</span>
                <AnimatedCurrency cents={netInvoiceTotal} className="tabular-nums" />
              </div>
            </div>
          </div>
        </div>
      </DocumentScroller>

      {/* Footer — the composer's action row. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3">
        <span
          aria-live="polite"
          className={cn("text-[11px]", autosaveState === "error" ? "font-medium text-destructive" : "text-muted-foreground")}
        >
          {autosaveLabel}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center">
            <Button variant="outline" size="sm" className="h-9 rounded-r-none text-xs" disabled={autosaveState === "saving"} onClick={handleSaveDraft}>
              Save
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 rounded-l-none border-l-0 px-2 text-xs" disabled={autosaveState === "saving"}>
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => { handleSaveDraft(); void handleDownloadPdf() }} disabled={generatingPdf}>
                  {generatingPdf ? <Spinner className="mr-2 size-4" /> : <Download className="mr-2 h-4 w-4" />}
                  {generatingPdf ? "Preparing PDF…" : "Save and download PDF"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button size="sm" className="h-9 text-xs" disabled={sending} onClick={handleSendClick}>
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {sending ? "Sending…" : "Send invoice"}
          </Button>
        </div>
      </div>

      <UnbilledCostsPicker open={costPickerOpen} onOpenChange={setCostPickerOpen} projectId={projectId} costCodesEnabled={showCostCodeColumn} onConfirm={handleCostSelection} />

      <Dialog open={sendConfirmOpen} onOpenChange={setSendConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send invoice {invoiceNumber.trim() || ""}</DialogTitle>
            <DialogDescription>
              {sendRecipient.trim()
                ? `The ${terms.owner.toLowerCase()} receives an email with a secure link to view and pay this invoice.`
                : `No recipient email — the invoice will be marked sent and visible in the ${terms.ownerPortal.toLowerCase()}, but no email will be delivered.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between border p-3 text-sm">
              <span className="text-muted-foreground">Amount due</span>
              <span className="font-semibold tabular-nums">{formatMoney(netInvoiceTotal / 100)}</span>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="invoice-send-recipient" className="text-xs font-medium text-muted-foreground">Send to</label>
              <Input id="invoice-send-recipient" type="email" value={sendRecipient} onChange={(event) => setSendRecipient(event.target.value)} placeholder="client@email.com" className="h-9" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendConfirmOpen(false)} disabled={sending}>Cancel</Button>
            <Button onClick={handleConfirmSend} disabled={sending}>
              {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
              Send invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={depositDialogOpen} onOpenChange={setDepositDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Apply deposit / credit</DialogTitle>
            <DialogDescription>Adds a credit line that reduces the amount due. Use it for retainers, deposits already received, or goodwill credits.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="deposit-amount" className="text-xs font-medium text-muted-foreground">Amount</label>
              <Input id="deposit-amount" inputMode="decimal" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} placeholder="0.00" className="h-9 text-right tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="deposit-memo" className="text-xs font-medium text-muted-foreground">Shown on invoice as</label>
              <Input id="deposit-memo" value={depositMemo} onChange={(event) => setDepositMemo(event.target.value)} className="h-9" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositDialogOpen(false)}>Cancel</Button>
            <Button onClick={applyDepositCredit}>Apply credit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

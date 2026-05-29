"use client"

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { addDays, format, parse } from "date-fns"
import { CalendarIcon, Check, ChevronDown, Download, Plus, Search, Send, UserRound, X } from "lucide-react"
import { NumberFlowLite, partitionParts } from "number-flow"

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { buildPartyDetailsBlock, parsePartyDetailsBlock } from "@/lib/invoices/party-details"
import { UnbilledCostsPicker, type CostSelection } from "@/components/invoices/unbilled-costs-picker"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  onSubmit: (values: InvoiceInput, sendToClient: boolean, options?: { silent?: boolean }) => Promise<Invoice>
  isSubmitting?: boolean
  mode?: "create" | "edit"
  invoice?: Invoice | null
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  contacts?: Contact[]
  costCodes?: CostCode[]
  enableApprovedCostsSource?: boolean
}

type BillingSource = "manual" | "draw" | "change_order" | "from_costs"

type ComposerLine = {
  id: string
  description: string
  quantity: string
  unit: string
  unit_cost: string
  taxable: boolean
  cost_code_id: string | null
  qbo_income_account_id: string | null
  qbo_income_account_name: string | null
  billable_cost_ids?: string[]
  cost_cents?: number | null
  markup_cents?: number | null
  markup_percent?: number | null
}

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

type QBOIncomeAccountOption = {
  id: string
  name: string
  fullyQualifiedName?: string
}

type QBOCustomerOption = {
  id: string
  name: string
  email?: string | null
  billingAddress?: string | null
}

type ComposerSettings = {
  defaultPaymentTermsDays: number
  defaultInvoiceNote: string
}

type QboDiagnostics = {
  connectionLastError: string | null
  refreshFailureCount: number
  accountLoadWarning: string | null
}

const NUMBER_FLOW_TAG = "number-flow"
let isNumberFlowDefined = false

function ensureNumberFlowDefined() {
  if (isNumberFlowDefined) return
  if (typeof window === "undefined" || typeof customElements === "undefined") return
  if (!customElements.get(NUMBER_FLOW_TAG)) {
    NumberFlowLite.define()
  }
  isNumberFlowDefined = true
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

function toLineState(invoice?: Invoice | null): ComposerLine[] {
  const lines = invoice?.lines ?? (invoice?.metadata?.lines as any[] | undefined) ?? []
  if (!Array.isArray(lines) || lines.length === 0) {
    return [
      {
        id: crypto.randomUUID(),
        description: "",
        quantity: "1",
        unit: "ea",
        unit_cost: "",
        taxable: true,
        cost_code_id: null,
        qbo_income_account_id: null,
        qbo_income_account_name: null,
      },
    ]
  }

  return lines.map((line: any) => ({
    id: crypto.randomUUID(),
    description: String(line.description ?? ""),
    quantity: String(line.quantity ?? 1),
    unit: String(line.unit ?? "ea"),
    unit_cost: String(((line.unit_cost_cents ?? 0) / 100).toFixed(2)),
    taxable: line.taxable !== false,
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

function parseDate(dateStr: string): Date | undefined {
  if (!dateStr) return undefined
  try {
    return parse(dateStr, "yyyy-MM-dd", new Date())
  } catch {
    return undefined
  }
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

/* Date picker button with calendar popover — fills its container; the caller supplies the label */
function DatePicker({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const date = parseDate(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
  const flowRef = useRef<NumberFlowLite | null>(null)
  const formatter = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }),
    [],
  )

  useEffect(() => {
    ensureNumberFlowDefined()
  }, [])

  useEffect(() => {
    if (!flowRef.current) return
    flowRef.current.parts = partitionParts(cents / 100, formatter)
  }, [cents, formatter])

  return createElement("number-flow", {
    ref: (el: unknown) => {
      flowRef.current = el as NumberFlowLite | null
    },
    className,
  })
}

function formatQboAccountLabel(account?: QBOIncomeAccountOption | null) {
  if (!account) return ""
  return account.fullyQualifiedName ?? account.name
}

function openPdfBase64(pdfBase64: string, fileName?: string) {
  if (typeof window === "undefined") return
  const binary = atob(pdfBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
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

async function openPdfUrl(url: string, fileName?: string) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" })
  if (!response.ok) {
    throw new Error("Unable to open generated PDF")
  }
  const blob = await response.blob()
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

interface QboLineAccountPickerProps {
  valueId: string | null
  valueLabel: string | null
  accounts: QBOIncomeAccountOption[]
  onSelect: (account: { id: string | null; name: string | null }) => void
  onCreateAccount: (name: string) => Promise<QBOIncomeAccountOption>
  triggerClassName?: string
}

function QboLineAccountPicker({
  valueId,
  valueLabel,
  accounts,
  onSelect,
  onCreateAccount,
  triggerClassName,
}: QboLineAccountPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)

  const selectedAccount = valueId ? accounts.find((account) => account.id === valueId) ?? null : null
  const displayLabel = selectedAccount
    ? formatQboAccountLabel(selectedAccount)
    : valueId
      ? (valueLabel ?? valueId)
      : "Pick account"
  const normalizedQuery = query.trim()
  const hasExactMatch = accounts.some((account) => {
    const lowerQuery = normalizedQuery.toLowerCase()
    return (
      account.name.toLowerCase() === lowerQuery ||
      (account.fullyQualifiedName ?? "").toLowerCase() === lowerQuery
    )
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
    <Popover open={open} onOpenChange={setOpen}>
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

export function InvoiceComposerSheet({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  onSubmit,
  isSubmitting,
  mode = "create",
  invoice,
  builderInfo,
  contacts = [],
  costCodes = [],
  enableApprovedCostsSource = false,
}: Props) {
  const initialProjectId = defaultProjectId ?? invoice?.project_id ?? projects[0]?.id
  const initialProjectName = projects.find((project) => project.id === initialProjectId)?.name ?? "Project"

  const [projectId, setProjectId] = useState<string | undefined>(initialProjectId)
  // Linked references (kept as metadata); the effective source_type is derived at submit from these + cost lines.
  const [sourceDrawId, setSourceDrawId] = useState<string>("none")
  const [sourceChangeOrderId, setSourceChangeOrderId] = useState<string>("none")
  const [drawOptions, setDrawOptions] = useState<DrawOption[]>([])
  const [changeOrderOptions, setChangeOrderOptions] = useState<ChangeOrder[]>([])
  const [qboConnected, setQboConnected] = useState(false)
  const [qboIncomeAccounts, setQboIncomeAccounts] = useState<QBOIncomeAccountOption[]>([])
  const [qboDiagnostics, setQboDiagnostics] = useState<QboDiagnostics | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [approvedCostsLoading, setApprovedCostsLoading] = useState(false)
  const [costPickerOpen, setCostPickerOpen] = useState(false)

  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoice_number ?? "")
  const [title, setTitle] = useState(invoice?.title ?? initialProjectName)
  const [issueDate, setIssueDate] = useState(invoice?.issue_date ?? format(new Date(), "yyyy-MM-dd"))
  const [dueDate, setDueDate] = useState(invoice?.due_date ?? format(addDays(new Date(), 15), "yyyy-MM-dd"))
  const [customerId, setCustomerId] = useState<string>(
    (invoice?.metadata?.customer_id as string | undefined) ??
      (invoice?.metadata?.qbo_customer_id ? `qbo:${invoice.metadata.qbo_customer_id}` : "none"),
  )
  // The QBO customer this invoice bills to (source of truth when QBO is connected). Held as an object
  // because it may not be in the current live-search slice — initialized from saved invoice metadata.
  const [selectedQboCustomer, setSelectedQboCustomer] = useState<QBOCustomerOption | null>(
    invoice?.metadata?.qbo_customer_id
      ? {
          id: String(invoice.metadata.qbo_customer_id),
          name: String(invoice.metadata.qbo_customer_name ?? invoice.customer_name ?? ""),
          email: invoice.metadata.customer_email ? String(invoice.metadata.customer_email) : null,
        }
      : null,
  )
  // Live QBO customer typeahead state.
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [customerQuery, setCustomerQuery] = useState("")
  const [customerResults, setCustomerResults] = useState<QBOCustomerOption[]>([])
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false)
  const [creatingQboCustomer, setCreatingQboCustomer] = useState(false)
  const [customerDetails, setCustomerDetails] = useState(
    buildPartyDetailsBlock({
      name: invoice?.customer_name ?? String(invoice?.metadata?.customer_name ?? ""),
      email: String(invoice?.metadata?.customer_email ?? ""),
      address: formatAddressBlock(String(invoice?.metadata?.customer_address ?? "")),
    }),
  )
  const [fromDetails, setFromDetails] = useState(
    buildPartyDetailsBlock({
      name: String(invoice?.metadata?.from_name ?? builderInfo?.name ?? "Arc Builder"),
      email: String(invoice?.metadata?.from_email ?? builderInfo?.email ?? ""),
      address: formatAddressBlock(String(invoice?.metadata?.from_address ?? builderInfo?.address ?? "")),
    }),
  )
  const [notes, setNotes] = useState(typeof invoice?.notes === "string" ? invoice.notes : "")
  const [taxRate, setTaxRate] = useState<number>(invoice?.totals?.tax_rate ?? ((invoice?.metadata?.tax_rate as number) ?? 0))
  const [paymentTermsDays, setPaymentTermsDays] = useState<number>((invoice?.metadata?.payment_terms_days as number) ?? 15)
  const [composerSettings, setComposerSettings] = useState<ComposerSettings>({
    defaultPaymentTermsDays: 15,
    defaultInvoiceNote: "",
  })
  const [lines, setLines] = useState<ComposerLine[]>(toLineState(invoice))
  const [submittingMode, setSubmittingMode] = useState<"save" | "send" | "save_and_download" | null>(null)
  const [numberLoading, setNumberLoading] = useState(false)
  const [numberSource, setNumberSource] = useState<"qbo" | "local">("local")
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [editingTax, setEditingTax] = useState(false)

  const reservationRef = useRef<string | null>(null)
  const reservationConsumedRef = useRef(false)
  const submitInFlightRef = useRef(false)
  const pdfInFlightRef = useRef(false)

  const contactsSorted = useMemo(() => [...contacts].sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? "")), [contacts])

  const financialContacts = useMemo(
    () => contactsSorted.filter((contact) => contact.contact_type === "client" || contact.contact_type === "consultant"),
    [contactsSorted],
  )

  const selectedContact = useMemo(() => contactsSorted.find((contact) => contact.id === customerId), [contactsSorted, customerId])
  const selectedProjectName = useMemo(
    () => projects.find((project) => project.id === projectId)?.name ?? "Project",
    [projectId, projects],
  )
  const showCustomerSelector = customerDetails.trim().length === 0
  const showQboWarning = Boolean(
    qboConnected &&
      (qboIncomeAccounts.length === 0 || qboDiagnostics?.accountLoadWarning || qboDiagnostics?.connectionLastError),
  )
  const showQboAccountColumn = qboConnected || contextLoading
  // Fallback picker (QBO not connected): Arc contacts only — no QBO merge / fuzzy reconciliation.
  const arcCustomerOptions = useMemo(
    () => financialContacts.map((contact) => ({ value: contact.id, label: contact.full_name, detail: contact.email ?? "Arc contact" })),
    [financialContacts],
  )

  const lineTotals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => {
      const quantity = Number(line.quantity)
      const unitCost = Number(line.unit_cost)
      if (!Number.isFinite(quantity) || !Number.isFinite(unitCost)) return sum
      return sum + Math.round(quantity * unitCost * 100)
    }, 0)

    const taxableSubtotal = lines.reduce((sum, line) => {
      if (!line.taxable) return sum
      const quantity = Number(line.quantity)
      const unitCost = Number(line.unit_cost)
      if (!Number.isFinite(quantity) || !Number.isFinite(unitCost)) return sum
      return sum + Math.round(quantity * unitCost * 100)
    }, 0)

    const tax = Math.round(taxableSubtotal * (taxRate / 100))
    return {
      subtotal,
      tax,
      total: subtotal + tax,
    }
  }, [lines, taxRate])

  const releaseReservation = useCallback(async () => {
    if (mode === "edit") return
    if (!reservationRef.current || reservationConsumedRef.current) return
    await fetch("/api/invoices/release-reservation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservation_id: reservationRef.current }),
    }).catch(() => null)
    reservationRef.current = null
  }, [mode])

  const loadInvoiceNumber = useCallback(async () => {
    if (mode === "edit") return
    setNumberLoading(true)
    reservationConsumedRef.current = false
    try {
      const response = await fetch("/api/invoices/next-number", { cache: "no-store" })
      if (!response.ok) throw new Error("Unable to reserve invoice number")
      const payload = await response.json()
      setInvoiceNumber(String(payload.number ?? ""))
      reservationRef.current = payload.reservation_id ?? null
      setNumberSource(payload.source === "qbo" ? "qbo" : "local")
    } catch (error: any) {
      toast.error("Could not reserve invoice number", { description: error?.message ?? "Try again." })
    } finally {
      setNumberLoading(false)
    }
  }, [mode])

  const resetForCreate = useCallback(() => {
    setSourceDrawId("none")
    setSourceChangeOrderId("none")
    setTitle(selectedProjectName)
    setIssueDate(format(new Date(), "yyyy-MM-dd"))
    setDueDate(format(addDays(new Date(), composerSettings.defaultPaymentTermsDays), "yyyy-MM-dd"))
    setCustomerId("none")
    setSelectedQboCustomer(null)
    setCustomerDetails("")
    setFromDetails(
      buildPartyDetailsBlock({
        name: builderInfo?.name ?? "Arc Builder",
        email: builderInfo?.email ?? "",
        address: formatAddressBlock(builderInfo?.address ?? ""),
      }),
    )
    setNotes(composerSettings.defaultInvoiceNote)
    setTaxRate(0)
    setPaymentTermsDays(composerSettings.defaultPaymentTermsDays)
    setLines([
      {
        id: crypto.randomUUID(),
        description: "",
        quantity: "1",
        unit: "ea",
        unit_cost: "",
        taxable: true,
        cost_code_id: null,
        qbo_income_account_id: null,
        qbo_income_account_name: null,
      },
    ])
  }, [builderInfo?.address, builderInfo?.email, builderInfo?.name, composerSettings.defaultInvoiceNote, composerSettings.defaultPaymentTermsDays, selectedProjectName])

  // Append generated lines, dropping any leading blank placeholder rows so sources stack cleanly.
  const appendLines = (incoming: ComposerLine[]) => {
    if (incoming.length === 0) return
    setLines((prev) => {
      const kept = prev.filter((line) => line.description.trim() !== "" || line.unit_cost.trim() !== "")
      return [...kept, ...incoming]
    })
  }

  const applyDrawToInvoice = (drawId: string) => {
    const draw = drawOptions.find((option) => option.id === drawId)
    if (!draw) return
    setSourceDrawId(drawId)
    setDueDate(draw.due_date ?? dueDate)
    appendLines([
      {
        id: crypto.randomUUID(),
        description: draw.title,
        quantity: "1",
        unit: "draw",
        unit_cost: ((draw.amount_cents ?? 0) / 100).toFixed(2),
        taxable: false,
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

    if (Array.isArray(changeOrder.lines) && changeOrder.lines.length > 0) {
      appendLines(
        changeOrder.lines.map((line) => ({
          id: crypto.randomUUID(),
          description: line.description ?? "",
          quantity: String(line.quantity ?? 1),
          unit: String(line.unit ?? "ea"),
          unit_cost: ((line.unit_cost_cents ?? 0) / 100).toFixed(2),
          taxable: line.taxable !== false,
          cost_code_id: line.cost_code_id ?? null,
          qbo_income_account_id: (line as Record<string, any>).qbo_income_account_id ?? null,
          qbo_income_account_name: (line as Record<string, any>).qbo_income_account_name ?? null,
        })),
      )
    } else {
      appendLines([
        {
          id: crypto.randomUUID(),
          description: changeOrder.title,
          quantity: "1",
          unit: "co",
          unit_cost: (((changeOrder.total_cents ?? 0) / 100) || 0).toFixed(2),
          taxable: true,
          cost_code_id: null,
          qbo_income_account_id: null,
          qbo_income_account_name: null,
        },
      ])
    }
  }

  // Insert grouped cost lines for the costs chosen in the picker. Lines carry billable_cost_ids,
  // which the save path uses to mark those costs billed (and prevent double-billing).
  const handleCostSelection = async (selection: CostSelection) => {
    if (!projectId) {
      toast.error("Pick a project first")
      throw new Error("missing project")
    }
    setApprovedCostsLoading(true)
    try {
      const result = await generateInvoiceFromCostsAction({
        projectId,
        dateRange: selection.dateRange,
        billableCostIds: selection.billableCostIds,
        groupBy: selection.groupBy,
        includeAllowanceVariances: false,
        dryRun: true,
      })

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

  useEffect(() => {
    if (!open) return

    if (mode === "create") {
      resetForCreate()
      setProjectId(defaultProjectId ?? projects[0]?.id)
      void loadInvoiceNumber()
      return
    }

    setProjectId(invoice?.project_id ?? defaultProjectId ?? projects[0]?.id)
    setSourceDrawId((invoice?.metadata?.source_draw_id as string | undefined) ?? "none")
    setSourceChangeOrderId((invoice?.metadata?.source_change_order_id as string | undefined) ?? "none")
    setInvoiceNumber(invoice?.invoice_number ?? "")
    setTitle(invoice?.title ?? "Invoice")
    setIssueDate(invoice?.issue_date ?? format(new Date(), "yyyy-MM-dd"))
    setDueDate(invoice?.due_date ?? format(addDays(new Date(), 15), "yyyy-MM-dd"))
    setCustomerId(
      (invoice?.metadata?.customer_id as string | undefined) ??
        (invoice?.metadata?.qbo_customer_id ? `qbo:${invoice.metadata.qbo_customer_id}` : "none"),
    )
    setSelectedQboCustomer(
      invoice?.metadata?.qbo_customer_id
        ? {
            id: String(invoice.metadata.qbo_customer_id),
            name: String(invoice.metadata.qbo_customer_name ?? invoice.customer_name ?? ""),
            email: invoice.metadata.customer_email ? String(invoice.metadata.customer_email) : null,
          }
        : null,
    )
    setCustomerDetails(
      buildPartyDetailsBlock({
        name: invoice?.customer_name ?? String(invoice?.metadata?.customer_name ?? ""),
        email: String(invoice?.metadata?.customer_email ?? ""),
        address: formatAddressBlock(String(invoice?.metadata?.customer_address ?? "")),
      }),
    )
    setFromDetails(
      buildPartyDetailsBlock({
        name: String(invoice?.metadata?.from_name ?? builderInfo?.name ?? "Arc Builder"),
        email: String(invoice?.metadata?.from_email ?? builderInfo?.email ?? ""),
        address: formatAddressBlock(String(invoice?.metadata?.from_address ?? builderInfo?.address ?? "")),
      }),
    )
    setNotes(typeof invoice?.notes === "string" ? invoice.notes : "")
    setTaxRate(invoice?.totals?.tax_rate ?? ((invoice?.metadata?.tax_rate as number) ?? 0))
    setPaymentTermsDays((invoice?.metadata?.payment_terms_days as number) ?? 15)
    setLines(toLineState(invoice))
  }, [open, mode, invoice, defaultProjectId, projects, loadInvoiceNumber, resetForCreate, builderInfo?.address, builderInfo?.email, builderInfo?.name])

  useEffect(() => {
    if (customerDetails.trim().length === 0) {
      if (customerId !== "none") setCustomerId("none")
      if (selectedQboCustomer) setSelectedQboCustomer(null)
    }
  }, [customerDetails, customerId, selectedQboCustomer])

  useEffect(() => {
    if (!open || mode !== "create") return
    if (title !== selectedProjectName) {
      setTitle(selectedProjectName)
    }
  }, [open, mode, title, selectedProjectName])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    setContextLoading(true)
    getInvoiceComposerContextAction(projectId ?? null)
      .then((result) => {
        if (cancelled) return
        setDrawOptions(result.draws ?? [])
        setChangeOrderOptions(result.changeOrders ?? [])
        setQboConnected(Boolean(result.qboConnected))
        setQboIncomeAccounts(result.qboIncomeAccounts ?? [])
        setQboDiagnostics((result.qboDiagnostics as QboDiagnostics | undefined) ?? null)
        const defaults = {
          defaultPaymentTermsDays: Number(result.settings?.defaultPaymentTermsDays ?? 15),
          defaultInvoiceNote: String(result.settings?.defaultInvoiceNote ?? ""),
        }
        setComposerSettings(defaults)
        if (mode === "create") {
          setPaymentTermsDays(defaults.defaultPaymentTermsDays)
          const issueBase = issueDate ? parse(issueDate, "yyyy-MM-dd", new Date()) : new Date()
          setDueDate(format(addDays(issueBase, defaults.defaultPaymentTermsDays), "yyyy-MM-dd"))
          if (!notes.trim()) {
            setNotes(defaults.defaultInvoiceNote)
          }
        }
      })
      .catch((error) => {
        if (cancelled) return
        setDrawOptions([])
        setChangeOrderOptions([])
        setQboConnected(false)
        setQboIncomeAccounts([])
        setQboDiagnostics(null)
        setComposerSettings({ defaultPaymentTermsDays: 15, defaultInvoiceNote: "" })
        toast.error("Unable to load billing sources", { description: error?.message ?? "Try again." })
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, projectId, issueDate, mode, notes])

  // Live QBO customer search: debounce keystrokes and query QBO directly so we never hold a second
  // customer base in Arc. Only runs while the picker is open and QBO is connected.
  useEffect(() => {
    if (!qboConnected || !customerPickerOpen) return
    let cancelled = false
    setCustomerSearchLoading(true)
    const handle = setTimeout(() => {
      searchQboCustomersAction(customerQuery)
        .then((result) => {
          if (cancelled) return
          setCustomerResults(result.customers ?? [])
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
  }, [qboConnected, customerPickerOpen, customerQuery])

  useEffect(() => {
    if (!open) {
      void releaseReservation()
    }
  }, [open, releaseReservation])

  useEffect(() => {
    return () => {
      void releaseReservation()
    }
  }, [releaseReservation])

  const updateLine = (lineId: string, key: keyof ComposerLine, value: string | boolean | null) => {
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, [key]: value } : line)))
  }

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        description: "",
        quantity: "1",
        unit: "ea",
        unit_cost: "",
        taxable: true,
        cost_code_id: null,
        qbo_income_account_id: null,
        qbo_income_account_name: null,
      },
    ])
  }

  const removeLine = (lineId: string) => {
    if (lines.length === 1) return
    setLines((prev) => prev.filter((line) => line.id !== lineId))
  }

  // Fallback only (QBO disconnected): bill an Arc contact.
  const selectContact = (contactId: string) => {
    setCustomerId(contactId)
    setSelectedQboCustomer(null)
    const contact = financialContacts.find((item) => item.id === contactId)
    if (contact) {
      setCustomerDetails(
        buildPartyDetailsBlock({
          name: contact.full_name,
          email: contact.email ?? "",
          address: formatAddressBlock(contact.address?.formatted ?? ""),
        }),
      )
    }
  }

  const selectQboCustomer = (customer: QBOCustomerOption) => {
    setCustomerId("none")
    setSelectedQboCustomer(customer)
    setCustomerPickerOpen(false)
    setCustomerDetails(
      buildPartyDetailsBlock({
        name: customer.name,
        email: customer.email ?? "",
        address: formatAddressBlock(customer.billingAddress ?? ""),
      }),
    )
  }

  // Create the customer directly in QuickBooks (the source of truth), then bill against it.
  const handleCreateQboCustomer = async () => {
    const name = customerQuery.trim()
    if (!name || creatingQboCustomer) return
    setCreatingQboCustomer(true)
    try {
      const created = await createQboCustomerAction({ name })
      selectQboCustomer(created)
      setCustomerQuery("")
      toast.success(`Created "${created.name}" in QuickBooks`)
    } catch (error: any) {
      toast.error("Couldn't create customer in QuickBooks", { description: error?.message ?? "Try again." })
    } finally {
      setCreatingQboCustomer(false)
    }
  }

  const handleCreateQboIncomeAccount = useCallback(
    async (name: string): Promise<QBOIncomeAccountOption> => {
      const created = await createQBOIncomeAccountAction(name)
      const normalized: QBOIncomeAccountOption = {
        id: created.id,
        name: created.name,
        fullyQualifiedName: created.fullyQualifiedName,
      }
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
    },
    [],
  )

  const submit = async (
    sendToClient: boolean,
    actionMode: "save" | "send" | "save_and_download" = sendToClient ? "send" : "save",
  ) => {
    if (submitInFlightRef.current) return
    if (!projectId) {
      toast.error("Project is required")
      return
    }
    if (!invoiceNumber.trim()) {
      toast.error("Invoice number is required")
      return
    }
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }

    const parsedLines = lines.map((line) => {
      const selectedLineAccount = qboIncomeAccounts.find((account) => account.id === line.qbo_income_account_id)
      return {
        cost_code_id: line.cost_code_id || undefined,
        description: line.description.trim(),
        quantity: Number(line.quantity),
        unit: line.unit.trim() || "ea",
        unit_cost: Number(line.unit_cost),
        taxable: line.taxable,
        qbo_income_account_id: line.qbo_income_account_id || undefined,
        qbo_income_account_name:
          selectedLineAccount?.fullyQualifiedName ??
          selectedLineAccount?.name ??
          line.qbo_income_account_name ??
          undefined,
        billable_cost_ids: line.billable_cost_ids,
        cost_cents: line.cost_cents ?? undefined,
        markup_cents: line.markup_cents ?? undefined,
        markup_percent: line.markup_percent ?? undefined,
      }
    })

    const hasInvalidLine = parsedLines.some(
      (line) =>
        !line.description ||
        !Number.isFinite(line.quantity) ||
        line.quantity <= 0 ||
        !Number.isFinite(line.unit_cost),
    )

    if (hasInvalidLine) {
      toast.error("Fix line item values before submitting")
      return
    }

    if (qboConnected && qboIncomeAccounts.length > 0 && parsedLines.some((line) => !line.qbo_income_account_id)) {
      toast.error("Pick a QuickBooks account for every line item")
      return
    }

    const mergedNotes = notes.trim()
    const parsedCustomerDetails = parsePartyDetailsBlock(customerDetails)
    const parsedFromDetails = parsePartyDetailsBlock(fromDetails)
    const recipientEmail = parsedCustomerDetails.email.trim()
    const recipientEmails = recipientEmail ? [recipientEmail] : undefined
    const nextStatus = sendToClient
      ? "sent"
      : mode === "edit" && invoice?.status && ["sent", "partial", "paid", "overdue", "void"].includes(invoice.status)
        ? invoice.status
        : "saved"

    // Derive the effective source_type from actual content: cost lines win (they drive billed-marking),
    // then a linked draw, then a linked change order, otherwise manual. Reference links are sent whenever set.
    const hasCostLines = lines.some((line) => (line.billable_cost_ids?.length ?? 0) > 0)
    const derivedSourceType: BillingSource = hasCostLines
      ? "from_costs"
      : sourceDrawId !== "none"
        ? "draw"
        : sourceChangeOrderId !== "none"
          ? "change_order"
          : "manual"

    const payload: InvoiceInput = {
      project_id: projectId,
      invoice_number: invoiceNumber.trim(),
      customer_id: customerId === "none" || customerId.startsWith("qbo:") ? undefined : customerId,
      customer_name: parsedCustomerDetails.name.trim() || selectedContact?.full_name || selectedQboCustomer?.name || undefined,
      customer_address: parsedCustomerDetails.address.trim() || undefined,
      qbo_customer_id: selectedQboCustomer?.id ?? null,
      qbo_customer_name: selectedQboCustomer?.name ?? null,
      from_name: parsedFromDetails.name.trim() || undefined,
      from_email: parsedFromDetails.email.trim() || undefined,
      from_address: parsedFromDetails.address.trim() || undefined,
      reservation_id: reservationRef.current ?? undefined,
      title: title.trim(),
      status: nextStatus,
      issue_date: issueDate || undefined,
      due_date: dueDate || undefined,
      notes: mergedNotes || undefined,
      client_visible: sendToClient,
      tax_rate: taxRate,
      lines: parsedLines,
      sent_to_emails: recipientEmails,
      payment_terms_days: paymentTermsDays,
      source_type: derivedSourceType,
      source_draw_id: sourceDrawId !== "none" ? sourceDrawId : undefined,
      source_change_order_id: sourceChangeOrderId !== "none" ? sourceChangeOrderId : undefined,
      qbo_income_account_id: null,
      qbo_income_account_name: null,
    }

    submitInFlightRef.current = true
    setSubmittingMode(actionMode)
    try {
      const savedInvoice = await onSubmit(payload, sendToClient, { silent: actionMode === "save_and_download" })
      reservationConsumedRef.current = true
      reservationRef.current = null
      return savedInvoice
    } finally {
      setSubmittingMode(null)
      submitInFlightRef.current = false
    }
  }

  const generateAndDownloadPdf = async () => {
    if (pdfInFlightRef.current) return
    pdfInFlightRef.current = true

    const slowToastTimer = window.setTimeout(() => {
      toast.message("Still preparing PDF…", {
        description: "This can take a few seconds on larger invoices.",
      })
    }, 2500)
    setGeneratingPdf(true)
    try {
      const savedInvoice = await submit(false, "save_and_download")
      const invoiceId = savedInvoice?.id ?? invoice?.id
      if (!invoiceId) {
        return
      }

      const result = await generateInvoicePdfAction(invoiceId, { persistToArc: false })
      if (result.pdfBase64) {
        openPdfBase64(result.pdfBase64, result.fileName)
      } else if (result.downloadUrl && typeof window !== "undefined") {
        await openPdfUrl(result.downloadUrl, result.fileName)
      }
      if (result.durationMs >= 5000) {
        toast.warning("PDF generation is slower than expected", {
          description: "We captured diagnostics so we can keep improving performance.",
        })
      }
    } catch (error: any) {
      toast.error("Failed to generate PDF", { description: error?.message ?? "Please try again." })
    } finally {
      window.clearTimeout(slowToastTimer)
      setGeneratingPdf(false)
      pdfInFlightRef.current = false
    }
  }

  const sendDisabled = Boolean(isSubmitting || submittingMode || generatingPdf || !projectId || lines.length === 0)
  const saveAndDownloadBusy = submittingMode === "save_and_download" || generatingPdf

  // Linked references shown as removable chips in the toolbar.
  const linkedDraw = sourceDrawId !== "none" ? drawOptions.find((draw) => draw.id === sourceDrawId) ?? null : null
  const linkedChangeOrder =
    sourceChangeOrderId !== "none"
      ? changeOrderOptions.find((co) => co.id === sourceChangeOrderId) ?? null
      : null
  // Summary of cost-derived lines (lines carrying billable_cost_ids), shown as an informational chip.
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
  const hasAddSources = enableApprovedCostsSource || drawOptions.length > 0 || changeOrderOptions.length > 0

  // Shared grid + label styling so the header band and every line row stay in lockstep.
  // Account and cost-code columns only appear when relevant, so the template is built dynamically.
  // The remove control is absolutely positioned (no reserved column) so Tax sits flush right.
  const showCostCodeColumn = costCodes.length > 0
  const lineGridTemplate = [
    showQboAccountColumn ? "150px" : null,
    showCostCodeColumn ? "120px" : null,
    "minmax(0, 1fr)", // description
    "72px", // qty
    "120px", // price
    "120px", // amount
    "44px", // tax
  ]
    .filter(Boolean)
    .join(" ")
  // Show the customer picker only while Bill To is empty and there's actually something to pick.
  // When QBO is connected, the picker is a live QBO typeahead; otherwise it's the Arc-contact fallback.
  const showQboCustomerPicker = showCustomerSelector && qboConnected
  const showArcCustomerPicker = showCustomerSelector && !qboConnected && (arcCustomerOptions.length > 0 || contextLoading)
  const showCustomerPicker = showQboCustomerPicker || showArcCustomerPicker
  const headerLabel = "text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70"
  // Borderless control that fills its cell vertically and reveals its outline on hover/focus.
  const ghostTrigger =
    "h-full w-full justify-start rounded-none border border-transparent bg-transparent px-2 text-sm shadow-none transition-colors hover:border-input focus:ring-0 focus-visible:ring-0 [&>svg]:size-3.5 [&>svg]:opacity-40"
  // Strip the native number spinners from qty/price.
  const noSpinner =
    "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-5xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 bg-background border"
      >
        {/* ── TOOLBAR: linked references & cost summary (collapses when empty) ── */}
        {(linkedDraw || linkedChangeOrder || costSummary || contextLoading || approvedCostsLoading) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 shrink-0">
          {linkedDraw && (
            <Badge variant="secondary" className="h-6 gap-1.5 rounded-none pr-1 text-xs">
              Draw {linkedDraw.draw_number} — {linkedDraw.title}
              <button
                type="button"
                onClick={() => setSourceDrawId("none")}
                className="rounded-none p-0.5 hover:bg-foreground/10"
                aria-label="Unlink draw"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {linkedChangeOrder && (
            <Badge variant="secondary" className="h-6 gap-1.5 rounded-none pr-1 text-xs">
              {linkedChangeOrder.title}
              <button
                type="button"
                onClick={() => setSourceChangeOrderId("none")}
                className="rounded-none p-0.5 hover:bg-foreground/10"
                aria-label="Unlink change order"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {costSummary && (
            <Badge variant="secondary" className="h-6 rounded-none text-xs">
              {costSummary.costCount} {costSummary.costCount === 1 ? "cost" : "costs"} ·{" "}
              {formatMoney(costSummary.totalBillableCents / 100)}
            </Badge>
          )}
          {(contextLoading || approvedCostsLoading) && (
            <Badge variant="outline" className="h-6 gap-1.5 rounded-none text-xs">
              <Spinner className="size-3" />
              Loading…
            </Badge>
          )}
        </div>
        )}
        {showQboWarning && (
          <div className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            {qboDiagnostics?.accountLoadWarning ||
              qboDiagnostics?.connectionLastError ||
              "QuickBooks is connected, but no income accounts were found."}
          </div>
        )}

        {/* ── SCROLLABLE CONTENT ── */}
        <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8 sm:py-8">

          {/* ── HEADER: Title + Invoice meta ── */}
          <div className="flex items-start justify-between gap-8">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Invoice</h1>
              <p className="mt-1 text-sm text-muted-foreground">{selectedProjectName}</p>
            </div>
            <div className="shrink-0">
              <div className="grid grid-cols-[auto_9rem] items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-right text-muted-foreground">Invoice #</span>
                <GhostInput
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  disabled={numberLoading}
                  placeholder={numberLoading ? "Reserving…" : "—"}
                  className="h-7 w-full px-2 text-right text-sm tabular-nums"
                />

                <span className="text-right text-muted-foreground">Issued</span>
                <DatePicker value={issueDate} onChange={setIssueDate} />

                <span className="text-right text-muted-foreground">Due</span>
                <DatePicker value={dueDate} onChange={setDueDate} />

                <span className="text-right text-muted-foreground">Net</span>
                <GhostInput
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="365"
                  value={paymentTermsDays}
                  onChange={(e) => setPaymentTermsDays(Number(e.target.value || 0))}
                  className={cn("h-7 w-full px-2 text-right text-sm tabular-nums", noSpinner)}
                />
              </div>
              {!numberLoading && qboConnected && numberSource === "local" && (
                <p className="ml-auto mt-1.5 max-w-[180px] text-right text-[11px] leading-snug text-muted-foreground/70">
                  Arc fallback — QuickBooks may renumber on sync.
                </p>
              )}
            </div>
          </div>

          {/* ── FROM / BILL TO ── */}
          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="border border-border/60 p-4">
              <div className="flex h-5 items-center">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">From</p>
              </div>
              <Textarea
                value={fromDetails}
                onChange={(e) => setFromDetails(e.target.value)}
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
                      onClick={() => {
                        setCustomerDetails("")
                        setCustomerId("none")
                        setSelectedQboCustomer(null)
                      }}
                      className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Change
                    </button>
                  </div>
                )}
              </div>

              {showQboCustomerPicker && (
                <Popover open={customerPickerOpen} onOpenChange={setCustomerPickerOpen}>
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
                        {!customerSearchLoading && customerResults.length === 0 && (
                          <CommandEmpty>No QuickBooks customers found.</CommandEmpty>
                        )}
                        {customerResults.length > 0 && (
                          <CommandGroup>
                            {customerResults.map((customer) => (
                              <CommandItem
                                key={customer.id}
                                value={customer.id}
                                onSelect={() => selectQboCustomer(customer)}
                              >
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
                                {creatingQboCustomer ? (
                                  <Spinner className="mr-2 h-3.5 w-3.5" />
                                ) : (
                                  <Plus className="mr-2 h-3.5 w-3.5" />
                                )}
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
                onChange={(e) => setCustomerDetails(e.target.value)}
                placeholder={
                  showCustomerPicker ? "…or enter billing details manually" : "Name\nemail@customer.com\nBilling address"
                }
                className={cn(
                  "mt-2 border-transparent bg-transparent text-sm leading-relaxed shadow-none transition-colors hover:border-input focus:border-input",
                  showCustomerPicker ? "min-h-[80px]" : "min-h-[124px]",
                )}
              />
            </div>
          </div>

          {/* ── LINE ITEMS ── */}
          <div className="mt-6">
            {/* Line items table */}
            <div className="overflow-hidden border border-border/60">
              {/* Header band */}
              <div
                className="grid items-center gap-x-2 border-b border-border/60 bg-muted/30 px-3 py-2"
                style={{ gridTemplateColumns: lineGridTemplate }}
              >
                {showQboAccountColumn && <span className={cn(headerLabel, "pl-2")}>Account</span>}
                {showCostCodeColumn && <span className={cn(headerLabel, "pl-2")}>Cost code</span>}
                <span className={cn(headerLabel, "pl-2")}>Description</span>
                <span className={cn(headerLabel, "text-center")}>Qty</span>
                <span className={cn(headerLabel, "pr-2 text-right")}>Price</span>
                <span className={cn(headerLabel, "pr-2 text-right")}>Amount</span>
                <span className={cn(headerLabel, "text-center")}>Tax</span>
              </div>

              {/* Rows */}
              <div className="divide-y divide-border/50">
                {lines.map((line) => {
                  const selectedCostCode = costCodes.find((c) => c.id === line.cost_code_id)
                  const lineAmount = (Number(line.quantity) || 0) * (Number(line.unit_cost) || 0)
                  return (
                    <div
                      key={line.id}
                      className="group relative grid min-h-[46px] items-stretch gap-x-2 px-3 transition-colors hover:bg-muted/20"
                      style={{ gridTemplateColumns: lineGridTemplate }}
                    >
                      {showQboAccountColumn &&
                        (contextLoading && !qboConnected ? (
                          <div className="flex items-center px-2 text-sm text-muted-foreground">Loading…</div>
                        ) : (
                          <QboLineAccountPicker
                            valueId={line.qbo_income_account_id}
                            valueLabel={line.qbo_income_account_name}
                            accounts={qboIncomeAccounts}
                            onSelect={({ id, name }) =>
                              setLines((prev) =>
                                prev.map((current) =>
                                  current.id === line.id
                                    ? { ...current, qbo_income_account_id: id, qbo_income_account_name: name }
                                    : current,
                                ),
                              )
                            }
                            onCreateAccount={async (name) => {
                              try {
                                return await handleCreateQboIncomeAccount(name)
                              } catch (error: any) {
                                toast.error("Could not create QBO account", {
                                  description: error?.message ?? "Please try again.",
                                })
                                throw error
                              }
                            }}
                            triggerClassName={cn(
                              ghostTrigger,
                              "max-w-none",
                              line.qbo_income_account_id ? "text-foreground" : "text-muted-foreground",
                            )}
                          />
                        ))}
                      {showCostCodeColumn && (
                        <Select
                          value={line.cost_code_id ?? "none"}
                          onValueChange={(value) =>
                            updateLine(line.id, "cost_code_id", value === "none" ? null : value)
                          }
                        >
                          <SelectTrigger
                            title={selectedCostCode ? `${selectedCostCode.code} — ${selectedCostCode.name}` : undefined}
                            className={cn(ghostTrigger, selectedCostCode ? "text-foreground" : "text-muted-foreground")}
                          >
                            <SelectValue placeholder="—">
                              {selectedCostCode ? selectedCostCode.code : "—"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No cost code</SelectItem>
                            {costCodes.map((code) => (
                              <SelectItem key={code.id} value={code.id}>
                                {code.code} — {code.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <GhostInput
                        value={line.description}
                        onChange={(e) => updateLine(line.id, "description", e.target.value)}
                        placeholder="Description"
                        className="h-full rounded-none px-2 text-sm font-medium"
                      />
                      <GhostInput
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.id, "quantity", e.target.value)}
                        className={cn("h-full rounded-none px-2 text-center text-sm tabular-nums", noSpinner)}
                      />
                      <GhostInput
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={line.unit_cost}
                        onChange={(e) => updateLine(line.id, "unit_cost", e.target.value)}
                        placeholder="0.00"
                        className={cn("h-full rounded-none px-2 text-right text-sm tabular-nums", noSpinner)}
                      />
                      <div className="flex items-center justify-end pr-2 text-sm font-semibold tabular-nums">
                        {formatMoney(lineAmount)}
                      </div>
                      <div className="flex items-center justify-center">
                        <Checkbox
                          checked={line.taxable}
                          onCheckedChange={(checked) => updateLine(line.id, "taxable", checked === true)}
                          className="size-4 rounded-[2px] shadow-none"
                          aria-label={`Tax line ${line.description || "item"}`}
                        />
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

            {/* Add line / Add from source */}
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-none border-dashed text-xs font-medium"
                onClick={addLine}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add line
              </Button>
              {hasAddSources && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 rounded-none text-xs font-medium text-muted-foreground">
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      Add from…
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
                    {enableApprovedCostsSource && (
                      <DropdownMenuItem onSelect={() => setCostPickerOpen(true)}>Unbilled costs…</DropdownMenuItem>
                    )}
                    {drawOptions.length > 0 && (
                      <>
                        {enableApprovedCostsSource && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          Draws
                        </DropdownMenuLabel>
                        {drawOptions.map((draw) => (
                          <DropdownMenuItem key={draw.id} onSelect={() => applyDrawToInvoice(draw.id)}>
                            Draw {draw.draw_number} — {draw.title}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                    {changeOrderOptions.length > 0 && (
                      <>
                        {(enableApprovedCostsSource || drawOptions.length > 0) && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          Change orders
                        </DropdownMenuLabel>
                        {changeOrderOptions.map((co) => (
                          <DropdownMenuItem key={co.id} onSelect={() => applyChangeOrderToInvoice(co.id)}>
                            {co.title}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {/* ── NOTES + TOTALS ── */}
          <div className="mt-4 grid grid-cols-[1fr_auto] gap-6 items-start">
            <div className="border border-border/60 p-4 min-h-[100px]">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-2">Payment details</p>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
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
                  {editingTax ? (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Tax (</span>
                      <input
                        type="number"
                        min="0"
                        max="20"
                        step="0.01"
                        value={taxRate}
                        onChange={(e) => setTaxRate(Number(e.target.value || 0))}
                        onBlur={() => setEditingTax(false)}
                        onKeyDown={(e) => e.key === "Enter" && setEditingTax(false)}
                        autoFocus
                        className="w-12 h-5 text-sm bg-transparent border-b border-foreground/30 outline-none text-center tabular-nums"
                      />
                      <span className="text-muted-foreground">%)</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingTax(true)}
                      className="text-muted-foreground hover:text-foreground transition-colors text-left"
                    >
                      Tax{taxRate > 0 ? ` (${taxRate}%)` : ""}
                    </button>
                  )}
                  <span className="tabular-nums">{formatMoney(lineTotals.tax / 100)}</span>
                </div>
                <div className="flex items-center justify-between border-t pt-2 mt-2 text-base font-semibold">
                  <span>Total</span>
                  <AnimatedCurrency cents={lineTotals.total} className="tabular-nums" />
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* ── FOOTER ── */}
        <div className="border-t px-6 py-3 shrink-0">
          <div className="flex items-center justify-end">
            <div className="flex items-center gap-2">
              <div className="flex items-center">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-r-none border-r-0 text-xs"
                  disabled={sendDisabled}
                  onClick={() => submit(false, "save")}
                >
                  {saveAndDownloadBusy ? (
                    <>
                      <Spinner className="mr-1.5 size-3.5" />
                      Preparing PDF...
                    </>
                  ) : submittingMode === "save" ? (
                    <>
                      <Spinner className="mr-1.5 size-3.5" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-l-none px-2 text-xs"
                      disabled={sendDisabled || saveAndDownloadBusy}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={generateAndDownloadPdf} disabled={saveAndDownloadBusy}>
                      {saveAndDownloadBusy ? (
                        <Spinner className="mr-2 size-4" />
                      ) : (
                        <Download className="mr-2 h-4 w-4" />
                      )}
                      {saveAndDownloadBusy ? "Preparing PDF..." : "Save and download PDF"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Button size="sm" className="h-8 text-xs" disabled={sendDisabled} onClick={() => submit(true)}>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {submittingMode === "send" ? "Sending..." : "Send invoice"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
      <UnbilledCostsPicker
        open={costPickerOpen}
        onOpenChange={setCostPickerOpen}
        projectId={projectId}
        onConfirm={handleCostSelection}
      />
    </Sheet>
  )
}

"use client"

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { addDays, format, parse } from "date-fns"
import { CalendarIcon, Check, ChevronDown, Download, Plus, Send, X } from "lucide-react"
import { NumberFlowLite, partitionParts } from "number-flow"

import type { ChangeOrder, Contact, CostCode, Invoice, Project } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import {
  createQBOIncomeAccountAction,
  generateInvoicePdfAction,
  getInvoiceComposerContextAction,
} from "@/app/(app)/invoices/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { buildPartyDetailsBlock, parsePartyDetailsBlock } from "@/lib/invoices/party-details"
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
}

type BillingSource = "manual" | "draw" | "change_order"

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
      className={`border-transparent bg-transparent shadow-none hover:border-input focus:border-input transition-colors ${className ?? ""}`}
      {...props}
    />
  )
}

/* Date picker button with calendar popover */
function DatePicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const date = parseDate(value)

  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-muted-foreground text-sm">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 h-7 px-2 text-sm rounded border border-transparent hover:border-input transition-colors text-right"
          >
            {date ? format(date, "MMM d, yyyy") : "Pick date"}
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
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
    </div>
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
  defaultAccountId: string | null
  onSelect: (account: { id: string | null; name: string | null }) => void
  onCreateAccount: (name: string) => Promise<QBOIncomeAccountOption>
}

function QboLineAccountPicker({
  valueId,
  valueLabel,
  accounts,
  defaultAccountId,
  onSelect,
  onCreateAccount,
}: QboLineAccountPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)

  const selectedAccount = valueId ? accounts.find((account) => account.id === valueId) ?? null : null
  const defaultAccount = defaultAccountId ? accounts.find((account) => account.id === defaultAccountId) ?? null : null
  const displayLabel = selectedAccount
    ? formatQboAccountLabel(selectedAccount)
    : valueId
      ? (valueLabel ?? valueId)
      : defaultAccount
        ? `Default: ${formatQboAccountLabel(defaultAccount)}`
        : "Default"
  const normalizedQuery = query.trim()
  const hasExactMatch = accounts.some((account) => {
    const lowerQuery = normalizedQuery.toLowerCase()
    return (
      account.name.toLowerCase() === lowerQuery ||
      (account.fullyQualifiedName ?? "").toLowerCase() === lowerQuery
    )
  })
  const showCreate = normalizedQuery.length > 0 && !hasExactMatch

  const selectDefault = () => {
    onSelect({ id: null, name: null })
    setOpen(false)
    setQuery("")
  }

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
          className="inline-flex h-5 max-w-[140px] items-center rounded-sm px-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          title={displayLabel}
        >
          <span className="truncate">{displayLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] overflow-hidden p-0" align="start">
        <Command>
          <CommandInput placeholder="Search QBO account..." value={query} onValueChange={setQuery} />
          <CommandList className="max-h-64 overscroll-contain" onWheelCapture={(event) => event.stopPropagation()}>
            <CommandEmpty>No matching accounts.</CommandEmpty>
            <CommandGroup heading="Accounts">
              <CommandItem value="__default__" onSelect={selectDefault}>
                Use default account
                <Check className={cn("ml-auto h-3.5 w-3.5", !valueId ? "opacity-100" : "opacity-0")} />
              </CommandItem>
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
}: Props) {
  const initialProjectId = defaultProjectId ?? invoice?.project_id ?? projects[0]?.id
  const initialProjectName = projects.find((project) => project.id === initialProjectId)?.name ?? "Project"

  const [projectId, setProjectId] = useState<string | undefined>(initialProjectId)
  const [source, setSource] = useState<BillingSource>("manual")
  const [sourceDrawId, setSourceDrawId] = useState<string>("none")
  const [sourceChangeOrderId, setSourceChangeOrderId] = useState<string>("none")
  const [drawOptions, setDrawOptions] = useState<DrawOption[]>([])
  const [changeOrderOptions, setChangeOrderOptions] = useState<ChangeOrder[]>([])
  const [qboConnected, setQboConnected] = useState(false)
  const [qboIncomeAccounts, setQboIncomeAccounts] = useState<QBOIncomeAccountOption[]>([])
  const [qboDefaultIncomeAccountId, setQboDefaultIncomeAccountId] = useState<string | null>(null)
  const [qboDiagnostics, setQboDiagnostics] = useState<QboDiagnostics | null>(null)
  const [contextLoading, setContextLoading] = useState(false)

  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoice_number ?? "")
  const [title, setTitle] = useState(invoice?.title ?? initialProjectName)
  const [issueDate, setIssueDate] = useState(invoice?.issue_date ?? format(new Date(), "yyyy-MM-dd"))
  const [dueDate, setDueDate] = useState(invoice?.due_date ?? format(addDays(new Date(), 15), "yyyy-MM-dd"))
  const [customerId, setCustomerId] = useState<string>(invoice?.metadata?.customer_id ?? "none")
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
    setSource("manual")
    setSourceDrawId("none")
    setSourceChangeOrderId("none")
    setTitle(selectedProjectName)
    setIssueDate(format(new Date(), "yyyy-MM-dd"))
    setDueDate(format(addDays(new Date(), composerSettings.defaultPaymentTermsDays), "yyyy-MM-dd"))
    setCustomerId("none")
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

  const applyDrawToInvoice = (drawId: string) => {
    const draw = drawOptions.find((option) => option.id === drawId)
    if (!draw) return
    setSource("draw")
    setSourceDrawId(drawId)
    setDueDate(draw.due_date ?? dueDate)
    setLines([
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

    setSource("change_order")
    setSourceChangeOrderId(changeOrderId)

    if (Array.isArray(changeOrder.lines) && changeOrder.lines.length > 0) {
      setLines(
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
      setLines([
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

  useEffect(() => {
    if (!open) return

    if (mode === "create") {
      resetForCreate()
      setProjectId(defaultProjectId ?? projects[0]?.id)
      void loadInvoiceNumber()
      return
    }

    setProjectId(invoice?.project_id ?? defaultProjectId ?? projects[0]?.id)
    setSource(((invoice?.metadata?.source_type as BillingSource | undefined) ?? "manual"))
    setSourceDrawId((invoice?.metadata?.source_draw_id as string | undefined) ?? "none")
    setSourceChangeOrderId((invoice?.metadata?.source_change_order_id as string | undefined) ?? "none")
    setInvoiceNumber(invoice?.invoice_number ?? "")
    setTitle(invoice?.title ?? "Invoice")
    setIssueDate(invoice?.issue_date ?? format(new Date(), "yyyy-MM-dd"))
    setDueDate(invoice?.due_date ?? format(addDays(new Date(), 15), "yyyy-MM-dd"))
    setCustomerId((invoice?.metadata?.customer_id as string) ?? "none")
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
    if (customerDetails.trim().length === 0 && customerId !== "none") {
      setCustomerId("none")
    }
  }, [customerDetails, customerId])

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
        const defaultIncomeAccountId =
          typeof result.qboDefaultIncomeAccountId === "string" ? result.qboDefaultIncomeAccountId : null
        setQboDefaultIncomeAccountId(defaultIncomeAccountId)
        const defaults = {
          defaultPaymentTermsDays: Number(result.settings?.defaultPaymentTermsDays ?? 15),
          defaultInvoiceNote: String(result.settings?.defaultInvoiceNote ?? ""),
        }
        setComposerSettings(defaults)
        if (mode === "create") {
          setPaymentTermsDays(defaults.defaultPaymentTermsDays)
          setDueDate(format(addDays(new Date(issueDate || new Date()), defaults.defaultPaymentTermsDays), "yyyy-MM-dd"))
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
        setQboDefaultIncomeAccountId(null)
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

  const selectContact = (contactId: string) => {
    setCustomerId(contactId)
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
      }
    })

    const hasInvalidLine = parsedLines.some(
      (line) =>
        !line.description ||
        !Number.isFinite(line.quantity) ||
        line.quantity <= 0 ||
        !Number.isFinite(line.unit_cost) ||
        line.unit_cost < 0,
    )

    if (hasInvalidLine) {
      toast.error("Fix line item values before submitting")
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

    const payload: InvoiceInput = {
      project_id: projectId,
      invoice_number: invoiceNumber.trim(),
      customer_id: customerId === "none" ? undefined : customerId,
      customer_name: parsedCustomerDetails.name.trim() || selectedContact?.full_name || undefined,
      customer_address: parsedCustomerDetails.address.trim() || undefined,
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
      source_type: source,
      source_draw_id: source === "draw" && sourceDrawId !== "none" ? sourceDrawId : undefined,
      source_change_order_id: source === "change_order" && sourceChangeOrderId !== "none" ? sourceChangeOrderId : undefined,
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

  const sourceValue = source === "draw" && sourceDrawId !== "none"
    ? sourceDrawId
    : source === "change_order" && sourceChangeOrderId !== "none"
      ? sourceChangeOrderId
      : "none"

  const handleSourceChange = (value: string) => {
    if (value === "none") {
      setSource("manual")
      setSourceDrawId("none")
      setSourceChangeOrderId("none")
      return
    }
    const draw = drawOptions.find((d) => d.id === value)
    if (draw) {
      applyDrawToInvoice(value)
      return
    }
    const co = changeOrderOptions.find((c) => c.id === value)
    if (co) {
      applyChangeOrderToInvoice(value)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-5xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 bg-background border"
      >
        {/* ── TOOLBAR ── */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5 shrink-0">
          <Select value={sourceValue} onValueChange={handleSourceChange}>
            <SelectTrigger className="w-[240px] h-8 text-xs">
              <SelectValue placeholder="Link source (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No linked source</SelectItem>
              {drawOptions.length > 0 && (
                <>
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Draws</div>
                  {drawOptions.map((draw) => (
                    <SelectItem key={draw.id} value={draw.id}>
                      Draw {draw.draw_number} — {draw.title}
                    </SelectItem>
                  ))}
                </>
              )}
              {changeOrderOptions.length > 0 && (
                <>
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Change Orders</div>
                  {changeOrderOptions.map((co) => (
                    <SelectItem key={co.id} value={co.id}>
                      {co.title}
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>

          {contextLoading && <Badge variant="outline" className="text-xs h-6">Loading...</Badge>}
        </div>
        {showQboWarning && (
          <div className="border-b bg-amber-50/60 px-4 py-2 text-xs text-amber-900">
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
            <div className="text-right text-sm space-y-1.5 shrink-0">
              <div className="flex items-center justify-end gap-2">
                <span className="text-muted-foreground whitespace-nowrap">Invoice #</span>
                <GhostInput
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className="w-28 h-7 text-right text-sm px-2"
                  placeholder="—"
                />
              </div>
              {numberLoading && <p className="text-xs text-muted-foreground">Reserving...</p>}
              {!numberLoading && numberSource === "qbo" && (
                <p className="text-xs text-muted-foreground">Number reserved from QuickBooks</p>
              )}
              <DatePicker value={issueDate} onChange={setIssueDate} label="Issue" />
              <DatePicker value={dueDate} onChange={setDueDate} label="Due" />
              <div className="flex items-center justify-end gap-2">
                <span className="text-muted-foreground whitespace-nowrap">Net</span>
                <Input
                  type="number"
                  min="0"
                  max="365"
                  value={paymentTermsDays}
                  onChange={(e) => setPaymentTermsDays(Number(e.target.value || 0))}
                  className="h-7 w-16 text-right text-sm px-2 border-transparent bg-transparent shadow-none hover:border-input focus:border-input transition-colors"
                />
              </div>
            </div>
          </div>

          {/* ── FROM / BILL TO ── */}
          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="rounded border border-border/60 p-4">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">From</p>
              <Textarea
                value={fromDetails}
                onChange={(e) => setFromDetails(e.target.value)}
                placeholder={"Business name\nemail@company.com\nAddress"}
                className="mt-2 min-h-[124px] border-transparent bg-transparent text-sm shadow-none hover:border-input focus:border-input transition-colors leading-relaxed"
              />
            </div>
            <div className="rounded border border-border/60 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Bill To</p>
                {!showCustomerSelector && (
                  <button
                    type="button"
                    onClick={() => setCustomerDetails("")}
                    className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
              {showCustomerSelector && (
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
                  <SelectTrigger className="mt-2 h-8 text-sm border-transparent bg-transparent shadow-none hover:border-input focus:border-input transition-colors">
                    <SelectValue placeholder="Select contact" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No linked contact</SelectItem>
                    {financialContacts.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Textarea
                value={customerDetails}
                onChange={(e) => setCustomerDetails(e.target.value)}
                placeholder={"Name\nemail@customer.com\nBilling address"}
                className="mt-2 min-h-[124px] border-transparent bg-transparent text-sm shadow-none hover:border-input focus:border-input transition-colors leading-relaxed"
              />
            </div>
          </div>

          {/* ── LINE ITEMS ── */}
          <div className="mt-6">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_64px_64px_96px_96px_28px] items-end gap-x-1.5 px-3 pb-1.5">
              <span className="text-[11px] text-muted-foreground font-medium pl-2">Description</span>
              <span className="text-[11px] text-muted-foreground font-medium text-center">Qty</span>
              <span className="text-[11px] text-muted-foreground font-medium text-center">Unit</span>
              <span className="text-[11px] text-muted-foreground font-medium text-right pr-2">Price</span>
              <span className="text-[11px] text-muted-foreground font-medium text-right">Amount</span>
              <span />
            </div>

            {/* Line items */}
            <div className="rounded border border-border/60 divide-y divide-border/40">
              {lines.map((line) => {
                const selectedCostCode = costCodes.find((c) => c.id === line.cost_code_id)
                const lineAmount = (Number(line.quantity) || 0) * (Number(line.unit_cost) || 0)
                const hasMeta = qboConnected || costCodes.length > 0

                return (
                  <div key={line.id} className="group">
                    {/* Primary row */}
                    <div className="grid grid-cols-[1fr_64px_64px_96px_96px_28px] items-center gap-x-1.5 px-1.5 pt-2 pb-1">
                      <GhostInput
                        value={line.description}
                        onChange={(e) => updateLine(line.id, "description", e.target.value)}
                        placeholder="Line item description"
                        className="h-8 text-sm px-2"
                      />
                      <GhostInput
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.id, "quantity", e.target.value)}
                        className="h-8 text-sm px-2 text-center"
                      />
                      <GhostInput
                        value={line.unit}
                        onChange={(e) => updateLine(line.id, "unit", e.target.value)}
                        className="h-8 text-sm px-2 text-center"
                      />
                      <GhostInput
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.unit_cost}
                        onChange={(e) => updateLine(line.id, "unit_cost", e.target.value)}
                        className="h-8 text-sm px-2 text-right"
                        placeholder="0.00"
                      />
                      <div className="text-right text-sm font-medium tabular-nums pr-0.5">
                        {formatMoney(lineAmount)}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length === 1}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:invisible mx-auto"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>

                    {/* Meta row — account, cost code, tax */}
                    <div className="flex items-center gap-2 pl-4 pr-2 pb-2 text-[10px]">
                      {qboConnected && (
                        <>
                          <QboLineAccountPicker
                            valueId={line.qbo_income_account_id}
                            valueLabel={line.qbo_income_account_name}
                            accounts={qboIncomeAccounts}
                            defaultAccountId={qboDefaultIncomeAccountId}
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
                          />
                          {costCodes.length > 0 && <span className="text-muted-foreground/30">·</span>}
                        </>
                      )}
                      {costCodes.length > 0 && (
                        <Select
                          value={line.cost_code_id ?? "none"}
                          onValueChange={(value) => updateLine(line.id, "cost_code_id", value === "none" ? null : value)}
                        >
                          <SelectTrigger
                            className={cn(
                              "h-5 w-auto max-w-[140px] min-w-0 shrink rounded-sm border-0 px-0 py-0 shadow-none focus:ring-0 gap-0.5 bg-transparent transition-colors text-[10px] [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground/40",
                              selectedCostCode
                                ? "text-muted-foreground hover:text-foreground"
                                : "text-muted-foreground/40 hover:text-muted-foreground",
                            )}
                          >
                            <SelectValue placeholder="Cost code">
                              {selectedCostCode ? selectedCostCode.code : "Cost code"}
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
                      {hasMeta && <span className="text-muted-foreground/30">·</span>}
                      <label className="inline-flex items-center gap-1 cursor-pointer select-none">
                        <Checkbox
                          checked={line.taxable}
                          onCheckedChange={(checked) => updateLine(line.id, "taxable", checked === true)}
                          className="size-3 rounded-[2px] shadow-none"
                        />
                        <span className={cn(
                          "text-[10px] transition-colors",
                          line.taxable ? "text-muted-foreground" : "text-muted-foreground/40",
                        )}>
                          Tax
                        </span>
                      </label>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Add line */}
            <div className="flex justify-end mt-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={addLine}>
                <Plus className="mr-1 h-3 w-3" />
                Add line
              </Button>
            </div>
          </div>

          {/* ── NOTES + TOTALS ── */}
          <div className="mt-4 grid grid-cols-[1fr_auto] gap-6 items-start">
            <div className="rounded border border-border/60 p-4 min-h-[100px]">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-2">Payment details</p>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="border-none shadow-none bg-transparent p-0 resize-none text-sm min-h-[72px] focus-visible:ring-0"
                placeholder="Bank instructions, ACH/wire details, references, and payment notes..."
              />
            </div>

            <div className="rounded border border-border/60 p-4 w-56">
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
    </Sheet>
  )
}

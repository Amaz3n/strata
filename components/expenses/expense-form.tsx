"use client"

import { type CSSProperties, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { format, isAfter, subDays } from "date-fns"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Drawer, DrawerContent } from "@/components/ui/drawer"
import { CalendarDays, Camera, Loader2, Receipt, Send, Sparkles, Upload, X } from "@/components/icons"

import type { CreateMyExpenseInput, ReceiptExtractionResult } from "@/app/(app)/projects/[id]/expenses/actions"

type ExtractedReceiptData = Extract<ReceiptExtractionResult, { ok: true }>["data"]

type DateOption = "today" | "yesterday" | "custom"
type QBOAccountOption = { id: string; name: string; fullyQualifiedName?: string; accountType?: string }

interface ExpenseAccountingContext {
  qboConnected: boolean
  expenseAccounts: QBOAccountOption[]
  paymentAccounts: QBOAccountOption[]
  apAccounts: QBOAccountOption[]
  defaults?: {
    expenseAccountId?: string
    paymentAccountId?: string
    creditCardAccountId?: string
    apAccountId?: string
  }
  warning?: string | null
}

interface ExpenseFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  onSubmit: (payload: CreateMyExpenseInput, receipt: File | null) => Promise<void>
  onExtractReceipt?: (receipt: File) => Promise<ReceiptExtractionResult>
  accountingContext?: ExpenseAccountingContext | null
  initialReceipt?: { id: number; file: File } | null
  isSubmitting?: boolean
}

export function ExpenseForm(props: ExpenseFormProps) {
  const isMobile = useIsMobile()
  return isMobile ? <MobileExpenseDrawer {...props} /> : <DesktopExpenseSheet {...props} />
}

/* ------------------------------- shared state ------------------------------ */

function useDateState() {
  const today = useMemo(() => new Date(), [])
  const [selectedDate, setSelectedDate] = useState<DateOption>("today")
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined)
  const [datePickerOpen, setDatePickerOpen] = useState(false)

  const expenseDateString = useMemo(() => {
    if (selectedDate === "today") return format(today, "yyyy-MM-dd")
    if (selectedDate === "yesterday") return format(subDays(today, 1), "yyyy-MM-dd")
    if (customDate) return format(customDate, "yyyy-MM-dd")
    return format(today, "yyyy-MM-dd")
  }, [selectedDate, customDate, today])

  function reset() {
    setSelectedDate("today")
    setCustomDate(undefined)
  }

  return {
    today,
    selectedDate,
    setSelectedDate,
    customDate,
    setCustomDate,
    datePickerOpen,
    setDatePickerOpen,
    expenseDateString,
    reset,
  }
}

function DateChips({
  today,
  selectedDate,
  setSelectedDate,
  customDate,
  setCustomDate,
  datePickerOpen,
  setDatePickerOpen,
  size = "sm",
}: ReturnType<typeof useDateState> & { size?: "sm" | "md" }) {
  const padding = size === "md" ? "px-4 py-2 text-sm" : "px-3 py-1.5 text-xs"
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setSelectedDate("today")
          setCustomDate(undefined)
        }}
        className={cn(
          "font-medium rounded-full transition-colors",
          padding,
          selectedDate === "today"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted/80",
        )}
      >
        Today
      </button>
      <button
        type="button"
        onClick={() => {
          setSelectedDate("yesterday")
          setCustomDate(undefined)
        }}
        className={cn(
          "font-medium rounded-full transition-colors",
          padding,
          selectedDate === "yesterday"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted/80",
        )}
      >
        Yesterday
      </button>
      <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 font-medium rounded-full transition-colors",
              padding,
              selectedDate === "custom"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            <CalendarDays className="h-3 w-3" />
            {selectedDate === "custom" && customDate ? format(customDate, "MMM d") : "Pick"}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <CalendarPicker
            mode="single"
            selected={customDate}
            onSelect={(date) => {
              if (date) {
                setCustomDate(date)
                setSelectedDate("custom")
                setDatePickerOpen(false)
              }
            }}
            disabled={(date) => isAfter(date, today)}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

/* ------------------------------- amount picker ----------------------------- */

interface AmountPickerProps {
  value: string
  onChange: (value: string) => void
  size?: "sm" | "md"
  isScanning?: boolean
}

function AmountPicker({ value, onChange, size = "md", isScanning = false }: AmountPickerProps) {
  const displayClass =
    size === "md"
      ? "text-4xl font-semibold tabular-nums"
      : "text-3xl font-semibold tabular-nums"

  function sanitize(raw: string) {
    const cleaned = raw.replace(/[^\d.]/g, "")
    const [whole, decimal] = cleaned.split(".")
    if (decimal === undefined) return whole
    return `${whole}.${decimal.slice(0, 2)}`
  }

  return (
    <div className={cn(
      "rounded-2xl border bg-card px-4 py-5 flex items-center justify-center gap-2 transition-colors",
      isScanning && "relative overflow-hidden border-primary/30 bg-primary/5",
    )}>
      {isScanning ? <div className="receipt-scan-sweep absolute inset-0" /> : null}
      <span className="text-2xl font-medium text-muted-foreground">$</span>
      <Input
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(sanitize(event.target.value))}
        placeholder="0.00"
        className={cn(
          "border-0 bg-transparent shadow-none text-center px-0 w-full max-w-[220px] focus-visible:ring-0 h-auto",
          displayClass,
        )}
      />
    </div>
  )
}

/* ---------------------------------- state ---------------------------------- */

function useExpenseFormState() {
  const [amount, setAmount] = useState("")
  const [tax, setTax] = useState("")
  const [vendor, setVendor] = useState("")
  const [paymentMethod, setPaymentMethod] = useState<CreateMyExpenseInput["paymentMethod"]>(null)
  const [qboTransactionType, setQboTransactionType] = useState<CreateMyExpenseInput["qboTransactionType"]>("purchase")
  const [qboExpenseAccountId, setQboExpenseAccountId] = useState("")
  const [qboPaymentAccountId, setQboPaymentAccountId] = useState("")
  const [qboApAccountId, setQboApAccountId] = useState("")
  const [notes, setNotes] = useState("")
  const [receipt, setReceipt] = useState<File | null>(null)
  function reset() {
    setAmount("")
    setTax("")
    setVendor("")
    setPaymentMethod(null)
    setQboTransactionType("purchase")
    setQboExpenseAccountId("")
    setQboPaymentAccountId("")
    setQboApAccountId("")
    setNotes("")
    setReceipt(null)
  }
  return {
    amount, setAmount,
    tax, setTax,
    vendor, setVendor,
    paymentMethod, setPaymentMethod,
    qboTransactionType, setQboTransactionType,
    qboExpenseAccountId, setQboExpenseAccountId,
    qboPaymentAccountId, setQboPaymentAccountId,
    qboApAccountId, setQboApAccountId,
    notes, setNotes,
    receipt, setReceipt,
    reset,
  }
}

function formatMoneyInput(value: number) {
  return value.toFixed(2).replace(/\.00$/, "")
}

function findAccount(accounts: QBOAccountOption[], id: string) {
  return accounts.find((account) => account.id === id) ?? null
}

function accountLabel(account: QBOAccountOption) {
  return account.fullyQualifiedName ?? account.name
}

function paymentMethodFromAccount(account: QBOAccountOption | null, fallback: CreateMyExpenseInput["paymentMethod"]) {
  if (fallback) return fallback
  return String(account?.accountType ?? "").toLowerCase() === "credit card" ? "company_card" : "cash"
}

function AccountingFields({
  context,
  form,
}: {
  context?: ExpenseAccountingContext | null
  form: ReturnType<typeof useExpenseFormState>
}) {
  if (!context?.qboConnected) return null

  const isBill = form.qboTransactionType === "bill"
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div>
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">QuickBooks</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose how this cost should hit accounting once it is approved.
        </p>
      </div>

      {context.warning ? <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">{context.warning}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Transaction</Label>
          <Select value={form.qboTransactionType ?? "purchase"} onValueChange={(value) => form.setQboTransactionType(value as "purchase" | "bill")}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="purchase">Paid expense</SelectItem>
              <SelectItem value="bill">Vendor bill due later</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Account</Label>
          <Select value={form.qboExpenseAccountId} onValueChange={form.setQboExpenseAccountId}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Choose account" />
            </SelectTrigger>
            <SelectContent>
              {context.expenseAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {accountLabel(account)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isBill ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Accounts payable account</Label>
          <Select value={form.qboApAccountId} onValueChange={form.setQboApAccountId}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Default AP account" />
            </SelectTrigger>
            <SelectContent>
              {context.apAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {accountLabel(account)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Paid from</Label>
          <Select value={form.qboPaymentAccountId} onValueChange={form.setQboPaymentAccountId}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Bank or credit card" />
            </SelectTrigger>
            <SelectContent>
              {context.paymentAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {accountLabel(account)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}

function isSupportedReceipt(file: File) {
  const type = file.type.toLowerCase()
  const name = file.name.toLowerCase()
  return (
    type.startsWith("image/") ||
    type === "application/pdf" ||
    /\.(pdf|jpe?g|png|webp|heic|heif)$/.test(name)
  )
}

function applyExtractionToForm({
  extraction,
  date,
  form,
}: {
  extraction: ExtractedReceiptData
  date: ReturnType<typeof useDateState>
  form: ReturnType<typeof useExpenseFormState>
}) {
  if (typeof extraction.totalDollars === "number" && extraction.totalDollars > 0) {
    form.setAmount(formatMoneyInput(extraction.totalDollars))
  }
  if (extraction.vendorName) {
    form.setVendor(extraction.vendorName)
  }
  if (extraction.paymentMethod) {
    form.setPaymentMethod(extraction.paymentMethod)
  }
  if (extraction.description && !form.notes.trim()) {
    form.setNotes(extraction.description)
  }
  if (extraction.expenseDate) {
    const parsedDate = new Date(`${extraction.expenseDate}T00:00:00`)
    if (!Number.isNaN(parsedDate.getTime())) {
      date.setCustomDate(parsedDate)
      date.setSelectedDate("custom")
    }
  }
}

function useReceiptScan({
  date,
  form,
  onExtractReceipt,
}: {
  date: ReturnType<typeof useDateState>
  form: ReturnType<typeof useExpenseFormState>
  onExtractReceipt?: (receipt: File) => Promise<ReceiptExtractionResult>
}) {
  const [isExtracting, setIsExtracting] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [extraction, setExtraction] = useState<ExtractedReceiptData | null>(null)

  const selectReceipt = useCallback(
    async (file: File | null) => {
      if (!file) return
      if (!isSupportedReceipt(file)) {
        toast.error("Attach an image or PDF receipt")
        return
      }

      form.setReceipt(file)
      setExtraction(null)

      if (!onExtractReceipt) return

      setIsExtracting(true)
      try {
        const result = await onExtractReceipt(file)
        if (!result.ok) {
          toast.error("Could not scan receipt", { description: result.error })
          return
        }

        setExtraction(result.data)
        applyExtractionToForm({ extraction: result.data, date, form })
        if (result.data.totalDollars) {
          toast.success("Receipt details filled in")
        } else {
          toast.message("Receipt scanned", { description: "I could not confidently find a total." })
        }
      } catch (error: any) {
        toast.error("Could not scan receipt", { description: error?.message ?? "You can still enter it manually." })
      } finally {
        setIsExtracting(false)
      }
    },
    [date, form, onExtractReceipt],
  )

  const dropHandlers = {
    onDragEnter(event: DragEvent<HTMLDivElement>) {
      event.preventDefault()
      if (event.dataTransfer.items?.length) setIsDragging(true)
    },
    onDragOver(event: DragEvent<HTMLDivElement>) {
      event.preventDefault()
      if (event.dataTransfer.items?.length) setIsDragging(true)
    },
    onDragLeave(event: DragEvent<HTMLDivElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setIsDragging(false)
      }
    },
    onDrop(event: DragEvent<HTMLDivElement>) {
      event.preventDefault()
      setIsDragging(false)
      void selectReceipt(event.dataTransfer.files?.[0] ?? null)
    },
  }

  const clearReceipt = useCallback(() => {
    form.setReceipt(null)
    setExtraction(null)
  }, [form])

  return {
    isExtracting,
    isDragging,
    extraction,
    selectReceipt,
    clearReceipt,
    dropHandlers,
  }
}

function ScanProgressBanner({ isExtracting, extraction }: { isExtracting: boolean; extraction: ExtractedReceiptData | null }) {
  if (!isExtracting && !extraction) return null

  return (
    <div className="relative overflow-hidden rounded-lg border bg-muted/30 px-3 py-2">
      {isExtracting ? <div className="receipt-scan-sweep absolute inset-0" /> : null}
      <div className="relative flex items-center gap-2 text-xs">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-background">
          {isExtracting ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : <Sparkles className="h-3.5 w-3.5 text-primary" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{isExtracting ? "Reading the receipt" : "Receipt details applied"}</p>
          <p className="truncate text-muted-foreground">
            {isExtracting ? "Finding vendor, date, total, and payment clues." : `Confidence: ${extraction?.confidence ?? "low"}`}
          </p>
        </div>
      </div>
    </div>
  )
}

function ReceiptScanDropzone({
  receipt,
  extraction,
  isDragging,
  isExtracting,
  onClick,
  onClear,
  dropHandlers,
}: {
  receipt: File | null
  extraction: ExtractedReceiptData | null
  isDragging: boolean
  isExtracting: boolean
  onClick: () => void
  onClear: () => void
  dropHandlers: ReturnType<typeof useReceiptScan>["dropHandlers"]
}) {
  return (
    <div
      {...dropHandlers}
      className={cn(
        "relative overflow-hidden rounded-lg border border-dashed bg-muted/20 px-3 py-3 transition-colors",
        isDragging || isExtracting ? "border-primary bg-primary/5" : "border-muted-foreground/25",
      )}
    >
      {isExtracting ? <div className="receipt-scan-sweep absolute inset-0" /> : null}
      {receipt ? (
        <div className="relative flex items-center gap-2 text-xs">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background">
            {isExtracting ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <Camera className="h-4 w-4 text-muted-foreground" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{receipt.name}</p>
            <p className="truncate text-muted-foreground">
              {isExtracting
                ? "Scanning receipt..."
                : extraction
                  ? `Autofilled with ${extraction.confidence} confidence`
                  : "Attached receipt"}
            </p>
          </div>
          <button type="button" onClick={onClear} className="text-muted-foreground hover:text-destructive">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="relative flex w-full items-center gap-3 text-left"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-background">
            <Upload className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{isDragging ? "Drop receipt here" : "Drop receipt or click to scan"}</p>
            <p className="text-xs text-muted-foreground">Images and PDFs autofill the form.</p>
          </div>
          <Sparkles className="h-4 w-4 text-primary" />
        </button>
      )}
    </div>
  )
}

/* ------------------------------- DESKTOP SHEET ----------------------------- */

function DesktopExpenseSheet({ open, onOpenChange, onSubmit, onExtractReceipt, accountingContext, initialReceipt, isSubmitting }: ExpenseFormProps) {
  const date = useDateState()
  const form = useExpenseFormState()
  const fileRef = useRef<HTMLInputElement>(null)
  const receiptScan = useReceiptScan({ date, form, onExtractReceipt })
  const lastInitialReceiptIdRef = useRef<number | null>(null)

  const resetAll = useCallback(() => {
    date.reset()
    form.reset()
  }, [date, form])

  useEffect(() => {
    if (!open || !initialReceipt || lastInitialReceiptIdRef.current === initialReceipt.id) return
    lastInitialReceiptIdRef.current = initialReceipt.id
    resetAll()
    void receiptScan.selectReceipt(initialReceipt.file)
  }, [open, initialReceipt, receiptScan, resetAll])

  useEffect(() => {
    if (!open || !accountingContext?.qboConnected) return
    if (!form.qboExpenseAccountId && accountingContext.defaults?.expenseAccountId) {
      form.setQboExpenseAccountId(accountingContext.defaults.expenseAccountId)
    }
    if (!form.qboPaymentAccountId && accountingContext.defaults?.paymentAccountId) {
      form.setQboPaymentAccountId(accountingContext.defaults.paymentAccountId)
    }
    if (!form.qboApAccountId && accountingContext.defaults?.apAccountId) {
      form.setQboApAccountId(accountingContext.defaults.apAccountId)
    }
  }, [open, accountingContext, form])

  async function submit() {
    const amountNum = Number(form.amount)
    if (!amountNum || amountNum <= 0) {
      toast.error("Enter the receipt total")
      return
    }
    const expenseAccount = findAccount(accountingContext?.expenseAccounts ?? [], form.qboExpenseAccountId)
    const paymentAccount = findAccount(accountingContext?.paymentAccounts ?? [], form.qboPaymentAccountId)
    const apAccount = findAccount(accountingContext?.apAccounts ?? [], form.qboApAccountId)
    try {
      await onSubmit(
        {
          expenseDate: date.expenseDateString,
          amountDollars: amountNum,
          taxDollars: Number(form.tax) || 0,
          vendorName: form.vendor.trim() || null,
          paymentMethod: form.qboTransactionType === "bill" ? "reimbursable_personal" : paymentMethodFromAccount(paymentAccount, form.paymentMethod),
          qboTransactionType: form.qboTransactionType ?? null,
          qboExpenseAccountId: expenseAccount?.id ?? null,
          qboExpenseAccountName: expenseAccount ? accountLabel(expenseAccount) : null,
          qboPaymentAccountId: paymentAccount?.id ?? null,
          qboPaymentAccountName: paymentAccount ? accountLabel(paymentAccount) : null,
          qboApAccountId: apAccount?.id ?? null,
          qboApAccountName: apAccount ? accountLabel(apAccount) : null,
          notes: form.notes.trim() || null,
        },
        form.receipt,
      )
      resetAll()
    } catch {
      // parent toasts
    }
  }

  const submitDisabled = isSubmitting || receiptScan.isExtracting || !Number(form.amount)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-primary" />
            Submit receipt
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Snap the receipt and enter the total. A reviewer will categorize it.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          <ScanProgressBanner isExtracting={receiptScan.isExtracting} extraction={receiptScan.extraction} />

          <div>
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Date</Label>
            <div className="mt-2">
              <DateChips {...date} />
            </div>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Total</Label>
            <div className="mt-2">
              <AmountPicker value={form.amount} onChange={form.setAmount} isScanning={receiptScan.isExtracting} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="exp-vendor" className="text-xs text-muted-foreground">
              Vendor <span className="text-muted-foreground/60">(optional)</span>
            </Label>
            <Input
              id="exp-vendor"
              value={form.vendor}
              onChange={(event) => form.setVendor(event.target.value)}
              placeholder="Home Depot, rental house, etc."
              className={cn("text-sm transition-colors", receiptScan.isExtracting && "border-primary/30 bg-primary/5")}
            />
          </div>

          <ReceiptScanDropzone
            receipt={form.receipt}
            extraction={receiptScan.extraction}
            isDragging={receiptScan.isDragging}
            isExtracting={receiptScan.isExtracting}
            onClick={() => fileRef.current?.click()}
            onClear={receiptScan.clearReceipt}
            dropHandlers={receiptScan.dropHandlers}
          />

          <AccountingFields context={accountingContext} form={form} />

          <div className="space-y-1.5">
            <Label htmlFor="exp-notes" className="text-xs text-muted-foreground">
              Notes <span className="text-muted-foreground/60">(optional)</span>
            </Label>
            <Textarea
              id="exp-notes"
              rows={3}
              value={form.notes}
              onChange={(event) => form.setNotes(event.target.value)}
              placeholder="What was this for?"
              className={cn("text-sm transition-colors", receiptScan.isExtracting && "border-primary/30 bg-primary/5")}
            />
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              void receiptScan.selectReceipt(file)
              event.target.value = ""
            }}
          />
        </div>

        <SheetFooter className="border-t bg-background/80 px-6 py-3 flex flex-row items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={receiptScan.isExtracting}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors disabled:opacity-60"
          >
            {receiptScan.isExtracting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            {form.receipt ? "Replace receipt" : "Scan receipt"}
          </button>

          <div className="flex-1" />

          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={submitDisabled} className="gap-1.5">
            {isSubmitting ? (
              "Submitting..."
            ) : (
              <>
                <span>Submit</span>
                <Send className="h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/* ------------------------------- MOBILE DRAWER ----------------------------- */

function MobileExpenseDrawer({ open, onOpenChange, onSubmit, onExtractReceipt, accountingContext, initialReceipt, isSubmitting }: ExpenseFormProps) {
  const date = useDateState()
  const form = useExpenseFormState()
  const fileRef = useRef<HTMLInputElement>(null)
  const receiptScan = useReceiptScan({ date, form, onExtractReceipt })
  const lastInitialReceiptIdRef = useRef<number | null>(null)

  const resetAll = useCallback(() => {
    date.reset()
    form.reset()
  }, [date, form])

  useEffect(() => {
    if (!open || !initialReceipt || lastInitialReceiptIdRef.current === initialReceipt.id) return
    lastInitialReceiptIdRef.current = initialReceipt.id
    resetAll()
    void receiptScan.selectReceipt(initialReceipt.file)
  }, [open, initialReceipt, receiptScan, resetAll])

  useEffect(() => {
    if (!open || !accountingContext?.qboConnected) return
    if (!form.qboExpenseAccountId && accountingContext.defaults?.expenseAccountId) {
      form.setQboExpenseAccountId(accountingContext.defaults.expenseAccountId)
    }
    if (!form.qboPaymentAccountId && accountingContext.defaults?.paymentAccountId) {
      form.setQboPaymentAccountId(accountingContext.defaults.paymentAccountId)
    }
    if (!form.qboApAccountId && accountingContext.defaults?.apAccountId) {
      form.setQboApAccountId(accountingContext.defaults.apAccountId)
    }
  }, [open, accountingContext, form])

  async function submit() {
    const amountNum = Number(form.amount)
    if (!amountNum || amountNum <= 0) {
      toast.error("Enter the receipt total")
      return
    }
    const expenseAccount = findAccount(accountingContext?.expenseAccounts ?? [], form.qboExpenseAccountId)
    const paymentAccount = findAccount(accountingContext?.paymentAccounts ?? [], form.qboPaymentAccountId)
    const apAccount = findAccount(accountingContext?.apAccounts ?? [], form.qboApAccountId)
    try {
      await onSubmit(
        {
          expenseDate: date.expenseDateString,
          amountDollars: amountNum,
          taxDollars: Number(form.tax) || 0,
          vendorName: form.vendor.trim() || null,
          paymentMethod: form.qboTransactionType === "bill" ? "reimbursable_personal" : paymentMethodFromAccount(paymentAccount, form.paymentMethod),
          qboTransactionType: form.qboTransactionType ?? null,
          qboExpenseAccountId: expenseAccount?.id ?? null,
          qboExpenseAccountName: expenseAccount ? accountLabel(expenseAccount) : null,
          qboPaymentAccountId: paymentAccount?.id ?? null,
          qboPaymentAccountName: paymentAccount ? accountLabel(paymentAccount) : null,
          qboApAccountId: apAccount?.id ?? null,
          qboApAccountName: apAccount ? accountLabel(apAccount) : null,
          notes: form.notes.trim() || null,
        },
        form.receipt,
      )
      resetAll()
    } catch {
      // toasted upstream
    }
  }

  const submitDisabled = isSubmitting || receiptScan.isExtracting || !Number(form.amount)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="mx-auto max-w-lg outline-none flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-4 pt-4 pb-1">
          <DateChips {...date} size="md" />
        </div>

        <div className="flex-1 overflow-y-auto p-4 pt-3 pb-2 space-y-4">
          <ScanProgressBanner isExtracting={receiptScan.isExtracting} extraction={receiptScan.extraction} />

          <AmountPicker value={form.amount} onChange={form.setAmount} isScanning={receiptScan.isExtracting} />

          <Input
            value={form.vendor}
            onChange={(event) => form.setVendor(event.target.value)}
            placeholder="Vendor (optional)"
            className={cn("h-11 text-base transition-colors", receiptScan.isExtracting && "border-primary/30 bg-primary/5")}
          />

          <ReceiptScanDropzone
            receipt={form.receipt}
            extraction={receiptScan.extraction}
            isDragging={receiptScan.isDragging}
            isExtracting={receiptScan.isExtracting}
            onClick={() => fileRef.current?.click()}
            onClear={receiptScan.clearReceipt}
            dropHandlers={receiptScan.dropHandlers}
          />

          <AccountingFields context={accountingContext} form={form} />

          <Textarea
            value={form.notes}
            onChange={(event) => form.setNotes(event.target.value)}
            placeholder="Notes (optional)"
            rows={3}
            className={cn("text-sm transition-colors", receiptScan.isExtracting && "border-primary/30 bg-primary/5")}
          />

          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              void receiptScan.selectReceipt(file)
              event.target.value = ""
            }}
          />
        </div>

        <div className="flex-shrink-0 border-t bg-background px-4 py-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={receiptScan.isExtracting}
              className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors disabled:opacity-60"
            >
              {receiptScan.isExtracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              <span className="text-xs font-medium">Receipt</span>
              {form.receipt ? <span className="text-xs text-primary">(1)</span> : null}
            </button>

            <Button
              type="button"
              size="sm"
              disabled={submitDisabled}
              onClick={submit}
              className="gap-1.5 px-4"
            >
              {isSubmitting ? (
                "Submitting..."
              ) : (
                <>
                  <span>Submit</span>
                  <Send className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

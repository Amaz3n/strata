"use client"

import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Loader2, Sparkles } from "@/components/icons"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { OVERHEAD_CATEGORIES, OVERHEAD_CATEGORY_LABELS, isOverheadCategory } from "@/lib/financials/overhead"
import { EXPENSE_PAYMENT_METHODS } from "@/lib/validation/org-expenses"
import { extractExpenseReceiptAction } from "@/app/(app)/projects/[id]/expenses/actions"
import { createOrgExpenseAction } from "@/app/(app)/payables/expenses/actions"

type PaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number]

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  credit_card: "Credit card",
  check: "Check",
  ach: "ACH",
  company_card: "Company card",
  reimbursable_personal: "Personal, reimburse me",
  other: "Other",
}

const NO_METHOD = "none"
const UNSORTED = "unsorted"

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (EXPENSE_PAYMENT_METHODS as readonly string[]).includes(value)
}

function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

function dollars(value: number | null) {
  return value === null ? "" : value.toFixed(2)
}

export function OrgExpenseCaptureSheet({
  open,
  onOpenChange,
  jobs,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobs: Array<{ id: string; name: string }>
  onSaved: () => void
}) {
  const [receipt, setReceipt] = useState<File | null>(null)
  const [date, setDate] = useState(today)
  const [total, setTotal] = useState("")
  const [tax, setTax] = useState("")
  const [vendor, setVendor] = useState("")
  const [method, setMethod] = useState<string>(NO_METHOD)
  const [home, setHome] = useState(UNSORTED)
  const [notes, setNotes] = useState("")
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [duplicate, setDuplicate] = useState<string | null>(null)

  function reset() {
    setReceipt(null)
    setDate(today())
    setTotal("")
    setTax("")
    setVendor("")
    setMethod(NO_METHOD)
    setHome(UNSORTED)
    setNotes("")
    setDuplicate(null)
  }

  async function scan() {
    if (!receipt) return
    setScanning(true)
    const formData = new FormData()
    formData.set("receipt", receipt)
    const result = await extractExpenseReceiptAction("", formData)
    setScanning(false)
    if (!result.success) {
      toast.error(result.error)
      return
    }
    if (!result.data.ok) {
      toast.error(result.data.error)
      return
    }
    const { vendorName, expenseDate, totalDollars, taxDollars, paymentMethod } = result.data.data
    if (vendorName) setVendor(vendorName)
    if (expenseDate) setDate(expenseDate)
    if (totalDollars !== null) setTotal(dollars(totalDollars))
    if (taxDollars !== null) setTax(dollars(taxDollars))
    if (isPaymentMethod(paymentMethod)) setMethod(paymentMethod)
    setDuplicate(null)
  }

  async function save(allowDuplicate: boolean) {
    const amountCents = parseMoneyToCents(total)
    const taxCents = parseMoneyToCents(tax)
    if (!amountCents || amountCents < 0) {
      toast.error("Enter the receipt total.")
      return
    }
    if (taxCents === null || taxCents < 0) {
      toast.error("Enter the tax as a positive amount, or leave it blank.")
      return
    }
    const category = home.startsWith("cat:") ? home.slice(4) : null
    const payload = {
      expense_date: date,
      amount_cents: amountCents,
      tax_cents: taxCents,
      vendor_name: vendor,
      payment_method: isPaymentMethod(method) ? method : null,
      description: notes,
      project_id: home.startsWith("job:") ? home.slice(4) : null,
      overhead_category: isOverheadCategory(category) ? category : null,
      allow_duplicate: allowDuplicate,
    }
    const formData = new FormData()
    formData.set("payload", JSON.stringify(payload))
    if (receipt) formData.set("receipt", receipt)
    setSaving(true)
    const result = await createOrgExpenseAction(formData)
    setSaving(false)
    if (!result.success) {
      if (result.code === "DUPLICATE_EXPENSE") setDuplicate(result.error)
      else toast.error(result.error)
      return
    }
    toast.success("Expense added")
    reset()
    onOpenChange(false)
    onSaved()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add expense</SheetTitle>
          <SheetDescription>Put the receipt on a job or in overhead, or leave it unsorted for review.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-expense-receipt" className="text-xs text-muted-foreground">Receipt</Label>
            <div className="flex items-center gap-2">
              <Input
                id="org-expense-receipt"
                type="file"
                accept="image/*,application/pdf"
                onChange={(event) => setReceipt(event.target.files?.[0] ?? null)}
              />
              <Button type="button" variant="outline" size="sm" disabled={!receipt || scanning} onClick={() => void scan()}>
                {scanning ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
                Scan receipt
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-expense-date" className="text-xs text-muted-foreground">Date</Label>
              <Input id="org-expense-date" type="date" value={date} max={today()} onChange={(event) => setDate(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-expense-total" className="text-xs text-muted-foreground">Total ($)</Label>
              <Input
                id="org-expense-total"
                inputMode="decimal"
                className="text-right tabular-nums"
                placeholder="0.00"
                value={total}
                onChange={(event) => setTotal(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-expense-tax" className="text-xs text-muted-foreground">Tax ($)</Label>
              <Input
                id="org-expense-tax"
                inputMode="decimal"
                className="text-right tabular-nums"
                placeholder="0.00"
                value={tax}
                onChange={(event) => setTax(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-expense-vendor" className="text-xs text-muted-foreground">Vendor</Label>
            <Input id="org-expense-vendor" value={vendor} onChange={(event) => setVendor(event.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Payment method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_METHOD}>Not specified</SelectItem>
                {EXPENSE_PAYMENT_METHODS.map((value) => (
                  <SelectItem key={value} value={value}>{PAYMENT_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Home</Label>
            <Select value={home} onValueChange={setHome}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSORTED}>Unsorted</SelectItem>
                <SelectGroup>
                  <SelectLabel>Jobs</SelectLabel>
                  {jobs.map((job) => (
                    <SelectItem key={job.id} value={`job:${job.id}`}>{job.name}</SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Overhead</SelectLabel>
                  {OVERHEAD_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={`cat:${category}`}>{OVERHEAD_CATEGORY_LABELS[category]}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-expense-notes" className="text-xs text-muted-foreground">Notes</Label>
            <Textarea id="org-expense-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>

          {duplicate ? (
            <div role="alert" className="flex flex-col gap-2 border border-warning/40 bg-warning/10 p-3 text-sm">
              <p className="text-warning">{duplicate}</p>
              <Button type="button" size="sm" variant="outline" className="self-start" disabled={saving} onClick={() => void save(true)}>
                Save anyway
              </Button>
            </div>
          ) : null}
        </div>

        <SheetFooter>
          <Button type="button" disabled={saving} onClick={() => void save(false)}>
            {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            Add expense
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

"use client"

import { type ReactNode } from "react"
import { format } from "date-fns"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { cn } from "@/lib/utils"
import { RecordRow, RecordSection, inlineCell, inlineInput, inlineTrigger } from "./record-section"
import { normalizeLienWaiverStatus, type PayableFormState } from "./payable-form"

const LIEN_WAIVER_LABELS: Record<string, string> = {
  not_required: "Not required",
  requested: "Requested",
  received: "Received",
}

function parseDate(value?: string | null) {
  if (!value) return undefined
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function InlineDate({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
}) {
  const selected = parseDate(value)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(inlineCell, "w-full tabular-nums", !selected && "text-muted-foreground")}
        >
          {selected ? format(selected, "MMM d, yyyy") : placeholder}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => onChange(date ? format(date, "yyyy-MM-dd") : "")}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  )
}

interface PayableTermsProps {
  bill: VendorBillSummary
  form: PayableFormState
  onChange: (patch: Partial<PayableFormState>) => void
  editable: boolean
  isVendorCredit: boolean
  heldRetainageCents: number
  onReleaseRetainage: () => void
  isPending: boolean
}

/**
 * The payable's terms.
 *
 * Two columns, because six single-file rows is three rows' worth of information
 * spread over twice the height. In read-only stages a term with no value is not
 * rendered at all — a label above an em-dash spends a line of the record saying
 * nothing. While the payable is still open the same row appears as an invitation
 * to fill it in, because that is the point at which the blank is actionable.
 */
export function PayableTerms({
  bill,
  form,
  onChange,
  editable,
  isVendorCredit,
  heldRetainageCents,
  onReleaseRetainage,
  isPending,
}: PayableTermsProps) {
  const numberLabel = isVendorCredit ? "Credit no." : "Invoice no."
  const dateLabel = isVendorCredit ? "Credit date" : "Invoice date"
  const waiver = normalizeLienWaiverStatus(bill.lien_waiver_status)

  const rows: ReactNode[] = []

  if (editable || bill.bill_number) {
    rows.push(
      <RecordRow key="number" label={numberLabel}>
        {editable ? (
          <Input
            value={form.billNumber}
            onChange={(event) => onChange({ billNumber: event.target.value })}
            placeholder="Add a number"
            className={cn(inlineInput, "-ml-2")}
          />
        ) : (
          <span className="font-medium">{bill.bill_number}</span>
        )}
      </RecordRow>,
    )
  }

  if (editable || bill.bill_date) {
    rows.push(
      <RecordRow key="bill-date" label={dateLabel}>
        {editable ? (
          <InlineDate
            value={form.billDate}
            onChange={(billDate) => onChange({ billDate })}
            placeholder="Add a date"
          />
        ) : (
          <span className="tabular-nums">
            {format(parseDate(bill.bill_date) ?? new Date(), "MMM d, yyyy")}
          </span>
        )}
      </RecordRow>,
    )
  }

  if (!isVendorCredit && (editable || bill.due_date)) {
    rows.push(
      <RecordRow key="due-date" label="Due date">
        {editable ? (
          <InlineDate
            value={form.dueDate}
            onChange={(dueDate) => onChange({ dueDate })}
            placeholder="Add a date"
          />
        ) : (
          <span className="tabular-nums">
            {format(parseDate(bill.due_date) ?? new Date(), "MMM d, yyyy")}
          </span>
        )}
      </RecordRow>,
    )
  }

  if (bill.commitment_title) {
    rows.push(
      <RecordRow key="commitment" label="Commitment">
        <span className="block truncate">{bill.commitment_title}</span>
      </RecordRow>,
    )
  }

  if (!isVendorCredit && (editable || bill.retainage_percent != null)) {
    rows.push(
      <RecordRow key="retainage" label="Retainage">
        {editable ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="0.1"
              value={form.retainage}
              onChange={(event) => onChange({ retainage: event.target.value })}
              placeholder="0"
              className={cn(inlineInput, "-ml-2 w-20 tabular-nums")}
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-3">
            <span className="tabular-nums">{bill.retainage_percent}%</span>
            {heldRetainageCents > 0 ? (
              <>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatMoneyFromCents(heldRetainageCents)} held
                </span>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  disabled={isPending}
                  onClick={onReleaseRetainage}
                >
                  Release
                </Button>
              </>
            ) : null}
          </span>
        )}
      </RecordRow>,
    )
  }

  if (!isVendorCredit && (editable || waiver !== "not_required")) {
    rows.push(
      <RecordRow key="waiver" label="Lien waiver">
        {editable ? (
          <Select value={form.lienWaiver} onValueChange={(lienWaiver) => onChange({ lienWaiver })}>
            <SelectTrigger className={cn(inlineTrigger, "-ml-2")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="not_required">Not required</SelectItem>
              <SelectItem value="requested">Requested</SelectItem>
              <SelectItem value="received">Received</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className={waiver === "received" ? "text-success" : "text-warning"}>
            {LIEN_WAIVER_LABELS[waiver] ?? waiver}
          </span>
        )}
      </RecordRow>,
    )
  }

  // Who moves the money. This is a real gate on both sides — the payment-run
  // preparer refuses an `external` payable, and recording an outside payment
  // against an `arc` one is refused too — so it has to be changeable, or a
  // payable can get stuck between the two paths with no way out.
  if (!isVendorCredit) {
    rows.push(
      <RecordRow key="channel" label="Paid by">
        {editable ? (
          <Select
            value={form.paymentChannel}
            onValueChange={(value) => onChange({ paymentChannel: value === "arc" ? "arc" : "external" })}
          >
            <SelectTrigger className={cn(inlineTrigger, "-ml-2")}>
              <SelectValue placeholder="Not decided" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="arc">Arc Pay</SelectItem>
              <SelectItem value="external">Paid outside Arc</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className={form.paymentChannel ? undefined : "text-muted-foreground"}>
            {form.paymentChannel === "arc" ? "Arc Pay" : form.paymentChannel === "external" ? "Paid outside Arc" : "Not decided"}
          </span>
        )}
      </RecordRow>,
    )
  }

  /*
    Early-pay discounts are not builder-entered: early pay is a future Arc
    program, and its terms (and fee) belong to Arc, not to this form. Discounts
    that arrived on the bill — e.g. from a QuickBooks import — stay visible as
    a fact of the record.
  */
  if (!isVendorCredit && bill.early_pay_discount_percent != null) {
    rows.push(
      <RecordRow key="discount" label="Early pay">
        <span className="tabular-nums">
          {bill.early_pay_discount_percent}%
          {bill.early_pay_discount_days != null
            ? ` if paid within ${bill.early_pay_discount_days} days`
            : ""}
        </span>
      </RecordRow>,
    )
  }

  // Nothing recorded and nothing fillable — the section itself is the noise.
  if (rows.length === 0) return null

  return (
    <RecordSection label="Terms">
      <div className="grid gap-x-16 gap-y-1 md:grid-cols-2">{rows}</div>
    </RecordSection>
  )
}

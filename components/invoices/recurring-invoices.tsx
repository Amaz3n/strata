"use client"

import { useEffect, useState } from "react"
import { addDays, addMonths, format, parseISO } from "date-fns"
import { toast } from "sonner"
import { Loader2, Repeat, Trash2 } from "lucide-react"

import type { Invoice } from "@/lib/types"
import type { InvoiceSchedule, InvoiceScheduleFrequency } from "@/lib/services/invoice-schedules"
import {
  createInvoiceScheduleAction,
  deleteInvoiceScheduleAction,
  listInvoiceSchedulesAction,
  setInvoiceScheduleActiveAction,
} from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { formatDateOnly, formatMoneyFromCents } from "./invoice-presentation"

/**
 * Recurring invoices: a schedule is an invoice that copies itself on a cadence.
 * The register lists every schedule as a row you can pause, resume or delete;
 * a schedule is only ever started from an invoice ("Make recurring…"), because
 * the invoice is the template.
 */

const FREQUENCY_LABEL: Record<InvoiceScheduleFrequency, string> = {
  weekly: "Every week",
  monthly: "Every month",
  quarterly: "Every quarter",
}

export function RecurringInvoices({ projectId, onChanged }: { projectId?: string; onChanged?: () => void }) {
  const [schedules, setSchedules] = useState<InvoiceSchedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listInvoiceSchedulesAction(projectId)
      .then((result) => {
        if (!cancelled) setSchedules(unwrapAction(result))
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load recurring invoices.")
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  async function toggle(schedule: InvoiceSchedule) {
    setBusyId(schedule.id)
    try {
      const updated = unwrapAction(await setInvoiceScheduleActiveAction(schedule.id, !schedule.active))
      setSchedules((current) => (current ?? []).map((entry) => (entry.id === updated.id ? updated : entry)))
      toast.success(updated.active ? "Schedule resumed" : "Schedule paused")
      onChanged?.()
    } catch (caught) {
      toast.error("Could not update the schedule", { description: caught instanceof Error ? caught.message : "Please try again." })
    } finally {
      setBusyId(null)
    }
  }

  async function remove(schedule: InvoiceSchedule) {
    setBusyId(schedule.id)
    try {
      unwrapAction(await deleteInvoiceScheduleAction(schedule.id))
      setSchedules((current) => (current ?? []).filter((entry) => entry.id !== schedule.id))
      toast.success("Schedule deleted", { description: "Invoices it already created are untouched." })
      onChanged?.()
    } catch (caught) {
      toast.error("Could not delete the schedule", { description: caught instanceof Error ? caught.message : "Please try again." })
    } finally {
      setBusyId(null)
    }
  }

  const active = (schedules ?? []).filter((schedule) => schedule.active)
  const monthlyCents = active.reduce((sum, schedule) => {
    const perMonth = schedule.frequency === "weekly" ? 52 / 12 : schedule.frequency === "quarterly" ? 1 / 3 : 1
    return sum + schedule.total_preview_cents * perMonth
  }, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
        <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
          <div className="flex items-baseline gap-1.5">
            <dt className="microlabel">Active</dt>
            <dd className="font-mono font-semibold tabular-nums">{active.length}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="microlabel">Per month</dt>
            <dd className="font-mono tabular-nums">{formatMoneyFromCents(Math.round(monthlyCents))}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">Start one from any invoice: its menu → Make recurring.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="m-4 border border-destructive/30 bg-destructive/10 p-4 text-sm">{error}</p>
        ) : !schedules ? (
          <div className="space-y-2 p-6">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : schedules.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Repeat className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No recurring invoices</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Open an invoice that repeats, and choose Make recurring from its menu.</p>
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="px-6 py-2.5">Invoice</TableHead>
                <TableHead className="px-4 py-2.5">Cadence</TableHead>
                <TableHead className="px-4 py-2.5">Next</TableHead>
                <TableHead className="px-4 py-2.5">Last</TableHead>
                <TableHead className="px-4 py-2.5 text-right">Amount</TableHead>
                <TableHead className="px-4 py-2.5">Delivery</TableHead>
                <TableHead className="px-4 py-2.5">Active</TableHead>
                <TableHead className="w-12 px-6 py-2.5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule) => (
                <TableRow key={schedule.id} className={cn("animate-in fade-in duration-200 motion-reduce:animate-none", !schedule.active && "text-muted-foreground")}>
                  <TableCell className="px-6 py-2.5">
                    <span className="font-medium">{schedule.title}</span>
                    {schedule.customer_name ? <span className="mt-0.5 block text-xs text-muted-foreground">{schedule.customer_name}</span> : null}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-sm">
                    {FREQUENCY_LABEL[schedule.frequency]}
                    {schedule.day_of_month ? <span className="text-xs text-muted-foreground"> · day {schedule.day_of_month}</span> : null}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-sm tabular-nums">{schedule.active ? formatDateOnly(schedule.next_run_on, { withYear: true }) : "Paused"}</TableCell>
                  <TableCell className="px-4 py-2.5 text-sm tabular-nums text-muted-foreground">
                    {schedule.last_run_at ? format(new Date(schedule.last_run_at), "MMM d, yyyy") : "Never"}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-sm tabular-nums">{formatMoneyFromCents(schedule.total_preview_cents)}</TableCell>
                  <TableCell className="px-4 py-2.5 text-xs">
                    {schedule.auto_send ? `Sends to ${schedule.recipient_email ?? "the customer"}` : "Drafts for review"}
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <Switch checked={schedule.active} disabled={busyId === schedule.id} onCheckedChange={() => void toggle(schedule)} aria-label={schedule.active ? "Pause schedule" : "Resume schedule"} />
                  </TableCell>
                  <TableCell className="px-6 py-2.5 text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" disabled={busyId === schedule.id} onClick={() => void remove(schedule)} aria-label="Delete schedule">
                      {busyId === schedule.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

/** Turn an invoice into the template for a schedule. */
export function MakeRecurringDialog({
  invoice,
  open,
  onOpenChange,
  onCreated,
}: {
  invoice: Invoice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void
}) {
  const [frequency, setFrequency] = useState<InvoiceScheduleFrequency>("monthly")
  const [startOn, setStartOn] = useState("")
  const [autoSend, setAutoSend] = useState(false)
  const [recipient, setRecipient] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !invoice) return
    setFrequency("monthly")
    setStartOn(format(addMonths(new Date(), 1), "yyyy-MM-dd"))
    setAutoSend(false)
    setRecipient(invoice.sent_to_emails?.[0] ?? String((invoice.metadata as Record<string, unknown> | undefined)?.customer_email ?? ""))
  }, [invoice, open])

  const nextDates = (() => {
    if (!startOn) return []
    const first = parseISO(startOn)
    const step = (date: Date) => (frequency === "weekly" ? addDays(date, 7) : addMonths(date, frequency === "monthly" ? 1 : 3))
    const second = step(first)
    return [first, second, step(second)]
  })()

  async function submit() {
    if (!invoice || !startOn) return
    setSaving(true)
    try {
      const schedule = unwrapAction(
        await createInvoiceScheduleAction({
          invoiceId: invoice.id,
          frequency,
          startOn,
          autoSend,
          recipientEmail: recipient.trim() || null,
        }),
      )
      toast.success("Recurring invoice set up", {
        description: `${FREQUENCY_LABEL[frequency]}, first on ${format(parseISO(schedule.next_run_on), "MMM d, yyyy")}.`,
      })
      onOpenChange(false)
      onCreated?.()
    } catch (caught) {
      toast.error("Could not set up the schedule", { description: caught instanceof Error ? caught.message : "Please try again." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make {invoice?.invoice_number ?? "this invoice"} recurring</DialogTitle>
          <DialogDescription>
            Each run copies this invoice with a new number and current dates
            {autoSend ? " and emails it" : " as a draft in Up next"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Repeats</span>
              <Select value={frequency} onValueChange={(value) => setFrequency(value as InvoiceScheduleFrequency)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FREQUENCY_LABEL) as InvoiceScheduleFrequency[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {FREQUENCY_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">First on</span>
              <Input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} className="h-9" />
            </label>
          </div>
          {nextDates.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Then {nextDates
                .slice(1)
                .map((date) => format(date, "MMM d"))
                .join(", ")}
              , and so on.
            </p>
          ) : null}
          <label className="flex items-center justify-between gap-4 border p-3 text-sm">
            <span>
              Send automatically
              <span className="block text-xs text-muted-foreground">Off means each run lands in Up next for you to review.</span>
            </span>
            <Switch checked={autoSend} onCheckedChange={setAutoSend} />
          </label>
          {autoSend ? (
            <label className="block space-y-1 animate-in fade-in duration-150 motion-reduce:animate-none">
              <span className="text-xs font-medium text-muted-foreground">Send to</span>
              <Input type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="customer@email.com" className="h-9" />
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !startOn || (autoSend && !recipient.includes("@"))}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Repeat className="mr-1.5 h-3.5 w-3.5" />}
            Start schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

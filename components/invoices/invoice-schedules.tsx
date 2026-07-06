"use client"

import { useEffect, useState } from "react"
import { format, parseISO } from "date-fns"
import { toast } from "sonner"

import type { Invoice } from "@/lib/types"
import type { InvoiceSchedule, InvoiceScheduleFrequency } from "@/lib/services/invoice-schedules"
import {
  createInvoiceScheduleAction,
  deleteInvoiceScheduleAction,
  listInvoiceSchedulesAction,
  setInvoiceScheduleActiveAction,
} from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Spinner } from "@/components/ui/spinner"

const frequencyLabels: Record<InvoiceScheduleFrequency, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function MakeRecurringDialog({
  invoice,
  open,
  onOpenChange,
  onCreated,
}: {
  invoice: Invoice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (schedule: InvoiceSchedule) => void
}) {
  const [frequency, setFrequency] = useState<InvoiceScheduleFrequency>("monthly")
  const [startOn, setStartOn] = useState("")
  const [autoSend, setAutoSend] = useState(false)
  const [recipient, setRecipient] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !invoice) return
    setFrequency("monthly")
    const nextMonth = new Date()
    nextMonth.setMonth(nextMonth.getMonth() + 1)
    setStartOn(format(nextMonth, "yyyy-MM-dd"))
    setAutoSend(false)
    setRecipient(
      invoice.sent_to_emails?.[0] ?? String((invoice.metadata as Record<string, any> | null)?.customer_email ?? ""),
    )
  }, [open, invoice])

  const handleCreate = async () => {
    if (!invoice) return
    if (!startOn) {
      toast.error("Pick a first run date")
      return
    }
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
      toast.success("Recurring schedule created", {
        description: `${frequencyLabels[frequency]}, next run ${format(parseISO(schedule.next_run_on), "MMM d, yyyy")}.`,
      })
      onCreated?.(schedule)
      onOpenChange(false)
    } catch (error: any) {
      toast.error("Could not create schedule", { description: error?.message ?? "Please try again." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make recurring</DialogTitle>
          <DialogDescription>
            Uses {invoice?.invoice_number ?? "this invoice"} as a template. Each run creates a fresh invoice with a new
            number and current dates{autoSend ? " and emails it automatically" : " as a draft for review"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="schedule-frequency">
                Repeats
              </label>
              <Select value={frequency} onValueChange={(value) => setFrequency(value as InvoiceScheduleFrequency)}>
                <SelectTrigger id="schedule-frequency" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(frequencyLabels) as InvoiceScheduleFrequency[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {frequencyLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="schedule-start">
                First run
              </label>
              <Input
                id="schedule-start"
                type="date"
                value={startOn}
                onChange={(event) => setStartOn(event.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={autoSend} onCheckedChange={(checked) => setAutoSend(checked === true)} />
            Send to the client automatically
          </label>
          {autoSend && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="schedule-recipient">
                Send to
              </label>
              <Input
                id="schedule-recipient"
                type="email"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="client@email.com"
                className="h-9"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={handleCreate}>
            {saving ? "Creating…" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InvoiceSchedulesDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId?: string
}) {
  const [schedules, setSchedules] = useState<InvoiceSchedule[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    listInvoiceSchedulesAction(projectId)
      .then((result) => {
        if (!cancelled) setSchedules(unwrapAction(result))
      })
      .catch((error: any) => {
        if (cancelled) return
        toast.error("Could not load schedules", { description: error?.message ?? "Please try again." })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  const toggleActive = async (schedule: InvoiceSchedule) => {
    setBusyId(schedule.id)
    try {
      const updated = unwrapAction(await setInvoiceScheduleActiveAction(schedule.id, !schedule.active))
      setSchedules((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      toast.success(updated.active ? "Schedule resumed" : "Schedule paused")
    } catch (error: any) {
      toast.error("Could not update schedule", { description: error?.message ?? "Please try again." })
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (schedule: InvoiceSchedule) => {
    setBusyId(schedule.id)
    try {
      unwrapAction(await deleteInvoiceScheduleAction(schedule.id))
      setSchedules((prev) => prev.filter((item) => item.id !== schedule.id))
      toast.success("Schedule deleted")
    } catch (error: any) {
      toast.error("Could not delete schedule", { description: error?.message ?? "Please try again." })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recurring invoices</DialogTitle>
          <DialogDescription>
            Schedules run daily; each due schedule creates a fresh invoice from its template.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading schedules…
          </div>
        ) : schedules.length === 0 ? (
          <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
            No recurring invoices yet. Use &ldquo;Make recurring&rdquo; on any invoice to create one.
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto border">
            <div className="grid grid-cols-[minmax(0,1fr)_90px_110px_90px_150px] gap-x-2 border-b bg-muted/30 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              <span>Invoice</span>
              <span>Repeats</span>
              <span>Next run</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Actions</span>
            </div>
            <div className="divide-y">
              {schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  className="grid grid-cols-[minmax(0,1fr)_90px_110px_90px_150px] items-center gap-x-2 px-3 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{schedule.title}</div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate">{schedule.customer_name ?? "No customer"}</span>
                      {schedule.auto_send && (
                        <Badge variant="secondary" className="h-4 rounded-sm px-1 text-[9px]">
                          Auto-send
                        </Badge>
                      )}
                      {!schedule.active && (
                        <Badge variant="outline" className="h-4 rounded-sm px-1 text-[9px] text-muted-foreground">
                          Paused
                        </Badge>
                      )}
                    </div>
                  </div>
                  <span className="text-muted-foreground">{frequencyLabels[schedule.frequency]}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {format(parseISO(schedule.next_run_on), "MMM d, yyyy")}
                  </span>
                  <span className="text-right font-mono tabular-nums">{formatMoney(schedule.total_preview_cents)}</span>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busyId === schedule.id}
                      onClick={() => void toggleActive(schedule)}
                    >
                      {schedule.active ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                      disabled={busyId === schedule.id}
                      onClick={() => void remove(schedule)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

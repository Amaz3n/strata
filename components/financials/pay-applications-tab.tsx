"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, FileText, Plus } from "lucide-react"
import { toast } from "sonner"

import {
  createPayApplicationAction,
  deletePayApplicationAction,
  fetchPayApplicationAction,
  generatePayApplicationPackageAction,
  generatePayApplicationPdfAction,
  markPayApplicationApprovedAction,
  submitPayApplicationAction,
  updatePayApplicationLinesAction,
  voidPayApplicationAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import {
  computePayAppLine,
  computePayAppSummary,
  resolveRetainageRatePercent,
  thisPeriodFromPercentComplete,
} from "@/lib/financials/pay-app-math"
import type {
  PayApplication,
  PayApplicationDetail,
  PayApplicationLine,
} from "@/lib/services/pay-applications"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface PayApplicationsTabProps {
  projectId: string
  payApplications: PayApplication[]
  onInvoiceGenerated?: (invoiceId: string | null) => void
}

const STATUS_BADGES: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  draft: { label: "Draft", variant: "outline" },
  submitted: { label: "Submitted", variant: "secondary" },
  approved: { label: "Approved", variant: "secondary" },
  invoiced: { label: "Invoiced", variant: "default" },
  paid: { label: "Paid", variant: "default" },
  void: { label: "Void", variant: "destructive" },
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function formatMoneyExact(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  })
}

function centsFromField(value: string): number | null {
  if (value.trim() === "") return 0
  const amount = Number(value.replace(/[$,\s]/g, ""))
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

function formatPeriod(app: PayApplication) {
  const end = app.period_end
  if (!end) return "—"
  if (app.period_start) return `${app.period_start} → ${end}`
  return `Through ${end}`
}

export function PayApplicationsTab({ projectId, payApplications, onInvoiceGenerated }: PayApplicationsTabProps) {
  const router = useRouter()
  const [apps, setApps] = useState<PayApplication[]>(payApplications)
  const [detail, setDetail] = useState<PayApplicationDetail | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [newPeriodEnd, setNewPeriodEnd] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  function refreshList(next?: PayApplication[]) {
    if (next) setApps(next)
    router.refresh()
  }

  function openApp(appId: string) {
    startTransition(async () => {
      try {
        const loaded = unwrapAction(await fetchPayApplicationAction(appId))
        setDetail(loaded)
        setSheetOpen(true)
      } catch (error) {
        toast.error("Unable to open pay application", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function createApp() {
    if (!newPeriodEnd) {
      toast.error("Pick a period end date")
      return
    }
    startTransition(async () => {
      try {
        const created = unwrapAction(await createPayApplicationAction(projectId, { period_end: newPeriodEnd }))
        setApps((current) => [created.application, ...current])
        setDetail(created)
        setSheetOpen(true)
        setCreateOpen(false)
        setNewPeriodEnd("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to create pay application", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function applyDetail(next: PayApplicationDetail) {
    setDetail(next)
    setApps((current) => current.map((app) => (app.id === next.application.id ? next.application : app)))
  }

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {apps.length} application{apps.length === 1 ? "" : "s"}
        </div>
        <Popover open={createOpen} onOpenChange={setCreateOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" disabled={isPending}>
              <Plus className="mr-1.5 h-4 w-4" />
              New pay application
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="payapp-period-end">Period ending</Label>
              <Input
                id="payapp-period-end"
                type="date"
                value={newPeriodEnd}
                onChange={(event) => setNewPeriodEnd(event.target.value)}
              />
            </div>
            <Button type="button" size="sm" className="w-full" onClick={createApp} disabled={isPending}>
              Create draft
            </Button>
          </PopoverContent>
        </Popover>
      </div>

      {apps.length === 0 ? (
        <div className="border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No pay applications yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Each month, create a pay application, enter progress against the schedule of values, and submit it to
            generate the owner invoice.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border">
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">App #</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-36 text-right">Completed + stored</TableHead>
                <TableHead className="w-28 text-right">Retainage</TableHead>
                <TableHead className="w-32 text-right">Payment due</TableHead>
                <TableHead className="w-28">Invoice due</TableHead>
                <TableHead className="w-28 text-right">Open balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const badge = STATUS_BADGES[app.status] ?? STATUS_BADGES.draft
                return (
                  <TableRow key={app.id} className="cursor-pointer" onClick={() => openApp(app.id)}>
                    <TableCell className="font-mono text-sm">
                      {app.application_number}
                      {app.is_retainage_release ? (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">Rel</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{formatPeriod(app)}</TableCell>
                    <TableCell>
                      <Badge variant={badge.variant} className="rounded-sm text-[10px]">
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {app.status === "draft" ? "—" : formatMoney(app.total_completed_stored_cents)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {app.status === "draft" ? "—" : formatMoney(app.retainage_cents)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {app.status === "draft" ? "—" : formatMoneyExact(app.current_payment_due_cents)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {app.invoice_due_date ?? "—"}
                      {(app.days_past_due ?? 0) > 0 ? <div className="text-xs text-destructive">{app.days_past_due}d overdue</div> : null}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {app.invoice_balance_due_cents == null ? "—" : formatMoneyExact(app.invoice_balance_due_cents)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <PayApplicationSheet
        projectId={projectId}
        detail={detail}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onDetailChange={applyDetail}
        onListChange={refreshList}
        onDeleted={(appId) => {
          setApps((current) => current.filter((app) => app.id !== appId))
          setSheetOpen(false)
          router.refresh()
        }}
        onInvoiceGenerated={onInvoiceGenerated}
      />
    </div>
  )
}

interface EntryDraft {
  this_period: string
  stored: string
}

function PayApplicationSheet({
  projectId,
  detail,
  open,
  onOpenChange,
  onDetailChange,
  onListChange,
  onDeleted,
  onInvoiceGenerated,
}: {
  projectId: string
  detail: PayApplicationDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDetailChange: (detail: PayApplicationDetail) => void
  onListChange: (apps?: PayApplication[]) => void
  onDeleted: (appId: string) => void
  onInvoiceGenerated?: (invoiceId: string | null) => void
}) {
  const [entries, setEntries] = useState<Record<string, EntryDraft>>({})
  const [dirty, setDirty] = useState(false)
  const [allowOverbilling, setAllowOverbilling] = useState(false)
  const [includeGcCompliance, setIncludeGcCompliance] = useState(false)
  const [isPending, startTransition] = useTransition()

  const app = detail?.application ?? null
  const isDraft = app?.status === "draft"
  const isRelease = app?.is_retainage_release ?? false

  function entryFor(line: PayApplicationLine): EntryDraft {
    return (
      entries[line.prime_sov_line_id] ?? {
        this_period: line.this_period_cents === 0 ? "" : (line.this_period_cents / 100).toFixed(2),
        stored: line.stored_materials_cents === 0 ? "" : (line.stored_materials_cents / 100).toFixed(2),
      }
    )
  }

  const liveLines = useMemo(() => {
    if (!detail) return []
    return detail.lines.map((line) => {
      const entry = entryFor(line)
      const thisPeriod = centsFromField(entry.this_period) ?? 0
      const stored = centsFromField(entry.stored) ?? 0
      const percentAfter =
        line.scheduled_value_cents > 0
          ? ((line.previous_billed_cents + thisPeriod) / line.scheduled_value_cents) * 100
          : 0
      const workRate = resolveRetainageRatePercent({
        percentComplete: percentAfter,
        schedule: detail.retainage_config.schedule,
        lineOverridePercent: line.retainage_percent_override,
        contractPercent: detail.retainage_config.contract_percent,
      })
      const storedRate = detail.retainage_config.stored_materials_percent ?? workRate
      const computed = computePayAppLine({
        scheduledValueCents: line.scheduled_value_cents,
        previousBilledCents: line.previous_billed_cents,
        thisPeriodCents: thisPeriod,
        storedMaterialsCents: stored,
        previousStoredMaterialsCents: line.previous_stored_materials_cents,
        workRetainagePercent: workRate,
        storedMaterialsRetainagePercent: storedRate,
      })
      return { line, computed }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, entries])

  const liveSummary = useMemo(() => {
    if (!detail) return null
    if (!isDraft) return detail.summary
    const previousHeld = detail.summary.retainageCents - detail.summary.currentRetainageCents
    return computePayAppSummary({
      originalContractSumCents: detail.summary.contractSumToDateCents - detail.application.change_order_sum_cents,
      changeOrderSumCents: detail.application.change_order_sum_cents,
      previousRetainageHeldCents: previousHeld,
      previousCertificatesCents: detail.summary.previousCertificatesCents,
      lines: liveLines.map((row) => row.computed),
    })
  }, [detail, isDraft, liveLines])

  const hasOverbilling = liveLines.some((row) => row.computed.overbilled)

  function updateEntry(line: PayApplicationLine, patch: Partial<EntryDraft>) {
    setEntries((current) => ({
      ...current,
      [line.prime_sov_line_id]: { ...entryFor(line), ...patch },
    }))
    setDirty(true)
  }

  function setPercent(line: PayApplicationLine, percentText: string) {
    const percent = Number(percentText)
    if (!Number.isFinite(percent)) return
    const thisPeriod = thisPeriodFromPercentComplete({
      scheduledValueCents: line.scheduled_value_cents,
      percentComplete: Math.min(100, Math.max(0, percent)),
      previousBilledCents: line.previous_billed_cents,
    })
    updateEntry(line, { this_period: (thisPeriod / 100).toFixed(2) })
  }

  function buildEntriesPayload() {
    if (!detail) return null
    const payload = []
    for (const line of detail.lines) {
      const entry = entryFor(line)
      const thisPeriod = centsFromField(entry.this_period)
      const stored = centsFromField(entry.stored)
      if (thisPeriod == null || stored == null) {
        toast.error(`Line ${line.line_number} has an invalid amount`)
        return null
      }
      if (stored < 0) {
        toast.error(`Line ${line.line_number}: stored materials cannot be negative`)
        return null
      }
      payload.push({
        prime_sov_line_id: line.prime_sov_line_id,
        this_period_cents: thisPeriod,
        stored_materials_cents: stored,
      })
    }
    return payload
  }

  function saveDraft(after?: (saved: PayApplicationDetail) => void) {
    if (!detail || !app) return
    const payload = buildEntriesPayload()
    if (!payload) return
    startTransition(async () => {
      try {
        const saved = unwrapAction(
          await updatePayApplicationLinesAction(projectId, app.id, {
            entries: payload,
            allow_overbilling: allowOverbilling,
          }),
        )
        onDetailChange(saved)
        setEntries({})
        setDirty(false)
        if (after) {
          after(saved)
        } else {
          toast.success("Draft saved")
        }
      } catch (error) {
        toast.error("Unable to save pay application", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function submit() {
    if (!detail || !app) return
    const doSubmit = () => {
      startTransition(async () => {
        try {
          const result = unwrapAction(await submitPayApplicationAction(projectId, app.id))
          onDetailChange(result.detail)
          onListChange(result.payApplications)
          toast.success(`Application #${result.detail.application.application_number} invoiced`)
          onInvoiceGenerated?.(result.detail.application.invoice_id)
        } catch (error) {
          toast.error("Unable to submit pay application", {
            description: error instanceof Error ? error.message : "Try again.",
          })
        }
      })
    }
    if (dirty) {
      saveDraft(() => doSubmit())
    } else {
      doSubmit()
    }
  }

  function voidApp() {
    if (!app) return
    startTransition(async () => {
      try {
        const voided = unwrapAction(await voidPayApplicationAction(projectId, app.id))
        onDetailChange(voided)
        onListChange()
        toast.success("Pay application voided")
      } catch (error) {
        toast.error("Unable to void pay application", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function deleteDraft() {
    if (!app) return
    startTransition(async () => {
      try {
        unwrapAction(await deletePayApplicationAction(projectId, app.id))
        toast.success("Draft deleted")
        onDeleted(app.id)
      } catch (error) {
        toast.error("Unable to delete draft", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function downloadPdf() {
    if (!app) return
    startTransition(async () => {
      try {
        const { fileName, pdfBase64 } = unwrapAction(await generatePayApplicationPdfAction(projectId, app.id))
        const bytes = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0))
        const blob = new Blob([bytes], { type: "application/pdf" })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = fileName
        anchor.click()
        URL.revokeObjectURL(url)
      } catch (error) {
        toast.error("Unable to generate the PDF", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function generatePackage() {
    if (!app) return
    startTransition(async () => {
      try {
        const result = unwrapAction(
          await generatePayApplicationPackageAction(projectId, app.id, { includeGcCompliance }),
        )
        const bytes = Uint8Array.from(atob(result.pdfBase64), (char) => char.charCodeAt(0))
        const blob = new Blob([bytes], { type: "application/pdf" })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = result.fileName
        anchor.click()
        URL.revokeObjectURL(url)
        toast.success("Owner pay-app package generated", {
          description: `${result.package.proof_count} supporting file${result.package.proof_count === 1 ? "" : "s"} attached to the package manifest.`,
        })
      } catch (error) {
        toast.error("Unable to generate the pay-app package", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function markApproved() {
    if (!app) return
    startTransition(async () => {
      try {
        const approved = unwrapAction(await markPayApplicationApprovedAction(projectId, app.id))
        onDetailChange(approved)
        toast.success("Owner approval recorded")
      } catch (error) {
        toast.error("Unable to record approval", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  if (!detail || !app) {
    return <Sheet open={false} onOpenChange={onOpenChange}><SheetContent side="right" /></Sheet>
  }

  const badge = STATUS_BADGES[app.status] ?? STATUS_BADGES.draft

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setEntries({})
          setDirty(false)
          setAllowOverbilling(false)
          setIncludeGcCompliance(false)
        }
        onOpenChange(next)
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-4xl">
        <SheetHeader className="pr-8">
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {isRelease ? "Retainage Release" : "Pay Application"} #{app.application_number}
            <Badge variant={badge.variant} className="rounded-sm text-[10px]">
              {badge.label}
            </Badge>
          </SheetTitle>
          <SheetDescription>{formatPeriod(app)}</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          {hasOverbilling ? (
            <div className="flex items-start gap-2 border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="space-y-1.5">
                <p>One or more lines bill past their scheduled value.</p>
                {isDraft ? (
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={allowOverbilling}
                      onCheckedChange={(checked) => setAllowOverbilling(checked === true)}
                    />
                    Allow overbilling on this application
                  </label>
                ) : null}
              </div>
            </div>
          ) : null}

          {!isRelease ? (
            <div className="overflow-x-auto border">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-9 text-right">#</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="w-28 text-right">Scheduled</TableHead>
                    <TableHead className="w-28 text-right">Previous</TableHead>
                    <TableHead className="w-28 text-right">This period</TableHead>
                    <TableHead className="w-16 text-right">%</TableHead>
                    <TableHead className="w-28 text-right">Stored</TableHead>
                    <TableHead className="w-28 text-right">Total + stored</TableHead>
                    <TableHead className="w-28 text-right">Balance</TableHead>
                    <TableHead className="w-24 text-right">Retainage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {liveLines.map(({ line, computed }) => {
                    const entry = entryFor(line)
                    return (
                      <TableRow key={line.id} className={computed.overbilled ? "bg-warning/5" : undefined}>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {line.line_number}
                        </TableCell>
                        <TableCell className="max-w-56">
                          <div className="truncate text-sm" title={line.description}>
                            {line.description}
                          </div>
                          {line.cost_code_label ? (
                            <div className="truncate text-xs text-muted-foreground">{line.cost_code_label}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {formatMoney(line.scheduled_value_cents)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {formatMoney(line.previous_billed_cents)}
                        </TableCell>
                        <TableCell className="text-right">
                          {isDraft ? (
                            <Input
                              value={entry.this_period}
                              onChange={(event) => updateEntry(line, { this_period: event.target.value })}
                              inputMode="decimal"
                              placeholder="0.00"
                              className="h-7 border-transparent bg-transparent px-1 text-right font-mono text-sm tabular-nums shadow-none focus-visible:border-input"
                              aria-label={`Line ${line.line_number} this period`}
                            />
                          ) : (
                            <span className="font-mono text-sm tabular-nums">{formatMoney(line.this_period_cents)}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {isDraft ? (
                            <Input
                              defaultValue={computed.percentComplete ? computed.percentComplete.toFixed(0) : ""}
                              key={`${line.id}-${computed.percentComplete.toFixed(2)}`}
                              onBlur={(event) => {
                                if (event.target.value.trim() !== "") setPercent(line, event.target.value)
                              }}
                              inputMode="decimal"
                              placeholder="%"
                              className="h-7 w-14 border-transparent bg-transparent px-1 text-right font-mono text-xs tabular-nums shadow-none focus-visible:border-input"
                              aria-label={`Line ${line.line_number} percent complete`}
                            />
                          ) : (
                            <span className="font-mono text-xs tabular-nums text-muted-foreground">
                              {computed.percentComplete.toFixed(1)}%
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {isDraft ? (
                            <Input
                              value={entry.stored}
                              onChange={(event) => updateEntry(line, { stored: event.target.value })}
                              inputMode="decimal"
                              placeholder="0.00"
                              className="h-7 border-transparent bg-transparent px-1 text-right font-mono text-sm tabular-nums shadow-none focus-visible:border-input"
                              aria-label={`Line ${line.line_number} stored materials`}
                            />
                          ) : (
                            <span className="font-mono text-sm tabular-nums">
                              {formatMoney(line.stored_materials_cents)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {formatMoney(computed.totalCompletedAndStoredCents)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {formatMoney(computed.balanceToFinishCents)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {formatMoney(computed.retainageCents)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {liveSummary ? (
            <div className="grid gap-x-8 gap-y-1.5 border p-4 text-sm sm:grid-cols-2">
              <SummaryRow label="Contract sum to date" cents={liveSummary.contractSumToDateCents} />
              <SummaryRow label="Total completed & stored" cents={liveSummary.totalCompletedStoredCents} />
              <SummaryRow label="Retainage (to date)" cents={liveSummary.retainageCents} />
              <SummaryRow label="Total earned less retainage" cents={liveSummary.totalEarnedLessRetainageCents} />
              <SummaryRow label="Less previous certificates" cents={liveSummary.previousCertificatesCents} />
              <SummaryRow label="Balance to finish" cents={liveSummary.balanceToFinishCents} />
              <div className="flex items-baseline justify-between border-t pt-2 sm:col-span-2">
                <span className="font-medium">Current payment due</span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  {formatMoneyExact(liveSummary.currentPaymentDueCents)}
                </span>
              </div>
            </div>
          ) : null}

          {app.status !== "draft" && app.status !== "void" ? (
            <label className="flex items-center justify-between gap-4 border bg-muted/20 p-3 text-sm">
              <span>
                <span className="block font-medium">Attach our bonds, insurance, and licenses</span>
                <span className="block text-xs text-muted-foreground">
                  Full-tier lien waivers are included automatically when required for this project.
                </span>
              </span>
              <Checkbox
                checked={includeGcCompliance}
                onCheckedChange={(checked) => setIncludeGcCompliance(checked === true)}
                aria-label="Attach GC compliance documents"
              />
            </label>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {isDraft ? (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={deleteDraft} disabled={isPending}>
                  Delete draft
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => saveDraft()} disabled={isPending || !dirty}>
                  Save draft
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={submit}
                  disabled={isPending || (hasOverbilling && !allowOverbilling)}
                >
                  Submit & generate invoice
                </Button>
              </>
            ) : null}
            {app.status !== "draft" && app.status !== "void" ? (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={downloadPdf} disabled={isPending}>
                  Download PDF only
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={generatePackage} disabled={isPending}>
                  Generate owner package
                </Button>
              </>
            ) : null}
            {(app.status === "invoiced" || app.status === "submitted") && !app.approved_at ? (
              <Button type="button" variant="outline" size="sm" onClick={markApproved} disabled={isPending}>
                Mark owner-approved
              </Button>
            ) : null}
            {(app.status === "invoiced" || app.status === "submitted" || app.status === "approved") ? (
              <Button type="button" variant="outline" size="sm" onClick={voidApp} disabled={isPending}>
                Void
              </Button>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SummaryRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{formatMoneyExact(cents)}</span>
    </div>
  )
}

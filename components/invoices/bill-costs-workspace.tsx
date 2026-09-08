"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, ChevronDown, Loader2, X } from "lucide-react"

import type { Project } from "@/lib/types"
import type { InvoiceDraft } from "@/lib/services/cost-plus"
import type { ProjectBillingUpNext, UpNextRow } from "@/lib/services/billing-book"
import type { BillingProfile } from "@/lib/financials/billing-profile"
import { listUnbilledCostsAction } from "@/app/(app)/invoices/actions"
import {
  generateInvoiceFromCostsAction,
  generateOwnerBillingPackageAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"

import { ArcInvoiceDocument, type ArcInvoiceDocumentData, type ArcInvoiceLine } from "./arc-invoice-document"
import { formatDateOnly, formatMoneyFromCents } from "./invoice-presentation"
import type { UnbilledCost } from "./unbilled-costs-picker"

/**
 * Billing a period of approved costs, as a workspace rather than a form.
 *
 * Left: every approved, unbilled cost on the job, grouped the way the invoice
 * will be, each with a checkbox — the ready ones already ticked. Right: the
 * invoice those ticks produce, rendered by the same component the customer
 * will receive, re-quoted by the server as the selection changes. The three
 * questions the old six-step wizard asked (fee, GMP cap, backup) are switches
 * under the totals. Creating the draft opens it in the book; nothing is sent.
 */

type GroupBy = "cost_code" | "detail"

const SOURCE_LABEL: Record<string, string> = {
  vendor_bill: "Bill",
  expense: "Expense",
  time_entry: "Time",
  manual: "Adjustment",
  allowance_variance: "Allowance",
}

export function BillCostsWorkspace({
  project,
  profile,
  row,
  periods,
  builderInfo,
  onClose,
  onCreated,
}: {
  project: Project
  profile: BillingProfile
  row: UpNextRow
  periods: ProjectBillingUpNext["periods"]
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  onClose: () => void
  onCreated: (invoiceId: string) => void | Promise<void>
}) {
  const period = row.period ?? null
  const billingPeriod = periods.find((entry) => entry.id === row.billingPeriodId) ?? null
  const [costs, setCosts] = useState<UnbilledCost[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(period?.readyCostIds ?? []))
  const [groupBy, setGroupBy] = useState<GroupBy>("cost_code")
  const [includeFee, setIncludeFee] = useState((period?.feeAvailableCents ?? 0) > 0)
  const [overrideGmp, setOverrideGmp] = useState(false)
  const [withBackup, setWithBackup] = useState(true)
  const [withCompliance, setWithCompliance] = useState(false)
  const [preview, setPreview] = useState<InvoiceDraft | null>(null)
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([])
  const [quoting, setQuoting] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    listUnbilledCostsAction(project.id)
      .then((result) => {
        if (cancelled) return
        const loaded: UnbilledCost[] = unwrapAction(result).costs.map((cost) => ({
          ...cost,
          costCodeId: cost.costCodeId ?? null,
          costCode: cost.costCode ?? null,
          costCodeName: cost.costCodeName ?? null,
        }))
        setCosts(loaded)
        // A row with no ready ids (all open costs) ticks everything.
        if (!period || period.readyCostIds.length === 0) setSelected(new Set(loaded.map((cost) => cost.id)))
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load the costs.")
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // The server prices the selection: markup rules, fee, retainage and the GMP
  // cap all live there, so the preview is the same arithmetic the draft gets.
  const quoteSeq = useRef(0)
  useEffect(() => {
    if (!costs) return
    const ids = Array.from(selected)
    if (ids.length === 0) {
      setPreview(null)
      setPreviewWarnings([])
      return
    }
    const seq = ++quoteSeq.current
    setQuoting(true)
    const handle = window.setTimeout(() => {
      generateInvoiceFromCostsAction({
        projectId: project.id,
        billingPeriodId: row.billingPeriodId ?? null,
        dateRange: { from: "1970-01-01", to: new Date().toISOString().slice(0, 10) },
        billableCostIds: ids,
        groupBy,
        includeAllowanceVariances: false,
        includeEarnedFee: includeFee && (period?.feeAvailableCents ?? 0) > 0,
        overrideGmpCap: overrideGmp,
        dryRun: true,
      })
        .then((result) => {
          if (seq !== quoteSeq.current) return
          const quoted = unwrapAction(result)
          setPreview(quoted.invoicePreview)
          setPreviewWarnings(quoted.warnings.map((warning) => warning.message))
        })
        .catch((error) => {
          if (seq !== quoteSeq.current) return
          setPreview(null)
          setPreviewWarnings([error instanceof Error ? error.message : "Could not price the selection."])
        })
        .finally(() => {
          if (seq === quoteSeq.current) setQuoting(false)
        })
    }, 350)
    return () => window.clearTimeout(handle)
  }, [costs, groupBy, includeFee, overrideGmp, period?.feeAvailableCents, project.id, row.billingPeriodId, selected])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !(event.target as HTMLElement | null)?.closest("[role='listbox'], [data-radix-popper-content-wrapper]")) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const groups = useMemo(() => {
    if (!costs) return []
    const map = new Map<string, { key: string; title: string; subtitle: string | null; costs: UnbilledCost[] }>()
    for (const cost of costs) {
      const key = groupBy === "cost_code" ? cost.costCodeId ?? "uncoded" : "all"
      const entry =
        map.get(key) ??
        {
          key,
          title: groupBy === "cost_code" ? cost.costCode ?? "No cost code" : "All costs",
          subtitle: groupBy === "cost_code" ? cost.costCodeName ?? null : null,
          costs: [],
        }
      entry.costs.push(cost)
      map.set(key, entry)
    }
    return Array.from(map.values()).sort((left, right) => left.title.localeCompare(right.title))
  }, [costs, groupBy])

  const selectedCosts = useMemo(() => (costs ?? []).filter((cost) => selected.has(cost.id)), [costs, selected])
  const selectedTotals = useMemo(
    () =>
      selectedCosts.reduce(
        (sum, cost) => ({
          cost: sum.cost + cost.costCents,
          markup: sum.markup + cost.markupCents,
          billable: sum.billable + cost.billableCents,
        }),
        { cost: 0, markup: 0, billable: 0 },
      ),
    [selectedCosts],
  )

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  const toggleGroup = (ids: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const gmpBlocked = Boolean(period?.gmp?.overrunRisk) && !overrideGmp && previewWarnings.some((warning) => /GMP/i.test(warning))
  const canCreate = selected.size > 0 && !quoting && !creating && !gmpBlocked && Boolean(preview)

  async function create() {
    if (!canCreate) return
    setCreating(true)
    try {
      const result = unwrapAction(
        await generateInvoiceFromCostsAction({
          projectId: project.id,
          billingPeriodId: row.billingPeriodId ?? null,
          dateRange: { from: "1970-01-01", to: new Date().toISOString().slice(0, 10) },
          billableCostIds: Array.from(selected),
          groupBy,
          includeAllowanceVariances: false,
          includeEarnedFee: includeFee && (period?.feeAvailableCents ?? 0) > 0,
          overrideGmpCap: overrideGmp,
          dryRun: false,
          idempotencyKey: crypto.randomUUID(),
        }),
      )
      const invoiceId = result.invoiceId ?? null
      if (!invoiceId) throw new Error("Nothing was billed — no billable costs were found in the selection.")
      if (withBackup) {
        try {
          unwrapAction(await generateOwnerBillingPackageAction({ projectId: project.id, invoiceId, includeGcCompliance: withCompliance }))
        } catch (error) {
          toast.error("Invoice created, but the backup package failed", {
            description: error instanceof Error ? error.message : "Generate it from the invoice's menu.",
          })
        }
      }
      toast.success("Draft invoice created", { description: "Review it, then send it." })
      await onCreated(invoiceId)
    } catch (error) {
      toast.error("Could not bill these costs", {
        description: error instanceof Error ? error.message : "Try again.",
      })
    } finally {
      setCreating(false)
    }
  }

  const documentData = useMemo<{ data: ArcInvoiceDocumentData; lines: ArcInvoiceLine[] } | null>(() => {
    if (!preview) return null
    const lines: ArcInvoiceLine[] = preview.lines.map((line) => ({
      description: line.description,
      quantity: 1,
      unit: line.unit ?? "LS",
      unitCostCents: line.billable_cents,
      lineTotalCents: line.billable_cents,
    }))
    const retainage = preview.totals.retainage_cents ?? 0
    if (retainage > 0) {
      lines.push({ description: "Retainage held", quantity: 1, unit: "retainage", unitCostCents: -retainage, lineTotalCents: -retainage })
    }
    const total = (preview.totals.gross_billable_cents ?? preview.totals.billable_cents) - retainage
    return {
      data: {
        invoiceNumber: "—",
        projectName: preview.title || project.name,
        logoUrl: null,
        issueDate: preview.issueDate,
        dueDate: preview.dueDate,
        fromLines: [builderInfo?.name ?? "", builderInfo?.email ?? "", builderInfo?.address ?? ""],
        billToLines: [project.name],
        notes: null,
        payUrl: null,
        paymentMethods: null,
        subtotalCents: preview.totals.gross_billable_cents ?? preview.totals.billable_cents,
        taxCents: 0,
        totalCents: total,
        amountDueCents: total,
        taxRate: null,
        discountCents: null,
        discountPercent: null,
      },
      lines,
    }
  }, [builderInfo, preview, project.name])

  const title = billingPeriod ? `Bill ${billingPeriod.name}` : "Bill approved costs"

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background animate-in fade-in duration-150 motion-reduce:animate-none"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight">{title}</h1>
            <p className="truncate text-[11px] text-muted-foreground">
              {project.name}
              {billingPeriod ? ` · ${formatDateOnly(billingPeriod.period_start)} – ${formatDateOnly(billingPeriod.period_end, { withYear: true })}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:block">
            {quoting ? "Pricing…" : selected.size > 0 ? `${selected.size} of ${costs?.length ?? 0} costs` : "Nothing selected"}
          </span>
          <Button size="sm" className="h-8" disabled={!canCreate} onClick={() => void create()}>
            {creating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Create draft invoice
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Costs */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 sm:px-6">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Group the invoice by</span>
              <div className="flex border">
                {(["cost_code", "detail"] as GroupBy[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setGroupBy(mode)}
                    className={cn("h-7 px-2.5 transition-colors", groupBy === mode ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}
                  >
                    {mode === "cost_code" ? "Cost code" : "Each cost"}
                  </button>
                ))}
              </div>
            </div>
            {costs && costs.length > 0 ? (
              <div className="flex items-center gap-3 text-xs">
                <button type="button" className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => setSelected(new Set(costs.map((cost) => cost.id)))}>
                  Select all
                </button>
                {period && period.readyCostIds.length > 0 ? (
                  <button type="button" className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => setSelected(new Set(period.readyCostIds))}>
                    Only ready
                  </button>
                ) : null}
                <button type="button" className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => setSelected(new Set())}>
                  None
                </button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadError ? (
              <p className="m-4 border border-destructive/30 bg-destructive/10 p-4 text-sm">{loadError}</p>
            ) : !costs ? (
              <div className="space-y-2 p-4 sm:p-6">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={index} className="h-10 w-full" />
                ))}
              </div>
            ) : costs.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <p className="text-sm font-medium">Nothing approved to bill</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Costs land here once they clear Cost Inbox.</p>
              </div>
            ) : (
              groups.map((group) => {
                const ids = group.costs.map((cost) => cost.id)
                const checkedCount = ids.filter((id) => selected.has(id)).length
                const subtotal = group.costs.filter((cost) => selected.has(cost.id)).reduce((sum, cost) => sum + cost.billableCents, 0)
                return (
                  <section key={group.key} className="animate-in fade-in duration-200 motion-reduce:animate-none">
                    <div className="sticky top-0 z-10 flex items-center gap-3 border-y bg-muted px-4 py-2 sm:px-6">
                      <Checkbox
                        checked={checkedCount === ids.length ? true : checkedCount > 0 ? "indeterminate" : false}
                        onCheckedChange={(checked) => toggleGroup(ids, checked === true)}
                        aria-label={`Select every cost in ${group.title}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider">
                        {group.title}
                        {group.subtitle ? <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">{group.subtitle}</span> : null}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {checkedCount}/{ids.length}
                      </span>
                      <span className="w-28 text-right font-mono text-xs tabular-nums">{formatMoneyFromCents(subtotal)}</span>
                    </div>
                    {group.costs.map((cost) => {
                      const checked = selected.has(cost.id)
                      const ready = period ? period.readyCostIds.includes(cost.id) : true
                      return (
                        <label
                          key={cost.id}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 border-b px-4 py-2 text-sm transition-colors hover:bg-muted/40 sm:px-6",
                            checked && "bg-primary/[0.04]",
                          )}
                        >
                          <Checkbox checked={checked} onCheckedChange={(next) => toggle(cost.id, next === true)} aria-label={`Bill ${cost.description}`} />
                          <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDateOnly(cost.occurredOn)}</span>
                          <span className="min-w-0 flex-1 truncate">
                            {cost.description || "Untitled cost"}
                            <span className="ml-2 text-xs text-muted-foreground">{SOURCE_LABEL[cost.sourceType] ?? cost.sourceType}</span>
                            {!ready ? <span className="ml-2 text-[11px] text-warning">not in this period</span> : null}
                          </span>
                          <span className="hidden w-24 text-right font-mono text-xs tabular-nums text-muted-foreground sm:block">{formatMoneyFromCents(cost.costCents)}</span>
                          <span className="hidden w-16 text-right text-xs tabular-nums text-muted-foreground md:block">
                            {cost.markupPercent ? `+${cost.markupPercent}%` : "—"}
                          </span>
                          <span className="w-28 text-right font-mono text-sm tabular-nums">{formatMoneyFromCents(cost.billableCents)}</span>
                        </label>
                      )
                    })}
                  </section>
                )
              })
            )}
          </div>

          {/* Totals and the three decisions */}
          <div className="shrink-0 border-t bg-background px-4 py-3 sm:px-6">
            {previewWarnings.length > 0 ? (
              <ul className="mb-3 space-y-1">
                {previewWarnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-2 text-xs text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
              <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Cost</dt>
                <dd className="text-right font-mono tabular-nums">{formatMoneyFromCents(selectedTotals.cost)}</dd>
                <dt className="text-muted-foreground">Markup</dt>
                <dd className="text-right font-mono tabular-nums">{formatMoneyFromCents(selectedTotals.markup)}</dd>
                {includeFee && (period?.feeAvailableCents ?? 0) > 0 ? (
                  <>
                    <dt className="text-muted-foreground">Earned fee</dt>
                    <dd className="text-right font-mono tabular-nums">{formatMoneyFromCents(preview?.totals.earned_fee_cents ?? period?.feeAvailableCents ?? 0)}</dd>
                  </>
                ) : null}
                {(preview?.totals.retainage_cents ?? 0) > 0 ? (
                  <>
                    <dt className="text-warning">Retainage held</dt>
                    <dd className="text-right font-mono tabular-nums text-warning">−{formatMoneyFromCents(preview?.totals.retainage_cents ?? 0)}</dd>
                  </>
                ) : null}
                <dt className="border-t pt-1 font-semibold">Invoice total</dt>
                <dd className="border-t pt-1 text-right font-mono font-semibold tabular-nums">
                  {formatMoneyFromCents(documentData?.data.totalCents ?? selectedTotals.billable)}
                </dd>
              </dl>
              <div className="space-y-2 text-sm">
                {(period?.feeAvailableCents ?? 0) > 0 ? (
                  <label className="flex items-center justify-between gap-4">
                    <span>
                      Include earned fee
                      <span className="block text-xs text-muted-foreground">{formatMoneyFromCents(period?.feeAvailableCents ?? 0)} earned and unbilled</span>
                    </span>
                    <Switch checked={includeFee} onCheckedChange={setIncludeFee} />
                  </label>
                ) : null}
                {period?.gmp?.overrunRisk ? (
                  <label className="flex items-center justify-between gap-4">
                    <span>
                      Bill past the revised GMP
                      <span className="block text-xs text-muted-foreground">GMP status: {period.gmp.status.replaceAll("_", " ")}</span>
                    </span>
                    <Switch checked={overrideGmp} onCheckedChange={setOverrideGmp} />
                  </label>
                ) : null}
                <label className="flex items-center justify-between gap-4">
                  <span>
                    Generate the backup package
                    <span className="block text-xs text-muted-foreground">Receipts and proofs for every cost</span>
                  </span>
                  <Switch checked={withBackup} onCheckedChange={setWithBackup} />
                </label>
                {withBackup ? (
                  <label className="flex items-center justify-between gap-4 animate-in fade-in duration-150 motion-reduce:animate-none">
                    <span>Attach our bonds, insurance and licenses</span>
                    <Switch checked={withCompliance} onCheckedChange={setWithCompliance} />
                  </label>
                ) : null}
                {profile.approvalRequired ? (
                  <p className="text-[11px] text-muted-foreground">{profile.customerLabel} billing on this job needs approval before it can be sent.</p>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* The invoice these ticks produce */}
        <aside className="hidden min-h-0 w-[42%] max-w-[820px] shrink-0 flex-col border-l bg-muted/40 lg:flex">
          <div className="relative min-h-0 flex-1 overflow-y-auto p-6">
            {documentData ? (
              <div className={cn("transition-opacity duration-200", quoting && "opacity-60")}>
                <DocumentPreview data={documentData.data} lines={documentData.lines} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-center">
                <p className="max-w-xs text-sm text-muted-foreground">
                  {quoting ? "Pricing the selection…" : "Tick the costs to bill and the invoice appears here."}
                </p>
              </div>
            )}
          </div>
          <div className="shrink-0 border-t px-5 py-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  About this preview
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuItem disabled className="whitespace-normal text-xs opacity-100">
                  The number, customer and payment details are filled in when the draft is created, from the project's contract and your invoice defaults.
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </aside>
      </div>
    </div>
  )
}

function DocumentPreview({ data, lines }: { data: ArcInvoiceDocumentData; lines: ArcInvoiceLine[] }) {
  const PAGE_WIDTH = 816
  const PAGE_HEIGHT = 1056
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.7)
  useLayoutEffect(() => {
    const element = frameRef.current
    if (!element) return
    const update = () => setScale(Math.min(1, Math.max(0.3, element.clientWidth / PAGE_WIDTH)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={frameRef} className="mx-auto w-full max-w-[816px]">
      <div className="relative shadow-md" style={{ width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale }}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${scale})` }}>
          <ArcInvoiceDocument data={data} lines={lines} width={PAGE_WIDTH} height={PAGE_HEIGHT} />
        </div>
      </div>
    </div>
  )
}

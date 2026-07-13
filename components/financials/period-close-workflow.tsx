"use client"

import Link from "next/link"
import { useMemo, useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowRight, CheckCircle2, FileArchive, FileText, Lock, PackageCheck } from "lucide-react"
import { toast } from "sonner"

import {
  closeProjectBillingPeriodAction,
  generateInvoiceFromCostsAction,
  generateOwnerBillingPackageAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ProjectBillingModel } from "@/lib/financials/billing-model"
import type { ProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import type { ProjectGmpControlSummary } from "@/lib/services/gmp-control"
import type { BillingAutopilotState } from "@/lib/services/billing-autopilot"
import type { ProjectBillingPeriod } from "@/lib/services/billing-periods"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

interface PeriodCloseWorkflowProps {
  projectId: string
  billingModel: ProjectBillingModel
  periods: ProjectBillingPeriod[]
  selectedPeriod: ProjectBillingPeriod | null
  summary: {
    reviewItemCount: number
    blockedItemCount: number
    readyCostIds: string[]
    readyCostCount: number
    readyCostCents: number
    lateCostCount: number
    lateCostCents: number
    oldestReadyCostDays: number
  }
  feeSummary?: ProjectFeeBillingSummary | null
  gmpSummary?: ProjectGmpControlSummary | null
  autopilot?: BillingAutopilotState
  loadErrors?: string[]
}

const NO_PERIOD = "__none__"

export function PeriodCloseWorkflow({
  projectId,
  billingModel,
  periods,
  selectedPeriod,
  summary,
  feeSummary = null,
  gmpSummary = null,
  autopilot = { enabled: false, run: null },
  loadErrors = [],
}: PeriodCloseWorkflowProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [includeEarnedFee, setIncludeEarnedFee] = useState(() =>
    Boolean(feeSummary?.enabled && (feeSummary.billable_fee_cents ?? 0) > 0),
  )
  const [overrideGmpCap, setOverrideGmpCap] = useState(false)
  const [includeGcCompliance, setIncludeGcCompliance] = useState(false)
  const selectedPeriodId = selectedPeriod?.id ?? null
  const periodRange = selectedPeriod ? { from: selectedPeriod.period_start, to: selectedPeriod.period_end } : null
  const canGenerate = summary.readyCostIds.length > 0
  const canClose = Boolean(selectedPeriod && selectedPeriod.status !== "closed")
  const autopilotItems = autopilot.run?.items ?? []
  const feeAvailableCents = Math.max(0, Number(feeSummary?.billable_fee_cents ?? 0))

  const gmpTone = useMemo(() => {
    if (!gmpSummary?.enabled) return "default"
    if (gmpSummary.status === "overrun") return "danger"
    if (gmpSummary.status === "watch") return "warning"
    return "success"
  }, [gmpSummary])

  function selectPeriod(periodId: string) {
    if (periodId === NO_PERIOD) {
      router.push(`/projects/${projectId}/financials/receivables?tab=close`)
      return
    }
    router.push(`/projects/${projectId}/financials/receivables?tab=close&period=${periodId}`)
  }

  function generateInvoiceAndBackup() {
    if (!canGenerate) return
    startTransition(async () => {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const result = unwrapAction(await generateInvoiceFromCostsAction({
          projectId,
          billingPeriodId: selectedPeriodId,
          dateRange: periodRange ?? { from: "1970-01-01", to: today },
          billableCostIds: summary.readyCostIds,
          groupBy: "cost_code",
          includeAllowanceVariances: false,
          includeEarnedFee,
          overrideGmpCap,
          dryRun: false,
          idempotencyKey: crypto.randomUUID(),
        }))
        const invoiceId = (result as any).invoiceId as string | undefined
        if (invoiceId) {
          unwrapAction(await generateOwnerBillingPackageAction({ projectId, invoiceId, includeGcCompliance }))
          toast.success("Invoice and backup package created")
          router.push(`/projects/${projectId}/financials/receivables?invoice=${invoiceId}`)
        } else {
          toast.success("Invoice workflow finished")
          router.refresh()
        }
      } catch (error) {
        toast.error("Could not generate invoice", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function closePeriod() {
    if (!selectedPeriodId) return
    startTransition(async () => {
      try {
        unwrapAction(await closeProjectBillingPeriodAction({
          projectId,
          billingPeriodId: selectedPeriodId,
        }))
        toast.success("Billing period closed")
        router.refresh()
      } catch (error) {
        toast.error("Could not close period", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  return (
    <div className="space-y-5 px-4 py-4 sm:px-6 lg:px-8">
      {loadErrors.length > 0 ? (
        <div className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
          {loadErrors.join(" · ")}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border bg-background p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{labelBillingModel(billingModel)}</Badge>
            {selectedPeriod ? (
              <Badge variant="secondary" className="capitalize">
                {selectedPeriod.status}
              </Badge>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Select a billing period, clear review blockers, create the invoice package, then lock the period.
          </p>
        </div>
        <Select value={selectedPeriodId ?? NO_PERIOD} onValueChange={selectPeriod}>
          <SelectTrigger className="w-full bg-background sm:w-[320px]">
            <SelectValue placeholder="Billing period" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PERIOD}>No period selected</SelectItem>
            {periods.map((period) => (
              <SelectItem key={period.id} value={period.id}>
                {period.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          <WorkflowStep
            number={1}
            title="Review queue"
            status={summary.reviewItemCount === 0 ? "done" : summary.blockedItemCount > 0 ? "blocked" : "open"}
            detail={`${summary.reviewItemCount} item${summary.reviewItemCount === 1 ? "" : "s"} still in review · ${summary.blockedItemCount} blocked`}
            href={`/projects/${projectId}/financials/review`}
          />
          <WorkflowStep
            number={2}
            title="Costs ready to bill"
            status={summary.readyCostCount > 0 ? "open" : "done"}
            detail={`${formatMoney(summary.readyCostCents)} across ${summary.readyCostCount} cost${summary.readyCostCount === 1 ? "" : "s"} · oldest ${summary.oldestReadyCostDays || 0} days`}
            href={`/projects/${projectId}/financials/review`}
          />
          <WorkflowStep
            number={3}
            title="Fee to include"
            status={feeAvailableCents > 0 ? "open" : "done"}
            detail={
              feeSummary?.enabled
                ? `${formatMoney(feeAvailableCents)} earned fee available`
                : "No fixed-fee amount is available for this period"
            }
          >
            {feeSummary?.enabled && feeAvailableCents > 0 ? (
              <label className="mt-3 flex items-center justify-between gap-3 border bg-muted/20 p-3 text-sm">
                <span>Include earned fee</span>
                <Checkbox
                  checked={includeEarnedFee}
                  onCheckedChange={(checked) => setIncludeEarnedFee(checked === true)}
                />
              </label>
            ) : null}
          </WorkflowStep>
          <WorkflowStep
            number={4}
            title="GMP cap check"
            status={gmpTone === "danger" ? "blocked" : gmpTone === "warning" ? "open" : "done"}
            detail={
              gmpSummary?.enabled
                ? `${gmpSummary.status.replaceAll("_", " ")} · ${formatMoney(gmpSummary.savings_cents)} forecast savings`
                : "Not a GMP project"
            }
          >
            {gmpSummary?.enabled && gmpTone !== "success" ? (
              <label className="mt-3 flex items-center justify-between gap-3 border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                <span>Allow invoice if this period exceeds the revised GMP</span>
                <Checkbox checked={overrideGmpCap} onCheckedChange={(checked) => setOverrideGmpCap(checked === true)} />
              </label>
            ) : null}
          </WorkflowStep>
          <WorkflowStep
            number={5}
            title="Generate invoice and backup"
            status={canGenerate ? "open" : "blocked"}
            detail={
              canGenerate
                ? `${formatMoney(summary.readyCostCents)} will be grouped by cost code`
                : "No ready costs are available for the selected period"
            }
          >
            <label className="mt-3 flex items-center justify-between gap-3 border bg-muted/20 p-3 text-sm">
              <span>Attach our bonds, insurance, and licenses</span>
              <Checkbox
                checked={includeGcCompliance}
                onCheckedChange={(checked) => setIncludeGcCompliance(checked === true)}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={isPending || !canGenerate} onClick={generateInvoiceAndBackup}>
                <PackageCheck className="h-4 w-4" />
                Generate invoice + backup
              </Button>
              <Button asChild variant="outline">
                <Link href={`/projects/${projectId}/financials/review`}>Adjust selection</Link>
              </Button>
            </div>
          </WorkflowStep>
          <WorkflowStep
            number={6}
            title="Close period"
            status={selectedPeriod?.status === "closed" ? "done" : canClose ? "open" : "blocked"}
            detail={
              selectedPeriod
                ? `Period status is ${selectedPeriod.status}`
                : "Create or select a billing period before closing"
            }
          >
            <Button className="mt-3" variant="outline" disabled={isPending || !canClose} onClick={closePeriod}>
              <Lock className="h-4 w-4" />
              Close period
            </Button>
          </WorkflowStep>
        </div>

        <aside className="space-y-4">
          <div className="border bg-background p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileArchive className="h-4 w-4 text-muted-foreground" />
              Period totals
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <Metric label="Ready costs" value={formatMoney(summary.readyCostCents)} />
              <Metric
                label="Late carried in"
                value={formatMoney(summary.lateCostCents)}
                detail={`${summary.lateCostCount} cost${summary.lateCostCount === 1 ? "" : "s"}`}
              />
              <Metric label="Earned fee" value={formatMoney(feeAvailableCents)} />
            </dl>
          </div>

          <div className="border bg-background p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Autopilot annotations
            </div>
            {autopilotItems.length > 0 ? (
              <div className="mt-3 space-y-2">
                {autopilotItems.slice(0, 5).map((item, index) => (
                  <div key={item.id ?? `${item.item_type}-${index}`} className="border bg-muted/20 p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">{item.title}</span>
                      <Badge variant="outline" className="capitalize">
                        {item.status.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    {item.description ? <p className="mt-1 text-xs text-muted-foreground">{item.description}</p> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No autopilot findings are prepared for this period.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

function WorkflowStep({
  number,
  title,
  status,
  detail,
  href,
  children,
}: {
  number: number
  title: string
  status: "done" | "open" | "blocked"
  detail: string
  href?: string
  children?: ReactNode
}) {
  return (
    <section className="border bg-background p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center border text-sm font-semibold",
              statusTone(status),
            )}
          >
            {status === "done" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : status === "blocked" ? (
              <AlertTriangle className="h-4 w-4" />
            ) : (
              number
            )}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">{title}</h2>
              <Badge variant="outline" className={cn("capitalize", statusTone(status))}>
                {status}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
          </div>
        </div>
        {href ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={href}>
              Open
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">
        <div className="font-semibold tabular-nums">{value}</div>
        {detail ? <div className="text-xs text-muted-foreground">{detail}</div> : null}
      </dd>
    </div>
  )
}

function statusTone(status: "done" | "open" | "blocked") {
  if (status === "done") return "border-success/30 bg-success/10 text-success"
  if (status === "blocked") return "border-destructive/30 bg-destructive/10 text-destructive"
  return "border-amber-500/30 bg-amber-500/10 text-amber-700"
}

function labelBillingModel(value: ProjectBillingModel) {
  return value
    .replace("cost_plus_gmp", "Cost plus GMP")
    .replace("cost_plus_fixed_fee", "Cost plus fixed fee")
    .replace("cost_plus_percent", "Cost plus percent")
    .replace("time_and_materials", "Time and materials")
    .replace("fixed_price", "Fixed price")
}

function formatMoney(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

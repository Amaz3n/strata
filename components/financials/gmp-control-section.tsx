"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { toast } from "sonner"
import { AlertTriangle, Minus, TrendingUp } from "lucide-react"

import { recordGmpContingencyDrawdownAction } from "@/app/(app)/projects/[id]/financials/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ProjectGmpControlSummary, ProjectGmpSnapshotTrendPoint } from "@/lib/services/gmp-control"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

const chartConfig = {
  eac: { label: "Inside-GMP EAC", color: "hsl(var(--chart-1))" },
  gmp: { label: "Revised GMP", color: "hsl(var(--chart-2))" },
  savings: { label: "Savings", color: "hsl(var(--chart-3))" },
} satisfies ChartConfig

function formatMoney(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function formatShortMoney(value?: number | null) {
  const dollars = Number(value ?? 0)
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`
  if (Math.abs(dollars) >= 1_000) return `$${Math.round(dollars / 1_000)}k`
  return `$${Math.round(dollars)}`
}

function moneyToCents(value: string) {
  const amount = Number(value.replace(/[$,\s]/g, ""))
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * 100)
}

function formatDateLabel(value: string) {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function statusTone(status: ProjectGmpControlSummary["status"]) {
  if (status === "overrun") return "border-destructive/30 bg-destructive/10 text-destructive"
  if (status === "watch") return "border-warning/30 bg-warning/10 text-warning"
  if (status === "not_configured") return "border-muted bg-muted/40 text-muted-foreground"
  return "border-success/30 bg-success/10 text-success"
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", tone)}>{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

export function GmpControlSection({
  projectId,
  summary,
  snapshots,
  allowDrawdown = true,
}: {
  projectId: string
  summary: ProjectGmpControlSummary
  snapshots: ProjectGmpSnapshotTrendPoint[]
  allowDrawdown?: boolean
}) {
  const router = useRouter()
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()

  const burnPercent = summary.revised_gmp_cents > 0 ? (summary.inside_gmp_eac_cents / summary.revised_gmp_cents) * 100 : 0
  const chartData = useMemo(
    () =>
      snapshots.map((point) => ({
        label: formatDateLabel(point.snapshot_date),
        eac: point.inside_gmp_eac_cents / 100,
        gmp: point.revised_gmp_cents / 100,
        savings: point.savings_cents / 100,
      })),
    [snapshots],
  )
  const drawdownCents = moneyToCents(amount)
  const canDrawDown =
    allowDrawdown &&
    drawdownCents != null &&
    drawdownCents > 0 &&
    drawdownCents <= Math.max(0, summary.contingency_remaining_cents) &&
    reason.trim().length >= 3

  function handleDrawdown() {
    if (!canDrawDown || drawdownCents == null) return
    startTransition(async () => {
      try {
        unwrapAction(await recordGmpContingencyDrawdownAction({
          projectId,
          amountCents: drawdownCents,
          reason: reason.trim(),
        }))
        setAmount("")
        setReason("")
        toast.success("Contingency drawdown recorded")
        router.refresh()
      } catch (error) {
        toast.error("Unable to record drawdown", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  return (
    <section className="space-y-4">
      <div className="border bg-background">
        <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={cn("text-[10px] uppercase", statusTone(summary.status))}>
                {summary.status.replaceAll("_", " ")}
              </Badge>
              <span className="text-xs text-muted-foreground">GMP control</span>
            </div>
            <h2 className="mt-2 text-xl font-semibold tracking-tight">Guaranteed maximum price</h2>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Metric label="Revised GMP" value={formatMoney(summary.revised_gmp_cents)} />
            <Metric label="Inside EAC" value={formatMoney(summary.inside_gmp_eac_cents)} tone={summary.overrun_cents > 0 ? "text-destructive" : undefined} />
            <Metric label="Outside GMP" value={formatMoney(summary.outside_gmp_eac_cents)} />
            <Metric
              label={summary.overrun_cents > 0 ? "Overrun" : "Savings"}
              value={formatMoney(summary.overrun_cents > 0 ? summary.overrun_cents : summary.savings_cents)}
              tone={summary.overrun_cents > 0 ? "text-destructive" : "text-success"}
            />
          </div>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">Burn against revised GMP</span>
                <span className="tabular-nums text-muted-foreground">{Math.round(burnPercent)}%</span>
              </div>
              <div className="mt-2 h-3 overflow-hidden rounded-sm bg-muted">
                <div
                  className={cn(
                    "h-full transition-all",
                    summary.overrun_cents > 0 ? "bg-destructive" : burnPercent >= 90 ? "bg-warning" : "bg-success",
                  )}
                  style={{ width: `${clampPercent(burnPercent)}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Actual inside GMP {formatMoney(summary.inside_gmp_actual_cents)}</span>
                <span>Base GMP {formatMoney(summary.base_gmp_cents)}</span>
                <span>Approved GMP changes {formatMoney(summary.approved_gmp_change_cents)}</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Contingency" value={formatMoney(summary.contingency_cents)} />
              <Metric label="Drawn down" value={formatMoney(summary.contingency_drawdown_cents)} />
              <Metric
                label="Remaining"
                value={formatMoney(summary.contingency_remaining_cents)}
                tone={summary.contingency_remaining_cents < 0 ? "text-destructive" : undefined}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Forecast savings" value={formatMoney(summary.savings_cents)} />
              <Metric label="Owner share" value={formatMoney(summary.owner_savings_cents)} />
              <Metric label="Builder share" value={formatMoney(summary.builder_savings_cents)} />
            </div>
          </div>

          <div className="space-y-4">
            <div className="border p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Trend</p>
                </div>
                <span className="text-xs text-muted-foreground">{chartData.length} snapshots</span>
              </div>
              {chartData.length > 1 ? (
                <ChartContainer config={chartConfig} className="h-[180px] aspect-auto">
                  <LineChart data={chartData} margin={{ left: 4, right: 8, top: 10, bottom: 0 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
                    <YAxis tickLine={false} axisLine={false} width={44} fontSize={10} tickFormatter={formatShortMoney} />
                    <ReferenceLine y={summary.revised_gmp_cents / 100} stroke="var(--color-gmp)" strokeDasharray="4 4" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line dataKey="eac" type="monotone" stroke="var(--color-eac)" strokeWidth={2} dot={false} />
                    <Line dataKey="savings" type="monotone" stroke="var(--color-savings)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ChartContainer>
              ) : (
                <div className="flex h-[180px] items-center justify-center border border-dashed text-sm text-muted-foreground">
                  Snapshot history will appear after daily GMP snapshots are recorded.
                </div>
              )}
            </div>

            {allowDrawdown ? (
              <div className="border p-3">
                <div className="flex items-center gap-2">
                  <Minus className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Record contingency drawdown</p>
                </div>
                <div className="mt-3 grid gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="gmp-drawdown-amount">Amount</Label>
                    <Input
                      id="gmp-drawdown-amount"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="gmp-drawdown-reason">Reason</Label>
                    <Textarea
                      id="gmp-drawdown-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      className="min-h-20"
                    />
                  </div>
                  <Button type="button" onClick={handleDrawdown} disabled={!canDrawDown || isPending}>
                    Record drawdown
                  </Button>
                  {drawdownCents != null && drawdownCents > summary.contingency_remaining_cents ? (
                    <p className="flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Drawdown cannot exceed remaining contingency.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {summary.warnings.length > 0 ? (
          <div className="border-t bg-muted/20 px-4 py-3">
            <div className="flex flex-wrap gap-2">
              {summary.warnings.map((warning) => (
                <Badge key={warning.code} variant="outline" className="rounded-sm">
                  {warning.message}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

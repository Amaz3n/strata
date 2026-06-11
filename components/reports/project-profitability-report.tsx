"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, FileText, Loader2, TrendingDown, TrendingUp } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type {
  ProfitabilityBasis,
  ProfitabilityGroupBy,
  ProfitabilitySection,
  ProjectProfitabilityReport,
} from "@/lib/services/reports/project-profitability"

type DatePreset = "all" | "ytd" | "last12" | "mtd" | "lastyear"

const PRESET_LABELS: Record<DatePreset, string> = {
  all: "All dates",
  ytd: "Year to date",
  last12: "Last 12 months",
  mtd: "This month",
  lastyear: "Last calendar year",
}

function presetRange(preset: DatePreset): { from: string | null; to: string | null } {
  const now = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const today = iso(now)
  switch (preset) {
    case "ytd":
      return { from: `${now.getUTCFullYear()}-01-01`, to: today }
    case "last12": {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
      return { from: iso(start), to: today }
    }
    case "mtd":
      return { from: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`, to: today }
    case "lastyear": {
      const y = now.getUTCFullYear() - 1
      return { from: `${y}-01-01`, to: `${y}-12-31` }
    }
    default:
      return { from: null, to: null }
  }
}

function formatCurrency(cents: number, opts?: { signed?: boolean }) {
  const value = cents / 100
  const formatted = value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
  if (opts?.signed && cents > 0) return `+${formatted}`
  return formatted
}


export function ProjectProfitabilityReportView({
  projectId,
  initialReport,
}: {
  projectId: string
  initialReport: ProjectProfitabilityReport
}) {
  const [basis, setBasis] = useState<ProfitabilityBasis>(initialReport.basis)
  const [preset, setPreset] = useState<DatePreset>("all")
  const [groupBy, setGroupBy] = useState<ProfitabilityGroupBy>(initialReport.group_by)
  const [report, setReport] = useState<ProjectProfitabilityReport>(initialReport)
  const [loading, setLoading] = useState(false)

  const range = useMemo(() => presetRange(preset), [preset])

  const queryString = useCallback(
    (format?: string) => {
      const params = new URLSearchParams()
      params.set("basis", basis)
      params.set("groupBy", groupBy)
      if (range.from) params.set("from", range.from)
      if (range.to) params.set("to", range.to)
      if (format) params.set("format", format)
      return params.toString()
    },
    [basis, groupBy, range.from, range.to],
  )

  useEffect(() => {
    // Skip refetch when still on the initial view.
    if (basis === initialReport.basis && preset === "all" && groupBy === initialReport.group_by) {
      setReport(initialReport)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/projects/${projectId}/reports/profitability?${queryString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && !data.error) setReport(data)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [basis, preset, groupBy, projectId, queryString, initialReport])

  const margin = report.net_margin_percent
  const marginPositive = report.net_profit_cents >= 0

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABELS) as DatePreset[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {PRESET_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            value={basis}
            onValueChange={(v) => v && setBasis(v as ProfitabilityBasis)}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="accrual" className="px-3 text-xs">
              Accrual
            </ToggleGroupItem>
            <ToggleGroupItem value="cash" className="px-3 text-xs">
              Cash
            </ToggleGroupItem>
          </ToggleGroup>
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as ProfitabilityGroupBy)}>
            <SelectTrigger className="h-9 w-[168px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="category">Group by cost code</SelectItem>
              <SelectItem value="account">Group by QBO account</SelectItem>
            </SelectContent>
          </Select>
          {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/projects/${projectId}/reports/profitability?${queryString("csv")}`}>
              <Download className="size-4" />
              CSV
            </a>
          </Button>
          <Button size="sm" asChild>
            <a href={`/api/projects/${projectId}/reports/profitability?${queryString("pdf")}`}>
              <FileText className="size-4" />
              Export PDF
            </a>
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Net profit"
          value={formatCurrency(report.net_profit_cents)}
          sub={`${margin}% margin`}
          accent={marginPositive ? "positive" : "negative"}
          icon={marginPositive ? TrendingUp : TrendingDown}
        />
        <KpiCard
          label="Income"
          value={formatCurrency(report.total_income_cents)}
          sub={report.percent_billed != null ? `${report.percent_billed}% of contract billed` : "Billed revenue"}
        />
        <KpiCard
          label="Cost of work"
          value={formatCurrency(report.total_cost_cents)}
          sub={report.percent_budget_spent != null ? `${report.percent_budget_spent}% of budget spent` : "Job-cost actuals"}
        />
        <KpiCard
          label="Margin vs. plan"
          value={report.budgeted_margin_percent != null ? `${margin}% / ${report.budgeted_margin_percent}%` : `${margin}%`}
          sub={report.budgeted_margin_percent != null ? "actual / budgeted" : "actual margin"}
        />
      </div>

      {/* Statement */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-baseline justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{report.project_name}</h2>
            <p className="text-xs text-muted-foreground">
              Project profitability · {basis === "cash" ? "Cash basis" : "Accrual basis"} ·{" "}
              {report.from || report.to ? PRESET_LABELS[preset] : "All dates"} ·{" "}
              {report.group_by === "account" ? "by QBO account" : "by cost code"}
            </p>
          </div>
          {report.org_name ? <span className="text-xs text-muted-foreground">{report.org_name}</span> : null}
        </div>

        <div className="divide-y">
          <IncomeBlock section={report.income} />
          <CostBlock section={report.cost_of_work} />

          <ResultRow label="Gross profit" amountCents={report.gross_profit_cents} marginPercent={report.gross_margin_percent} />
          <ResultRow
            label="Net profit"
            amountCents={report.net_profit_cents}
            marginPercent={report.net_margin_percent}
            emphasized
          />
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Income reflects {basis === "cash" ? "payments received" : "issued invoices"}. Cost of work reflects posted job-cost
        actuals (vendor bills, expenses, and labor)
        {report.group_by === "account"
          ? " grouped by the QuickBooks expense account on each bill or expense. Budget variance isn't shown in this view — switch to cost-code grouping to compare against budget."
          : " grouped by cost-code category; costs without a cost code fall back to their QuickBooks expense account. Budget and variance columns use the project's current adjusted budget."}
      </p>
    </div>
  )
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  icon: Icon,
}: {
  label: string
  value: string
  sub?: string
  accent?: "positive" | "negative"
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <Card className="gap-1 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        {Icon ? (
          <Icon
            className={cn(
              "size-4",
              accent === "positive" && "text-emerald-600",
              accent === "negative" && "text-red-600",
              !accent && "text-muted-foreground",
            )}
          />
        ) : null}
      </div>
      <span
        className={cn(
          "text-xl font-semibold tabular-nums",
          accent === "positive" && "text-emerald-600",
          accent === "negative" && "text-red-600",
        )}
      >
        {value}
      </span>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </Card>
  )
}

function IncomeBlock({ section }: { section: ProfitabilitySection }) {
  return (
    <div className="px-5 py-3">
      <div className="mb-1 text-sm font-semibold">{section.label}</div>
      {section.lines.length === 0 ? (
        <LineRow label="No billings in this period" amountCents={0} muted />
      ) : (
        section.lines.map((line) => (
          <LineRow
            key={line.key}
            label={line.label}
            amountCents={line.amount_cents}
            pct={line.pct_of_income}
          />
        ))
      )}
      <TotalRow label="Total income" amountCents={section.total_cents} />
    </div>
  )
}

function CostBlock({ section }: { section: ProfitabilitySection }) {
  const hasBudget = section.budget_total_cents != null
  return (
    <div className="px-5 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-semibold">{section.label}</span>
        {hasBudget ? (
          <div className="hidden gap-6 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:flex">
            <span className="w-24 text-right">Budget</span>
            <span className="w-24 text-right">Variance</span>
            <span className="w-28 text-right">Actual</span>
          </div>
        ) : null}
      </div>
      {section.lines.length === 0 ? (
        <LineRow label="No costs in this period" amountCents={0} muted />
      ) : (
        section.lines.map((line) => (
          <div key={line.key} className="flex items-center justify-between py-1 text-sm">
            <span className="flex-1 truncate text-muted-foreground">{line.label}</span>
            {hasBudget ? (
              <div className="hidden items-center gap-6 sm:flex">
                <span className="w-24 text-right tabular-nums text-muted-foreground">
                  {line.budget_cents != null ? formatCurrency(line.budget_cents) : "—"}
                </span>
                <span
                  className={cn(
                    "w-24 text-right tabular-nums",
                    line.variance_cents == null
                      ? "text-muted-foreground"
                      : line.variance_cents >= 0
                        ? "text-emerald-600"
                        : "text-red-600",
                  )}
                >
                  {line.variance_cents != null ? formatCurrency(line.variance_cents, { signed: true }) : "—"}
                </span>
                <span className="w-28 text-right font-medium tabular-nums">{formatCurrency(line.amount_cents)}</span>
              </div>
            ) : (
              <span className="text-right font-medium tabular-nums">{formatCurrency(line.amount_cents)}</span>
            )}
          </div>
        ))
      )}
      <div className="mt-1 flex items-center justify-between border-t pt-2 text-sm font-semibold">
        <span className="flex-1">Total cost of work</span>
        {hasBudget ? (
          <div className="hidden items-center gap-6 sm:flex">
            <span className="w-24 text-right tabular-nums">{formatCurrency(section.budget_total_cents ?? 0)}</span>
            <span
              className={cn(
                "w-24 text-right tabular-nums",
                (section.variance_total_cents ?? 0) >= 0 ? "text-emerald-600" : "text-red-600",
              )}
            >
              {formatCurrency(section.variance_total_cents ?? 0, { signed: true })}
            </span>
            <span className="w-28 text-right tabular-nums">{formatCurrency(section.total_cents)}</span>
          </div>
        ) : (
          <span className="tabular-nums">{formatCurrency(section.total_cents)}</span>
        )}
      </div>
    </div>
  )
}

function LineRow({ label, amountCents, pct, muted }: { label: string; amountCents: number; pct?: number; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className={cn("flex-1 truncate", muted ? "italic text-muted-foreground" : "text-muted-foreground")}>{label}</span>
      <div className="flex items-center gap-3">
        {pct != null && pct > 0 ? (
          <span className="hidden w-12 text-right text-xs tabular-nums text-muted-foreground sm:inline">
            {Math.round(pct * 100)}%
          </span>
        ) : null}
        <span className="text-right font-medium tabular-nums">{formatCurrency(amountCents)}</span>
      </div>
    </div>
  )
}

function TotalRow({ label, amountCents }: { label: string; amountCents: number }) {
  return (
    <div className="mt-1 flex items-center justify-between border-t pt-2 text-sm font-semibold">
      <span>{label}</span>
      <span className="tabular-nums">{formatCurrency(amountCents)}</span>
    </div>
  )
}

function ResultRow({
  label,
  amountCents,
  marginPercent,
  emphasized,
}: {
  label: string
  amountCents: number
  marginPercent: number
  emphasized?: boolean
}) {
  const positive = amountCents >= 0
  return (
    <div className={cn("flex items-center justify-between px-5 py-3", emphasized ? "bg-muted/50" : "bg-muted/20")}>
      <span className={cn("font-semibold", emphasized ? "text-base" : "text-sm")}>
        {label}
        <span className="ml-2 text-xs font-normal text-muted-foreground">{marginPercent}% margin</span>
      </span>
      <span
        className={cn(
          "font-semibold tabular-nums",
          emphasized ? "text-base" : "text-sm",
          positive ? "text-emerald-600" : "text-red-600",
        )}
      >
        {formatCurrency(amountCents)}
      </span>
    </div>
  )
}

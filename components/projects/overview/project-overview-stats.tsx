import { format, parseISO } from "date-fns"
import { ArrowDown, ArrowUp } from "@/components/icons"
import { cn } from "@/lib/utils"

interface ProjectOverviewStatsProps {
  scheduleProgress: number
  timeElapsedPercent: number
  daysRemaining: number
  daysElapsed: number
  daysUntilStart: number
  totalDays: number
  contractTotalCents: number
  approvedChangeOrdersTotalCents: number
  invoicedCents: number
  startDate?: string
  endDate?: string
  totalActualCents?: number
  adjustedBudgetCents?: number
  totalInvoicedCents?: number
  totalExpensesCents?: number
}

type Tone = "neutral" | "success" | "warning" | "destructive"

interface CellStatus {
  tone: Tone
  label: string
  trend?: "up" | "down"
}

function formatMoney(cents: number): string {
  if (!cents || cents <= 0) return "$0"
  const dollars = cents / 100
  if (dollars >= 1_000_000) {
    const m = dollars / 1_000_000
    const formatted = m >= 10 ? m.toFixed(1) : m.toFixed(2)
    return `$${formatted.replace(/\.?0+$/, "")}M`
  }
  if (dollars >= 10_000) {
    return `$${Math.round(dollars / 1_000)}K`
  }
  if (dollars >= 1_000) {
    return `$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  }
  return `$${Math.round(dollars).toLocaleString()}`
}

function formatFullMoney(cents: number): string {
  if (cents === undefined || cents === null) return "$0.00"
  const dollars = cents / 100
  const absoluteDollars = Math.abs(dollars)
  const formatted = absoluteDollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return dollars < 0 ? `-$${formatted}` : `$${formatted}`
}

export function ProjectOverviewStats({
  scheduleProgress,
  timeElapsedPercent,
  daysRemaining,
  daysElapsed,
  daysUntilStart,
  totalDays,
  contractTotalCents,
  approvedChangeOrdersTotalCents,
  invoicedCents,
  startDate,
  endDate,
  totalActualCents,
  adjustedBudgetCents,
  totalInvoicedCents,
  totalExpensesCents,
}: ProjectOverviewStatsProps) {
  // contracts.total_cents is the revised value after approved change orders.
  const totalContractCents = contractTotalCents
  const baseContractCents = Math.max(0, totalContractCents - approvedChangeOrdersTotalCents)
  const hasContract = totalContractCents > 0
  const hasCOs = approvedChangeOrdersTotalCents > 0

  const billedPercent = hasContract
    ? Math.round((invoicedCents / totalContractCents) * 100)
    : 0
  const outstandingCents = Math.max(0, totalContractCents - invoicedCents)

  const notStarted = daysUntilStart > 0
  const variance = scheduleProgress - timeElapsedPercent
  const varianceDays = totalDays > 0 ? Math.round((variance / 100) * totalDays) : 0
  const paceTone: Tone =
    totalDays <= 0 || notStarted
      ? "neutral"
      : varianceDays >= 3
      ? "success"
      : varianceDays <= -3
      ? "destructive"
      : "neutral"
  const scheduleStatus: CellStatus | null =
    totalDays <= 0
      ? null
      : notStarted
      ? { tone: "neutral", label: "Upcoming" }
      : paceTone === "success"
      ? { tone: "success", label: `${Math.abs(varianceDays)}d ahead`, trend: "up" }
      : paceTone === "destructive"
      ? { tone: "destructive", label: `${Math.abs(varianceDays)}d behind`, trend: "down" }
      : { tone: "neutral", label: "On pace" }

  const realizedInvoiced = totalInvoicedCents ?? invoicedCents
  const hasBudget = (adjustedBudgetCents ?? 0) > 0
  const hasActuals = (totalActualCents ?? 0) > 0
  const realizedMarginPercent =
    realizedInvoiced > 0 && hasActuals
      ? Math.round(((realizedInvoiced - (totalActualCents ?? 0)) / realizedInvoiced) * 1000) / 10
      : null
  const plannedMarginPercent =
    hasContract && hasBudget
      ? Math.round(
          ((totalContractCents - (adjustedBudgetCents ?? 0)) / totalContractCents) * 1000
        ) / 10
      : null
  const profitCents =
    realizedInvoiced > 0 && hasActuals ? realizedInvoiced - (totalActualCents ?? 0) : null
  const marginDelta =
    realizedMarginPercent !== null && plannedMarginPercent !== null
      ? Math.round((realizedMarginPercent - plannedMarginPercent) * 10) / 10
      : null
  const marginStatus: CellStatus | null =
    marginDelta === null
      ? null
      : marginDelta >= 0.5
      ? {
          tone: "success",
          label: `${marginDelta > 0 ? "+" : ""}${marginDelta.toFixed(1)} pts`,
          trend: "up",
        }
      : marginDelta <= -0.5
      ? { tone: "destructive", label: `${marginDelta.toFixed(1)} pts`, trend: "down" }
      : { tone: "neutral", label: "On plan" }

  // Billed status: lag vs schedule progress
  const billingLag = scheduleProgress - billedPercent
  const billedStatus: CellStatus | null = !hasContract
    ? null
    : billingLag > 15
    ? { tone: "destructive", label: "Behind" }
    : billingLag > 5
    ? { tone: "warning", label: "Lagging" }
    : null

  // Total expenses: all posted job-cost actuals (approved bills + expenses) on the project.
  const totalExpenses = totalExpensesCents ?? 0
  const hasExpenses = totalExpenses > 0
  const expensesOfContractPercent =
    hasContract && hasExpenses ? Math.round((totalExpenses / totalContractCents) * 100) : null

  // Contract value status: surface CO count if any
  const contractStatus: CellStatus | null = hasCOs
    ? { tone: "neutral", label: `+${formatFullMoney(approvedChangeOrdersTotalCents)} COs` }
    : null

  return (
    <section className="border-b">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
        <Cell
          label="Contract value"
          value={hasContract ? formatFullMoney(totalContractCents) : "—"}
          detail={
            hasContract
              ? hasCOs
                ? `Base ${formatFullMoney(baseContractCents)} · with change orders`
                : "No change orders"
              : "No contract"
          }
          status={contractStatus}
          position={0}
        >
          {hasContract && hasCOs ? (
            <StackedBar
              parts={[
                { value: baseContractCents, tone: "primary" },
                { value: approvedChangeOrdersTotalCents, tone: "accent" },
              ]}
              total={totalContractCents}
            />
          ) : (
            <ThinBar width={hasContract ? 100 : 0} tone="primary" />
          )}
        </Cell>

        <Cell
          label="Billed"
          value={hasContract ? formatFullMoney(invoicedCents) : "—"}
          detail={
            hasContract
              ? `${billedPercent}% of ${formatFullMoney(totalContractCents)} · ${formatFullMoney(
                  outstandingCents
                )} outstanding`
              : "No contract to bill against"
          }
          status={billedStatus}
          position={1}
        >
          <BilledBar
            billedPercent={billedPercent}
            scheduleProgress={scheduleProgress}
            hasContract={hasContract}
            tone={billedStatus?.tone ?? "neutral"}
          />
        </Cell>

        <Cell
          label="Schedule"
          value={
            totalDays <= 0
              ? "—"
              : notStarted
              ? `Starts in ${daysUntilStart}d`
              : `Day ${daysElapsed} of ${totalDays}`
          }
          detail={
            totalDays <= 0
              ? "Start and end dates not set"
              : notStarted
              ? startDate
                ? `Begins ${format(parseISO(startDate), "MMM d, yyyy")} · ${totalDays}d planned`
                : `${totalDays}d planned`
              : endDate
              ? `Ends ${format(parseISO(endDate), "MMM d, yyyy")} · ${daysRemaining}d left`
              : `${daysRemaining}d left`
          }
          status={scheduleStatus}
          position={2}
        >
          <PaceBar
            scheduleProgress={scheduleProgress}
            timeElapsedPercent={timeElapsedPercent}
            tone={paceTone}
          />
        </Cell>

        <Cell
          label="Margin"
          value={
            realizedMarginPercent !== null
              ? `${realizedMarginPercent.toFixed(1)}%`
              : "—"
          }
          detail={
            realizedMarginPercent === null
              ? hasContract
                ? "Add costs to track margin"
                : "No contract or budget"
              : profitCents !== null
              ? plannedMarginPercent !== null
                ? `${formatMoney(profitCents)} profit · ${plannedMarginPercent.toFixed(
                    1
                  )}% planned`
                : `${formatMoney(profitCents)} profit so far`
              : ""
          }
          status={marginStatus}
          position={3}
        >
          <MarginBar
            realized={realizedMarginPercent}
            planned={plannedMarginPercent}
            tone={marginStatus?.tone ?? "neutral"}
          />
        </Cell>

        <Cell
          label="Total expenses"
          value={hasExpenses ? formatFullMoney(totalExpenses) : "—"}
          detail={
            hasExpenses
              ? expensesOfContractPercent !== null
                ? `${expensesOfContractPercent}% of contract value`
                : "Costs recorded to date"
              : "No costs recorded yet"
          }
          position={4}
        >
          <ThinBar
            width={expensesOfContractPercent ?? (hasExpenses ? 100 : 0)}
            tone={hasExpenses ? "primary" : "muted"}
          />
        </Cell>
      </div>
    </section>
  )
}

const cellBorders: Record<number, string> = {
  0: "border-b sm:border-r lg:border-b-0 lg:border-r",
  1: "border-b lg:border-b-0 lg:border-r",
  2: "border-b sm:border-r lg:border-b-0 lg:border-r",
  3: "border-b lg:border-b-0 lg:border-r",
  4: "",
}

const cellTints: Record<Tone, string> = {
  neutral: "",
  success: "bg-gradient-to-br from-success/[0.06] via-success/[0.02] to-transparent",
  warning: "bg-gradient-to-br from-warning/[0.07] via-warning/[0.02] to-transparent",
  destructive: "bg-gradient-to-br from-destructive/[0.06] via-destructive/[0.02] to-transparent",
}

interface CellProps {
  label: string
  value: string
  detail: string
  position: number
  status?: CellStatus | null
  children: React.ReactNode
}

function Cell({ label, value, detail, position, status, children }: CellProps) {
  const tint = status?.tone === "neutral" ? "" : cellTints[status?.tone ?? "neutral"]
  return (
    <div
      className={cn(
        "px-6 py-7 sm:px-8 sm:py-8 flex flex-col gap-4 relative",
        cellBorders[position],
        tint
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
          {label}
        </div>
        {status && <StatusPill status={status} />}
      </div>
      <div className="text-[28px] sm:text-[32px] leading-none font-semibold tracking-tight tabular-nums text-foreground truncate">
        {value}
      </div>
      <div>{children}</div>
      <div className="text-xs text-muted-foreground truncate">{detail}</div>
    </div>
  )
}

const pillStyles: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
}

function StatusPill({ status }: { status: CellStatus }) {
  const Icon = status.trend === "up" ? ArrowUp : status.trend === "down" ? ArrowDown : null
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] tabular-nums rounded-sm",
        pillStyles[status.tone]
      )}
    >
      {status.tone !== "neutral" && !Icon && (
        <span className="h-1 w-1 rounded-full bg-current" />
      )}
      {Icon && <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />}
      {status.label}
    </span>
  )
}

/* ================================================================
 * Micro-visualizations
 * ============================================================== */

function ThinBar({ width, tone }: { width: number; tone: "primary" | "muted" }) {
  return (
    <div className="h-1 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500",
          tone === "primary" ? "bg-foreground" : "bg-muted-foreground/40"
        )}
        style={{ width: `${Math.min(100, Math.max(0, width))}%` }}
      />
    </div>
  )
}

function StackedBar({
  parts,
  total,
}: {
  parts: { value: number; tone: "primary" | "accent" }[]
  total: number
}) {
  if (total <= 0) return <ThinBar width={0} tone="primary" />
  return (
    <div className="flex h-1 w-full overflow-hidden rounded-full bg-muted">
      {parts.map((part, i) => (
        <div
          key={i}
          className={cn(
            "h-full transition-all duration-500",
            part.tone === "primary" && "bg-foreground",
            part.tone === "accent" && "bg-foreground/45"
          )}
          style={{ width: `${(part.value / total) * 100}%` }}
        />
      ))}
    </div>
  )
}

function BilledBar({
  billedPercent,
  scheduleProgress,
  hasContract,
  tone,
}: {
  billedPercent: number
  scheduleProgress: number
  hasContract: boolean
  tone: Tone
}) {
  if (!hasContract) return <ThinBar width={0} tone="primary" />
  const billed = Math.min(100, Math.max(0, billedPercent))
  const marker = Math.min(100, Math.max(0, scheduleProgress))
  return (
    <div className="relative h-1 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          "absolute inset-y-0 left-0 transition-all duration-500",
          tone === "neutral" && "bg-foreground",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "destructive" && "bg-destructive"
        )}
        style={{ width: `${billed}%` }}
      />
      {scheduleProgress > 0 && (
        <div
          aria-hidden
          className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/70"
          style={{ left: `${marker}%` }}
          title={`Schedule: ${scheduleProgress}%`}
        />
      )}
    </div>
  )
}

function PaceBar({
  scheduleProgress,
  timeElapsedPercent,
  tone,
}: {
  scheduleProgress: number
  timeElapsedPercent: number
  tone: Tone
}) {
  const progress = Math.min(100, Math.max(0, scheduleProgress))
  const time = Math.min(100, Math.max(0, timeElapsedPercent))
  return (
    <div className="relative h-1 rounded-full bg-muted overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 bg-muted-foreground/35 transition-all duration-500"
        style={{ width: `${time}%` }}
      />
      <div
        className={cn(
          "absolute inset-y-0 left-0 transition-all duration-500",
          tone === "success" && "bg-success",
          tone === "destructive" && "bg-destructive",
          (tone === "neutral" || tone === "warning") && "bg-foreground"
        )}
        style={{ width: `${progress}%` }}
      />
    </div>
  )
}

function MarginBar({
  realized,
  planned,
  tone,
}: {
  realized: number | null
  planned: number | null
  tone: Tone
}) {
  if (realized === null) return <ThinBar width={0} tone="primary" />
  const scale = 30
  const realizedPct = Math.min(100, Math.max(0, (realized / scale) * 100))
  const plannedPct =
    planned !== null ? Math.min(100, Math.max(0, (planned / scale) * 100)) : null
  return (
    <div className="relative h-1 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          "absolute inset-y-0 left-0 transition-all duration-500",
          tone === "success" && "bg-success",
          tone === "destructive" && "bg-destructive",
          (tone === "neutral" || tone === "warning") && "bg-foreground"
        )}
        style={{ width: `${realizedPct}%` }}
      />
      {plannedPct !== null && (
        <div
          aria-hidden
          className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/70"
          style={{ left: `${plannedPct}%` }}
          title={`Planned: ${planned?.toFixed(1)}%`}
        />
      )}
    </div>
  )
}

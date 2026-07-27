import { format, parseISO } from "date-fns"
import {
  MarkerBar,
  StackedBar,
  StatCell,
  StatStrip,
  ThinBar,
  type CellStatus,
  type Tone,
} from "@/components/overview/primitives"

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

  // Margin is plotted against a 30% ceiling — the scale a builder reads by.
  const marginScale = 30

  return (
    <StatStrip>
      <StatCell
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
      </StatCell>

      <StatCell
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
        {hasContract ? (
          <MarkerBar
            fill={billedPercent}
            tone={billedStatus?.tone ?? "neutral"}
            marker={scheduleProgress > 0 ? scheduleProgress : null}
            markerTitle={`Schedule: ${scheduleProgress}%`}
          />
        ) : (
          <ThinBar width={0} tone="primary" />
        )}
      </StatCell>

      <StatCell
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
        <MarkerBar fill={scheduleProgress} ghost={timeElapsedPercent} tone={paceTone} />
      </StatCell>

      <StatCell
        label="Margin"
        value={
          realizedMarginPercent !== null ? `${realizedMarginPercent.toFixed(1)}%` : "—"
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
        {realizedMarginPercent === null ? (
          <ThinBar width={0} tone="primary" />
        ) : (
          <MarkerBar
            fill={(realizedMarginPercent / marginScale) * 100}
            tone={marginStatus?.tone ?? "neutral"}
            marker={
              plannedMarginPercent !== null
                ? (plannedMarginPercent / marginScale) * 100
                : null
            }
            markerTitle={
              plannedMarginPercent !== null
                ? `Planned: ${plannedMarginPercent.toFixed(1)}%`
                : undefined
            }
          />
        )}
      </StatCell>

      <StatCell
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
      </StatCell>
    </StatStrip>
  )
}

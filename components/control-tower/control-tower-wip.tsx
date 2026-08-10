import Link from "next/link"

import type { ControlTowerWipBand } from "@/lib/services/dashboard"
import { cn } from "@/lib/utils"

const MONEY_FORMAT: Intl.NumberFormatOptions = {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", MONEY_FORMAT).format(Math.abs(cents) / 100)
}

function formatAsOf(asOf: string) {
  const [year, month, day] = asOf.split("-").map(Number)
  if (!year || !month || !day) return asOf
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

/**
 * The portfolio's billing position against work earned.
 *
 * Under-billing leads because it is the half someone can act on today: earned
 * work nobody invoiced is cash sitting on a jobsite. Over-billing is reported
 * beside it because it is borrowed cash, not profit, and a builder reading only
 * the net would miss both.
 */
export function ControlTowerWip({ band }: { band: ControlTowerWipBand }) {
  if (band.projectCount === 0) {
    return (
      <section className="border-b px-6 py-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Over / under billing</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No WIP snapshots yet. Positions appear once a project has a budget and a contract value.
        </p>
      </section>
    )
  }

  const net = band.netOverUnderCents

  return (
    <section className="border-b px-6 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Over / under billing</h2>
        <span className="text-xs text-muted-foreground">
          {band.projectCount} active {band.projectCount === 1 ? "job" : "jobs"}
          {band.asOf ? ` · as of ${formatAsOf(band.asOf)}` : null}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Net position</div>
          <div
            className={cn(
              "text-2xl font-semibold tabular-nums",
              net > 0 ? "text-success" : net < 0 ? "text-warning" : "",
            )}
          >
            {net === 0 ? formatMoney(0) : `${net > 0 ? "+" : "−"}${formatMoney(net)}`}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {net > 0 ? "billed ahead of work" : net < 0 ? "work ahead of billing" : "in balance"}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Under-billed</div>
          <div className="text-lg font-medium tabular-nums text-warning">{formatMoney(band.underBilledCents)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Over-billed</div>
          <div className="text-lg font-medium tabular-nums text-success">{formatMoney(band.overBilledCents)}</div>
        </div>
      </div>

      {band.mostUnderBilled.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {band.mostUnderBilled.map((project) => (
            <li key={project.projectId} className="flex items-center gap-2">
              <Link
                href={`/projects/${project.projectId}/financials/budget`}
                className="max-w-56 truncate text-foreground underline-offset-2 hover:underline"
              >
                {project.projectName}
              </Link>
              <span className="tabular-nums text-warning">{formatMoney(project.overUnderCents)}</span>
              <span className="tabular-nums text-muted-foreground">
                {Math.round(project.percentComplete * 100)}%
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

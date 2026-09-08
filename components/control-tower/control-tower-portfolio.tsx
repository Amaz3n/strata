"use client"

import Link from "next/link"
import { useMemo, useState } from "react"

import { ArrowDown, ArrowUp } from "@/components/icons"
import { formatMoney, shortDate, type ScoredProject } from "@/lib/control-tower/model"
import type { ControlTowerRollup } from "@/lib/control-tower/model"
import { cn } from "@/lib/utils"

/**
 * Every active job on one screen, worst first.
 *
 * This is the band the old desk was missing. It had a watchlist that showed the
 * five projects an opaque score had flagged, which answered "is anything on
 * fire" and nothing else — a builder with eleven jobs could not see the other
 * six at all, and the five it did show never said what to do about them.
 *
 * A row is one job's whole position: what is wrong with it in words, how far
 * through the schedule it is, what it has spent, what it is owed, and what it
 * has not billed. Sorting is client-side because every number is already here;
 * re-querying to reorder forty rows would be the slow desk all over again.
 */

type SortKey = "risk" | "name" | "schedule" | "budget" | "overdue" | "unbilled"

const SORTS: Record<SortKey, (a: ScoredProject, b: ScoredProject) => number> = {
  risk: (a, b) => b.health.score - a.health.score || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  schedule: (a, b) => b.sched_overdue - a.sched_overdue || b.health.score - a.health.score,
  budget: (a, b) => (b.health.budgetRatio ?? -1) - (a.health.budgetRatio ?? -1),
  overdue: (a, b) => b.ar_overdue_cents - a.ar_overdue_cents,
  unbilled: (a, b) => b.ready_to_bill_cents - a.ready_to_bill_cents,
}

const HEAD =
  "sticky top-0 z-10 h-9 bg-background px-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80 shadow-[inset_0_-1px_0_var(--border)]"

export function ControlTowerPortfolio({
  projects,
  total,
  showMoney,
  wip,
}: {
  projects: ScoredProject[]
  total: number
  showMoney: boolean
  wip: ControlTowerRollup["wip"] | null
}) {
  const [sort, setSort] = useState<SortKey>("risk")
  const hasWip = Boolean(wip && wip.project_count > 0)

  const rows = useMemo(() => [...projects].sort(SORTS[sort]), [projects, sort])

  const SortHead = ({
    label,
    sortKey,
    className,
  }: {
    label: string
    sortKey: SortKey
    className?: string
  }) => (
    <th scope="col" className={cn(HEAD, className)}>
      <button
        type="button"
        onClick={() => setSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-[0.12em] transition-colors hover:text-foreground",
          sort === sortKey && "text-foreground",
        )}
      >
        {label}
        {sort === sortKey && <ArrowDown aria-hidden className="h-2.5 w-2.5" />}
      </button>
    </th>
  )

  return (
    <section
      className="desk-rise flex min-h-0 flex-1 flex-col"
      style={{ "--desk-stagger": 2 } as React.CSSProperties}
    >
      <header className="flex min-h-[2.75rem] flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-5 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
            Active jobs
          </h2>
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
            {rows.length < total ? `${rows.length} of ${total}` : total} · worst first
          </span>
        </div>
        {hasWip && wip && (
          <Link
            href="/reports"
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Over/under billing {formatMoney(wip.net_cents)} net
            {wip.under_billed_cents > 0
              ? ` · ${formatMoney(wip.under_billed_cents)} earned but unbilled`
              : ""}
            {wip.as_of ? ` · as of ${shortDate(wip.as_of)}` : ""}
          </Link>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full caption-bottom border-collapse text-sm">
          <thead>
            <tr>
              <SortHead label="Job" sortKey="name" className="text-left" />
              <th scope="col" className={cn(HEAD, "hidden text-left lg:table-cell")}>
                What needs attention
              </th>
              <SortHead label="Schedule" sortKey="schedule" className="text-left" />
              <SortHead label="Budget" sortKey="budget" className="text-left" />
              {showMoney && (
                <SortHead label="Overdue" sortKey="overdue" className="text-right" />
              )}
              {showMoney && (
                <SortHead label="Unbilled" sortKey="unbilled" className="text-right" />
              )}
              {hasWip && (
                <th scope="col" className={cn(HEAD, "hidden text-right xl:table-cell")}>
                  Over/under
                </th>
              )}
              <th scope="col" className={cn(HEAD, "hidden text-right sm:table-cell")}>
                Open
              </th>
              <SortHead label="Risk" sortKey="risk" className="text-right" />
            </tr>
          </thead>
          <tbody>
            {rows.map((project) => (
              <tr
                key={project.id}
                className="border-b transition-colors last:border-b-0 hover:bg-foreground/[0.03]"
              >
                <td className="max-w-[16rem] px-3 py-2">
                  <Link href={`/projects/${project.id}`} className="block">
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {project.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {[
                        project.client_name,
                        project.current_phase,
                        project.next_milestone_date
                          ? `${project.next_milestone_name ?? "Next"} ${shortDate(project.next_milestone_date)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "No client or phase set"}
                    </span>
                  </Link>
                </td>

                <td className="hidden max-w-[18rem] px-3 py-2 lg:table-cell">
                  {project.health.worst ? (
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          project.health.worst.tone === "destructive"
                            ? "bg-destructive"
                            : "bg-warning",
                        )}
                      />
                      <span className="truncate text-[12px] text-foreground/85">
                        {project.health.worst.detail}
                      </span>
                      {project.health.signals.length > 1 && (
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                          +{project.health.signals.length - 1}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-[12px] text-success">On track</span>
                  )}
                </td>

                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-1 w-14 shrink-0 overflow-hidden bg-muted">
                      <span
                        className={cn(
                          "block h-full",
                          project.sched_critical_behind > 0 || project.sched_blocked > 0
                            ? "bg-destructive"
                            : "bg-foreground",
                        )}
                        style={{
                          width: `${Math.round((project.health.scheduleRatio ?? 0) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                      {project.sched_total > 0
                        ? `${project.sched_completed}/${project.sched_total}`
                        : "—"}
                    </span>
                    {project.sched_overdue > 0 && (
                      <span className="whitespace-nowrap text-[11px] font-medium tabular-nums text-destructive">
                        {project.sched_overdue} late
                      </span>
                    )}
                  </div>
                </td>

                <td className="px-3 py-2">
                  {project.health.budgetRatio === null ? (
                    <span className="text-[11px] text-muted-foreground/60">No budget</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="h-1 w-14 shrink-0 overflow-hidden bg-muted">
                        <span
                          className={cn(
                            "block h-full",
                            project.health.budgetRatio >= 1
                              ? "bg-destructive"
                              : project.health.budgetRatio >= 0.9
                                ? "bg-warning"
                                : "bg-foreground",
                          )}
                          style={{
                            width: `${Math.min(100, Math.round(project.health.budgetRatio * 100))}%`,
                          }}
                        />
                      </span>
                      <span
                        className={cn(
                          "whitespace-nowrap text-[11px] tabular-nums",
                          project.health.budgetRatio >= 1
                            ? "font-medium text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {Math.round(project.health.budgetRatio * 100)}%
                      </span>
                    </div>
                  )}
                </td>

                {showMoney && (
                  <td
                    className={cn(
                      "whitespace-nowrap px-3 py-2 text-right text-[12.5px] tabular-nums",
                      project.ar_overdue_cents > 0
                        ? "font-medium text-destructive"
                        : "text-muted-foreground/60",
                    )}
                  >
                    {project.ar_overdue_cents > 0 ? formatMoney(project.ar_overdue_cents) : "—"}
                  </td>
                )}

                {showMoney && (
                  <td
                    className={cn(
                      "whitespace-nowrap px-3 py-2 text-right text-[12.5px] tabular-nums",
                      project.ready_to_bill_cents > 0 ? "text-foreground" : "text-muted-foreground/60",
                    )}
                  >
                    {project.ready_to_bill_cents > 0
                      ? formatMoney(project.ready_to_bill_cents)
                      : "—"}
                  </td>
                )}

                {hasWip && (
                  <td
                    className={cn(
                      "hidden whitespace-nowrap px-3 py-2 text-right text-[12.5px] tabular-nums xl:table-cell",
                      (project.poc_over_under_cents ?? 0) < 0
                        ? "text-warning"
                        : (project.poc_over_under_cents ?? 0) > 0
                          ? "text-success"
                          : "text-muted-foreground/60",
                    )}
                  >
                    {project.poc_over_under_cents === null
                      ? "—"
                      : formatMoney(project.poc_over_under_cents)}
                  </td>
                )}

                <td className="hidden whitespace-nowrap px-3 py-2 text-right sm:table-cell">
                  <OpenItems project={project} />
                </td>

                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <span
                    className={cn(
                      "inline-flex min-w-8 justify-center px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                      project.health.score >= 25
                        ? "bg-destructive/10 text-destructive"
                        : project.health.score >= 8
                          ? "bg-warning/10 text-warning"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {project.health.score}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length < total && (
          <p className="border-t px-5 py-2 text-[11px] text-muted-foreground">
            Showing the {rows.length} jobs most in need of attention. {total - rows.length} more are
            active — the projects list carries all of them.
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * Open paperwork as one number with its breakdown on hover. Four separate
 * columns of small integers cost more width than they earn on a row whose job
 * is to be scanned.
 */
function OpenItems({ project }: { project: ScoredProject }) {
  const parts = [
    project.rfis_open > 0 ? `${project.rfis_open} RFI${project.rfis_open === 1 ? "" : "s"}` : null,
    project.submittals_pending > 0 ? `${project.submittals_pending} submittals` : null,
    project.cos_pending > 0 ? `${project.cos_pending} change orders` : null,
    project.punch_open > 0 ? `${project.punch_open} punch` : null,
    project.closeout_missing > 0 ? `${project.closeout_missing} closeout docs missing` : null,
  ].filter(Boolean) as string[]

  const total =
    project.rfis_open + project.submittals_pending + project.cos_pending + project.punch_open

  if (total === 0) {
    return <span className="text-[11px] text-muted-foreground/60">—</span>
  }

  return (
    <span
      title={parts.join(" · ")}
      className={cn(
        "text-[12px] tabular-nums",
        project.rfis_overdue > 0 ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      {total}
      {project.rfis_overdue > 0 ? ` (${project.rfis_overdue} late)` : ""}
    </span>
  )
}

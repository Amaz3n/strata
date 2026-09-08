import Link from "next/link"

import { ControlTowerDecisions } from "@/components/control-tower/control-tower-decisions"
import { ControlTowerPortfolio } from "@/components/control-tower/control-tower-portfolio"
import { ControlTowerWeek } from "@/components/control-tower/control-tower-week"
import { ArrowUpRight } from "@/components/icons"
import { formatMoney } from "@/lib/control-tower/model"
import { getControlTowerDesk } from "@/lib/services/control-tower"
import { cn } from "@/lib/utils"

/**
 * The custom-builder control tower.
 *
 * Three bands, in the order a builder asks the questions: where the money
 * stands, what needs a decision from me and what the field is doing this week,
 * then every job on one screen ranked by how much trouble it is in.
 *
 * It is one Suspense boundary because it is one query. The previous desk
 * streamed four bands separately because each was a different pile of round
 * trips landing on a different clock; with `control_tower_rollup` there is no
 * slow half left to hide behind a skeleton.
 */
export async function ControlTowerDesk() {
  const desk = await getControlTowerDesk()

  if (desk.projectTotal === 0) {
    return <EmptyDesk hasAnyProject={Object.keys(desk.projectsByStatus).length > 0} />
  }

  const overBudget = desk.projects.filter((project) => project.health.overBudgetCents > 0)
  const overBudgetCents = overBudget.reduce(
    (sum, project) => sum + project.health.overBudgetCents,
    0,
  )

  return (
    <div className="flex min-h-full flex-col">
      {desk.money && (
        <section
          className="desk-rise grid grid-cols-1 border-b sm:grid-cols-2 xl:grid-cols-4"
          style={{ "--desk-stagger": 0 } as React.CSSProperties}
        >
          <MoneyCell
            label="Cash to collect"
            value={formatMoney(desk.money.outstandingArCents)}
            href="/invoices"
            detail={
              desk.money.outstandingArCents === 0
                ? "Every invoice is settled"
                : desk.money.overdueArCents >= desk.money.outstandingArCents
                  ? // Restating the headline as its own caption tells the reader
                    // nothing; that every dollar of it is late does.
                    "All of it past due"
                  : desk.money.overdueArCents > 0
                    ? `${formatMoney(desk.money.overdueArCents)} past due`
                    : `${Math.round(desk.money.collectedRatio * 100)}% collected this year`
            }
            status={
              desk.money.overdueArCents > 0
                ? { tone: "destructive", label: "Past due" }
                : desk.money.outstandingArCents > 0
                  ? null
                  : { tone: "success", label: "Clear" }
            }
            ratio={
              desk.money.outstandingArCents > 0
                ? desk.money.overdueArCents / desk.money.outstandingArCents
                : null
            }
            ratioTone="destructive"
            position={0}
          />
          <MoneyCell
            label="You owe"
            value={formatMoney(desk.money.unpaidBillsCents)}
            href="/payables"
            detail={
              desk.money.unpaidBillsCount === 0
                ? "No approved bills outstanding"
                : `${desk.money.unpaidBillsCount} approved bill${desk.money.unpaidBillsCount === 1 ? "" : "s"}${
                    desk.money.pendingBillsCount > 0
                      ? ` · ${desk.money.pendingBillsCount} awaiting approval`
                      : ""
                  }`
            }
            status={
              desk.money.pendingBillsCount > 0
                ? { tone: "warning", label: `${desk.money.pendingBillsCount} to approve` }
                : null
            }
            ratio={null}
            position={1}
          />
          <MoneyCell
            label="Ready to bill"
            value={formatMoney(desk.money.readyToBillCents)}
            href="/billing"
            detail={
              desk.money.readyToBillCents === 0
                ? "Nothing approved and unbilled"
                : `Approved cost across ${desk.money.readyToBillProjects} job${desk.money.readyToBillProjects === 1 ? "" : "s"}`
            }
            status={
              desk.money.readyToBillCents >= 1_000_00
                ? { tone: "warning", label: "Uninvoiced" }
                : { tone: "success", label: "Current" }
            }
            ratio={null}
            position={2}
          />
          <MoneyCell
            label="Over budget"
            value={overBudgetCents > 0 ? formatMoney(overBudgetCents) : "—"}
            href="/reports"
            detail={
              overBudget.length > 0
                ? `${overBudget.length} of ${desk.projectTotal} job${desk.projectTotal === 1 ? "" : "s"} past budget`
                : `All ${desk.projectTotal} active job${desk.projectTotal === 1 ? "" : "s"} within budget`
            }
            status={
              overBudget.length > 0
                ? { tone: "destructive", label: `${overBudget.length} over` }
                : { tone: "success", label: "In plan" }
            }
            ratio={overBudget.length > 0 ? overBudget.length / desk.projectTotal : null}
            ratioTone="destructive"
            position={3}
          />
        </section>
      )}

      <div
        className="desk-rise grid border-b lg:grid-cols-2"
        style={{ "--desk-stagger": 1 } as React.CSSProperties}
      >
        <ControlTowerDecisions
          decisions={desk.decisions}
          total={desk.decisionTotal}
          compliance={desk.compliance}
        />
        <ControlTowerWeek week={desk.week} />
      </div>

      <ControlTowerPortfolio
        projects={desk.projects}
        total={desk.projectTotal}
        showMoney={desk.money !== null}
        wip={desk.money?.wip ?? null}
      />
    </div>
  )
}

/* ================================================================
 * Money strip
 * ============================================================== */

type Tone = "neutral" | "success" | "warning" | "destructive"

const cellBorders: Record<number, string> = {
  0: "border-b sm:border-r xl:border-b-0",
  1: "border-b xl:border-b-0 xl:border-r",
  2: "border-b sm:border-r sm:border-b-0 xl:border-r",
  3: "",
}

const pillStyles: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
}

const barStyles: Record<Tone, string> = {
  neutral: "bg-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
}

function MoneyCell({
  label,
  value,
  detail,
  href,
  status,
  ratio,
  ratioTone = "neutral",
  position,
}: {
  label: string
  value: string
  detail: string
  href: string
  status: { tone: Tone; label: string } | null
  /** 0–1, or null where there is no honest denominator — never a zeroed bar. */
  ratio: number | null
  ratioTone?: Tone
  position: number
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex flex-col gap-4 px-6 py-7 transition-colors hover:bg-foreground/[0.015] sm:px-8",
        cellBorders[position],
      )}
    >
      <div className="flex min-h-[1.6rem] items-start justify-between gap-3">
        <span className="text-[10px] font-medium uppercase leading-[1.4] tracking-[0.14em] text-muted-foreground/80">
          {label}
        </span>
        {status && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] tabular-nums",
              pillStyles[status.tone],
            )}
          >
            <span className="h-1 w-1 rounded-full bg-current" />
            {status.label}
          </span>
        )}
      </div>
      <div className="truncate text-[28px] font-semibold leading-none tracking-tight tabular-nums text-foreground sm:text-[32px]">
        {value}
      </div>
      <div className={cn("h-1 overflow-hidden", ratio !== null && "bg-muted")}>
        {ratio !== null && (
          <div
            className={cn("h-full", barStyles[ratioTone])}
            style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
        <ArrowUpRight
          aria-hidden
          className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground/85"
        />
      </div>
    </Link>
  )
}

function EmptyDesk({ hasAnyProject }: { hasAnyProject: boolean }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="desk-rise max-w-lg border p-8">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
          Control tower
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight">
          {hasAnyProject ? "No active jobs right now" : "Nothing to watch yet"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasAnyProject
            ? "Every job is planning, bidding, or closed. This desk reports on jobs that are actively building — money, schedule pressure, and what needs a decision."
            : "Create a project and this desk fills in as work moves: cash position, the decisions waiting on you, and every job ranked by how much trouble it is in."}
        </p>
        <div className="mt-5 flex gap-4 text-sm">
          <Link className="font-medium underline underline-offset-4" href="/projects">
            {hasAnyProject ? "Open the projects list" : "Create a project"}
          </Link>
          <Link className="text-muted-foreground underline underline-offset-4" href="/directory">
            Set up the directory
          </Link>
        </div>
      </div>
    </div>
  )
}

"use client"

import Link from "next/link"
import { ArrowDown, ArrowUp, ArrowUpRight } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type {
  ControlTowerData,
  DecisionItem,
  DecisionType,
  WatchlistProject,
} from "@/lib/services/dashboard"

interface ControlTowerStatsProps {
  portfolioHealth: ControlTowerData["portfolioHealth"]
  financials: ControlTowerData["financials"]
  decisionItems: DecisionItem[]
  tasks: ControlTowerData["tasks"]
  projectsByStatus: ControlTowerData["projects"]["byStatus"]
  topWatchlist: WatchlistProject[]
  openItems: ControlTowerData["openItems"]
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
  if (dollars >= 10_000) return `$${Math.round(dollars / 1_000)}K`
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return `$${Math.round(dollars).toLocaleString()}`
}

const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  planning: "Planning",
  on_hold: "On hold",
  bidding: "Bidding",
  completed: "Completed",
  cancelled: "Cancelled",
}

const DECISION_TYPE_LABELS: Record<DecisionType, string> = {
  change_order: "Change orders",
  rfi: "RFIs",
  submittal: "Submittals",
  vendor_bill: "Bills awaiting approval",
  proposal: "Proposal signatures",
  punch_item: "Punch items",
}

const DECISION_TYPE_HREF: Record<DecisionType, string> = {
  change_order: "/change-orders",
  rfi: "/rfis",
  submittal: "/submittals",
  vendor_bill: "/payments",
  proposal: "/signatures",
  punch_item: "/tasks",
}

export function ControlTowerStats({
  portfolioHealth,
  financials,
  decisionItems,
  tasks,
  projectsByStatus,
  topWatchlist,
  openItems,
}: ControlTowerStatsProps) {
  const activeProjects = portfolioHealth.activeProjects
  const projectsAtRisk = portfolioHealth.projectsAtRisk
  const riskRatio = activeProjects > 0 ? projectsAtRisk / activeProjects : 0

  const collectedRatio =
    financials.totalInvoiced > 0
      ? financials.totalCollected / financials.totalInvoiced
      : 0
  const overdueRatio =
    financials.outstandingAR > 0
      ? portfolioHealth.overdueARCents / financials.outstandingAR
      : 0

  const urgentDecisions = decisionItems.filter((i) => i.severity === "high").length
  const decisionsCount = decisionItems.length
  const urgentRatio = decisionsCount > 0 ? urgentDecisions / decisionsCount : 0

  const dueCount = portfolioHealth.itemsDueNext7Days
  const blockers = portfolioHealth.totalBlockers
  const tasksDue = tasks.dueThisWeek
  const scheduleDue = Math.max(0, dueCount - tasksDue)

  const activeStatus: CellStatus | null =
    activeProjects === 0
      ? null
      : projectsAtRisk >= 3
      ? { tone: "destructive", label: `${projectsAtRisk} at risk`, trend: "down" }
      : projectsAtRisk > 0
      ? { tone: "warning", label: `${projectsAtRisk} at risk` }
      : { tone: "success", label: "All steady", trend: "up" }

  const cashStatus: CellStatus | null =
    portfolioHealth.overdueARCents > 500_000
      ? { tone: "destructive", label: "Past due" }
      : portfolioHealth.overdueARCents > 0
      ? { tone: "warning", label: "Past due" }
      : financials.outstandingAR > 0
      ? null
      : { tone: "success", label: "Settled", trend: "up" }

  const decisionStatus: CellStatus | null =
    urgentDecisions >= 3
      ? { tone: "destructive", label: `${urgentDecisions} urgent`, trend: "down" }
      : urgentDecisions > 0
      ? { tone: "warning", label: `${urgentDecisions} urgent` }
      : decisionsCount > 0
      ? null
      : { tone: "success", label: "Clear", trend: "up" }

  const dueStatus: CellStatus | null =
    blockers > 0
      ? { tone: "destructive", label: `${blockers} blocked`, trend: "down" }
      : dueCount > 20
      ? { tone: "warning", label: "Heavy week" }
      : dueCount === 0
      ? { tone: "success", label: "Clear", trend: "up" }
      : null

  return (
    <section className="border-b">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <Cell
          label="Active projects"
          value={activeProjects > 0 ? String(activeProjects) : "—"}
          detail={
            activeProjects === 0
              ? "No active jobs"
              : projectsAtRisk > 0
              ? `${projectsAtRisk} on watchlist · ${activeProjects - projectsAtRisk} steady`
              : "All projects on track"
          }
          status={activeStatus}
          position={0}
          align="start"
          popover={
            <ActiveProjectsPopover
              byStatus={projectsByStatus}
              topWatchlist={topWatchlist}
            />
          }
        >
          <RatioBar
            ratio={1 - riskRatio}
            tone={activeStatus?.tone ?? "neutral"}
          />
        </Cell>

        <Cell
          label="Cash to collect"
          value={financials.outstandingAR > 0 ? formatMoney(financials.outstandingAR) : "$0"}
          detail={
            financials.outstandingAR === 0
              ? "All invoices settled"
              : portfolioHealth.overdueARCents > 0
              ? `${formatMoney(portfolioHealth.overdueARCents)} overdue · ${Math.round(collectedRatio * 100)}% collected YTD`
              : `${Math.round(collectedRatio * 100)}% collected YTD`
          }
          status={cashStatus}
          position={1}
          align="start"
          popover={
            <CashPopover
              arAging={financials.arAging}
              unpaidBillsCents={portfolioHealth.unpaidApprovedBillsCents}
            />
          }
        >
          <SplitBar
            primaryRatio={overdueRatio}
            tone={cashStatus?.tone ?? "neutral"}
          />
        </Cell>

        <Cell
          label="Decisions"
          value={decisionsCount > 0 ? String(decisionsCount) : "—"}
          detail={
            decisionsCount === 0
              ? "Nothing waiting on you"
              : urgentDecisions > 0
              ? `${urgentDecisions} urgent · ${decisionsCount - urgentDecisions} routine`
              : `${decisionsCount} pending review`
          }
          status={decisionStatus}
          position={2}
          align="end"
          popover={<DecisionsPopover items={decisionItems} />}
        >
          <SplitBar
            primaryRatio={urgentRatio}
            tone={decisionStatus?.tone ?? "neutral"}
          />
        </Cell>

        <Cell
          label="Due this week"
          value={dueCount > 0 ? String(dueCount) : "—"}
          detail={
            dueCount === 0
              ? "Clear week ahead"
              : blockers > 0
              ? `${blockers} blocker${blockers === 1 ? "" : "s"} in the mix`
              : "Tasks & schedule items"
          }
          status={dueStatus}
          position={3}
          align="end"
          popover={
            <DuePopover
              tasksDue={tasksDue}
              scheduleDue={scheduleDue}
              tasksOverdue={tasks.overdue}
              blockers={blockers}
              openItems={openItems}
            />
          }
        >
          <RatioBar ratio={Math.min(dueCount / 25, 1)} tone={dueStatus?.tone ?? "neutral"} />
        </Cell>
      </div>
    </section>
  )
}

const cellBorders: Record<number, string> = {
  0: "border-b sm:border-r xl:border-b-0 xl:border-r",
  1: "border-b xl:border-b-0 xl:border-r",
  2: "border-b sm:border-r sm:border-b-0 xl:border-r",
  3: "",
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
  popover?: React.ReactNode
  align?: "start" | "center" | "end"
  children: React.ReactNode
}

function Cell({ label, value, detail, position, status, popover, align = "center", children }: CellProps) {
  const tint = status?.tone === "neutral" ? "" : cellTints[status?.tone ?? "neutral"]

  const cellBody = (
    <>
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
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground truncate">{detail}</div>
        {popover && (
          <ArrowUpRight
            aria-hidden
            className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground/85 group-data-[state=open]:text-foreground"
          />
        )}
      </div>
    </>
  )

  const cellClasses = cn(
    "px-6 py-7 sm:px-8 sm:py-8 flex flex-col gap-4 relative w-full text-left transition-colors",
    cellBorders[position],
    tint,
    popover && "group cursor-pointer hover:bg-foreground/[0.015] data-[state=open]:bg-foreground/[0.025] outline-none focus-visible:bg-foreground/[0.025]"
  )

  if (!popover) {
    return <div className={cellClasses}>{cellBody}</div>
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cellClasses}>
          {cellBody}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={-1}
        className="w-80 p-0 rounded-none border shadow-lg"
      >
        {popover}
      </PopoverContent>
    </Popover>
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

function RatioBar({ ratio, tone }: { ratio: number; tone: Tone }) {
  const width = Math.min(100, Math.max(0, ratio * 100))
  return (
    <div className="h-1 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "destructive" && "bg-destructive",
          tone === "neutral" && "bg-foreground"
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

function SplitBar({ primaryRatio, tone }: { primaryRatio: number; tone: Tone }) {
  const primary = Math.min(100, Math.max(0, primaryRatio * 100))
  const remainder = 100 - primary
  return (
    <div className="flex h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full transition-all duration-500",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "destructive" && "bg-destructive",
          tone === "neutral" && "bg-foreground"
        )}
        style={{ width: `${primary}%` }}
      />
      <div
        className="h-full bg-foreground/45 transition-all duration-500"
        style={{ width: `${remainder}%` }}
      />
    </div>
  )
}

/* ================================================================
 * Popover content
 * ============================================================== */

function PopHeader({ label, count }: { label: string; count?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/85">
        {label}
      </span>
      {count && (
        <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
          {count}
        </span>
      )}
    </div>
  )
}

function PopRow({
  label,
  value,
  href,
  tone = "default",
}: {
  label: string
  value: string
  href?: string
  tone?: "default" | "destructive" | "muted"
}) {
  const inner = (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-1.5 -mx-0.5 transition-colors",
        href && "rounded-sm hover:bg-foreground/[0.04]"
      )}
    >
      <span
        className={cn(
          "text-[12px] truncate",
          tone === "destructive" ? "text-destructive font-medium" : "text-foreground/85"
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "text-[12px] font-semibold tabular-nums shrink-0",
          tone === "destructive" && "text-destructive",
          tone === "muted" && "text-muted-foreground/70",
          tone === "default" && "text-foreground"
        )}
      >
        {value}
      </span>
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}

function PopRule() {
  return <div aria-hidden className="my-2 border-t border-border/60" />
}

function PopFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border/60 px-4 py-2.5 bg-muted/30">
      {children}
    </div>
  )
}

function PopLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1 text-[11px] font-medium text-foreground/80 hover:text-foreground transition-colors"
    >
      {children}
      <ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </Link>
  )
}

function ActiveProjectsPopover({
  byStatus,
  topWatchlist,
}: {
  byStatus: Record<string, number>
  topWatchlist: WatchlistProject[]
}) {
  const visibleStatuses = Object.entries(byStatus)
    .filter(([key]) => ["active", "planning", "on_hold", "bidding"].includes(key))
    .sort(([, a], [, b]) => b - a)

  return (
    <div>
      <PopHeader label="Active projects" />
      <div className="px-1 pb-2">
        {visibleStatuses.length === 0 ? (
          <p className="px-4 py-2 text-[12px] text-muted-foreground">No projects yet.</p>
        ) : (
          visibleStatuses.map(([key, count]) => (
            <PopRow
              key={key}
              label={PROJECT_STATUS_LABELS[key] ?? key}
              value={String(count)}
              href={`/projects?status=${key}`}
            />
          ))
        )}
      </div>

      {topWatchlist.length > 0 && (
        <>
          <PopRule />
          <PopHeader label="Most at risk" count={`${topWatchlist.length} flagged`} />
          <div className="px-1 pb-2">
            {topWatchlist.slice(0, 4).map((project) => {
              const isCritical = project.signals.some((s) => s.status === "critical")
              return (
                <PopRow
                  key={project.id}
                  label={project.name}
                  value={`risk ${project.riskScore}`}
                  href={`/projects/${project.id}`}
                  tone={isCritical ? "destructive" : "default"}
                />
              )
            })}
          </div>
        </>
      )}

      <PopFooter>
        <PopLink href="/projects">View all projects</PopLink>
      </PopFooter>
    </div>
  )
}

function CashPopover({
  arAging,
  unpaidBillsCents,
}: {
  arAging: ControlTowerData["financials"]["arAging"]
  unpaidBillsCents: number
}) {
  const buckets: Array<{ label: string; cents: number; tone: "default" | "destructive" }> = [
    { label: "Current", cents: arAging.current, tone: "default" },
    { label: "1–30 days", cents: arAging.oneToThirty, tone: "default" },
    { label: "31–60 days", cents: arAging.thirtyOneToSixty, tone: "default" },
    { label: "61–90 days", cents: arAging.sixtyOneToNinety, tone: "destructive" },
    { label: "90+ days", cents: arAging.overNinety, tone: "destructive" },
  ]
  if (arAging.noDueDate > 0) {
    buckets.push({ label: "No due date", cents: arAging.noDueDate, tone: "default" })
  }

  return (
    <div>
      <PopHeader label="AR aging" />
      <div className="px-1 pb-2">
        {buckets.map((bucket) => (
          <PopRow
            key={bucket.label}
            label={bucket.label}
            value={formatMoney(bucket.cents)}
            tone={bucket.cents === 0 ? "muted" : bucket.tone}
          />
        ))}
      </div>

      {unpaidBillsCents > 0 && (
        <>
          <PopRule />
          <PopHeader label="You owe" />
          <div className="px-1 pb-2">
            <PopRow
              label="Approved bills unpaid"
              value={formatMoney(unpaidBillsCents)}
              href="/payments"
            />
          </div>
        </>
      )}

      <PopFooter>
        <PopLink href="/invoices">View invoices</PopLink>
        <span className="text-muted-foreground/40">·</span>
        <PopLink href="/invoices?status=overdue">Overdue</PopLink>
      </PopFooter>
    </div>
  )
}

function DecisionsPopover({ items }: { items: DecisionItem[] }) {
  const counts = new Map<DecisionType, { count: number; urgent: number }>()
  for (const item of items) {
    const entry = counts.get(item.type) ?? { count: 0, urgent: 0 }
    entry.count += 1
    if (item.severity === "high") entry.urgent += 1
    counts.set(item.type, entry)
  }
  const sortedTypes = (Object.keys(DECISION_TYPE_LABELS) as DecisionType[])
    .map((type) => ({ type, ...(counts.get(type) ?? { count: 0, urgent: 0 }) }))
    .sort((a, b) => b.count - a.count)

  return (
    <div>
      <PopHeader label="By type" count={`${items.length} pending`} />
      <div className="px-1 pb-2">
        {sortedTypes.map(({ type, count, urgent }) => (
          <PopRow
            key={type}
            label={
              urgent > 0
                ? `${DECISION_TYPE_LABELS[type]} · ${urgent} urgent`
                : DECISION_TYPE_LABELS[type]
            }
            value={String(count)}
            href={count > 0 ? DECISION_TYPE_HREF[type] : undefined}
            tone={urgent > 0 ? "destructive" : count === 0 ? "muted" : "default"}
          />
        ))}
      </div>
      <PopFooter>
        <PopLink href="/change-orders">Change orders</PopLink>
        <span className="text-muted-foreground/40">·</span>
        <PopLink href="/rfis">RFIs</PopLink>
      </PopFooter>
    </div>
  )
}

function DuePopover({
  tasksDue,
  scheduleDue,
  tasksOverdue,
  blockers,
  openItems,
}: {
  tasksDue: number
  scheduleDue: number
  tasksOverdue: number
  blockers: number
  openItems: ControlTowerData["openItems"]
}) {
  return (
    <div>
      <PopHeader label="Coming up" />
      <div className="px-1 pb-2">
        <PopRow
          label="Tasks due in 7 days"
          value={String(tasksDue)}
          href="/tasks"
          tone={tasksDue === 0 ? "muted" : "default"}
        />
        <PopRow
          label="Schedule items"
          value={String(scheduleDue)}
          href="/schedule"
          tone={scheduleDue === 0 ? "muted" : "default"}
        />
        {tasksOverdue > 0 && (
          <PopRow
            label="Tasks overdue"
            value={String(tasksOverdue)}
            href="/tasks"
            tone="destructive"
          />
        )}
        {blockers > 0 && (
          <PopRow label="Total blockers" value={String(blockers)} tone="destructive" />
        )}
      </div>

      <PopRule />
      <PopHeader label="Open work" />
      <div className="px-1 pb-2">
        <PopRow label="RFIs open" value={String(openItems.rfis)} href="/rfis" tone={openItems.rfis === 0 ? "muted" : "default"} />
        <PopRow label="Submittals" value={String(openItems.submittals)} href="/submittals" tone={openItems.submittals === 0 ? "muted" : "default"} />
        <PopRow label="Change orders" value={String(openItems.changeOrders)} href="/change-orders" tone={openItems.changeOrders === 0 ? "muted" : "default"} />
        <PopRow label="Punch items" value={String(openItems.punchItems)} href="/tasks" tone={openItems.punchItems === 0 ? "muted" : "default"} />
      </div>

      <PopFooter>
        <PopLink href="/tasks">View tasks</PopLink>
        <span className="text-muted-foreground/40">·</span>
        <PopLink href="/schedule">View schedule</PopLink>
      </PopFooter>
    </div>
  )
}

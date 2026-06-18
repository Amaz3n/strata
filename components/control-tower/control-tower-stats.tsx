"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { format } from "date-fns"
import NumberFlow from "@number-flow/react"
import { ArrowDown, ArrowUp, ArrowUpRight, Download } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import type {
  BudgetHealthItem,
  ControlTowerData,
  DueWorkItem,
  OverdueInvoiceItem,
  WatchlistProject,
} from "@/lib/services/dashboard"

interface ControlTowerStatsProps {
  portfolioHealth: ControlTowerData["portfolioHealth"]
  financials: ControlTowerData["financials"]
  budgetHealth: ControlTowerData["budgetHealth"]
  tasks: ControlTowerData["tasks"]
  projectsByStatus: ControlTowerData["projects"]["byStatus"]
  topWatchlist: WatchlistProject[]
  openItems: ControlTowerData["openItems"]
  dueItems: ControlTowerData["dueItems"]
}

type Tone = "neutral" | "success" | "warning" | "destructive"
type KpiKey = "projects" | "cash" | "budget" | "due"

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

const MONEY_FORMAT: Intl.NumberFormatOptions = {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
}
const PERCENT_FORMAT: Intl.NumberFormatOptions = { style: "percent", maximumFractionDigits: 0 }
const COUNT_FORMAT: Intl.NumberFormatOptions = {}

/** Animated number that rolls up from 0 on mount, formatted via Intl. */
function AnimatedNumber({
  value,
  format: formatOptions = COUNT_FORMAT,
  delay = 0,
  locale = "en-US",
}: {
  value: number
  format?: Intl.NumberFormatOptions
  delay?: number
  locale?: string
}) {
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setDisplay(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return <NumberFlow value={display} format={formatOptions as any} locales={locale} willChange />
}

function formatDate(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return format(date, "MMM d")
}

function toneText(tone: Tone): string {
  return tone === "destructive"
    ? "text-destructive"
    : tone === "warning"
    ? "text-warning"
    : tone === "success"
    ? "text-success"
    : "text-muted-foreground"
}

const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  planning: "Planning",
  on_hold: "On hold",
  bidding: "Bidding",
  completed: "Completed",
  cancelled: "Cancelled",
}

export function ControlTowerStats({
  portfolioHealth,
  financials,
  budgetHealth,
  tasks,
  projectsByStatus,
  topWatchlist,
  openItems,
  dueItems,
}: ControlTowerStatsProps) {
  const [activeKpi, setActiveKpi] = useState<KpiKey | null>(null)

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

  const budgetRatio = Math.min(budgetHealth.percentSpent / 100, 1)

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

  const budgetStatus: CellStatus | null =
    budgetHealth.jobsOver > 0
      ? { tone: "destructive", label: `${budgetHealth.jobsOver} over`, trend: "down" }
      : budgetHealth.jobsApproaching > 0
      ? { tone: "warning", label: `${budgetHealth.jobsApproaching} near` }
      : budgetHealth.jobsTracked > 0
      ? { tone: "success", label: "On budget", trend: "up" }
      : null

  const dueStatus: CellStatus | null =
    blockers > 0
      ? { tone: "destructive", label: `${blockers} blocked`, trend: "down" }
      : dueCount > 20
      ? { tone: "warning", label: "Heavy week" }
      : dueCount === 0
      ? { tone: "success", label: "Clear", trend: "up" }
      : null

  return (
    <>
      <section className="border-b">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          <Cell
            label="Active projects"
            value={activeProjects > 0 ? <AnimatedNumber value={activeProjects} delay={60} /> : "—"}
            detail={
              activeProjects === 0
                ? "No active jobs"
                : projectsAtRisk > 0
                ? `${projectsAtRisk} on watchlist · ${activeProjects - projectsAtRisk} steady`
                : "All projects on track"
            }
            status={activeStatus}
            position={0}
            onOpen={() => setActiveKpi("projects")}
          >
            <RatioBar ratio={1 - riskRatio} tone={activeStatus?.tone ?? "neutral"} delay={60} />
          </Cell>

          <Cell
            label="Cash to collect"
            value={<AnimatedNumber value={financials.outstandingAR / 100} format={MONEY_FORMAT} delay={130} />}
            detail={
              financials.outstandingAR === 0
                ? "All invoices settled"
                : portfolioHealth.overdueARCents > 0
                ? `${formatMoney(portfolioHealth.overdueARCents)} overdue · ${Math.round(collectedRatio * 100)}% collected YTD`
                : `${Math.round(collectedRatio * 100)}% collected YTD`
            }
            status={cashStatus}
            position={1}
            onOpen={() => setActiveKpi("cash")}
          >
            <SplitBar primaryRatio={overdueRatio} tone={cashStatus?.tone ?? "neutral"} delay={130} />
          </Cell>

          <Cell
            label="Over budget"
            value={
              budgetHealth.jobsOver > 0 ? (
                <AnimatedNumber value={budgetHealth.overBudgetCents / 100} format={MONEY_FORMAT} delay={200} />
              ) : budgetHealth.jobsTracked > 0 ? (
                <AnimatedNumber value={budgetHealth.percentSpent / 100} format={PERCENT_FORMAT} delay={200} />
              ) : (
                "—"
              )
            }
            detail={
              budgetHealth.jobsTracked === 0
                ? "No budgets set yet"
                : budgetHealth.jobsOver > 0
                ? `${budgetHealth.jobsOver} of ${budgetHealth.jobsTracked} jobs over budget`
                : budgetHealth.jobsApproaching > 0
                ? `${budgetHealth.jobsApproaching} approaching budget`
                : `${budgetHealth.percentSpent}% of budget spent`
            }
            status={budgetStatus}
            position={2}
            onOpen={() => setActiveKpi("budget")}
          >
            <RatioBar ratio={budgetRatio} tone={budgetStatus?.tone ?? "neutral"} delay={200} />
          </Cell>

          <Cell
            label="Due this week"
            value={dueCount > 0 ? <AnimatedNumber value={dueCount} delay={270} /> : "—"}
            detail={
              dueCount === 0
                ? "Clear week ahead"
                : blockers > 0
                ? `${blockers} blocker${blockers === 1 ? "" : "s"} in the mix`
                : "Tasks & schedule items"
            }
            status={dueStatus}
            position={3}
            onOpen={() => setActiveKpi("due")}
          >
            <RatioBar ratio={Math.min(dueCount / 25, 1)} tone={dueStatus?.tone ?? "neutral"} delay={270} />
          </Cell>
        </div>
      </section>

      <Sheet open={activeKpi !== null} onOpenChange={(open) => !open && setActiveKpi(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          {activeKpi === "projects" && (
            <ProjectsSheet
              activeProjects={activeProjects}
              projectsAtRisk={projectsAtRisk}
              byStatus={projectsByStatus}
              topWatchlist={topWatchlist}
            />
          )}
          {activeKpi === "cash" && (
            <CashSheet
              outstandingAR={financials.outstandingAR}
              overdueARCents={portfolioHealth.overdueARCents}
              arAging={financials.arAging}
              overdueInvoices={financials.overdueInvoices}
              readyToInvoiceCents={financials.readyToInvoiceCents}
              unpaidBillsCents={portfolioHealth.unpaidApprovedBillsCents}
            />
          )}
          {activeKpi === "budget" && <BudgetSheet budgetHealth={budgetHealth} />}
          {activeKpi === "due" && (
            <DueSheet
              dueCount={dueCount}
              blockers={blockers}
              tasksDue={tasksDue}
              scheduleDue={scheduleDue}
              tasksOverdue={tasks.overdue}
              dueItems={dueItems}
              openItems={openItems}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}

/* ================================================================
 * KPI cells
 * ============================================================== */

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
  value: React.ReactNode
  detail: string
  position: number
  status?: CellStatus | null
  onOpen?: () => void
  children: React.ReactNode
}

function Cell({ label, value, detail, position, status, onOpen, children }: CellProps) {
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
        {onOpen && (
          <ArrowUpRight
            aria-hidden
            className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground/85"
          />
        )}
      </div>
    </>
  )

  const cellClasses = cn(
    "px-6 py-7 sm:px-8 sm:py-8 flex flex-col gap-4 relative w-full text-left transition-colors",
    cellBorders[position],
    tint,
    onOpen &&
      "group cursor-pointer hover:bg-foreground/[0.015] outline-none focus-visible:bg-foreground/[0.025]"
  )

  if (!onOpen) {
    return <div className={cellClasses}>{cellBody}</div>
  }

  return (
    <button type="button" onClick={onOpen} className={cellClasses}>
      {cellBody}
    </button>
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

function useMountedWidth(target: number, delay: number) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay)
    return () => clearTimeout(timer)
  }, [delay])
  return mounted ? target : 0
}

function RatioBar({ ratio, tone, delay = 0 }: { ratio: number; tone: Tone; delay?: number }) {
  const width = useMountedWidth(Math.min(100, Math.max(0, ratio * 100)), delay)
  return (
    <div className="h-1 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-700 ease-out",
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

function SplitBar({ primaryRatio, tone, delay = 0 }: { primaryRatio: number; tone: Tone; delay?: number }) {
  const primary = useMountedWidth(Math.min(100, Math.max(0, primaryRatio * 100)), delay)
  const remainder = primary === 0 ? 0 : 100 - primary
  return (
    <div className="flex h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full transition-[width] duration-700 ease-out",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "destructive" && "bg-destructive",
          tone === "neutral" && "bg-foreground"
        )}
        style={{ width: `${primary}%` }}
      />
      <div
        className="h-full bg-foreground/45 transition-[width] duration-700 ease-out"
        style={{ width: `${remainder}%` }}
      />
    </div>
  )
}

/* ================================================================
 * Sheet building blocks
 * ============================================================== */

function SheetHead({
  label,
  value,
  subtitle,
  subtitleTone = "neutral",
}: {
  label: string
  value: string
  subtitle?: string
  subtitleTone?: Tone
}) {
  return (
    <div className="shrink-0 border-b px-5 pb-4 pt-5 pr-12">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
        {label}
      </div>
      <div className="mt-1.5 text-[30px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      {subtitle && (
        <div className={cn("mt-2 text-sm font-medium", toneText(subtitleTone))}>{subtitle}</div>
      )}
    </div>
  )
}

function SheetBody({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
}

function Section({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-baseline justify-between px-5 pb-1.5 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/70">
          {label}
        </span>
        {hint && (
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
            {hint}
          </span>
        )}
      </div>
      <div className="px-2.5 pb-3">{children}</div>
    </div>
  )
}

function LineRow({
  label,
  value,
  href,
  tone = "default",
  bar,
}: {
  label: string
  value: string
  href?: string
  tone?: "default" | "destructive" | "muted"
  bar?: { ratio: number; tone: Tone }
}) {
  const inner = (
    <div
      className={cn(
        "flex flex-col gap-1.5 px-2.5 py-1.5 transition-colors",
        href && "rounded-md hover:bg-foreground/[0.04]"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            "truncate text-[12.5px]",
            tone === "destructive" ? "font-medium text-destructive" : "text-foreground/85"
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "shrink-0 text-[12.5px] font-semibold tabular-nums",
            tone === "destructive" && "text-destructive",
            tone === "muted" && "text-muted-foreground/70",
            tone === "default" && "text-foreground"
          )}
        >
          {value}
        </span>
      </div>
      {bar && <RatioBar ratio={bar.ratio} tone={bar.tone} />}
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}

function ItemRow({
  href,
  title,
  meta,
  value,
  valueTone = "default",
  badge,
}: {
  href: string
  title: string
  meta: string
  value?: string
  valueTone?: "default" | "destructive"
  badge?: { label: string; tone: Tone }
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-md px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
          {badge && (
            <span
              className={cn(
                "shrink-0 rounded-sm px-1 py-px text-[9px] font-semibold uppercase tracking-wide",
                pillStyles[badge.tone]
              )}
            >
              {badge.label}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta}</div>
      </div>
      {value && (
        <span
          className={cn(
            "shrink-0 text-[13px] font-semibold tabular-nums",
            valueTone === "destructive" ? "text-destructive" : "text-foreground"
          )}
        >
          {value}
        </span>
      )}
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground/70" />
    </Link>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 py-3 text-[12px] text-muted-foreground">{children}</p>
}

function SheetFootLinks({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-muted/30 px-5 py-3">{children}</div>
  )
}

function FootLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1 text-[11px] font-medium text-foreground/80 transition-colors hover:text-foreground"
    >
      {children}
      <ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </Link>
  )
}

/* ================================================================
 * Per-KPI sheet bodies
 * ============================================================== */

function ProjectsSheet({
  activeProjects,
  projectsAtRisk,
  byStatus,
  topWatchlist,
}: {
  activeProjects: number
  projectsAtRisk: number
  byStatus: Record<string, number>
  topWatchlist: WatchlistProject[]
}) {
  const visibleStatuses = Object.entries(byStatus)
    .filter(([key]) => ["active", "planning", "on_hold", "bidding"].includes(key))
    .sort(([, a], [, b]) => b - a)

  return (
    <>
      <SheetHead
        label="Active projects"
        value={activeProjects > 0 ? String(activeProjects) : "—"}
        subtitle={
          projectsAtRisk > 0 ? `${projectsAtRisk} on the watchlist` : "All projects on track"
        }
        subtitleTone={projectsAtRisk > 0 ? "warning" : "success"}
      />
      <SheetBody>
        <Section label="By status">
          {visibleStatuses.length === 0 ? (
            <EmptyState>No projects yet.</EmptyState>
          ) : (
            visibleStatuses.map(([key, count]) => (
              <LineRow
                key={key}
                label={PROJECT_STATUS_LABELS[key] ?? key}
                value={String(count)}
                href={`/projects?status=${key}`}
              />
            ))
          )}
        </Section>

        <Section label="Most at risk" hint={topWatchlist.length > 0 ? `${topWatchlist.length} flagged` : undefined}>
          {topWatchlist.length === 0 ? (
            <EmptyState>No projects flagged. Nice.</EmptyState>
          ) : (
            topWatchlist.map((project) => {
              const flagged = project.signals.filter((s) => s.status !== "ok")
              const isCritical = flagged.some((s) => s.status === "critical")
              const meta =
                flagged.length > 0
                  ? flagged.map((s) => s.label).join(" · ")
                  : "Watchlist"
              return (
                <ItemRow
                  key={project.id}
                  href={`/projects/${project.id}`}
                  title={project.name}
                  meta={meta}
                  value={`Risk ${project.riskScore}`}
                  valueTone={isCritical ? "destructive" : "default"}
                  badge={isCritical ? { label: "Critical", tone: "destructive" } : undefined}
                />
              )
            })
          )}
        </Section>
      </SheetBody>
      <SheetFootLinks>
        <FootLink href="/projects">All projects</FootLink>
      </SheetFootLinks>
    </>
  )
}

function CashSheet({
  outstandingAR,
  overdueARCents,
  arAging,
  overdueInvoices,
  readyToInvoiceCents,
  unpaidBillsCents,
}: {
  outstandingAR: number
  overdueARCents: number
  arAging: ControlTowerData["financials"]["arAging"]
  overdueInvoices: OverdueInvoiceItem[]
  readyToInvoiceCents: number
  unpaidBillsCents: number
}) {
  const buckets: Array<{ label: string; cents: number; tone: Tone }> = [
    { label: "Current", cents: arAging.current, tone: "neutral" },
    { label: "1–30 days", cents: arAging.oneToThirty, tone: "neutral" },
    { label: "31–60 days", cents: arAging.thirtyOneToSixty, tone: "warning" },
    { label: "61–90 days", cents: arAging.sixtyOneToNinety, tone: "destructive" },
    { label: "90+ days", cents: arAging.overNinety, tone: "destructive" },
  ]
  if (arAging.noDueDate > 0) {
    buckets.push({ label: "No due date", cents: arAging.noDueDate, tone: "neutral" })
  }
  const maxBucket = Math.max(1, ...buckets.map((b) => b.cents))

  return (
    <>
      <SheetHead
        label="Cash to collect"
        value={outstandingAR > 0 ? formatMoney(outstandingAR) : "$0"}
        subtitle={
          outstandingAR === 0
            ? "All invoices settled"
            : overdueARCents > 0
            ? `${formatMoney(overdueARCents)} overdue`
            : "Nothing overdue"
        }
        subtitleTone={overdueARCents > 0 ? "destructive" : "success"}
      />
      <SheetBody>
        <Section label="AR aging">
          {buckets.map((bucket) => (
            <LineRow
              key={bucket.label}
              label={bucket.label}
              value={formatMoney(bucket.cents)}
              tone={bucket.cents === 0 ? "muted" : bucket.tone === "destructive" ? "destructive" : "default"}
              bar={bucket.cents > 0 ? { ratio: bucket.cents / maxBucket, tone: bucket.tone } : undefined}
            />
          ))}
        </Section>

        {overdueInvoices.length > 0 && (
          <Section label="Overdue invoices" hint={`${overdueInvoices.length} shown`}>
            {overdueInvoices.map((inv) => (
              <ItemRow
                key={inv.id}
                href={inv.href}
                title={inv.number ? `Invoice #${inv.number}` : "Invoice"}
                meta={`${inv.projectName ?? "—"} · ${inv.daysOverdue}d overdue`}
                value={formatMoney(inv.balanceCents)}
                valueTone="destructive"
              />
            ))}
          </Section>
        )}

        {readyToInvoiceCents > 0 && (
          <Section label="Ready to bill">
            <LineRow
              label="Approved costs not yet invoiced"
              value={formatMoney(readyToInvoiceCents)}
              href="/projects"
            />
          </Section>
        )}

        {unpaidBillsCents > 0 && (
          <Section label="You owe">
            <LineRow
              label="Approved bills unpaid"
              value={formatMoney(unpaidBillsCents)}
              href="/payments"
            />
          </Section>
        )}
      </SheetBody>
      <SheetFootLinks>
        <FootLink href="/invoices">Invoices</FootLink>
        <span className="text-muted-foreground/40">·</span>
        <FootLink href="/invoices?status=overdue">Overdue</FootLink>
        <a
          href="/api/reports/ar-aging/export?format=pdf"
          className="group ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-foreground/80 transition-colors hover:text-foreground"
        >
          <Download className="h-3 w-3" />
          Export PDF
        </a>
      </SheetFootLinks>
    </>
  )
}

function BudgetSheet({ budgetHealth }: { budgetHealth: ControlTowerData["budgetHealth"] }) {
  const over = budgetHealth.items.filter((i) => i.status === "over")
  const approaching = budgetHealth.items.filter((i) => i.status === "warning")

  const renderItem = (item: BudgetHealthItem) => (
    <ItemRow
      key={item.projectId}
      href={item.href}
      title={item.projectName}
      meta={`${item.percentSpent}% spent · budget ${formatMoney(item.budgetCents)}`}
      value={
        item.status === "over"
          ? `+${formatMoney(item.overageCents)}`
          : `${formatMoney(item.budgetCents - item.actualCents)} left`
      }
      valueTone={item.status === "over" ? "destructive" : "default"}
      badge={
        item.status === "over"
          ? { label: "Over", tone: "destructive" }
          : { label: "Near", tone: "warning" }
      }
    />
  )

  return (
    <>
      <SheetHead
        label="Over budget"
        value={
          budgetHealth.jobsOver > 0
            ? formatMoney(budgetHealth.overBudgetCents)
            : budgetHealth.jobsTracked > 0
            ? `${budgetHealth.percentSpent}% spent`
            : "—"
        }
        subtitle={
          budgetHealth.jobsTracked === 0
            ? "No active jobs have a budget yet"
            : budgetHealth.jobsOver > 0
            ? `${budgetHealth.jobsOver} of ${budgetHealth.jobsTracked} jobs over budget`
            : budgetHealth.jobsApproaching > 0
            ? `${budgetHealth.jobsApproaching} approaching budget`
            : "All jobs within budget"
        }
        subtitleTone={
          budgetHealth.jobsOver > 0
            ? "destructive"
            : budgetHealth.jobsApproaching > 0
            ? "warning"
            : "success"
        }
      />
      <SheetBody>
        {over.length > 0 && (
          <Section label="Over budget" hint={`${over.length}`}>
            {over.map(renderItem)}
          </Section>
        )}
        {approaching.length > 0 && (
          <Section label="Approaching budget" hint={`${approaching.length}`}>
            {approaching.map(renderItem)}
          </Section>
        )}
        {over.length === 0 && approaching.length === 0 && (
          <Section label="Budget health">
            <EmptyState>
              {budgetHealth.jobsTracked > 0
                ? "Every active job with a budget is tracking within plan."
                : "No active jobs have a budget set. Add budgets to track cost variance here."}
            </EmptyState>
          </Section>
        )}
        {budgetHealth.jobsNoBudget > 0 && (
          <Section label="Not tracked">
            <LineRow
              label="Active jobs without a budget"
              value={String(budgetHealth.jobsNoBudget)}
              tone="muted"
              href="/projects"
            />
          </Section>
        )}
      </SheetBody>
      <SheetFootLinks>
        <FootLink href="/projects">All projects</FootLink>
      </SheetFootLinks>
    </>
  )
}

function DueSheet({
  dueCount,
  blockers,
  tasksDue,
  scheduleDue,
  tasksOverdue,
  dueItems,
  openItems,
}: {
  dueCount: number
  blockers: number
  tasksDue: number
  scheduleDue: number
  tasksOverdue: number
  dueItems: ControlTowerData["dueItems"]
  openItems: ControlTowerData["openItems"]
}) {
  const renderWork = (item: DueWorkItem) => (
    <ItemRow
      key={item.id}
      href={item.href}
      title={item.title}
      meta={[item.projectName, formatDate(item.date)].filter(Boolean).join(" · ") || "—"}
      badge={
        item.isOverdue
          ? { label: "Overdue", tone: "destructive" }
          : item.isCriticalPath
          ? { label: "Critical path", tone: "warning" }
          : undefined
      }
    />
  )

  return (
    <>
      <SheetHead
        label="Due this week"
        value={dueCount > 0 ? String(dueCount) : "—"}
        subtitle={
          dueCount === 0
            ? "Clear week ahead"
            : blockers > 0
            ? `${blockers} blocker${blockers === 1 ? "" : "s"} · ${tasksDue} tasks · ${scheduleDue} schedule`
            : `${tasksDue} tasks · ${scheduleDue} schedule items`
        }
        subtitleTone={blockers > 0 ? "destructive" : dueCount === 0 ? "success" : "neutral"}
      />
      <SheetBody>
        <Section label="Tasks" hint={tasksOverdue > 0 ? `${tasksOverdue} overdue` : undefined}>
          {dueItems.tasks.length === 0 ? (
            <EmptyState>No tasks due in the next 7 days.</EmptyState>
          ) : (
            dueItems.tasks.map(renderWork)
          )}
        </Section>

        <Section label="Schedule">
          {dueItems.scheduleItems.length === 0 ? (
            <EmptyState>No schedule items landing this week.</EmptyState>
          ) : (
            dueItems.scheduleItems.map(renderWork)
          )}
        </Section>

        <Section label="Open work">
          <LineRow label="RFIs" value={String(openItems.rfis)} href="/rfis" tone={openItems.rfis === 0 ? "muted" : "default"} />
          <LineRow label="Submittals" value={String(openItems.submittals)} href="/submittals" tone={openItems.submittals === 0 ? "muted" : "default"} />
          <LineRow label="Change orders" value={String(openItems.changeOrders)} href="/change-orders" tone={openItems.changeOrders === 0 ? "muted" : "default"} />
          <LineRow label="Punch items" value={String(openItems.punchItems)} href="/tasks" tone={openItems.punchItems === 0 ? "muted" : "default"} />
        </Section>
      </SheetBody>
      <SheetFootLinks>
        <FootLink href="/tasks">Tasks</FootLink>
        <span className="text-muted-foreground/40">·</span>
        <FootLink href="/schedule">Schedule</FootLink>
      </SheetFootLinks>
    </>
  )
}

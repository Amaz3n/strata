import Link from "next/link"

import { ArrowDown, ArrowUp } from "@/components/icons"
import { cn } from "@/lib/utils"

/**
 * The shared instrument every overview page is built from: a stat strip of five
 * headline numbers, then bands of grouped rows.
 *
 * Extracted from the project overview so the sales deal file is the *same*
 * design rather than a copy of it — a copy drifts the first time either page is
 * touched. Nothing here knows what a project or a deal is; it only knows the
 * rhythm: one rule per band, tiny uppercase headings, 1px bars, colour reserved
 * for state.
 */

export type Tone = "neutral" | "success" | "warning" | "destructive"

export interface CellStatus {
  tone: Tone
  label: string
  trend?: "up" | "down"
}

/** The horizontal padding every band shares, so nothing sits off the spine. */
export const BAND_X = "px-5 sm:px-8 lg:px-12"

/* ================================================================
 * Stat strip — five numbers across the top of the page
 * ============================================================== */

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

export function StatStrip({ children }: { children: React.ReactNode }) {
  return (
    <section className="border-b">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">{children}</div>
    </section>
  )
}

interface StatCellProps {
  label: string
  value: string
  detail: string
  /** 0-4, left to right. Decides which rules the cell carries at each width. */
  position: number
  status?: CellStatus | null
  children: React.ReactNode
}

export function StatCell({ label, value, detail, position, status, children }: StatCellProps) {
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

export function StatusPill({ status }: { status: CellStatus }) {
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
 * Micro-visualizations — one pixel of colour, never a chart
 * ============================================================== */

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value))
}

const barTones: Record<Tone, string> = {
  neutral: "bg-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
}

export function ThinBar({ width, tone }: { width: number; tone: "primary" | "muted" }) {
  return (
    <div className="h-1 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500",
          tone === "primary" ? "bg-foreground" : "bg-muted-foreground/40"
        )}
        style={{ width: `${clamp(width)}%` }}
      />
    </div>
  )
}

export function StackedBar({
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

/**
 * Progress against a plan: the fill is what happened, the optional ghost is
 * where the calendar says you should be, the optional hairline is the target.
 */
export function MarkerBar({
  fill,
  tone,
  ghost,
  marker,
  markerTitle,
}: {
  fill: number
  tone: Tone
  ghost?: number
  marker?: number | null
  markerTitle?: string
}) {
  return (
    <div className="relative h-1 rounded-full bg-muted overflow-hidden">
      {ghost !== undefined && (
        <div
          className="absolute inset-y-0 left-0 bg-muted-foreground/35 transition-all duration-500"
          style={{ width: `${clamp(ghost)}%` }}
        />
      )}
      <div
        className={cn("absolute inset-y-0 left-0 transition-all duration-500", barTones[tone])}
        style={{ width: `${clamp(fill)}%` }}
      />
      {marker !== null && marker !== undefined && (
        <div
          aria-hidden
          className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/70"
          style={{ left: `${clamp(marker)}%` }}
          title={markerTitle}
        />
      )}
    </div>
  )
}

/* ================================================================
 * Bands — a heading, then grouped rows
 * ============================================================== */

export function BandHeader({
  title,
  count,
  children,
}: {
  title: string
  /** Small print beside the heading, e.g. "7 open". Hidden when empty. */
  count?: string | null
  /** Right-hand pills, or a control. */
  children?: React.ReactNode
}) {
  // The row centres so an aside can be a real control and not only a pill; the
  // heading and its count still share a baseline inside it.
  return (
    <header className={cn(BAND_X, "pt-10 pb-5 flex items-center justify-between gap-3")}>
      <div className="flex items-baseline gap-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/85">
          {title}
        </h2>
        {count ? (
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
            {count}
          </span>
        ) : null}
      </div>
      {children ? <div className="flex items-center gap-1.5">{children}</div> : null}
    </header>
  )
}

export function BandBody({ children }: { children: React.ReactNode }) {
  return <div className={cn(BAND_X, "pb-10")}>{children}</div>
}

export function GroupHeader({
  label,
  count,
  ruleClassName,
  labelClassName,
  children,
}: {
  label: string
  count: number
  ruleClassName: string
  labelClassName: string
  /** Anything that sits after the label, e.g. a date or a today dot. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={cn("h-px w-4 shrink-0", ruleClassName)} />
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-[0.16em] truncate",
            labelClassName
          )}
        >
          {label}
        </span>
        {children}
      </div>
      <span className="text-[10px] font-medium tabular-nums text-muted-foreground/55 shrink-0">
        {count}
      </span>
    </div>
  )
}

export function IconChip({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: "neutral" | "destructive" | "warning" | "success" | "inverted"
}) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors",
        tone === "neutral" &&
          "bg-muted/60 text-muted-foreground ring-1 ring-foreground/[0.04] ring-inset",
        tone === "destructive" && "bg-destructive/10 text-destructive",
        tone === "warning" && "bg-warning/12 text-warning",
        tone === "success" && "bg-success/12 text-success",
        tone === "inverted" && "bg-foreground text-background"
      )}
    >
      {children}
    </span>
  )
}

export type RowTone = "neutral" | "destructive" | "success" | "emphasis"

const rowWash: Record<RowTone, string> = {
  neutral: "",
  destructive: "bg-destructive/[0.03]",
  success: "bg-success/[0.03]",
  emphasis: "bg-foreground/[0.025]",
}

const rowHover: Record<RowTone, string> = {
  neutral: "hover:bg-muted/45",
  destructive: "hover:bg-destructive/[0.07]",
  success: "hover:bg-success/[0.07]",
  emphasis: "hover:bg-foreground/[0.05]",
}

/**
 * One item in a band. A row with no `href` renders inert rather than a dead
 * link — some things that need attention are resolved by the page's own primary
 * action, and a link that goes nowhere is worse than none.
 */
export function OverviewRow({
  href,
  tone = "neutral",
  children,
}: {
  href?: string | null
  tone?: RowTone
  children: React.ReactNode
}) {
  const base = "flex items-center gap-3 py-2 -mx-2 px-2 rounded-md transition-all duration-150"
  if (!href) {
    return <div className={cn(base, rowWash[tone])}>{children}</div>
  }
  return (
    <Link href={href} className={cn("group", base, rowWash[tone], rowHover[tone])}>
      {children}
    </Link>
  )
}

export function OverviewEmptyState({
  icon,
  tone,
  title,
  description,
}: {
  icon: React.ReactNode
  tone: "success" | "neutral"
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div
        className={cn(
          "mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full",
          tone === "success" && "bg-success/10",
          tone === "neutral" && "bg-muted/60"
        )}
      >
        {icon}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

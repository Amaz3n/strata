"use client"

import Link from "next/link"
import {
  FileText,
  HelpCircle,
  ClipboardCheck,
  Receipt,
  Send,
  Wrench,
  Clock,
  ArrowRight,
  DollarSign,
  CalendarDays,
  Inbox,
} from "lucide-react"
import type { DecisionItem, DecisionType } from "@/lib/services/dashboard"

const typeConfig: Record<
  DecisionType,
  { icon: typeof FileText; color: string; bg: string }
> = {
  change_order: {
    icon: FileText,
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/10 dark:bg-amber-400/15",
  },
  rfi: {
    icon: HelpCircle,
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-500/10 dark:bg-blue-400/15",
  },
  submittal: {
    icon: ClipboardCheck,
    color: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-500/10 dark:bg-violet-400/15",
  },
  vendor_bill: {
    icon: Receipt,
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/10 dark:bg-emerald-400/15",
  },
  proposal: {
    icon: Send,
    color: "text-sky-600 dark:text-sky-400",
    bg: "bg-sky-500/10 dark:bg-sky-400/15",
  },
  punch_item: {
    icon: Wrench,
    color: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-500/10 dark:bg-rose-400/15",
  },
}

function formatAge(days: number): string {
  if (days === 0) return "Today"
  if (days === 1) return "1d"
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 30)}mo`
}

function AgeBadge({ days }: { days: number }) {
  const isUrgent = days > 7
  const isCritical = days > 14
  return (
    <div
      className={`
        flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold tabular-nums
        ${isCritical
          ? "bg-red-500/10 text-red-600 dark:bg-red-400/15 dark:text-red-400"
          : isUrgent
            ? "bg-amber-500/10 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400"
            : "bg-muted text-muted-foreground"
        }
      `}
    >
      <Clock className="h-3 w-3" />
      {formatAge(days)}
    </div>
  )
}

function DecisionRow({ item }: { item: DecisionItem }) {
  const config = typeConfig[item.type]
  const Icon = config.icon

  return (
    <Link
      href={item.href}
      className="group flex items-center gap-0 border-b border-border/50 last:border-b-0 transition-colors hover:bg-muted/40"
    >
      {/* Type icon */}
      <div className="flex items-center justify-center w-12 shrink-0 self-stretch border-r border-border/30">
        <div className={`flex h-7 w-7 items-center justify-center ${config.bg}`}>
          <Icon className={`h-3.5 w-3.5 ${config.color}`} strokeWidth={2} />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex items-center gap-3 px-3.5 py-2.5">
        {/* Issue + project */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${config.color} shrink-0`}>
              {item.typeLabel}
            </span>
            {item.projectName && (
              <>
                <span className="text-muted-foreground/30 text-[10px]">/</span>
                <span className="text-[10px] text-muted-foreground truncate">
                  {item.projectName}
                </span>
              </>
            )}
          </div>
          <p className="text-[13px] font-medium text-foreground truncate mt-0.5 leading-snug">
            {item.title}
          </p>
        </div>

        {/* Age */}
        <AgeBadge days={item.ageDays} />

        {/* Impact */}
        <div className="hidden sm:flex items-center gap-1.5 min-w-[120px] justify-end">
          {item.impactCents !== undefined && item.impactCents > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] font-medium text-foreground/70">
              <DollarSign className="h-3 w-3 text-muted-foreground/60" />
              {(item.impactCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
          )}
          {item.impactDays !== undefined && item.impactDays > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] font-medium text-foreground/70">
              <CalendarDays className="h-3 w-3 text-muted-foreground/60" />
              {item.impactDays}d
            </span>
          )}
          {!item.impactCents && !item.impactDays && (
            <span className="text-[11px] text-muted-foreground/50">
              {item.impactLabel}
            </span>
          )}
        </div>

        {/* CTA */}
        <div
          className={`
            hidden md:flex items-center gap-1 px-2.5 py-1
            text-[11px] font-semibold
            ${config.bg} ${config.color}
            opacity-70 group-hover:opacity-100
            transition-opacity
          `}
        >
          {item.ctaLabel}
          <ArrowRight className="h-3 w-3" />
        </div>
      </div>
    </Link>
  )
}

export function DecisionQueue({ items }: { items: DecisionItem[] }) {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground tracking-tight">
            Decision Queue
          </h2>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {items.length === 0
              ? "No decisions pending — you're all caught up"
              : `${items.length} item${items.length !== 1 ? "s" : ""} waiting on your decision`}
          </p>
        </div>

        {/* Severity summary pills */}
        {items.length > 0 && (
          <div className="hidden sm:flex items-center gap-1.5">
            {(() => {
              const high = items.filter((i) => i.severity === "high").length
              const med = items.filter((i) => i.severity === "medium").length
              return (
                <>
                  {high > 0 && (
                    <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold bg-red-500/10 text-red-600 dark:bg-red-400/15 dark:text-red-400">
                      {high} urgent
                    </span>
                  )}
                  {med > 0 && (
                    <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold bg-amber-500/10 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
                      {med} aging
                    </span>
                  )}
                </>
              )
            })()}
          </div>
        )}
      </div>

      {/* Queue */}
      <div className="ring-1 ring-border overflow-hidden bg-card">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Inbox className="h-10 w-10 text-muted-foreground/20 mb-3" strokeWidth={1} />
            <p className="text-[13px] text-muted-foreground/50 font-medium">
              Nothing needs your attention
            </p>
          </div>
        ) : (
          items.map((item) => (
            <DecisionRow key={item.id} item={item} />
          ))
        )}
      </div>
    </div>
  )
}

import Link from "next/link"
import {
  CheckCircle2,
  DollarSign,
  FileText,
  Hammer,
  MessageSquare,
  Receipt,
  ClipboardCheck,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import type { DecisionItem, DecisionType } from "@/lib/services/dashboard"

interface ControlTowerDecisionsProps {
  items: DecisionItem[]
}

const typeIcon: Record<DecisionType, React.ReactNode> = {
  change_order: <DollarSign className="h-3.5 w-3.5" />,
  rfi: <MessageSquare className="h-3.5 w-3.5" />,
  submittal: <FileText className="h-3.5 w-3.5" />,
  vendor_bill: <Receipt className="h-3.5 w-3.5" />,
  proposal: <ClipboardCheck className="h-3.5 w-3.5" />,
  punch_item: <Hammer className="h-3.5 w-3.5" />,
}

type GroupKey = "urgent" | "waiting" | "queued"
type Tone = "destructive" | "warning" | "neutral"

const GROUP_LABELS: Record<GroupKey, string> = {
  urgent: "Urgent",
  waiting: "Waiting",
  queued: "Queued",
}

const GROUP_TONE: Record<GroupKey, Tone> = {
  urgent: "destructive",
  waiting: "warning",
  queued: "neutral",
}

const GROUP_ORDER: GroupKey[] = ["urgent", "waiting", "queued"]

const toneText: Record<Tone, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
  neutral: "text-muted-foreground/85",
}

const toneRule: Record<Tone, string> = {
  destructive: "bg-destructive/40",
  warning: "bg-warning/40",
  neutral: "bg-muted-foreground/30",
}

function groupOf(item: DecisionItem): GroupKey {
  if (item.severity === "high" || item.ageDays > 7) return "urgent"
  if (item.severity === "medium") return "waiting"
  return "queued"
}

function formatMoney(cents: number): string {
  if (!cents || cents <= 0) return "—"
  const dollars = cents / 100
  if (dollars >= 1_000_000) {
    const m = dollars / 1_000_000
    return `$${(m >= 10 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, "")}M`
  }
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}K`
  return `$${Math.round(dollars).toLocaleString()}`
}

export function ControlTowerDecisions({ items }: ControlTowerDecisionsProps) {
  const visible = items.slice(0, 12)
  const grouped = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key],
    tone: GROUP_TONE[key],
    items: visible.filter((i) => groupOf(i) === key),
  })).filter((g) => g.items.length > 0)

  const urgentCount = visible.filter((i) => groupOf(i) === "urgent").length

  return (
    <section className="border-b lg:border-b-0 lg:border-r">
      <header className="px-5 sm:px-8 lg:px-12 pt-10 pb-5 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/85">
            Decisions waiting
          </h2>
          {visible.length > 0 && (
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
              {visible.length} open
            </span>
          )}
        </div>
        {urgentCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-destructive bg-destructive/10 px-2 py-0.5 rounded-sm">
            <span className="h-1 w-1 rounded-full bg-destructive" />
            {urgentCount} urgent
          </span>
        )}
      </header>

      <div className="px-5 sm:px-8 lg:px-12 pb-10">
        {visible.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5 text-success" />}
            tone="success"
            title="Nothing waiting on you"
            description="Decisions are all handled."
          />
        ) : (
          <div className="space-y-7">
            {grouped.map((group) => (
              <div key={group.key}>
                <GroupHeader label={group.label} count={group.items.length} tone={group.tone} />
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const isUrgent = group.key === "urgent"
                    return (
                      <li key={item.id}>
                        <Link
                          href={item.href}
                          className={cn(
                            "group flex items-center gap-3 py-2 -mx-2 px-2 rounded-md transition-all duration-150",
                            isUrgent
                              ? "bg-destructive/[0.03] hover:bg-destructive/[0.07]"
                              : "hover:bg-muted/45"
                          )}
                        >
                          <IconChip tone={isUrgent ? "destructive" : "neutral"}>
                            {typeIcon[item.type]}
                          </IconChip>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">
                              {item.title}
                            </p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {item.typeLabel}
                              {item.projectName ? ` · ${item.projectName}` : ""}
                            </p>
                          </div>
                          <RightMeta item={item} groupKey={group.key} />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function GroupHeader({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={cn("h-px w-4 shrink-0", toneRule[tone])} />
        <span className={cn("text-[10px] font-semibold uppercase tracking-[0.16em] truncate", toneText[tone])}>
          {label}
        </span>
      </div>
      <span className="text-[10px] font-medium tabular-nums text-muted-foreground/55 shrink-0">
        {count}
      </span>
    </div>
  )
}

function IconChip({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: "neutral" | "destructive" | "warning" | "success"
}) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors",
        tone === "neutral" &&
          "bg-muted/60 text-muted-foreground ring-1 ring-foreground/[0.04] ring-inset",
        tone === "destructive" && "bg-destructive/10 text-destructive",
        tone === "warning" && "bg-warning/12 text-warning",
        tone === "success" && "bg-success/12 text-success"
      )}
    >
      {children}
    </span>
  )
}

function RightMeta({ item, groupKey }: { item: DecisionItem; groupKey: GroupKey }) {
  const ageLabel =
    item.ageDays === 0 ? "Today" : item.ageDays === 1 ? "1d" : `${item.ageDays}d`
  const impact = item.impactCents
    ? formatMoney(item.impactCents)
    : item.impactDays
    ? `${item.impactDays}d`
    : null

  return (
    <div className="shrink-0 hidden sm:flex items-center gap-3">
      {impact && impact !== "—" && (
        <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
          {impact}
        </span>
      )}
      <span
        className={cn(
          "text-[11px] font-semibold tabular-nums",
          groupKey === "urgent" && "text-destructive",
          groupKey === "waiting" && "text-warning",
          groupKey === "queued" && "text-muted-foreground/85"
        )}
      >
        {ageLabel}
      </span>
    </div>
  )
}

function EmptyState({
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

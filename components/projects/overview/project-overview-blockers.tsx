import { parseISO, differenceInDays } from "date-fns"
import {
  CheckCircle2,
  CalendarDays,
  MessageSquare,
  FileText,
  Hammer,
  AlertTriangle,
  CheckSquare,
  DollarSign,
} from "@/components/icons"
import {
  BandBody,
  BandHeader,
  GroupHeader,
  IconChip,
  OverviewEmptyState,
  OverviewRow,
} from "@/components/overview/primitives"
import { cn } from "@/lib/utils"
import type { AttentionItem, HealthCounts } from "@/app/(app)/projects/[id]/overview-actions"

interface ProjectOverviewBlockersProps {
  items: AttentionItem[]
  health: HealthCounts
  projectId: string
}

const typeIcon: Record<AttentionItem["type"], React.ReactNode> = {
  task: <CheckSquare className="h-3.5 w-3.5" />,
  schedule: <CalendarDays className="h-3.5 w-3.5" />,
  rfi: <MessageSquare className="h-3.5 w-3.5" />,
  submittal: <FileText className="h-3.5 w-3.5" />,
  punch: <Hammer className="h-3.5 w-3.5" />,
  closeout: <AlertTriangle className="h-3.5 w-3.5" />,
  warranty: <AlertTriangle className="h-3.5 w-3.5" />,
}

type GroupKey = "overdue_long" | "overdue" | "at_risk" | "pending"
type Tone = "destructive" | "warning" | "neutral"

const GROUP_LABELS: Record<GroupKey, string> = {
  overdue_long: "Overdue 7+ days",
  overdue: "Overdue",
  at_risk: "At risk",
  pending: "Pending",
}

const GROUP_TONE: Record<GroupKey, Tone> = {
  overdue_long: "destructive",
  overdue: "destructive",
  at_risk: "warning",
  pending: "neutral",
}

const GROUP_ORDER: GroupKey[] = ["overdue_long", "overdue", "at_risk", "pending"]

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

interface BlockerItem extends AttentionItem {
  isBudget?: boolean
}

function daysLate(dueDate?: string | null): number {
  if (!dueDate) return 0
  const days = differenceInDays(new Date(), parseISO(dueDate))
  return Math.max(0, days)
}

function groupOf(item: BlockerItem): GroupKey {
  const late = daysLate(item.dueDate)
  if (late >= 7) return "overdue_long"
  if (late >= 1 || item.reason === "overdue") return "overdue"
  if (item.reason === "at_risk" || item.reason === "blocked") return "at_risk"
  return "pending"
}

export function ProjectOverviewBlockers({
  items,
  health,
  projectId,
}: ProjectOverviewBlockersProps) {
  const budgetBlocker: BlockerItem | null =
    health.financial.budgetVariancePercent > 100
      ? {
          id: "budget",
          type: "task",
          title: `Budget at ${health.financial.budgetVariancePercent}% of plan`,
          reason: "overdue",
          dueDate: null,
          link: `/projects/${projectId}/financials`,
          isBudget: true,
        }
      : null

  const allItems: BlockerItem[] = [
    ...(budgetBlocker ? [budgetBlocker] : []),
    ...items,
  ].slice(0, 12)

  const grouped = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key],
    tone: GROUP_TONE[key],
    items: allItems.filter((i) => groupOf(i) === key),
  })).filter((g) => g.items.length > 0)

  const criticalCount = allItems.filter(
    (i) =>
      groupOf(i) === "overdue_long" ||
      groupOf(i) === "overdue" ||
      i.reason === "blocked"
  ).length

  return (
    <section className="border-b lg:border-b-0 lg:border-r">
      <BandHeader title="Needs attention" count={allItems.length > 0 ? `${allItems.length} open` : null}>
        {criticalCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-destructive bg-destructive/10 px-2 py-0.5 rounded-sm">
            <span className="h-1 w-1 rounded-full bg-destructive" />
            {criticalCount} critical
          </span>
        )}
      </BandHeader>

      <BandBody>
        {allItems.length === 0 ? (
          <OverviewEmptyState
            icon={<CheckCircle2 className="h-5 w-5 text-success" />}
            tone="success"
            title="Nothing blocking"
            description="All open items are on track."
          />
        ) : (
          <div className="space-y-7">
            {grouped.map((group) => (
              <div key={group.key}>
                <GroupHeader
                  label={group.label}
                  count={group.items.length}
                  ruleClassName={toneRule[group.tone]}
                  labelClassName={toneText[group.tone]}
                />
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const isCritical =
                      group.key === "overdue_long" || item.reason === "blocked"
                    const late = daysLate(item.dueDate)
                    const icon = item.isBudget ? (
                      <DollarSign className="h-3.5 w-3.5" />
                    ) : (
                      typeIcon[item.type]
                    )
                    return (
                      <li key={`${item.type}-${item.id}`}>
                        <OverviewRow href={item.link} tone={isCritical ? "destructive" : "neutral"}>
                          <IconChip tone={isCritical ? "destructive" : "neutral"}>
                            {icon}
                          </IconChip>
                          <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
                            {item.title}
                          </span>
                          <RightMeta late={late} reason={item.reason} groupKey={group.key} />
                        </OverviewRow>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </BandBody>
    </section>
  )
}

function RightMeta({
  late,
  reason,
  groupKey,
}: {
  late: number
  reason: AttentionItem["reason"]
  groupKey: GroupKey
}) {
  if (late > 0) {
    return (
      <span
        className={cn(
          "shrink-0 text-[11px] font-semibold tabular-nums",
          groupKey === "overdue_long" && "text-destructive",
          groupKey === "overdue" && "text-destructive/85",
          groupKey !== "overdue_long" && groupKey !== "overdue" && "text-muted-foreground"
        )}
      >
        {late === 1 ? "1d late" : `${late}d late`}
      </span>
    )
  }
  if (reason === "blocked") return <span className="shrink-0 text-[11px] font-semibold text-destructive">Blocked</span>
  if (reason === "overdue") return <span className="shrink-0 text-[11px] font-semibold text-destructive">Overdue</span>
  if (reason === "at_risk") return <span className="shrink-0 text-[11px] font-semibold text-warning">At risk</span>
  if (reason === "missing") return <span className="shrink-0 text-[11px] font-medium text-muted-foreground">Missing</span>
  return <span className="shrink-0 text-[11px] font-medium text-muted-foreground/70">Pending</span>
}

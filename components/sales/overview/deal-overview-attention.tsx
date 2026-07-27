import {
  Bell,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileText,
  Home,
  KeyRound,
  Phone,
  Receipt,
  Timer,
  UserPlus,
} from "@/components/icons"
import { IconChip, OverviewRow } from "@/components/overview/primitives"
import { FollowUpControl } from "@/components/sales/follow-up-control"
import { MetaBlock } from "@/components/sales/overview/meta-block"
import {
  DEAL_ATTENTION_ORDER,
  type DealAttentionGroup,
  type DealAttentionItem,
  type DealAttentionKind,
} from "@/lib/sales/deal-attention"
import { cn } from "@/lib/utils"

const kindIcon: Record<DealAttentionKind, React.ReactNode> = {
  call_back: <Phone className="h-3.5 w-3.5" />,
  follow_up: <Bell className="h-3.5 w-3.5" />,
  follow_up_missing: <Bell className="h-3.5 w-3.5" />,
  hold_expiry: <Clock className="h-3.5 w-3.5" />,
  no_home: <Home className="h-3.5 w-3.5" />,
  no_contact: <UserPlus className="h-3.5 w-3.5" />,
  no_touches: <Timer className="h-3.5 w-3.5" />,
  unassigned: <UserPlus className="h-3.5 w-3.5" />,
  deposit: <Receipt className="h-3.5 w-3.5" />,
  agreement: <FileText className="h-3.5 w-3.5" />,
  closing_date: <CalendarDays className="h-3.5 w-3.5" />,
  closing_gates: <KeyRound className="h-3.5 w-3.5" />,
  closing_late: <CalendarDays className="h-3.5 w-3.5" />,
}

const chipTone: Record<DealAttentionGroup, "destructive" | "warning" | "neutral"> = {
  overdue: "destructive",
  at_risk: "warning",
  pending: "neutral",
}

const metaTone: Record<DealAttentionGroup, string> = {
  overdue: "font-semibold text-destructive",
  at_risk: "font-semibold text-warning",
  pending: "font-medium text-muted-foreground/70",
}

/**
 * Everything holding this buyer up, worst first, in one list.
 *
 * Deliberately not split into Overdue / At risk / Pending sections: a deal
 * carries three or four of these at a time, and three headings over one row each
 * is filing, not reading. Severity rides on the row instead — a red chip is late,
 * amber is at risk, grey is merely open — so the list stays one thing to scan.
 *
 * Rows that no other desk owns render inert on purpose: the follow-up is set from
 * the control in this very heading, and a lead is corrected in the deal's actions
 * menu, so a link would only send the consultant somewhere they have already been.
 */
export function DealAttentionBlock({
  items,
  prospectId,
  followUpAt,
}: {
  items: DealAttentionItem[]
  /** Null for a deal with no lead record behind it — an imported agreement. */
  prospectId: string | null
  followUpAt: string | null
}) {
  const ordered = DEAL_ATTENTION_ORDER.flatMap((group) =>
    items.filter((item) => item.group === group),
  )
  const criticalCount = items.filter((item) => item.group === "overdue").length

  return (
    <MetaBlock
      title="Needs attention"
      count={ordered.length > 0 ? `${ordered.length} open` : null}
      aside={
        <div className="flex items-center gap-2">
          {criticalCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.16em] text-destructive uppercase">
              <span className="h-1 w-1 rounded-full bg-destructive" />
              {criticalCount} critical
            </span>
          ) : null}
          <FollowUpControl
            prospectId={prospectId}
            followUpAt={followUpAt}
            variant="block"
            className="w-auto"
          />
        </div>
      }
    >
      {ordered.length === 0 ? (
        <div className="flex items-center gap-3">
          <IconChip tone="success">
            <CheckCircle2 className="h-3.5 w-3.5" />
          </IconChip>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Nothing blocking</p>
            <p className="text-xs text-muted-foreground">
              No follow-up is late and nothing is waiting on this deal.
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {ordered.map((item) => (
            <li key={item.kind + item.title}>
              <OverviewRow
                href={item.href}
                tone={item.group === "overdue" ? "destructive" : "neutral"}
              >
                <IconChip tone={chipTone[item.group]}>{kindIcon[item.kind]}</IconChip>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {item.title}
                </span>
                <span className={cn("shrink-0 text-[11px] tabular-nums", metaTone[item.group])}>
                  {item.meta}
                </span>
              </OverviewRow>
            </li>
          ))}
        </ul>
      )}
    </MetaBlock>
  )
}

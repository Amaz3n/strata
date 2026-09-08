import Link from "next/link"

import {
  CheckCircle2,
  DollarSign,
  FileText,
  Hammer,
  MessageSquare,
  Receipt,
  ShieldCheck,
} from "@/components/icons"
import { formatMoney, type DecisionKind, type RankedDecision } from "@/lib/control-tower/model"
import type { ComplianceLoad } from "@/lib/services/control-tower"
import { cn } from "@/lib/utils"

const KIND_ICON: Record<DecisionKind, React.ReactNode> = {
  change_order: <DollarSign className="h-3.5 w-3.5" />,
  rfi: <MessageSquare className="h-3.5 w-3.5" />,
  submittal: <FileText className="h-3.5 w-3.5" />,
  vendor_bill: <Receipt className="h-3.5 w-3.5" />,
  punch_item: <Hammer className="h-3.5 w-3.5" />,
}

/**
 * What is waiting on a person, ranked by consequence.
 *
 * One list, not three severity groups. Grouping by bucket meant a $200k change
 * order signed off this morning sorted below a stale $500 one, because the
 * bucket was decided before the money was looked at. The rank is now money and
 * lateness together (`rankDecisions`), and urgency is reported on the row.
 *
 * Vendor compliance leads when it is holding money: an unreviewed certificate
 * stops payables exactly the way a non-compliant vendor does, so it is a
 * decision waiting on someone, not a statistic.
 */
export function ControlTowerDecisions({
  decisions,
  total,
  compliance,
}: {
  decisions: RankedDecision[]
  total: number
  compliance: ComplianceLoad | null
}) {
  const urgent = decisions.filter((decision) => decision.severity === "urgent").length
  const hasCompliance = (compliance?.reviews ?? 0) > 0
  const hidden = Math.max(0, total - decisions.length)

  return (
    <section className="border-b lg:border-b-0 lg:border-r">
      <header className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-5 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
            Needs you
          </h2>
          {total > 0 && (
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
              {total} open
            </span>
          )}
        </div>
        {urgent > 0 && (
          <span className="inline-flex items-center gap-1.5 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-destructive">
            <span className="h-1 w-1 rounded-full bg-destructive" />
            {urgent} urgent
          </span>
        )}
      </header>

      {decisions.length === 0 && !hasCompliance ? (
        <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <p className="mt-3 text-sm font-medium text-foreground">Nothing waiting on you</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No change orders, RFIs, submittals, bills, or urgent punch items are open.
          </p>
        </div>
      ) : (
        <div>
          {hasCompliance && compliance && <ComplianceRow compliance={compliance} />}

          {decisions.map((decision) => (
            <Link
              key={`${decision.kind}:${decision.id}`}
              href={decision.href}
              className="group flex items-center gap-3 border-b px-5 py-2.5 transition-colors last:border-b-0 hover:bg-foreground/[0.03]"
            >
              <span
                className={cn(
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center",
                  decision.severity === "urgent"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {KIND_ICON[decision.kind]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {decision.title}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {[decision.typeLabel, decision.projectName].filter(Boolean).join(" · ")}
                </span>
              </span>
              {decision.impactCents !== null && (
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
                  {formatMoney(decision.impactCents)}
                </span>
              )}
              <span
                className={cn(
                  "w-16 shrink-0 text-right text-[11px] font-medium tabular-nums",
                  decision.overdueDays > 0 ? "text-destructive" : "text-muted-foreground/70",
                )}
              >
                {decision.overdueDays > 0
                  ? `${decision.overdueDays}d late`
                  : decision.ageDays === 0
                    ? "today"
                    : `${decision.ageDays}d old`}
              </span>
            </Link>
          ))}

          {hidden > 0 && (
            <p className="px-5 py-2 text-[11px] text-muted-foreground">
              Showing the {decisions.length} that cost the most. {hidden} more are open.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The held figure is the money the hold provably stops, not the vendor's whole
 * balance. A truncated scan says so rather than reporting a floor as a total,
 * because a number nobody could establish must never read as an all-clear.
 */
function ComplianceRow({ compliance }: { compliance: ComplianceLoad }) {
  const held =
    compliance.heldCents > 0
      ? `${formatMoney(compliance.heldCents)}${compliance.heldTruncated ? "+" : ""} held`
      : compliance.heldTruncated
        ? "Not counted"
        : "Holding nothing up"

  return (
    <Link
      href="/directory?compliance=pending"
      className="group flex items-center gap-3 border-b bg-warning/[0.04] px-5 py-2.5 transition-colors hover:bg-warning/[0.08]"
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center bg-warning/12 text-warning">
        <ShieldCheck className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">
          {compliance.reviews} compliance review{compliance.reviews === 1 ? "" : "s"} waiting
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          Vendor documents · payments stay held until someone rules
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 text-[13px] font-semibold tabular-nums",
          compliance.heldCents > 0 ? "text-destructive" : "text-muted-foreground/70",
        )}
      >
        {held}
      </span>
      <span className="w-16 shrink-0" />
    </Link>
  )
}

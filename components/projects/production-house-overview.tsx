import Link from "next/link"

import type { ProductionHouseOverviewData } from "@/lib/services/production-house-overview"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function Metric({ label, value, href }: { label: string; value: string; href?: string }) {
  const content = <><p className="text-xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></>
  return href ? <Link className="p-4 hover:bg-muted/20" href={href}>{content}</Link> : <div className="p-4">{content}</div>
}

export function ProductionHouseOverview({ data }: { data: ProductionHouseOverviewData }) {
  const i = data.identity
  const m = data.money
  return (
    <div>
      <header className="border-b px-5 py-5 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {i.communityId ? <Link className="hover:underline" href={`/communities/${i.communityId}`}>{i.communityName}</Link> : <span>{i.communityName}</span>}
              {i.phaseName ? <><span>/</span><span>{i.phaseName}</span></> : null}
              {i.lotNumber ? <><span>/</span><span>Lot {i.lotNumber}</span></> : null}
            </div>
            <h1 className="mt-1 text-xl font-semibold">{i.projectName}</h1>
            <p className="text-sm text-muted-foreground">{i.address ?? "Address not assigned"}</p>
          </div>
          <div className="text-right text-xs text-muted-foreground"><p>{i.buyer ?? "SPEC"}</p><p>{i.superintendent ?? "Superintendent unassigned"}</p></div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {i.planId ? <Link className="font-medium hover:underline" href={`/plans/${i.planId}`}>{i.planName}</Link> : <span>{i.planName}</span>}
          <span>{[i.elevation, i.swing].filter(Boolean).join(" · ") || "Standard elevation"}</span>
          <span>Plan v{i.version ?? "—"}</span>
          <span>Released {i.startReleasedDate ?? "—"}</span>
          <span>Closing {i.projectedClosing ?? "—"}</span>
        </div>
      </header>

      <div className="grid border-b lg:grid-cols-[1.1fr_1fr]">
        <section className="border-b p-5 lg:border-b-0 lg:border-r sm:p-8">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stage & schedule</p>
          <div className="mt-3 flex items-end justify-between"><div><p className="text-2xl font-semibold">{data.schedule.currentStage}</p><p className="text-sm text-muted-foreground">{data.schedule.completed} of {data.schedule.total} tasks · {data.schedule.progress}% · {data.schedule.daysElapsed ?? "—"} days elapsed{data.schedule.communityAverageCycleDays != null ? ` vs ${data.schedule.communityAverageCycleDays}d community median` : ""}</p></div><Link className="text-xs underline underline-offset-4" href={`/projects/${i.projectId}/schedule`}>Full schedule</Link></div>
          <div className="mt-5 divide-y border">{data.schedule.next.map((row) => <Link className="grid grid-cols-[1fr_7rem] gap-3 px-3 py-2.5 text-sm hover:bg-muted/20" href={`/projects/${i.projectId}/schedule`} key={row.id}><span>{row.name}</span><span className="text-right text-xs tabular-nums text-muted-foreground">{row.date ?? row.status}</span></Link>)}</div>
        </section>
        <section className="p-5 sm:p-8">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Money as variance</p>
          <div className="mt-3 grid grid-cols-2 border">
            <Metric label="Base + premium" value={money(m.basePriceCents + m.lotPremiumCents)} />
            <Metric label="Options + selections + COs" value={money(m.structuralOptionsCents + m.selectionsCents + m.changeOrdersCents)} />
            <Metric label="Generated budget / actual" value={`${money(m.budgetCents)} / ${money(m.actualCostCents)}`} href={`/projects/${i.projectId}/budget`} />
            <Metric label={`${m.vpoCount} VPOs${m.topVpoReason ? ` · ${m.topVpoReason}` : ""}`} value={money(m.vpoCents)} href="/purchasing?tab=variance" />
          </div>
          <div className="mt-4 border-l-2 pl-4"><p className="text-2xl font-semibold tabular-nums">{money(m.projectedMarginCents)} · {m.projectedMarginPercent.toFixed(1)}%</p><p className="text-xs text-muted-foreground">Projected margin after direct cost and VPOs</p></div>
        </section>
      </div>

      <section className="grid border-b sm:grid-cols-3">
        <Metric label={`Start package · ${data.gates.startPassed}/${data.gates.startTotal} gates`} value={data.gates.startStatus} href="/starts" />
        <Metric label={data.gates.nextCutoff ? `Next cutoff · ${data.gates.nextCutoff}` : "No open cutoff"} value={data.gates.selectionStatus} href={`/projects/${i.projectId}/selections`} />
        <Metric label={`${data.gates.closingOpen}/${data.gates.closingTotal} checklist items open`} value={data.gates.closingStatus} href={`/projects/${i.projectId}/closing`} />
      </section>

      <section className="grid grid-cols-2 divide-x text-xs sm:grid-cols-4">
        <Link className="p-4 hover:bg-muted/20" href={`/projects/${i.projectId}/punch`}>{data.quiet.openPunch} open punch items</Link>
        <Link className="p-4 hover:bg-muted/20" href={`/projects/${i.projectId}/photos`}>Latest photo · {data.quiet.latestPhotoAt?.slice(0, 10) ?? "none"}</Link>
        <Link className="p-4 hover:bg-muted/20" href={`/projects/${i.projectId}/daily-logs`}>Latest daily log · {data.quiet.latestDailyLogDate ?? "none"}</Link>
        <Link className="p-4 hover:bg-muted/20" href={`/projects/${i.projectId}/warranty`}>{data.quiet.openWarranty} open warranty items</Link>
      </section>
    </div>
  )
}

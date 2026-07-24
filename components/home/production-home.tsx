import Link from "next/link"

import type { ProductionHomeData } from "@/lib/services/production-home"
import { cn } from "@/lib/utils"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

export function ProductionHome({ data, showCustomProjects }: { data: ProductionHomeData; showCustomProjects: boolean }) {
  if (!data.hasCommunities) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <div className="max-w-lg border p-8">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Production setup</p>
          <h2 className="mt-2 text-xl font-semibold">Build the operating spine</h2>
          <p className="mt-2 text-sm text-muted-foreground">Create a community, load plans and lots, then release the first start package. Arc will populate this tempo view as work moves.</p>
          <div className="mt-5 flex gap-3 text-sm"><Link className="font-medium underline underline-offset-4" href="/communities">Create a community</Link><Link className="text-muted-foreground underline underline-offset-4" href="/admin/provision">Open onboarding</Link></div>
        </div>
      </div>
    )
  }
  const stats = [
    { href: "/starts", value: `${data.stats.startsReleased} / ${data.stats.startsTarget}`, label: "Starts this week · released / target" },
    { href: "/sales?tab=closings", value: `${data.stats.closingsScheduled} / ${data.stats.closingsCleared}`, label: `Closings this month · scheduled / cleared · ${money(data.stats.closingValueCents)}` },
    { href: "/my-houses", value: String(data.stats.underConstruction), label: `Homes under construction · ${data.stats.averageCycleDays == null ? "cycle target pending" : `${data.stats.averageCycleDays}d median cycle`}` },
    { href: "/purchasing?tab=variance", value: money(data.stats.vpoWeekCents), label: `VPO this week · ${data.stats.vpoPercentDirectCost.toFixed(2)}% direct cost` },
    { href: "/sales?tab=backlog", value: String(data.stats.backlogUnits), label: `Backlog · ${money(data.stats.backlogValueCents)} · ${data.stats.specUnits} spec` },
  ]
  return (
    <div className="flex min-h-full flex-col">
      {showCustomProjects ? <Link className="border-b bg-muted/20 px-5 py-2 text-xs text-muted-foreground hover:text-foreground" href="/control-tower">Custom projects are active · open the custom project control tower →</Link> : null}
      <div className="grid border-b sm:grid-cols-2 xl:grid-cols-5">
        {stats.map((stat) => <Link className="border-b p-5 hover:bg-muted/20 sm:border-r xl:border-b-0" href={stat.href} key={stat.href}><p className="text-2xl font-semibold tabular-nums">{stat.value}</p><p className="mt-1 text-xs text-muted-foreground">{stat.label}</p></Link>)}
      </div>
      <div className="grid flex-1 lg:grid-cols-2">
        <section className="border-b lg:border-b-0 lg:border-r">
          <div className="border-b px-5 py-4"><h2 className="text-sm font-semibold">Exceptions</h2><p className="text-xs text-muted-foreground">What is jamming the line right now.</p></div>
          <div className="divide-y">{data.exceptions.map((item) => <Link className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-muted/20" href={item.href} key={item.id}><div><p className="text-sm font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.detail}</p></div><span className={cn("h-2 w-2 shrink-0 rounded-full", item.tone === "danger" ? "bg-destructive" : item.tone === "warning" ? "bg-amber-500" : "bg-muted-foreground")} /></Link>)}</div>
          {data.exceptions.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">No production exceptions need attention.</p> : null}
        </section>
        <section>
          <div className="border-b px-5 py-4"><h2 className="text-sm font-semibold">Two-week lookahead</h2><p className="text-xs text-muted-foreground">Releases, closings, selection cutoffs, and lot takedowns.</p></div>
          <div className="divide-y">{data.lookahead.map((item) => <Link className="grid grid-cols-[6rem_8rem_1fr] gap-3 px-5 py-3 text-sm hover:bg-muted/20" href={item.href} key={item.id}><span className="tabular-nums text-muted-foreground">{item.date}</span><span className="text-xs text-muted-foreground">{item.type}</span><span className="font-medium">{item.label}</span></Link>)}</div>
          {data.lookahead.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">Nothing scheduled in the next two weeks.</p> : null}
        </section>
      </div>
    </div>
  )
}

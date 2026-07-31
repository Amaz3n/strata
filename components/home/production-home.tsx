import Link from "next/link"

import { AssignedTile } from "@/components/home/assigned-tile"
import { NowActivities } from "@/components/home/now-activities"
import { shortDate } from "@/components/home/short-date"
import { LinkTile, type TileContent } from "@/components/home/stat-tile"
import { ArrowUpRight } from "@/components/icons"
import type { FieldWindow, ProductionHomeData } from "@/lib/services/production-home"
import { cn } from "@/lib/utils"

/** Four is a glimpse. Five is a dashboard. */
const TILE_CAP = 4

const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 xl:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
}

const WINDOWS: Array<{ key: FieldWindow; label: string }> = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "twoweek", label: "2 wk" },
]

const TILE_HREF: Record<string, string> = {
  starts: "/starts",
  closings: "/sales?tab=closings",
  construction: "/projects",
  backlog: "/sales?tab=backlog",
  purchasing: "/purchasing?tab=variance",
}

function money(cents: number) {
  const dollars = cents / 100
  if (dollars >= 1_000_000) {
    const millions = dollars / 1_000_000
    return `$${(millions >= 10 ? millions.toFixed(1) : millions.toFixed(2)).replace(/\.?0+$/, "")}M`
  }
  if (dollars >= 10_000) return `$${Math.round(dollars / 1_000)}K`
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return `$${Math.round(dollars).toLocaleString()}`
}

export function ProductionHome({ data, showCustomProjects }: { data: ProductionHomeData; showCustomProjects: boolean }) {
  if (!data.hasCommunities) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <div className="desk-rise max-w-lg border p-8">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">Production setup</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">Build the operating spine</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Create a community, load plans and lots, then release the first start package. Arc will populate this
            view as work moves.
          </p>
          <div className="mt-5 flex gap-4 text-sm">
            <Link className="font-medium underline underline-offset-4" href="/communities">Create a community</Link>
            <Link className="text-muted-foreground underline underline-offset-4" href="/admin/provision">Open onboarding</Link>
          </div>
        </div>
      </div>
    )
  }

  const { assigned, now, next } = data
  const tiles = buildTiles(data).slice(0, TILE_CAP)

  return (
    <div className="flex min-h-full flex-col">
      {showCustomProjects && (
        <Link
          className="flex items-center gap-1.5 border-b px-5 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          href="/control-tower"
        >
          Custom projects are active · open the custom project control tower
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      )}

      {tiles.length > 0 && (
        <section
          className={cn("desk-rise grid border-b", COLUMNS[Math.min(tiles.length, TILE_CAP)])}
          style={{ "--desk-stagger": 0 } as React.CSSProperties}
        >
          {tiles.map((tile, index) => {
            const last = index === tiles.length - 1
            return tile.key === "assigned" && assigned ? (
              <AssignedTile content={tile} houses={assigned.houses} key={tile.key} last={last} />
            ) : (
              <LinkTile content={tile} href={TILE_HREF[tile.key] ?? "/projects"} key={tile.key} last={last} />
            )
          })}
        </section>
      )}

      {/* Two panes, always, for everyone. Now is what needs you; Next is what is
          coming. An item is in exactly one of them — its status decides which. */}
      <div className="desk-rise grid lg:grid-cols-2" style={{ "--desk-stagger": 1 } as React.CSSProperties}>
        <section className="border-b lg:border-b-0 lg:border-r">
          <PaneHead
            title="Now"
            trailing={
              now.kind === "activities" ? (
                <nav aria-label="Work window" className="flex items-center gap-0.5">
                  {WINDOWS.map((option) => (
                    <Link
                      aria-current={now.window === option.key ? "page" : undefined}
                      className={cn(
                        "px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] transition-colors",
                        now.window === option.key
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      href={option.key === "week" ? "/" : `/?w=${option.key}`}
                      key={option.key}
                      scroll={false}
                    >
                      {option.label}
                    </Link>
                  ))}
                </nav>
              ) : undefined
            }
          />
          {now.kind === "activities" ? (
            <NowActivities groups={now.groups} truncated={now.truncated} />
          ) : now.items.length === 0 ? (
            <PaneEmpty>Nothing is blocked.</PaneEmpty>
          ) : (
            <div>
              {now.items.map((item) => (
                <Link
                  className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-foreground/[0.03]"
                  href={item.href}
                  key={item.id}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      item.tone === "danger" ? "bg-destructive" : "bg-warning",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">{item.label}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{item.detail}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <PaneHead title="Next" />
          {next.length === 0 ? (
            <PaneEmpty>Nothing in the next two weeks.</PaneEmpty>
          ) : (
            <div>
              {next.map((item) => (
                <Link
                  className="flex items-baseline gap-3 px-5 py-2.5 text-[13px] transition-colors hover:bg-foreground/[0.03]"
                  href={item.href}
                  key={item.id}
                >
                  <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{shortDate(item.date)}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground/70">{item.type}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function PaneHead({ title, trailing }: { title: string; trailing?: React.ReactNode }) {
  return (
    <div className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-5 py-2.5">
      <h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">{title}</h2>
      {trailing}
    </div>
  )
}

function PaneEmpty({ children }: { children: React.ReactNode }) {
  return <p className="p-8 text-center text-sm text-muted-foreground">{children}</p>
}

/**
 * Ordered by who needs it most, then capped. Your own work leads; the org-wide
 * numbers follow in the order a production builder reads them — release rate,
 * closings, work in progress, backlog. Purchasing sits last because only a
 * purchasing manager holds the key that surfaces it, and they hold few of the
 * others, so it still reaches them inside the cap.
 */
function buildTiles(data: ProductionHomeData): TileContent[] {
  const tiles: TileContent[] = []
  const { assigned } = data
  const { starts, closings, construction, purchasing, backlog } = data.stats

  if (assigned) {
    const trouble = [
      assigned.lateCount > 0 ? `${assigned.lateCount} late` : null,
      assigned.missingLogCount > 0 ? `${assigned.missingLogCount} missing logs` : null,
    ].filter(Boolean)
    tiles.push({
      key: "assigned",
      label: "Your homes",
      value: String(assigned.houseCount),
      detail: trouble.length ? trouble.join(" · ") : "All current",
      ratio: assigned.houseCount > 0
        ? Math.max(0, assigned.houseCount - assigned.lateCount) / assigned.houseCount
        : null,
      status: assigned.lateCount > 0
        ? { tone: "destructive", label: `${assigned.lateCount} late` }
        : assigned.missingLogCount > 0
          ? { tone: "warning", label: "Logs due" }
          : { tone: "success", label: "Current" },
    })
  }

  if (starts) {
    tiles.push({
      key: "starts",
      label: "Starts · week",
      value: `${starts.released} / ${starts.target}`,
      detail: starts.target === 0 ? "No even-flow target set" : "Released against target",
      ratio: starts.target > 0 ? starts.released / starts.target : null,
      status:
        starts.target === 0
          ? null
          : starts.released >= starts.target
            ? { tone: "success", label: "On pace" }
            : starts.released / starts.target >= 0.7
              ? { tone: "warning", label: `${starts.target - starts.released} short` }
              : { tone: "destructive", label: "Behind" },
    })
  }

  if (closings) {
    const open = closings.scheduled - closings.cleared
    tiles.push({
      key: "closings",
      label: "Closings · month",
      value: `${closings.cleared} / ${closings.scheduled}`,
      detail: closings.scheduled === 0 ? "Nothing scheduled" : `${money(closings.valueCents)} scheduled`,
      ratio: closings.scheduled > 0 ? closings.cleared / closings.scheduled : null,
      status:
        closings.scheduled === 0
          ? null
          : open === 0
            ? { tone: "success", label: "All cleared" }
            : { tone: "warning", label: `${open} open` },
    })
  }

  if (construction) {
    tiles.push({
      key: "construction",
      label: "Under construction",
      value: String(construction.underConstruction),
      detail:
        construction.averageCycleDays == null
          ? "Cycle target pending"
          : `${construction.averageCycleDays}d median cycle`,
      ratio: null,
      status: null,
    })
  }

  if (backlog) {
    tiles.push({
      key: "backlog",
      label: "Backlog",
      value: String(backlog.units),
      detail: `${money(backlog.valueCents)} · ${backlog.specUnits} spec`,
      // Sold share of the backlog; spec is already named in the detail line.
      ratio: backlog.units > 0 ? Math.min((backlog.units - backlog.specUnits) / backlog.units, 1) : null,
      status: null,
    })
  }

  if (purchasing) {
    tiles.push({
      key: "purchasing",
      label: "VPO · week",
      value: money(purchasing.vpoWeekCents),
      detail: `${purchasing.percentDirectCost.toFixed(2)}% of direct cost`,
      // Read against a 3% ceiling so the bar means something rather than filling.
      ratio: Math.min(purchasing.percentDirectCost / 3, 1),
      status:
        purchasing.vpoWeekCents === 0
          ? { tone: "success", label: "None" }
          : purchasing.percentDirectCost >= 3
            ? { tone: "destructive", label: "High" }
            : purchasing.percentDirectCost >= 1.5
              ? { tone: "warning", label: "Watch" }
              : { tone: "success", label: "In band" },
    })
  }

  return tiles
}

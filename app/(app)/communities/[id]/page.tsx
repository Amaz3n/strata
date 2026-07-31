import { notFound } from "next/navigation"

import { CommunityInventory } from "@/components/communities/community-inventory"
import type { LotMoney } from "@/components/communities/lot-inspector"
import { isLotStatus } from "@/lib/land/lot-lifecycle"
import {
  countCommunityLotsByStatus,
  INVENTORY_MAP_PAGE_SIZE,
  INVENTORY_TABLE_PAGE_SIZE,
  isInventorySort,
  listCommunityInventory,
  type CommunityInventoryPage,
} from "@/lib/services/community-inventory"
import { getCommunity } from "@/lib/services/communities"
import { listAttachableProjects } from "@/lib/services/lots"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getCommunityPnl } from "@/lib/services/production-reporting"

export const dynamic = "force-dynamic"

interface InventoryPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    view?: string
    status?: string
    phase?: string
    q?: string
    page?: string
    sort?: string
    dir?: string
  }>
}

/**
 * Margin lives in the P&L rather than on the lot, so Postgres cannot order by
 * it. Sorting by margin therefore pulls the community in one page and orders it
 * here, where both halves are already in hand.
 */
function sortByMargin(
  inventory: CommunityInventoryPage,
  money: Record<string, LotMoney>,
  direction: "asc" | "desc",
  page: number,
): CommunityInventoryPage {
  const sign = direction === "desc" ? -1 : 1
  const ranked = [...inventory.lots].sort((a, b) => {
    const left = a.projectId ? money[a.projectId]?.projectedMarginPercent : undefined
    const right = b.projectId ? money[b.projectId]?.projectedMarginPercent : undefined
    // A lot with no home has no margin, so it sorts to the bottom either way
    // rather than pretending to be the best or the worst lot in the community.
    if (left == null && right == null) return 0
    if (left == null) return 1
    if (right == null) return -1
    return (left - right) * sign
  })
  const from = (page - 1) * INVENTORY_TABLE_PAGE_SIZE
  return {
    lots: ranked.slice(from, from + INVENTORY_TABLE_PAGE_SIZE),
    total: inventory.total,
    page,
    pageSize: INVENTORY_TABLE_PAGE_SIZE,
    truncated: inventory.total > from + INVENTORY_TABLE_PAGE_SIZE,
  }
}

export default async function CommunityInventoryPage({ params, searchParams }: InventoryPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const view = query.view === "map" ? "map" : "table"
  const direction = query.dir === "desc" ? "desc" : "asc"
  const page = Number(query.page) > 0 ? Number(query.page) : 1

  const [community, permissions] = await Promise.all([getCommunity(id).catch(() => null), getCurrentUserPermissions()])
  if (!community) notFound()

  const canWrite = permissions.permissions.some((permission) => ["lot.write", "org.admin", "*"].includes(permission))
  const canReadMoney = permissions.permissions.some((permission) =>
    ["report.read", "org.admin", "*"].includes(permission),
  )

  const byMargin = query.sort === "margin" && canReadMoney

  const [inventory, pnl, projects, statusCounts] = await Promise.all([
    listCommunityInventory(id, {
      status: isLotStatus(query.status) ? query.status : undefined,
      phaseId: query.phase,
      search: query.q,
      sort: isInventorySort(query.sort) ? query.sort : undefined,
      direction,
      // The map draws every lot it has and a margin sort has to see every lot
      // before it can rank one; the table pages normally.
      page: view === "map" || byMargin ? 1 : page,
      pageSize: view === "map" || byMargin ? INVENTORY_MAP_PAGE_SIZE : INVENTORY_TABLE_PAGE_SIZE,
    }),
    canReadMoney ? getCommunityPnl(id).catch(() => null) : Promise.resolve(null),
    canWrite ? listAttachableProjects(id).catch(() => []) : Promise.resolve([]),
    countCommunityLotsByStatus(id, { phaseId: query.phase, search: query.q }).catch(() => null),
  ])

  const money: Record<string, LotMoney> = {}
  for (const row of pnl?.lots ?? []) {
    money[row.projectId] = {
      revenueCents: row.revenueCents,
      budgetCents: row.budgetCents,
      actualCostCents: row.actualCostCents,
      vpoCents: row.vpoCents,
      projectedMarginCents: row.projectedMarginCents,
      projectedMarginPercent: row.projectedMarginPercent,
    }
  }

  return (
    <CommunityInventory
      community={community}
      inventory={byMargin ? sortByMargin(inventory, money, direction, page) : inventory}
      statusCounts={statusCounts}
      marginSortCap={byMargin && inventory.total > INVENTORY_MAP_PAGE_SIZE ? INVENTORY_MAP_PAGE_SIZE : null}
      money={money}
      marginTargetPercent={pnl?.targetMarginPercent ?? null}
      projects={projects}
      canWrite={canWrite}
      canReadMoney={canReadMoney}
      view={view}
      sort={byMargin ? "margin" : isInventorySort(query.sort) ? query.sort : "lot"}
      direction={direction}
    />
  )
}

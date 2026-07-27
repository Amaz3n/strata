import { notFound } from "next/navigation"

import { CommunityPlat } from "@/components/communities/community-plat"
import type { LotMoney } from "@/components/communities/lot-inspector"
import { getCommunity } from "@/lib/services/communities"
import { listAttachableProjects, listLotsForPlat } from "@/lib/services/lots"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getCommunityPnl } from "@/lib/services/production-reporting"

export const dynamic = "force-dynamic"

export default async function CommunityPlatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [community, plat, permissions] = await Promise.all([
    getCommunity(id).catch(() => null),
    listLotsForPlat(id),
    getCurrentUserPermissions(),
  ])
  if (!community) notFound()

  const canWrite = permissions.permissions.some((permission) => ["lot.write", "org.admin", "*"].includes(permission))
  const canReadMoney = permissions.permissions.some((permission) => ["report.read", "org.admin", "*"].includes(permission))

  // The margin lens and the inspector's money block replace the old P&L tab.
  // Without report.read the plat simply loses that one lens.
  const [projects, pnl] = await Promise.all([
    canWrite ? listAttachableProjects(id).catch(() => []) : Promise.resolve([]),
    canReadMoney ? getCommunityPnl(id).catch(() => null) : Promise.resolve(null),
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
    <CommunityPlat
      community={community}
      lots={plat.lots}
      total={plat.total}
      truncated={plat.truncated}
      money={money}
      projects={projects}
      canWrite={canWrite}
    />
  )
}

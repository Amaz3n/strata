import { notFound } from "next/navigation"

import { LotTable } from "@/components/communities/lot-table"
import { getCommunity } from "@/lib/services/communities"
import { getLotStatusCounts, listLinkedLotProjectIds, listLots } from "@/lib/services/lots"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listProjects } from "@/lib/services/projects"
import { LOT_STATUSES, type LotStatus } from "@/lib/land/lot-lifecycle"

export const dynamic = "force-dynamic"

export default async function CommunityLotsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string; status?: string; phase?: string; q?: string }> }) {
  const [{ id }, filters] = await Promise.all([params, searchParams])
  const page = Math.max(1, Number(filters.page) || 1)
  const status: LotStatus | undefined = LOT_STATUSES.find((candidate) => candidate === filters.status)
  const [community, lotsPage, counts, permissions, projects, linkedProjectIds] = await Promise.all([
    getCommunity(id).catch(() => null),
    listLots(id, { page, pageSize: 100, status, phaseId: filters.phase, search: filters.q }),
    getLotStatusCounts(id),
    getCurrentUserPermissions(),
    listProjects().catch(() => []),
    listLinkedLotProjectIds().catch(() => []),
  ])
  if (!community) notFound()
  const linkedProjectSet = new Set(linkedProjectIds)
  const availableProjects = projects.filter((project) => !linkedProjectSet.has(project.id) && !["completed", "cancelled"].includes(project.status) && (!project.property_type || project.property_type === "production")).map((project) => ({ id: project.id, name: project.name }))
  const canWrite = permissions.permissions.some((permission) => ["lot.write", "org.admin", "*"].includes(permission))
  return <LotTable communityId={id} lots={lotsPage.lots} counts={counts} phases={community.phases} takedowns={community.takedowns} projects={availableProjects} total={lotsPage.total} page={lotsPage.page} pageSize={lotsPage.pageSize} filters={{ status: filters.status, phase: filters.phase, q: filters.q }} canWrite={canWrite} />
}

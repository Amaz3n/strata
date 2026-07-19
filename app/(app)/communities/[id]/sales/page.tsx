import { notFound } from "next/navigation"

import {
  SalesTab,
  type ClosingRowDTO,
  type PriceSheetRowDTO,
  type ReservationRowDTO,
  type SpecRowDTO,
} from "@/components/communities/sales-tab"
import { getCommunity } from "@/lib/services/communities"
import { getCommunityPriceSheet, getCommunitySalesPipeline } from "@/lib/services/community-sales"
import { listContacts } from "@/lib/services/contacts"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function CommunitySalesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [community, pipeline, priceSheet, permissions, contacts] = await Promise.all([
    getCommunity(id).catch(() => null),
    getCommunitySalesPipeline(id),
    getCommunityPriceSheet(id),
    getCurrentUserPermissions(),
    listContacts().catch(() => []),
  ])
  if (!community) notFound()
  const canManage = permissions.permissions.some((permission) => ["sales.manage", "org.admin", "*"].includes(permission))

  const toReservationRow = (row: (typeof pipeline.holds)[number]): ReservationRowDTO => ({
    id: row.id,
    lotLabel: row.lotLabel,
    buyerName: row.buyerName,
    status: row.status,
    expiresAt: row.expiresAt,
    askingPriceCents: row.askingPriceCents,
    depositRequiredCents: row.depositRequiredCents,
    projectId: row.projectId,
  })

  const specs: SpecRowDTO[] = pipeline.specs.map((row) => ({
    lotId: row.lotId,
    lotLabel: row.lotLabel,
    projectId: row.projectId,
    planLabel: row.planLabel,
    agingDays: row.agingDays,
    askingPriceCents: row.askingPriceCents,
  }))

  const priceRows: PriceSheetRowDTO[] = priceSheet.rows.map((row) => ({
    key: `${row.planId}-${row.elevationId ?? "base"}`,
    planName: row.planName ?? "—",
    elevationName: row.elevationName,
    beds: row.beds ?? null,
    baths: row.baths ?? null,
    sqft: row.sqft ?? null,
    fromPriceCents: row.fromPriceCents,
  }))

  const closings: ClosingRowDTO[] = pipeline.closings.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project?.name ?? "Home",
    lotLabel: row.lot?.lot_number ?? null,
    status: String(row.status),
    scheduledDate: row.scheduled_date ?? null,
  }))

  return (
    <SalesTab
      specs={specs}
      holds={pipeline.holds.map(toReservationRow)}
      reserved={pipeline.reserved.map(toReservationRow)}
      agreements={pipeline.agreements.map(toReservationRow)}
      priceSheet={priceRows}
      incentives={priceSheet.incentives.map((row) => ({ id: String(row.id), name: String(row.name) }))}
      premiumRange={{ minCents: priceSheet.minPremiumCents, maxCents: priceSheet.maxPremiumCents }}
      asOfDate={priceSheet.asOfDate}
      closings={closings}
      buyers={contacts.map((contact) => ({ id: contact.id, name: contact.full_name }))}
      canManage={canManage}
    />
  )
}

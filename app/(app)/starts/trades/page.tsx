import { PageLayout } from "@/components/layout/page-layout"
import { TradeLookaheadClient } from "@/components/starts/trade-lookahead-client"
import { getTradeLookahead } from "@/lib/services/trade-lookahead"

export const dynamic = "force-dynamic"

export default async function TradeLookaheadPage({ searchParams }: { searchParams: Promise<{ weeks?: string }> }) {
  const params = await searchParams
  const weeks = params.weeks === "2" || params.weeks === "4" ? Number(params.weeks) as 2 | 4 : 3
  const result = await getTradeLookahead({ weeks, pageSize: 100 })
  return <PageLayout title="Trade look-aheads"><div className="space-y-3 p-4"><p className="text-sm text-muted-foreground">Upcoming production work grouped by assigned trade company. Sending is deduplicated once per company per day.</p><TradeLookaheadClient rows={result.rows} weeks={weeks} /></div></PageLayout>
}

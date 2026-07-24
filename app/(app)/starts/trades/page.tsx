import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { TradeLookaheadClient } from "@/components/starts/trade-lookahead-client"
import { getTradeLookahead } from "@/lib/services/trade-lookahead"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

const WINDOWS = [2, 3, 4] as const

export default async function TradeLookaheadPage({ searchParams }: { searchParams: Promise<{ weeks?: string }> }) {
  const params = await searchParams
  const weeks = params.weeks === "2" || params.weeks === "4" ? (Number(params.weeks) as 2 | 4) : 3
  const result = await getTradeLookahead({ weeks, pageSize: 100 })
  return (
    <PageLayout title="Trade look-aheads">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Upcoming production work grouped by trade company. Sending is deduplicated once per company per day.
          </p>
          <div className="flex border text-xs" role="group" aria-label="Look-ahead window">
            {WINDOWS.map((window) => (
              <Link
                key={window}
                href={window === 3 ? "/starts/trades" : `/starts/trades?weeks=${window}`}
                className={cn(
                  "px-3 py-1.5 tabular-nums",
                  window === weeks ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground",
                )}
                aria-current={window === weeks ? "true" : undefined}
              >
                {window} wk
              </Link>
            ))}
          </div>
        </div>
        <TradeLookaheadClient rows={result.rows} weeks={weeks} />
      </div>
    </PageLayout>
  )
}

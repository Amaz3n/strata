import { MetaBlock, Note } from "@/components/sales/overview/meta-block"
import { INQUIRY_CHANNEL_LABELS, isInquiryChannel } from "@/lib/sales/activity"
import { formatDealDate } from "@/lib/sales/dates"
import type { ProspectAttribution, ProspectAttributionHistory } from "@/lib/services/prospects"

function channelLabel(channel: ProspectAttribution["channel"]) {
  return isInquiryChannel(channel) ? INQUIRY_CHANNEL_LABELS[channel] : "Import"
}

/** "google / cpc · spring-open-house" — what a marketer reads a touch by. */
function campaignLine(touch: ProspectAttribution) {
  const medium = [touch.utmSource, touch.utmMedium].filter(Boolean).join(" / ")
  return [medium, touch.utmCampaign].filter(Boolean).join(" · ") || null
}

function hostAndPath(url: string | null) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return url
  }
}

/**
 * Where the buyer came from, every time they came: the first touch and each
 * later submission that merged into this deal, newest last, with campaign and
 * landing page. A buyer won or lost before says so, because "came back" is the
 * most useful thing a consultant can know before calling.
 */
export function DealOverviewAttribution({ history }: { history: ProspectAttributionHistory | null }) {
  const touches = history?.touches ?? []
  return (
    <MetaBlock
      title="Attribution"
      count={touches.length > 1 ? `${touches.length} touches${history?.truncated ? ", first 50 shown" : ""}` : null}
    >
      {history?.returningFrom ? (
        <p className="mb-3 border-l-2 border-l-warning bg-warning/5 px-2.5 py-1.5 text-xs">
          Returning buyer — {history.returningFrom.status === "won" ? "bought" : "lost"} on an earlier deal
          {history.returningFrom.closedAt ? ` (${formatDealDate(history.returningFrom.closedAt)})` : ""}.
        </p>
      ) : null}
      {touches.length === 0 ? (
        <Note>No touches recorded — this deal was entered before lead attribution existed.</Note>
      ) : (
        <ol className="divide-y border-y">
          {touches.map((touch) => {
            const campaign = campaignLine(touch)
            const landing = hostAndPath(touch.landingUrl)
            return (
              <li key={touch.id} className="space-y-0.5 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{touch.touch === 1 ? "First touch" : `Touch ${touch.touch}`}</span>
                    <span className="ml-1.5 text-muted-foreground">
                      {channelLabel(touch.channel)}
                      {touch.sourceLabel ? ` · ${touch.sourceLabel}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDealDate(touch.occurredAt)}</span>
                </div>
                {campaign || touch.communityName ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {[campaign, touch.communityName].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
                {landing ? (
                  <p className="truncate text-xs text-muted-foreground" title={touch.landingUrl ?? undefined}>
                    Landed on {landing}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
    </MetaBlock>
  )
}

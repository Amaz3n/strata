import { FileText, MapPin } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { BidPortalSheet } from "@/lib/services/bid-portal"

/** The site walk is read before pricing, so it sits in the brief. */
export function BidSiteWalk({ at }: { at: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Site walk</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-2 text-sm">
        <MapPin className="h-4 w-4 text-muted-foreground" />
        {new Date(at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
      </CardContent>
    </Card>
  )
}

/** The sheets this request is priced from. Each opens as its own page. */
export function BidPlans({ token, sheets }: { token: string; sheets: BidPortalSheet[] }) {
  return (
    <ul className="grid gap-px border bg-border sm:grid-cols-2">
      {sheets.map((sheet) => (
        <li key={sheet.id} className="bg-card">
          <a
            href={`/api/portal/b/${encodeURIComponent(token)}/sheets/${sheet.id}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 px-3 py-2.5 text-sm transition-colors duration-150 hover:bg-muted/50"
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="w-16 shrink-0 font-mono text-xs font-semibold">{sheet.sheet_number}</span>
            <span className="min-w-0 truncate text-muted-foreground">{sheet.sheet_title ?? "Untitled sheet"}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

import type { Retainage } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

interface RetainageTrackerProps {
  retainage: Retainage[]
  compact?: boolean
}

export function RetainageTracker({ retainage, compact = false }: RetainageTrackerProps) {
  if (!retainage.length) {
    return (
      <Card>
        <CardHeader className={compact ? "pb-3" : ""}>
          <CardTitle className={compact ? "text-sm font-semibold" : "text-base"}>Retainage</CardTitle>
        </CardHeader>
        <CardContent className={compact ? "pt-0" : ""}>
          <p className={compact ? "text-xs sm:text-sm text-muted-foreground" : "text-sm text-muted-foreground"}>No retainage held for this project.</p>
        </CardContent>
      </Card>
    )
  }

  const totalHeld = retainage.reduce((sum, r) => sum + (r.status === "held" ? r.amount_cents : 0), 0)
  const released = retainage.reduce((sum, r) => sum + (r.status === "released" || r.status === "paid" ? r.amount_cents : 0), 0)
  const percentReleased = totalHeld + released > 0 ? Math.round((released / (totalHeld + released)) * 100) : 0

  return (
    <Card>
      <CardHeader className={compact ? "pb-3" : ""}>
        <CardTitle className={compact ? "text-sm font-semibold" : "text-base"}>Retainage</CardTitle>
      </CardHeader>
      <CardContent className={compact ? "pt-0 space-y-2" : "space-y-3"}>
        <div className={`flex items-center justify-between ${compact ? "text-xs sm:text-sm" : "text-sm"}`}>
          <div className="text-muted-foreground">Released</div>
          <div className="font-semibold">{percentReleased}%</div>
        </div>
        <Progress value={percentReleased} />
        <div className={`grid grid-cols-2 ${compact ? "gap-2 sm:gap-3 text-xs sm:text-sm" : "gap-3 text-sm"}`}>
          <InfoItem label="Held" value={formatCurrency(totalHeld)} compact={compact} />
          <InfoItem label="Released" value={formatCurrency(released)} compact={compact} />
        </div>
      </CardContent>
    </Card>
  )
}

function InfoItem({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={compact ? "space-y-0.5" : "space-y-1"}>
      <div className={compact ? "text-[10px] sm:text-xs uppercase tracking-wide text-muted-foreground" : "text-xs uppercase tracking-wide text-muted-foreground"}>{label}</div>
      <div className={`font-medium text-foreground ${compact ? "text-xs sm:text-sm" : ""}`}>{value}</div>
    </div>
  )
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

import type { Retainage } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

interface RetainageTrackerProps {
  retainage: Retainage[]
}

export function RetainageTracker({ retainage }: RetainageTrackerProps) {
  if (!retainage.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retainage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No retainage held for this project.</p>
        </CardContent>
      </Card>
    )
  }

  const totalHeld = retainage.reduce((sum, r) => sum + (r.status === "held" ? r.amount_cents : 0), 0)
  const released = retainage.reduce((sum, r) => sum + (r.status === "released" || r.status === "paid" ? r.amount_cents : 0), 0)
  const percentReleased = totalHeld + released > 0 ? Math.round((released / (totalHeld + released)) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Retainage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <div className="text-muted-foreground">Released</div>
          <div className="font-semibold">{percentReleased}%</div>
        </div>
        <Progress value={percentReleased} />
        <div className="grid grid-cols-2 gap-3 text-sm">
          <InfoItem label="Held" value={formatCurrency(totalHeld)} />
          <InfoItem label="Released" value={formatCurrency(released)} />
        </div>
      </CardContent>
    </Card>
  )
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium text-foreground">{value}</div>
    </div>
  )
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

import { format } from "date-fns"

import type { DrawSchedule } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

const statusMap: Record<string, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "bg-amber-100 text-amber-700" },
  invoiced: { label: "Invoiced", tone: "bg-blue-100 text-blue-700" },
  partial: { label: "Partial", tone: "bg-purple-100 text-purple-700" },
  paid: { label: "Paid", tone: "bg-emerald-100 text-emerald-700" },
}

interface DrawScheduleTableProps {
  draws: DrawSchedule[]
}

export function DrawScheduleTable({ draws }: DrawScheduleTableProps) {
  if (!draws.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Draw Schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No draws scheduled yet.</p>
        </CardContent>
      </Card>
    )
  }

  const total = draws.reduce((sum, draw) => sum + (draw.amount_cents ?? 0), 0)
  const paid = draws
    .filter((d) => d.status === "paid" || d.status === "invoiced")
    .reduce((sum, draw) => sum + (draw.amount_cents ?? 0), 0)
  const progress = total > 0 ? Math.round((paid / total) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Draw Schedule</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">Invoiced vs total</div>
          <div className="text-sm font-medium">{progress}%</div>
        </div>
        <Progress value={progress} />
        <div className="divide-y">
          {draws.map((draw) => {
            const status = statusMap[draw.status] ?? statusMap.pending
            return (
              <div key={draw.id} className="py-3 flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-sm font-semibold">
                  {draw.draw_number}
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{draw.title}</p>
                    <Badge className={`text-xs ${status.tone}`} variant="secondary">
                      {status.label}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-1">{draw.description}</p>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    {draw.due_date ? format(new Date(draw.due_date), "MMM d, yyyy") : "No due date"}
                    {typeof draw.percent_of_contract === "number" && (
                      <span>• {draw.percent_of_contract}% of contract</span>
                    )}
                  </div>
                </div>
                <div className="text-right text-sm font-semibold">
                  {((draw.amount_cents ?? 0) / 100).toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                    maximumFractionDigits: 0,
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import type { Company } from "@/lib/types"

function daysUntil(date: string) {
  const target = new Date(date)
  const now = new Date()
  const msPerDay = 1000 * 60 * 60 * 24
  return Math.floor((target.getTime() - now.getTime()) / msPerDay)
}

export function InsuranceWidget({ companies }: { companies: Company[] }) {
  const expiring = companies
    .filter((c) => c.insurance_expiry)
    .map((c) => ({ ...c, days: daysUntil(c.insurance_expiry as string) }))
    .filter((c) => c.days <= 90)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Insurance expiry (90d)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {expiring.length === 0 ? (
          <p className="text-muted-foreground text-sm">No upcoming expirations.</p>
        ) : (
          expiring.map((c) => {
            const percent = Math.min(100, Math.max(0, ((90 - c.days) / 90) * 100))
            return (
              <div key={c.id} className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">
                      Expires in {c.days} day{c.days === 1 ? "" : "s"}
                    </span>
                  </div>
                  <Badge variant={c.days < 0 ? "destructive" : "secondary"}>{c.insurance_expiry}</Badge>
                </div>
                <Progress value={percent} />
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}



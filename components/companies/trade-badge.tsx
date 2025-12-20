"use client"

import { Badge } from "@/components/ui/badge"

const TRADE_COLORS: Record<string, string> = {
  Electrical: "bg-amber-100 text-amber-800",
  Plumbing: "bg-blue-100 text-blue-800",
  HVAC: "bg-cyan-100 text-cyan-800",
  Roofing: "bg-slate-100 text-slate-800",
  Framing: "bg-emerald-100 text-emerald-800",
  Concrete: "bg-stone-100 text-stone-800",
}

export function TradeBadge({ trade }: { trade?: string }) {
  if (!trade) return null
  const className = TRADE_COLORS[trade] ?? "bg-muted text-muted-foreground"
  return (
    <Badge variant="outline" className={className}>
      {trade}
    </Badge>
  )
}





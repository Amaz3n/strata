"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { compareForecastSnapshotLines } from "@/lib/financials/forecasting"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Snapshot = { id: string; snapshot_date: string; label: string | null; source: string; by_cost_code: any[] }
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export function BudgetSnapshotComparison({ projectId, snapshots }: { projectId: string; snapshots: Snapshot[] }) {
  const [fromId, setFromId] = useState(snapshots[1]?.id ?? snapshots[0]?.id ?? "")
  const [toId, setToId] = useState(snapshots[0]?.id ?? "")
  const rows = useMemo(() => compareForecastSnapshotLines(snapshots.find((item) => item.id === fromId)?.by_cost_code ?? [], snapshots.find((item) => item.id === toId)?.by_cost_code ?? []), [snapshots, fromId, toId])
  return <section className="space-y-3 border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">Compare forecast snapshots</p><p className="text-xs text-muted-foreground">Line-level EAC movement between any two captured states.</p></div><Button variant="outline" size="sm" asChild><Link href={`/projects/${projectId}/reports/forecast-time-phased`}>Time-phased forecast</Link></Button></div>{snapshots.length < 2 ? <p className="py-8 text-center text-sm text-muted-foreground">Two snapshots are required for comparison. Nightly snapshots will appear automatically.</p> : <><div className="flex gap-2"><Select value={fromId} onValueChange={setFromId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{snapshots.map((item) => <SelectItem key={item.id} value={item.id}>{item.label ?? `${item.snapshot_date} · ${item.source}`}</SelectItem>)}</SelectContent></Select><Select value={toId} onValueChange={setToId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{snapshots.map((item) => <SelectItem key={item.id} value={item.id}>{item.label ?? `${item.snapshot_date} · ${item.source}`}</SelectItem>)}</SelectContent></Select></div><div className="max-h-80 overflow-auto border"><Table><TableHeader><TableRow><TableHead>Cost line</TableHead><TableHead className="text-right">From</TableHead><TableHead className="text-right">To</TableHead><TableHead className="text-right">Variance</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.key}><TableCell>{row.label}</TableCell><TableCell className="text-right tabular-nums">{money(row.from_cents)}</TableCell><TableCell className="text-right tabular-nums">{money(row.to_cents)}</TableCell><TableCell className="text-right font-medium tabular-nums">{money(row.variance_cents)}</TableCell></TableRow>)}</TableBody></Table></div></>}</section>
}

"use client"

import { useMemo, useState } from "react"
import { format, subDays } from "date-fns"
import { Download } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function BulkDailyReportExportButton({ projectId }: { projectId: string }) {
  const today = useMemo(() => new Date(), [])
  const [from, setFrom] = useState(format(subDays(today, 6), "yyyy-MM-dd"))
  const [to, setTo] = useState(format(today, "yyyy-MM-dd"))
  const dayCount = Math.floor((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000) + 1
  const valid = dayCount >= 1 && dayCount <= 31
  return <Popover><PopoverTrigger asChild><Button variant="ghost" size="sm" className="h-7 text-xs"><Download className="mr-1 h-3.5 w-3.5" />Export range</Button></PopoverTrigger><PopoverContent align="end" className="w-72 space-y-3"><div><p className="text-sm font-semibold">Daily report packet</p><p className="text-xs text-muted-foreground">Merge up to 31 calendar days into one PDF.</p></div><div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>From</Label><Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div><div className="space-y-1"><Label>To</Label><Input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div></div>{!valid && <p className="text-xs text-destructive">Choose a range from 1 to 31 days.</p>}<Button asChild className="w-full" disabled={!valid}><a href={valid ? `/projects/${projectId}/exports/daily-report-bulk?from=${from}&to=${to}` : "#"} target="_blank" rel="noreferrer">Open merged PDF</a></Button></PopoverContent></Popover>
}

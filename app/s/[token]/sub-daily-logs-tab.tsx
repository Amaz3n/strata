"use client"

import { useEffect, useState } from "react"
import { format } from "date-fns"
import { toast } from "sonner"
import { Camera, ClipboardList } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { PortalDailyLogSubmission } from "@/lib/services/daily-reports"
import { listSubPortalDailyLogsAction, submitSubPortalDailyLogAction } from "./daily-logs/actions"

export function SubDailyLogsTab({ token }: { token: string }) {
  const [rows, setRows] = useState<PortalDailyLogSubmission[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void listSubPortalDailyLogsAction(token).then(setRows).catch((error) => toast.error(error instanceof Error ? error.message : "Unable to load daily logs")).finally(() => setLoading(false)) }, [token])

  async function submit(formData: FormData) {
    setBusy(true)
    try { const row = await submitSubPortalDailyLogAction(token, formData); setRows((current) => [row, ...current]); toast.success("Daily log submitted") } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to submit daily log") } finally { setBusy(false) }
  }

  return <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6">
    <div><h2 className="text-lg font-semibold">Daily logs</h2><p className="text-sm text-muted-foreground">Submit only your company&apos;s manpower, narrative, and site photo. The GC&apos;s report stays private.</p></div>
    <form action={submit} className="space-y-4 border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-3"><div className="space-y-1"><Label htmlFor="sub-log-date">Date</Label><Input id="sub-log-date" name="date" type="date" defaultValue={format(new Date(), "yyyy-MM-dd")} max={format(new Date(), "yyyy-MM-dd")} required /></div><div className="space-y-1"><Label htmlFor="sub-log-workers">Workers</Label><Input id="sub-log-workers" name="workers" type="number" min="1" required /></div><div className="space-y-1"><Label htmlFor="sub-log-hours">Hours each</Label><Input id="sub-log-hours" name="hours" type="number" min="0" max="24" step="0.5" /></div></div>
      <div className="space-y-1"><Label htmlFor="sub-log-trade">Trade</Label><Input id="sub-log-trade" name="trade" placeholder="Drywall, electrical, concrete…" /></div>
      <div className="space-y-1"><Label htmlFor="sub-log-narrative">Work performed</Label><Textarea id="sub-log-narrative" name="narrative" rows={4} placeholder="Describe your crew's work, areas completed, and constraints." /></div>
      <div className="space-y-1"><Label htmlFor="sub-log-photo">Site photo</Label><Input id="sub-log-photo" name="photo" type="file" accept="image/*" /><p className="flex items-center gap-1 text-xs text-muted-foreground"><Camera className="h-3.5 w-3.5" />Optional, up to 25 MB</p></div>
      <div className="flex justify-end"><Button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit daily log"}</Button></div>
    </form>
    <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your submissions</h3>{loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? <div className="border border-dashed p-8 text-center"><ClipboardList className="mx-auto h-6 w-6 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No submissions yet</p></div> : <div className="divide-y border">{rows.map((row) => <div key={row.id} className="p-3"><div className="flex items-center justify-between gap-3"><p className="font-mono text-xs font-medium tabular-nums">{row.date}</p><p className="font-mono text-xs tabular-nums text-muted-foreground">{row.workers} workers{row.hours != null ? ` · ${row.hours}h` : ""}</p></div>{row.trade && <p className="mt-1 text-xs font-medium text-muted-foreground">{row.trade}</p>}{row.narrative && <p className="mt-2 text-sm leading-relaxed">{row.narrative}</p>}{row.photo_file_id && <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Camera className="h-3.5 w-3.5" />Photo attached</p>}</div>)}</div>}</div>
  </div>
}

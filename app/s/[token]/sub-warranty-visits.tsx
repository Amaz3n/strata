"use client"

import { useState, useTransition } from "react"
import { CalendarClock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import type { WarrantyServiceVisitDTO } from "@/lib/services/warranty"
import { confirmSubPortalWarrantyVisitAction, completeSubPortalWarrantyVisitAction } from "./warranty/actions"

type PortalVisit = WarrantyServiceVisitDTO & { request?: Record<string, unknown> | null; project?: Record<string, unknown> | null }

export function SubWarrantyVisits({ token, initialVisits }: { token: string; initialVisits: PortalVisit[] }) {
  const [visits, setVisits] = useState(initialVisits)
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [photo, setPhoto] = useState<File | null>(null)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()
  if (!visits.length) return null

  const update = (visit: WarrantyServiceVisitDTO) => setVisits((rows) => rows.map((row) => row.id === visit.id ? { ...row, ...visit } : row))
  return (
    <section className="mx-auto mb-4 max-w-5xl border">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <CalendarClock className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Warranty appointments</h2>
      </div>
      <div className="divide-y">
        {visits.map((visit) => (
          <div key={visit.id} className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto]">
            <div>
              <div className="flex items-center gap-2"><p className="text-sm font-medium">{String(visit.request?.title ?? `Service visit ${visit.visit_number}`)}</p><Badge variant="outline">{visit.status.replaceAll("_", " ")}</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(visit.window_start).toLocaleString()} – {new Date(visit.window_end).toLocaleTimeString()}</p>
              {visit.project?.location ? <p className="text-xs text-muted-foreground">{String((visit.project.location as { address?: string }).address ?? "")}</p> : null}
            </div>
            <div className="flex items-start gap-2">
              {visit.status === "scheduled" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => { try { update(await confirmSubPortalWarrantyVisitAction(token, visit.id)); toast({ title: "Appointment confirmed" }) } catch (error) { toast({ title: "Unable to confirm", description: error instanceof Error ? error.message : "Try again" }) } })}>Confirm</Button> : null}
              {!["completed","canceled"].includes(visit.status) ? <Button size="sm" onClick={() => setSelected(visit.id)}>Complete</Button> : null}
            </div>
            {selected === visit.id ? <div className="space-y-2 border-t pt-3 md:col-span-2"><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Describe completed work"/><Input type="file" accept="image/*" onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}/><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Cancel</Button><Button size="sm" disabled={pending || !note.trim()} onClick={() => startTransition(async () => { try { const formData = new FormData(); formData.append("visit_id", visit.id); formData.append("note", note); if (photo) formData.append("photo", photo); update(await completeSubPortalWarrantyVisitAction(token, formData)); setSelected(null); setNote(""); setPhoto(null); toast({ title: "Completion sent for verification" }) } catch (error) { toast({ title: "Unable to complete", description: error instanceof Error ? error.message : "Try again" }) } })}>Send completion</Button></div></div> : null}
          </div>
        ))}
      </div>
    </section>
  )
}

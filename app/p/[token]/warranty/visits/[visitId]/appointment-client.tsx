"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { CalendarCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import type { WarrantyServiceVisitDTO } from "@/lib/services/warranty"
import { formatWarrantyVisitInstant, formatWarrantyVisitWindow, resolveWarrantyTimeZone } from "@/lib/services/warranty/visit-time"
import { confirmWarrantyVisitPortalAction, requestWarrantyVisitRescheduleAction } from "../../actions"

export function WarrantyAppointmentClient({ token, initialVisit, requestTitle, projectName }: {
  token: string
  initialVisit: WarrantyServiceVisitDTO
  requestTitle: string
  projectName: string | null
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [visit, setVisit] = useState(initialVisit)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState("")
  const timeZone = resolveWarrantyTimeZone(visit.time_zone)
  const open = visit.status === "scheduled" || visit.status === "confirmed"

  const answer = (run: () => ReturnType<typeof confirmWarrantyVisitPortalAction>, done: string) => startTransition(async () => {
    const result = await run()
    if (!result.success) { toast({ title: "Unable to save your answer", description: result.error }); return }
    setVisit((current) => ({ ...current, ...result.data }))
    setAsking(false)
    setNote("")
    toast({ title: done })
  })

  return (
    <div className="space-y-4 p-4">
      <section className="space-y-3 border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{requestTitle}</p>
            {projectName ? <p className="text-xs text-muted-foreground">{projectName} · Visit {visit.visit_number}</p> : null}
          </div>
          <Badge variant={visit.buyer_confirmed_at ? "secondary" : "outline"}>
            {visit.buyer_confirmed_at ? "You confirmed" : visit.buyer_reschedule_requested_at ? "Change requested" : visit.status === "canceled" ? "Canceled" : "Awaiting your confirmation"}
          </Badge>
        </div>
        <p className="text-lg font-medium tabular-nums">{formatWarrantyVisitWindow(visit.window_start, visit.window_end, timeZone)}</p>
        {visit.assigned_user_name || visit.assigned_company_name ? <p className="text-sm text-muted-foreground">With {visit.assigned_user_name ?? visit.assigned_company_name}</p> : null}
        {visit.buyer_confirmed_at ? <p className="text-xs text-muted-foreground">Confirmed {formatWarrantyVisitInstant(visit.buyer_confirmed_at, timeZone)}</p> : null}
        {visit.buyer_reschedule_requested_at ? (
          <p className="text-xs text-muted-foreground">You asked for another time on {formatWarrantyVisitInstant(visit.buyer_reschedule_requested_at, timeZone)}: {visit.buyer_reschedule_note}. We will contact you with a new time.</p>
        ) : null}
      </section>

      {open ? (
        <section className="space-y-3 border border-border bg-card p-4">
          {asking ? (
            <>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="What days or times work better for you?" rows={3} />
              <div className="flex gap-2">
                <Button disabled={pending || note.trim().length < 3} onClick={() => answer(() => requestWarrantyVisitRescheduleAction(token, visit.id, note.trim()), "We have your request")}>Send request</Button>
                <Button variant="ghost" disabled={pending} onClick={() => setAsking(false)}>Back</Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button disabled={pending || Boolean(visit.buyer_confirmed_at)} onClick={() => answer(() => confirmWarrantyVisitPortalAction(token, visit.id), "Appointment confirmed")}>
                <CalendarCheck className="mr-2 size-4" />{visit.buyer_confirmed_at ? "Confirmed" : "Confirm this time"}
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => setAsking(true)}>I need a different time</Button>
            </div>
          )}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">This appointment can no longer be changed here. <Link href={`/p/${token}/warranty`} className="underline underline-offset-2">Back to your warranty</Link></p>
      )}
    </div>
  )
}

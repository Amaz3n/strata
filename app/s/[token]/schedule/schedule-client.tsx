"use client"

import { useState, useTransition } from "react"
import { CalendarClock } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import type { TradeWorkForPortal } from "@/lib/services/trade-responses"
import { respondToTradeWorkAction } from "./actions"

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const formatDay = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`))
const formatRange = (start: string, end: string) => (start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`)

type Mode = { itemId: string; kind: "declined" | "reschedule_requested" }

function answerState(item: TradeWorkForPortal): { label: string; tone: string; needsAnswer: boolean } {
  const answer = item.answer
  if (!answer || (answer.stale && answer.status === "open")) {
    return {
      label: answer ? "Dates changed — confirm again" : "Needs your answer",
      tone: "text-warning",
      needsAnswer: true,
    }
  }
  if (answer.status === "resolved" && answer.resolution === "reschedule_applied") {
    return { label: "Moved to your dates — confirm", tone: "text-warning", needsAnswer: true }
  }
  if (answer.status === "resolved" && answer.stale) {
    return { label: "Dates changed — confirm again", tone: "text-warning", needsAnswer: true }
  }
  if (answer.response === "accepted") return { label: "Confirmed", tone: "text-success", needsAnswer: false }
  if (answer.response === "declined") {
    return { label: answer.status === "open" ? "Declined — builder notified" : "Decline acknowledged", tone: "text-destructive", needsAnswer: false }
  }
  if (answer.status === "resolved") return { label: "Request declined — original dates stand", tone: "text-muted-foreground", needsAnswer: true }
  return {
    label: `Asked for ${answer.proposedStart && answer.proposedEnd ? formatRange(answer.proposedStart, answer.proposedEnd) : "other dates"}`,
    tone: "text-warning",
    needsAnswer: false,
  }
}

export function TradeScheduleClient({ token, initialItems, truncated, cap }: {
  token: string
  initialItems: TradeWorkForPortal[]
  truncated: boolean
  cap: number
}) {
  const [items, setItems] = useState(initialItems)
  const [mode, setMode] = useState<Mode | null>(null)
  const [reason, setReason] = useState("")
  const [proposedStart, setProposedStart] = useState("")
  const [proposedEnd, setProposedEnd] = useState("")
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  const close = () => { setMode(null); setReason(""); setProposedStart(""); setProposedEnd("") }

  const send = (item: TradeWorkForPortal, response: "accepted" | "declined" | "reschedule_requested") => {
    startTransition(async () => {
      const result = await respondToTradeWorkAction(token, {
        scheduleItemId: item.scheduleItemId,
        response,
        issuedStart: item.startDate,
        issuedEnd: item.endDate,
        ...(response === "reschedule_requested" ? { proposedStart, proposedEnd } : {}),
        ...(response !== "accepted" ? { reason } : {}),
      })
      if (!result.success) {
        toast({ title: "Unable to send your answer", description: result.error })
        return
      }
      setItems((rows) => rows.map((row) => row.scheduleItemId === item.scheduleItemId ? {
        ...row,
        confirmed: response === "accepted",
        answer: {
          id: result.data.id, response, status: "open", resolution: null,
          proposedStart: response === "reschedule_requested" ? proposedStart : null,
          proposedEnd: response === "reschedule_requested" ? proposedEnd : null,
          reason: response === "accepted" ? null : reason, respondedAt: new Date().toISOString(), stale: false,
        },
      } : row))
      close()
      toast({ title: response === "accepted" ? "Confirmed" : "Sent to the builder" })
    })
  }

  if (!items.length) {
    return (
      <div className="border border-border bg-card px-4 py-12 text-center">
        <CalendarClock className="mx-auto mb-3 size-8 text-muted-foreground" />
        <p className="text-sm font-medium">Nothing scheduled for your crew</p>
        <p className="mt-1 text-sm text-muted-foreground">Work assigned to your company in the next twelve weeks appears here.</p>
      </div>
    )
  }

  const projects = Array.from(new Set(items.map((item) => item.projectId)))
  return (
    <div className="space-y-4">
      {projects.map((projectId) => {
        const rows = items.filter((item) => item.projectId === projectId)
        return (
          <section key={projectId} className="border border-border bg-card">
            <h2 className="border-b border-border px-4 py-2 text-sm font-medium">{rows[0]?.projectName}</h2>
            <div className="divide-y divide-border">
              {rows.map((item) => {
                const state = answerState(item)
                const open = mode?.itemId === item.scheduleItemId
                return (
                  <div key={item.scheduleItemId} className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto]">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{item.name}</p>
                      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{formatRange(item.startDate, item.endDate)}</p>
                      <p className={cn("mt-1 text-xs font-medium", state.tone)}>{state.label}</p>
                      {item.answer?.reason ? <p className="mt-0.5 text-xs text-muted-foreground">{item.answer.reason}</p> : null}
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      <Button size="sm" variant={state.needsAnswer ? "default" : "outline"} disabled={pending} onClick={() => send(item, "accepted")}>
                        {item.confirmed && !state.needsAnswer ? "Confirmed" : "Confirm"}
                      </Button>
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => setMode({ itemId: item.scheduleItemId, kind: "reschedule_requested" })}>Other dates</Button>
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => setMode({ itemId: item.scheduleItemId, kind: "declined" })}>Can&apos;t do it</Button>
                    </div>
                    {open && mode ? (
                      <div className="space-y-3 border-t border-border pt-3 md:col-span-2">
                        {mode.kind === "reschedule_requested" ? (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                              <Label htmlFor={`start-${item.scheduleItemId}`}>First day you can start</Label>
                              <Input id={`start-${item.scheduleItemId}`} type="date" value={proposedStart} onChange={(event) => setProposedStart(event.target.value)} />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor={`end-${item.scheduleItemId}`}>Last day</Label>
                              <Input id={`end-${item.scheduleItemId}`} type="date" value={proposedEnd} min={proposedStart || undefined} onChange={(event) => setProposedEnd(event.target.value)} />
                            </div>
                          </div>
                        ) : null}
                        <div className="space-y-1.5">
                          <Label htmlFor={`reason-${item.scheduleItemId}`}>{mode.kind === "declined" ? "Why can't your crew do it?" : "Why the change?"}</Label>
                          <Textarea id={`reason-${item.scheduleItemId}`} value={reason} onChange={(event) => setReason(event.target.value)} />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
                          <Button
                            size="sm"
                            disabled={pending || reason.trim().length < 3 || (mode.kind === "reschedule_requested" && (!proposedStart || !proposedEnd || proposedEnd < proposedStart))}
                            onClick={() => send(item, mode.kind)}
                          >
                            {mode.kind === "declined" ? "Send decline" : "Send request"}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
      {truncated ? <p className="text-xs text-muted-foreground">Showing the first {cap} tasks, soonest first. Ask your builder for the rest.</p> : null}
    </div>
  )
}

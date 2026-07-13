"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { MeetingDetail } from "@/lib/services/meetings"
import { addMeetingItemAction, createMeetingItemTaskAction, updateMeetingItemAction } from "./actions"

const statuses = ["open", "info", "closed"] as const

export function MeetingRunMode({ projectId, meeting }: { projectId: string; meeting: MeetingDetail }) {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [index, setIndex] = useState(0)
  const [pending, startTransition] = useTransition()
  const discussionRef = useRef<HTMLTextAreaElement>(null)
  const bicRef = useRef<HTMLInputElement>(null)
  const newItemRef = useRef<HTMLInputElement>(null)
  const current = meeting.items[index]
  const run = (work: () => Promise<void>) => startTransition(() => void work().catch((error) => toast.error(error instanceof Error ? error.message : "Meeting update failed")))

  useEffect(() => {
    if (!running) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input,textarea,button,[role=combobox]")) return
      if (event.key === "j") setIndex((value) => Math.min(meeting.items.length - 1, value + 1))
      else if (event.key === "k") setIndex((value) => Math.max(0, value - 1))
      else if (event.key === "e") discussionRef.current?.focus()
      else if (event.key === "b") bicRef.current?.focus()
      else if (event.key === "n") newItemRef.current?.focus()
      else if (event.key === "s" && current) {
        event.preventDefault()
        const next = statuses[(statuses.indexOf(current.status) + 1) % statuses.length]
        run(async () => { unwrapAction(await updateMeetingItemAction(projectId, current.id, { status: next })); toast.success(`Status: ${next}`); router.refresh() })
      } else if (event.key === "t" && current && !current.task_id) {
        run(async () => { unwrapAction(await createMeetingItemTaskAction(projectId, { meeting_item_id: current.id })); toast.success("Task created"); router.refresh() })
      } else if (event.key === " " && current) {
        event.preventDefault(); setIndex((value) => Math.min(meeting.items.length - 1, value + 1))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [running, current, meeting.items.length, projectId, router])

  if (!running) return <div className="border-b p-4"><Button size="sm" variant="outline" onClick={() => setRunning(true)}>Run meeting</Button><span className="ml-3 text-xs text-muted-foreground">Focused, keyboard-first view for live minutes.</span></div>
  if (!current) return <div className="border-b p-4"><p className="text-sm text-muted-foreground">Add a business item before starting run mode.</p><Button className="mt-2" size="sm" variant="outline" onClick={() => setRunning(false)}>Exit run mode</Button></div>
  return <section className="border-b bg-muted/10 p-4"><div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Run mode · {index + 1}/{meeting.items.length}</p><p className="font-mono text-sm">{current.item_number}</p></div><div className="flex items-center gap-2"><Badge variant="outline">{current.status}</Badge><Button size="sm" variant="ghost" onClick={() => setRunning(false)}>Exit</Button></div></div><form key={current.id} className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); run(async () => { unwrapAction(await updateMeetingItemAction(projectId, current.id, { discussion: String(form.get("discussion") || "") || null, ball_in_court: String(form.get("ball_in_court") || "") || null, due_date: String(form.get("due_date") || "") || null })); toast.success("Item updated"); setIndex((value) => Math.min(meeting.items.length - 1, value + 1)); router.refresh() }) }}><h2 className="text-xl font-semibold">{current.topic}</h2><Textarea ref={discussionRef} name="discussion" defaultValue={current.discussion ?? ""} className="min-h-40 text-base" placeholder="Discussion and decision notes" /><div className="grid gap-3 sm:grid-cols-2"><Input ref={bicRef} name="ball_in_court" defaultValue={current.ball_in_court ?? ""} placeholder="Ball in court" /><Input name="due_date" type="date" defaultValue={current.due_date ?? ""} /></div><div className="flex flex-wrap gap-2"><Button disabled={pending}>Save &amp; advance</Button><Button type="button" variant="outline" onClick={() => setIndex((value) => Math.min(meeting.items.length - 1, value + 1))}>No update</Button><Button type="button" variant="outline" disabled={pending || Boolean(current.task_id)} onClick={() => run(async () => { unwrapAction(await createMeetingItemTaskAction(projectId, { meeting_item_id: current.id })); toast.success("Task created"); router.refresh() })}>{current.task_id ? "Task linked" : "Create task"}</Button></div></form><form className="mt-4 flex gap-2 border-t pt-4" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); run(async () => { unwrapAction(await addMeetingItemAction(projectId, { meeting_id: meeting.id, topic: form.get("topic"), status: "open" })); (event.currentTarget as HTMLFormElement).reset(); toast.success("Item added"); router.refresh() }) }}><Input ref={newItemRef} name="topic" placeholder="New item (n)" required /><Button variant="outline" disabled={pending}>Add</Button></form><p className="mt-3 text-[11px] text-muted-foreground">Keys: j/k move · e discussion · s status · b ball-in-court · t task · n new item · space no-update advance</p></section>
}

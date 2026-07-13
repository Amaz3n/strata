"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { MeetingAttendee, MeetingDetail, MeetingItem } from "@/lib/services/meetings"
import type { MeetingLinkOption } from "@/lib/services/meeting-link-options"
import type { MeetingTranscript } from "@/lib/services/meeting-transcripts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { addMeetingAttendeeAction, addMeetingItemAction, createMeetingAction, createMeetingItemTaskAction, deleteMeetingAction, finalizeMeetingAction, updateMeetingAction, updateMeetingAttendeeAction, updateMeetingItemAction } from "./actions"
import { MeetingRunMode } from "./meeting-run-mode"
import { MeetingTranscriptPanel } from "./meeting-transcript-panel"

function MeetingItemEditor({ projectId, item, linkOptions, pending, submit }: { projectId: string; item: MeetingItem; linkOptions: MeetingLinkOption[]; pending: boolean; submit: (work: () => Promise<void>) => void }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  if (!editing) return <div className="grid grid-cols-[52px_1fr_auto] gap-3 border-b py-3 last:border-0"><span className="font-mono text-xs">{item.item_number}</span><div><div className="font-medium">{item.topic}</div>{item.discussion ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{item.discussion}</p> : null}<div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground"><span className="capitalize">{item.status}</span><span>BIC: {item.ball_in_court ?? "—"}</span><span>Due: {item.due_date ?? "—"}</span><span className={item.meetings_elapsed >= 3 ? "text-warning" : ""}>Meeting {item.meetings_elapsed}</span>{item.linked_entity ? <Badge variant="outline">{item.linked_entity.label} · {item.linked_entity.status ?? "—"}</Badge> : null}</div></div><div className="flex items-start gap-1"><Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(true)}>Edit</Button>{item.task_id ? <Badge variant="outline">Task linked</Badge> : <Button size="sm" variant="ghost" disabled={pending} onClick={() => submit(async () => { unwrapAction(await createMeetingItemTaskAction(projectId, { meeting_item_id: item.id })); toast.success("Task created"); router.refresh() })}>Create task</Button>}</div></div>
  return <form className="grid gap-2 border-b py-3" onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); const link = String(form.get("linked_entity") || "none"); const [linkedType, linkedId] = link === "none" ? [null, null] : link.split(":"); submit(async () => { unwrapAction(await updateMeetingItemAction(projectId, item.id, { topic: form.get("topic"), discussion: form.get("discussion") || null, status: form.get("status"), ball_in_court: form.get("ball_in_court") || null, due_date: form.get("due_date") || null, linked_entity_type: linkedType, linked_entity_id: linkedId })); setEditing(false); toast.success("Meeting item updated"); router.refresh() }) }}><div className="grid gap-2 md:grid-cols-[1fr_140px]"><Input name="topic" defaultValue={item.topic} required /><Select name="status" defaultValue={item.status}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="closed">Closed</SelectItem><SelectItem value="info">Information</SelectItem></SelectContent></Select></div><Textarea name="discussion" defaultValue={item.discussion ?? ""} placeholder="Discussion / decision notes" /><div className="grid gap-2 md:grid-cols-3"><Input name="ball_in_court" defaultValue={item.ball_in_court ?? ""} placeholder="Ball in court" /><Input name="due_date" type="date" defaultValue={item.due_date ?? ""} /><Select name="linked_entity" defaultValue={item.linked_entity_type && item.linked_entity_id ? `${item.linked_entity_type}:${item.linked_entity_id}` : "none"}><SelectTrigger><SelectValue placeholder="Linked record" /></SelectTrigger><SelectContent><SelectItem value="none">No linked record</SelectItem>{linkOptions.map((option) => <SelectItem key={`${option.type}:${option.id}`} value={`${option.type}:${option.id}`}>{option.label}</SelectItem>)}</SelectContent></Select></div><div className="flex gap-2"><Button type="submit" size="sm" disabled={pending}>Save item</Button><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div></form>
}

function AttendanceRow({ projectId, attendee, pending, submit }: { projectId: string; attendee: MeetingAttendee; pending: boolean; submit: (work: () => Promise<void>) => void }) {
  const router = useRouter()
  return <div className="flex items-start justify-between gap-2"><div><div className="text-sm font-medium">{attendee.display_name}</div><div className="text-xs text-muted-foreground">{attendee.company_name ?? attendee.email ?? "—"}</div></div><Button size="sm" variant={attendee.present ? "outline" : "ghost"} disabled={pending} onClick={() => submit(async () => { unwrapAction(await updateMeetingAttendeeAction(projectId, attendee.id, { present: !attendee.present })); toast.success(attendee.present ? "Marked absent" : "Marked present"); router.refresh() })}>{attendee.present ? "Present" : "Absent"}</Button></div>
}

export function MeetingsClient({ projectId, meetings, selected, linkOptions, transcripts }: { projectId: string; meetings: Array<MeetingDetail | Omit<MeetingDetail, "items" | "attendees" | "distributions">>; selected?: MeetingDetail | null; linkOptions: MeetingLinkOption[]; transcripts: MeetingTranscript[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [series, setSeries] = useState("oac")

  const submit = (work: () => Promise<void>) => startTransition(() => { void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong")) })

  return (
    <div className="space-y-6">
      <form className="grid gap-3 border p-4 md:grid-cols-[130px_1fr_180px_auto]" onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        submit(async () => {
          const meeting = unwrapAction(await createMeetingAction({ project_id: projectId, series, title: form.get("title"), held_at: form.get("held_at") ? new Date(String(form.get("held_at"))).toISOString() : null, location: form.get("location") || null }))
          toast.success("Meeting created")
          router.push(`/projects/${projectId}/meetings?meeting=${meeting.id}`)
          router.refresh()
        })
      }}>
        <Select value={series} onValueChange={setSeries} disabled={pending}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="oac">OAC</SelectItem><SelectItem value="sub">Subcontractor</SelectItem><SelectItem value="safety">Safety</SelectItem><SelectItem value="custom">Custom</SelectItem></SelectContent></Select>
        <Input name="title" required minLength={2} placeholder="Meeting title" disabled={pending} />
        <Input name="held_at" type="datetime-local" disabled={pending} />
        <Button type="submit" disabled={pending}>New meeting</Button>
        <Input name="location" placeholder="Location (optional)" className="md:col-start-2 md:col-span-2" disabled={pending} />
      </form>

      <div className="border">
        <Table>
          <TableHeader><TableRow><TableHead className="w-28">Number</TableHead><TableHead>Title</TableHead><TableHead className="w-28">Series</TableHead><TableHead className="w-36">Held</TableHead><TableHead className="w-28">Status</TableHead></TableRow></TableHeader>
          <TableBody>
            {meetings.length ? meetings.map((meeting) => <TableRow key={meeting.id} className="cursor-pointer" onClick={() => router.push(`/projects/${projectId}/meetings?meeting=${meeting.id}`)}><TableCell className="font-mono text-xs">{meeting.display_number}</TableCell><TableCell className="font-medium">{meeting.title}</TableCell><TableCell className="uppercase text-muted-foreground">{meeting.series}</TableCell><TableCell>{meeting.held_at ? new Date(meeting.held_at).toLocaleDateString() : "—"}</TableCell><TableCell><Badge variant={meeting.status === "finalized" ? "secondary" : "outline"}>{meeting.status}</Badge></TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No meetings yet. Create the first meeting above.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>

      {selected ? <section className="border">
        <div className="flex items-start justify-between gap-4 border-b p-4"><div><p className="font-mono text-xs text-muted-foreground">{selected.display_number} · {selected.series.toUpperCase()}</p><h2 className="text-lg font-semibold">{selected.title}</h2><p className="text-sm text-muted-foreground">{selected.location ?? "Location not set"}</p></div><div className="flex gap-2">{selected.pdf_file_id ? <Button variant="outline" asChild><a href={`/api/files/${selected.pdf_file_id}/raw`}>Download PDF</a></Button> : null}{selected.status === "draft" ? <><Button variant="destructive" disabled={pending} onClick={() => { if (!window.confirm("Delete this draft meeting and all of its items?")) return; submit(async () => { unwrapAction(await deleteMeetingAction(projectId, selected.id)); toast.success("Draft meeting deleted"); router.push(`/projects/${projectId}/meetings`); router.refresh() }) }}>Delete</Button><Button disabled={pending} onClick={() => submit(async () => { unwrapAction(await finalizeMeetingAction(projectId, selected.id)); toast.success("Minutes finalized and distributed"); router.refresh() })}>Finalize</Button></> : <Badge variant="secondary">Finalized</Badge>}</div></div>
        {selected.status === "draft" ? <form className="grid gap-2 border-b p-4 md:grid-cols-[1fr_180px_1fr_auto]" onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); submit(async () => { unwrapAction(await updateMeetingAction(projectId, selected.id, { title: form.get("title"), held_at: form.get("held_at") ? new Date(String(form.get("held_at"))).toISOString() : null, location: form.get("location") || null })); toast.success("Meeting details updated"); router.refresh() }) }}><Input name="title" defaultValue={selected.title} required /><Input name="held_at" type="datetime-local" defaultValue={selected.held_at ? new Date(new Date(selected.held_at).getTime() - new Date(selected.held_at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ""} /><Input name="location" defaultValue={selected.location ?? ""} placeholder="Location" /><Button type="submit" variant="outline" disabled={pending}>Save details</Button></form> : null}
        {selected.status === "draft" ? <MeetingRunMode projectId={projectId} meeting={selected} /> : null}
        <div className="grid divide-y lg:grid-cols-[1fr_280px] lg:divide-x lg:divide-y-0">
          <div className="p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Business items</h3>
            <div className="space-y-2">{selected.items.length ? selected.items.map((item) => selected.status === "draft" ? <MeetingItemEditor key={item.id} projectId={projectId} item={item} linkOptions={linkOptions} pending={pending} submit={submit} /> : <div key={item.id} className="grid grid-cols-[52px_1fr] gap-3 border-b py-3 last:border-0"><span className="font-mono text-xs">{item.item_number}</span><div><div className="font-medium">{item.topic}</div>{item.discussion ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{item.discussion}</p> : null}<div className="mt-2 flex gap-3 text-xs text-muted-foreground"><span className="capitalize">{item.status}</span><span>BIC: {item.ball_in_court ?? "—"}</span><span>Due: {item.due_date ?? "—"}</span></div></div></div>) : <p className="py-8 text-center text-sm text-muted-foreground">No business items.</p>}</div>
            {selected.status === "draft" ? <form className="mt-4 grid gap-3 border-t pt-4" onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); submit(async () => { unwrapAction(await addMeetingItemAction(projectId, { meeting_id: selected.id, topic: form.get("topic"), discussion: form.get("discussion") || null, ball_in_court: form.get("ball_in_court") || null, due_date: form.get("due_date") || null, status: "open" })); element.reset(); toast.success("Meeting item added"); router.refresh() }) }}><Input name="topic" placeholder="New business item" required /><Textarea name="discussion" placeholder="Discussion / decision notes" /><div className="grid grid-cols-2 gap-3"><Input name="ball_in_court" placeholder="Ball in court" /><Input name="due_date" type="date" /></div><Button type="submit" className="justify-self-start" disabled={pending}>Add item</Button></form> : null}
          </div>
          <aside className="p-4"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attendance</h3><div className="space-y-3">{selected.attendees.map((attendee) => selected.status === "draft" ? <AttendanceRow key={attendee.id} projectId={projectId} attendee={attendee} pending={pending} submit={submit} /> : <div key={attendee.id}><div className="text-sm font-medium">{attendee.display_name}</div><div className="text-xs text-muted-foreground">{attendee.company_name ?? attendee.email ?? "—"} · {attendee.present ? "Present" : "Absent"}</div></div>)}{!selected.attendees.length ? <p className="text-sm text-muted-foreground">No attendees added.</p> : null}</div>{selected.status === "draft" ? <form className="mt-4 space-y-2 border-t pt-4" onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); submit(async () => { unwrapAction(await addMeetingAttendeeAction(projectId, { meeting_id: selected.id, display_name: form.get("display_name"), company_name: form.get("company_name") || null, email: form.get("email") || null, present: true })); element.reset(); toast.success("Attendee added"); router.refresh() }) }}><Input name="display_name" placeholder="Attendee name" required /><Input name="company_name" placeholder="Company" /><Input name="email" type="email" placeholder="Email" /><Button type="submit" size="sm" variant="outline" disabled={pending}>Add attendee</Button></form> : null}{selected.distributions.length ? <div className="mt-4 space-y-2 border-t pt-4"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Distribution receipts</h3>{selected.distributions.map((recipient) => <div key={recipient.id} className="text-xs"><p className="font-medium">{recipient.display_name}</p><p className="text-muted-foreground">Sent {new Date(recipient.sent_at).toLocaleString()} · {recipient.first_viewed_at ? `Viewed ${new Date(recipient.first_viewed_at).toLocaleString()}` : "Not viewed"}</p></div>)}</div> : null}</aside>
        </div>
        {selected.status === "draft" ? <MeetingTranscriptPanel projectId={projectId} meetingId={selected.id} transcripts={transcripts} items={selected.items} /> : null}
      </section> : null}
    </div>
  )
}

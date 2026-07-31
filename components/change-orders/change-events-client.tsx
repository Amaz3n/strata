"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { ChangeEvent } from "@/lib/services/change-events"
import { convertChangeEventAction, createChangeEventAction, priceChangeEventAction, voidChangeEventAction } from "@/app/(app)/projects/[id]/change-orders/change-events-actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

export function ChangeEventsClient({ projectId, initialEvents }: { projectId: string; initialEvents: ChangeEvent[] }) {
  const [events, setEvents] = useState(initialEvents)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [rom, setRom] = useState("")
  const [pending, startTransition] = useTransition()
  const exposure = events.filter((event) => !["converted", "void"].includes(event.status)).reduce((sum, event) => sum + (event.latest_price_cents || event.rom_cents), 0)

  function create() {
    startTransition(async () => {
      try {
        const event = unwrapAction(await createChangeEventAction(projectId, { title, description, rom_cents: Math.round(Number(rom || 0) * 100) }))
        setEvents((current) => [event, ...current]); setOpen(false); setTitle(""); setDescription(""); setRom("")
        toast.success("Change event created")
      } catch (error) { toast.error(error instanceof Error ? error.message : "Could not create change event") }
    })
  }

  function price(event: ChangeEvent) {
    const raw = window.prompt("Latest price (dollars)", String((event.latest_price_cents || event.rom_cents) / 100))
    if (raw == null) return
    startTransition(async () => {
      try { const updated = unwrapAction(await priceChangeEventAction(projectId, event.id, { description: event.title, amount_cents: Math.round(Number(raw) * 100) })); setEvents((all) => all.map((item) => item.id === event.id ? updated : item)); toast.success("Pricing saved") } catch (error) { toast.error(error instanceof Error ? error.message : "Could not price event") }
    })
  }

  function convert(event: ChangeEvent) {
    startTransition(async () => {
      try { await convertChangeEventAction(projectId, event.id).then(unwrapAction); setEvents((all) => all.map((item) => item.id === event.id ? { ...item, status: "converted" } : item)); toast.success("Draft change order created") } catch (error) { toast.error(error instanceof Error ? error.message : "Could not convert event") }
    })
  }

  return <div className="space-y-4">
    <div className="flex items-center justify-between border bg-card p-4">
      <div><p className="text-xs font-medium uppercase text-muted-foreground">Uncommitted exposure</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(exposure)}</p></div>
      <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild><Button>New change event</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>Catch a change</SheetTitle></SheetHeader><div className="mt-6 space-y-4"><div><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div><div><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div><div><Label>ROM amount</Label><Input inputMode="decimal" value={rom} onChange={(e) => setRom(e.target.value)} placeholder="0.00" /></div><Button disabled={pending || title.trim().length < 3} onClick={create} className="w-full">Create event</Button></div></SheetContent></Sheet>
    </div>
    <div className="overflow-hidden border bg-card"><Table><TableHeader><TableRow><TableHead>Event</TableHead><TableHead>Origin</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Exposure</TableHead><TableHead className="w-56" /></TableRow></TableHeader><TableBody>{events.map((event) => <TableRow key={event.id}><TableCell><p className="font-medium">CE-{String(event.event_number).padStart(3, "0")} · {event.title}</p><p className="line-clamp-1 text-xs text-muted-foreground">{event.description || "No description"}</p></TableCell><TableCell className="capitalize">{event.origin_type.replaceAll("_", " ")}</TableCell><TableCell><Badge variant="outline" className="capitalize">{event.status.replaceAll("_", " ")}</Badge></TableCell><TableCell className="text-right tabular-nums">{money(event.latest_price_cents || event.rom_cents)}</TableCell><TableCell><div className="flex justify-end gap-2">{!["converted", "void"].includes(event.status) && <><Button size="sm" variant="outline" onClick={() => price(event)}>Price</Button><Button size="sm" disabled={!event.lines.length || pending} onClick={() => convert(event)}>Convert</Button><Button size="sm" variant="ghost" onClick={() => startTransition(async () => { try { await voidChangeEventAction(projectId, event.id).then(unwrapAction); setEvents((all) => all.map((item) => item.id === event.id ? { ...item, status: "void" } : item)) } catch (error) { toast.error(error instanceof Error ? error.message : "Could not void event") } })}>Void</Button></>}</div></TableCell></TableRow>)}{events.length === 0 && <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">No change events yet.</TableCell></TableRow>}</TableBody></Table></div>
  </div>
}

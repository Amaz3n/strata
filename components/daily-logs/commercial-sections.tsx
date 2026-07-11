"use client"

import { useState } from "react"
import { toast } from "sonner"
import { ChevronDown, Edit, Plus, Trash2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { DailyReport, ScheduleItem } from "@/lib/types"
import type {
  DailyReportSectionKind,
  DelayInput,
  DeliveryInput,
  EquipmentInput,
  VisitorInput,
  DailyReportSectionInput,
} from "@/lib/validation/daily-logs"

type SectionInput = DailyReportSectionInput

interface CommercialSectionsProps {
  report?: DailyReport
  dateKey: string
  locked: boolean
  scheduleItems: ScheduleItem[]
  onAdd: (date: string, kind: DailyReportSectionKind, input: SectionInput) => Promise<DailyReport>
  onUpdate: (kind: DailyReportSectionKind, id: string, input: SectionInput) => Promise<DailyReport>
  onDelete: (kind: DailyReportSectionKind, id: string) => Promise<DailyReport>
}

const CONFIG = [
  { kind: "delay" as const, label: "Delays" },
  { kind: "equipment" as const, label: "Equipment" },
  { kind: "delivery" as const, label: "Deliveries" },
  { kind: "visitor" as const, label: "Visitors" },
]

function rowsFor(report: DailyReport | undefined, kind: DailyReportSectionKind) {
  if (kind === "delay") return report?.delays ?? []
  if (kind === "equipment") return report?.equipment ?? []
  if (kind === "visitor") return report?.visitors ?? []
  return report?.deliveries ?? []
}

function rowTitle(kind: DailyReportSectionKind, row: Record<string, unknown>) {
  if (kind === "visitor") return String(row.name ?? "Visitor")
  return String(row.description ?? "Entry")
}

function rowMeta(kind: DailyReportSectionKind, row: Record<string, unknown>, scheduleItems: ScheduleItem[]) {
  if (kind === "delay") {
    const schedule = scheduleItems.find((item) => item.id === row.schedule_item_id)
    return [String(row.delay_type ?? "delay").replaceAll("_", " "), row.hours_lost != null ? `${row.hours_lost}h lost` : null, schedule?.name, row.potential_claim ? "Potential claim" : null].filter(Boolean).join(" · ")
  }
  if (kind === "equipment") return [row.company, row.count ? `Qty ${row.count}` : null, row.hours_used != null ? `${row.hours_used}h` : null, row.idle ? "Idle" : null].filter(Boolean).join(" · ")
  if (kind === "visitor") return [row.company, row.purpose, row.time_in && row.time_out ? `${row.time_in}–${row.time_out}` : row.time_in].filter(Boolean).join(" · ")
  return [row.supplier, row.quantity, row.ticket_number ? `Ticket ${row.ticket_number}` : null, row.received_by ? `Received by ${row.received_by}` : null].filter(Boolean).join(" · ")
}

function initialForm(kind: DailyReportSectionKind, row?: Record<string, unknown>) {
  if (kind === "delay") return { delay_type: row?.delay_type ?? "weather", description: row?.description ?? "", hours_lost: row?.hours_lost ?? "", affected_trades: row?.affected_trades ?? "", schedule_item_id: row?.schedule_item_id ?? "none", potential_claim: row?.potential_claim ?? false }
  if (kind === "equipment") return { description: row?.description ?? "", company: row?.company ?? "", count: row?.count ?? 1, hours_used: row?.hours_used ?? "", idle: row?.idle ?? false, notes: row?.notes ?? "" }
  if (kind === "visitor") return { name: row?.name ?? "", company: row?.company ?? "", purpose: row?.purpose ?? "", time_in: row?.time_in ?? "", time_out: row?.time_out ?? "" }
  return { description: row?.description ?? "", supplier: row?.supplier ?? "", quantity: row?.quantity ?? "", ticket_number: row?.ticket_number ?? "", received_by: row?.received_by ?? "", notes: row?.notes ?? "" }
}

function SectionForm({ kind, initial, scheduleItems, busy, onCancel, onSubmit }: {
  kind: DailyReportSectionKind
  initial: Record<string, unknown>
  scheduleItems: ScheduleItem[]
  busy: boolean
  onCancel: () => void
  onSubmit: (input: SectionInput) => void
}) {
  const [form, setForm] = useState(initial)
  const set = (key: string, value: unknown) => setForm((current) => ({ ...current, [key]: value }))
  const text = (key: string) => String(form[key] ?? "")
  const numeric = (key: string) => text(key) === "" ? undefined : Number(text(key))

  function submit() {
    if (kind === "delay") onSubmit({ delay_type: form.delay_type as DelayInput["delay_type"], description: text("description"), hours_lost: numeric("hours_lost"), affected_trades: text("affected_trades") || undefined, schedule_item_id: text("schedule_item_id") === "none" ? null : text("schedule_item_id"), potential_claim: Boolean(form.potential_claim) })
    else if (kind === "equipment") onSubmit({ description: text("description"), company: text("company") || undefined, count: Number(form.count || 1), hours_used: numeric("hours_used"), idle: Boolean(form.idle), notes: text("notes") || undefined })
    else if (kind === "visitor") onSubmit({ name: text("name"), company: text("company") || undefined, purpose: text("purpose") || undefined, time_in: text("time_in") || undefined, time_out: text("time_out") || undefined })
    else onSubmit({ description: text("description"), supplier: text("supplier") || undefined, quantity: text("quantity") || undefined, ticket_number: text("ticket_number") || undefined, received_by: text("received_by") || undefined, notes: text("notes") || undefined })
  }

  return (
    <div className="space-y-3 border border-border bg-muted/20 p-3">
      {kind === "delay" && <>
        <div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>Type</Label><Select value={text("delay_type")} onValueChange={(value) => set("delay_type", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["weather","owner","design","material","labor","equipment","utility","other"].map((value) => <SelectItem key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1"><Label>Hours lost</Label><Input type="number" min="0" max="24" step="0.5" value={text("hours_lost")} onChange={(event) => set("hours_lost", event.target.value)} /></div></div>
        <div className="space-y-1"><Label>Description</Label><Textarea value={text("description")} onChange={(event) => set("description", event.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>Affected trades</Label><Input value={text("affected_trades")} onChange={(event) => set("affected_trades", event.target.value)} /></div><div className="space-y-1"><Label>Schedule item</Label><Select value={text("schedule_item_id")} onValueChange={(value) => set("schedule_item_id", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Not linked</SelectItem>{scheduleItems.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></div></div>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(form.potential_claim)} onCheckedChange={(value) => set("potential_claim", value === true)} />Potential claim</label>
      </>}
      {kind === "equipment" && <><div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>Description</Label><Input value={text("description")} onChange={(event) => set("description", event.target.value)} /></div><div className="space-y-1"><Label>Company</Label><Input value={text("company")} onChange={(event) => set("company", event.target.value)} /></div></div><div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>Count</Label><Input type="number" min="1" value={text("count")} onChange={(event) => set("count", event.target.value)} /></div><div className="space-y-1"><Label>Hours used</Label><Input type="number" min="0" step="0.5" value={text("hours_used")} onChange={(event) => set("hours_used", event.target.value)} /></div></div><label className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(form.idle)} onCheckedChange={(value) => set("idle", value === true)} />Idle equipment</label><div className="space-y-1"><Label>Notes</Label><Textarea value={text("notes")} onChange={(event) => set("notes", event.target.value)} /></div></>}
      {kind === "visitor" && <><div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>Name</Label><Input value={text("name")} onChange={(event) => set("name", event.target.value)} /></div><div className="space-y-1"><Label>Company</Label><Input value={text("company")} onChange={(event) => set("company", event.target.value)} /></div></div><div className="space-y-1"><Label>Purpose</Label><Input value={text("purpose")} onChange={(event) => set("purpose", event.target.value)} /></div><div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>Time in</Label><Input type="time" value={text("time_in")} onChange={(event) => set("time_in", event.target.value)} /></div><div className="space-y-1"><Label>Time out</Label><Input type="time" value={text("time_out")} onChange={(event) => set("time_out", event.target.value)} /></div></div></>}
      {kind === "delivery" && <><div className="space-y-1"><Label>Description</Label><Input value={text("description")} onChange={(event) => set("description", event.target.value)} /></div><div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label>Supplier</Label><Input value={text("supplier")} onChange={(event) => set("supplier", event.target.value)} /></div><div className="space-y-1"><Label>Quantity</Label><Input value={text("quantity")} onChange={(event) => set("quantity", event.target.value)} /></div><div className="space-y-1"><Label>Ticket number</Label><Input value={text("ticket_number")} onChange={(event) => set("ticket_number", event.target.value)} /></div><div className="space-y-1"><Label>Received by</Label><Input value={text("received_by")} onChange={(event) => set("received_by", event.target.value)} /></div></div><div className="space-y-1"><Label>Notes</Label><Textarea value={text("notes")} onChange={(event) => set("notes", event.target.value)} /></div></>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button><Button type="button" size="sm" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Save"}</Button></div>
    </div>
  )
}

export function CommercialSections({ report, dateKey, locked, scheduleItems, onAdd, onUpdate, onDelete }: CommercialSectionsProps) {
  const [open, setOpen] = useState<DailyReportSectionKind | null>(null)
  const [editing, setEditing] = useState<{ kind: DailyReportSectionKind; id: string } | null>(null)
  const [adding, setAdding] = useState<DailyReportSectionKind | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(work: () => Promise<unknown>, done: () => void) {
    setBusy(true)
    try { await work(); done() } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save section") } finally { setBusy(false) }
  }

  return <div className="divide-y border-y">
    {CONFIG.map(({ kind, label }) => {
      const rows = rowsFor(report, kind)
      const expanded = open === kind || adding === kind || editing?.kind === kind
      if (locked && rows.length === 0) return null
      return <section key={kind}>
        <div className="flex min-h-11 items-center justify-between gap-3 py-2">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(expanded ? null : kind)}><ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} /><span className="text-xs font-semibold uppercase tracking-wider">{label}</span><span className="font-mono text-[10px] text-muted-foreground">{rows.length || "—"}</span></button>
          {!locked && <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => { setOpen(kind); setAdding(kind); setEditing(null) }}><Plus className="mr-1 h-3.5 w-3.5" />Add</Button>}
        </div>
        {expanded && <div className="space-y-2 pb-3 pl-5">
          {rows.length === 0 && adding !== kind && <p className="py-1 text-sm text-muted-foreground">No {label.toLowerCase()} recorded.</p>}
          {rows.map((row) => {
            const record = row as unknown as Record<string, unknown>
            if (editing?.kind === kind && editing.id === row.id) return <SectionForm key={row.id} kind={kind} initial={initialForm(kind, record)} scheduleItems={scheduleItems} busy={busy} onCancel={() => setEditing(null)} onSubmit={(input) => void run(() => onUpdate(kind, row.id, input), () => setEditing(null))} />
            return <div key={row.id} className="group flex items-start gap-3 border-b border-border/60 py-2 last:border-0"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{rowTitle(kind, record)}</p><p className="mt-0.5 text-xs capitalize text-muted-foreground">{rowMeta(kind, record, scheduleItems) || "No details"}</p></div>{!locked && <div className="flex opacity-0 transition-opacity group-hover:opacity-100"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing({ kind, id: row.id }); setAdding(null) }}><Edit className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => void run(() => onDelete(kind, row.id), () => {})}><Trash2 className="h-3.5 w-3.5" /></Button></div>}</div>
          })}
          {adding === kind && <SectionForm kind={kind} initial={initialForm(kind)} scheduleItems={scheduleItems} busy={busy} onCancel={() => setAdding(null)} onSubmit={(input) => void run(() => onAdd(dateKey, kind, input), () => setAdding(null))} />}
        </div>}
      </section>
    })}
  </div>
}

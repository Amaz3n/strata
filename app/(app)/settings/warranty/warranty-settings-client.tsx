"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import type { WarrantyProgramDTO } from "@/lib/services/warranty"
import { saveWarrantyProgramAction, saveWarrantySlaTargetsAction } from "@/app/(app)/warranty/actions"

type Target = { severity: string; first_response_hours: number; resolution_days: number }

export function WarrantySettingsClient({ programs: initialPrograms, targets: initialTargets }: { programs: WarrantyProgramDTO[]; targets: Target[] }) {
  const [programs, setPrograms] = useState(initialPrograms)
  const [targets, setTargets] = useState(initialTargets)
  const [pending, startTransition] = useTransition()
  const program = programs.find((item) => item.is_default) ?? programs[0]
  return <div className="space-y-6">
    <section className="border"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Coverage program</h2><p className="text-xs text-muted-foreground">Terms are snapshotted when a home enrolls; edits never move existing expiries.</p></div>{program ? <form className="space-y-4 p-4" action={(formData) => startTransition(async () => { const terms = program.terms.map((term, index) => ({ ...term, label: String(formData.get(`label-${index}`) || term.label), duration_months: Number(formData.get(`months-${index}`) || term.duration_months), description: String(formData.get(`description-${index}`) || "") || null })); const result = await saveWarrantyProgramAction({ ...program, name: String(formData.get("name") || program.name), description: String(formData.get("description") || "") || null, terms }); if (!result.success) { toast.error(result.error); return } setPrograms((rows) => rows.map((row) => row.id === result.data.id ? result.data : row)); toast.success("Warranty program saved") })}><div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="program-name">Name</Label><Input id="program-name" name="name" defaultValue={program.name}/></div><div><Label htmlFor="program-description">Description</Label><Input id="program-description" name="description" defaultValue={program.description ?? ""}/></div></div><div className="divide-y border">{program.terms.map((term, index) => <div key={term.key} className="grid gap-3 p-3 md:grid-cols-[1fr_140px_2fr]"><div><Label htmlFor={`label-${index}`}>Term</Label><Input id={`label-${index}`} name={`label-${index}`} defaultValue={term.label}/></div><div><Label htmlFor={`months-${index}`}>Months</Label><Input id={`months-${index}`} name={`months-${index}`} type="number" min={1} defaultValue={term.duration_months}/></div><div><Label htmlFor={`description-${index}`}>Buyer-facing description</Label><Textarea id={`description-${index}`} name={`description-${index}`} defaultValue={term.description ?? ""}/></div></div>)}</div><div className="flex justify-end"><Button disabled={pending}>Save program</Button></div></form> : <div className="p-4 text-sm text-muted-foreground">No warranty program configured.</div>}</section>
    <section className="border"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Service-level targets</h2></div><form className="p-4" action={() => startTransition(async () => { const result = await saveWarrantySlaTargetsAction({ targets }); if (!result.success) { toast.error(result.error); return } toast.success("SLA targets saved") })}><div className="divide-y border">{targets.map((target, index) => <div key={target.severity} className="grid items-end gap-3 p-3 sm:grid-cols-[1fr_160px_160px]"><div><p className="text-sm font-medium">{target.severity.replaceAll("_", " ")}</p></div><div><Label>First response hours</Label><Input type="number" min={1} value={target.first_response_hours} onChange={(event) => setTargets((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, first_response_hours: Number(event.target.value) } : row))}/></div><div><Label>Resolution days</Label><Input type="number" min={1} value={target.resolution_days} onChange={(event) => setTargets((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, resolution_days: Number(event.target.value) } : row))}/></div></div>)}</div><div className="mt-4 flex justify-end"><Button disabled={pending}>Save targets</Button></div></form></section>
  </div>
}

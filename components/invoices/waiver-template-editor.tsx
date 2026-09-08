"use client"

import { useEffect, useState } from "react"
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { INVOICE_WAIVER_TYPES, INVOICE_WAIVER_TYPE_LABELS, type InvoiceLienWaiverType } from "@/lib/types"
import { WAIVER_FIELDS, WAIVER_PDF_LIMIT, templateInputSchema, type WaiverFieldKey, type WaiverPlacement, type WaiverTemplate } from "@/lib/lien-waivers/invoice-waiver"
import { unwrapAction } from "@/lib/action-result"
import { saveWaiverTemplateAction } from "@/app/(app)/invoices/waiver-actions"
import { WaiverPdfPreview } from "./waiver-pdf-preview"

export function WaiverTemplateEditor({ invoiceId, projectId, canManageCompany, template, onBack, onSaved }: {
  invoiceId: string; projectId?: string | null; canManageCompany: boolean; template?: WaiverTemplate;
  onBack: () => void; onSaved: (templates: WaiverTemplate[]) => void;
}) {
  const [name, setName] = useState(template?.name ?? "")
  const [kind, setKind] = useState<InvoiceLienWaiverType>(template?.waiver_type ?? "conditional_progress")
  const [scope, setScope] = useState<"company" | "project">(template?.scope ?? (projectId ? "project" : "company"))
  const [preferred, setPreferred] = useState(template?.preferred ?? true)
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState(template ? `/api/invoices/${invoiceId}/waiver-templates/${template.id}` : "")
  const [fields, setFields] = useState<WaiverPlacement[]>(template?.fields ?? [])
  const [active, setActive] = useState<WaiverFieldKey>("claimant_name")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selected = fields.find((f) => f.id === selectedId)
  useEffect(() => {
    if (!file) return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  function place(key: WaiverFieldKey, page: number, x: number, y: number) {
    const field = { id: crypto.randomUUID(), key, page, x: Math.min(x, 0.68), y: Math.min(y, 0.96), width: 0.32, height: key === "exceptions" ? 0.08 : 0.035 }
    field.y = Math.min(field.y, 1 - field.height)
    setFields((current) => [...current, field]); setSelectedId(field.id)
  }
  function change(field: WaiverPlacement) { setFields((current) => current.map((f) => f.id === field.id ? field : f)) }
  async function save() {
    const parsed = templateInputSchema.safeParse({ name, waiver_type: kind, scope, preferred, fields, family_id: template?.family_id ?? template?.id })
    if (!parsed.success) { toast.error(parsed.error.issues[0].message); return }
    if (!file && !template) { toast.error("Choose your PDF first"); return }
    setBusy(true)
    try {
      const form = new FormData(); form.set("invoiceId", invoiceId); form.set("input", JSON.stringify(parsed.data)); if (file) form.set("file", file)
      const templates = unwrapAction(await saveWaiverTemplateAction(form))
      toast.success(template ? "New template version saved" : "Template ready to use")
      onSaved(templates)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save template") }
    finally { setBusy(false) }
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-5"><Button variant="ghost" size="icon" disabled={busy} aria-label="Back to waiver" onClick={onBack}><ArrowLeft className="size-4" /></Button><div><p className="text-sm font-medium">{template ? "Revise template" : "Set up your form"}</p><p className="text-xs text-muted-foreground">Map once. Reuse with every invoice.</p></div></div>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex h-56 min-h-0 shrink-0 md:h-auto md:flex-1">{url ? <WaiverPdfPreview url={url} fields={fields} activeField={active} selectedId={selectedId} onPlace={place} onSelect={setSelectedId} onChange={change} /> : <div className="flex flex-1 items-center justify-center bg-muted/30 p-8 text-center text-sm text-muted-foreground">Choose your original PDF to place fields.</div>}</div>
      <div className="flex min-h-0 w-full flex-1 flex-col border-t md:w-80 md:flex-none md:border-l md:border-t-0">
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          <div className="space-y-1.5"><Label htmlFor="waiver-template-name">Template name</Label><Input id="waiver-template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Company progress waiver" maxLength={100} /></div>
          <div className="space-y-1.5"><Label htmlFor="waiver-template-file">Original PDF</Label><Input id="waiver-template-file" type="file" accept="application/pdf,.pdf" className="text-xs" onChange={(e) => {
            const next = e.target.files?.[0]; if (!next) return
            if (next.size > WAIVER_PDF_LIMIT) { toast.error("Choose a PDF smaller than 15 MB"); return }
            setFile(next); setFields([]); setSelectedId(null)
          }} /></div>
          <Select value={kind} onValueChange={(v) => setKind(v as InvoiceLienWaiverType)}><SelectTrigger aria-label="Template waiver type"><SelectValue /></SelectTrigger><SelectContent>{INVOICE_WAIVER_TYPES.map((k) => <SelectItem key={k} value={k}>{INVOICE_WAIVER_TYPE_LABELS[k]}</SelectItem>)}</SelectContent></Select>
          <Select value={scope} disabled={Boolean(template)} onValueChange={(v) => setScope(v as "company" | "project")}><SelectTrigger aria-label="Template availability"><SelectValue /></SelectTrigger><SelectContent>{projectId && <SelectItem value="project">This project</SelectItem>}{canManageCompany && <SelectItem value="company">Entire company</SelectItem>}</SelectContent></Select>
          <label className="flex items-start gap-2 text-xs leading-relaxed"><Checkbox checked={preferred} onCheckedChange={(v) => setPreferred(v === true)} />Use by default for this waiver type</label>
          <div className="space-y-2 border-t pt-4"><Label>Field to place</Label><Select value={active} onValueChange={(v) => setActive(v as WaiverFieldKey)}><SelectTrigger aria-label="Field to place"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(WAIVER_FIELDS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select>
            <p className="text-xs leading-relaxed text-muted-foreground">Click the blank on the form. Use arrow keys to fine-tune a selected field.</p>
            <Button size="sm" variant="outline" disabled={!url} className="w-full" onClick={() => place(active, 0, 0.35, 0.5)}><Plus className="mr-2 size-3.5" />Add field to first page</Button>
          </div>
          {selected && <div className="space-y-3 rounded-lg border p-3"><div className="flex items-center justify-between text-xs font-medium">{WAIVER_FIELDS[selected.key]}<Button size="icon" variant="ghost" className="size-6" aria-label="Remove selected field" onClick={() => { setFields((fs) => fs.filter((f) => f.id !== selected.id)); setSelectedId(null) }}><Trash2 className="size-3.5" /></Button></div>
            {(["width", "height"] as const).map((key) => <label key={key} className="block text-xs capitalize">{key}<input className="mt-2 block w-full accent-primary" type="range" aria-label={`Field ${key}`} min={key === "width" ? 0.05 : 0.02} max={key === "width" ? 1 - selected.x : Math.min(0.5, 1 - selected.y)} step="0.005" value={selected[key]} onChange={(e) => change({ ...selected, [key]: Number(e.target.value) })} /></label>)}
          </div>}
          <div className="flex flex-wrap gap-1.5">{fields.map((f) => <button type="button" key={f.id} onClick={() => setSelectedId(f.id)} className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted">{WAIVER_FIELDS[f.key]} · {f.page + 1}</button>)}</div>
          <p className="text-xs leading-relaxed text-muted-foreground">Your form’s wording stays intact. Revisions create a new version; issued waivers keep their original document.</p>
        </div>
        <div className="border-t p-4"><Button className="w-full" disabled={busy || !url || (scope === "company" && !canManageCompany)} onClick={() => void save()}>{busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}{busy ? "Saving…" : "Save template"}</Button></div>
      </div>
    </div>
  </div>
}

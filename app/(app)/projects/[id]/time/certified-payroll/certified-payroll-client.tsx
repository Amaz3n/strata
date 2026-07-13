"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { CertifiedPayrollDetail, CertifiedPayrollReport, PayrollWorkerProfile, WageClassification, WageDetermination } from "@/lib/services/certified-payroll"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  certifiedPayrollRegisterCsvAction,
  createCertifiedPayrollAction,
  createWageClassificationAction,
  createWageDeterminationAction,
  finalizeCertifiedPayrollAction,
  savePayrollWorkerProfileAction,
  updateCertifiedPayrollLineAction,
} from "./actions"

function dollars(cents: number) { return `$${(cents / 100).toFixed(2)}` }

export function CertifiedPayrollClient({ projectId, determinations, classifications, workers, reports, initialSelected }: {
  projectId: string
  determinations: WageDetermination[]
  classifications: WageClassification[]
  workers: PayrollWorkerProfile[]
  reports: CertifiedPayrollReport[]
  initialSelected: CertifiedPayrollDetail | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState(initialSelected)
  const [noWork, setNoWork] = useState(false)
  const [finalPayroll, setFinalPayroll] = useState(false)
  const [classificationPaste, setClassificationPaste] = useState("")
  const run = (work: () => Promise<void>) => startTransition(() => void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong")))

  return (
    <Tabs defaultValue="reports" className="min-h-0 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4 border-b pb-4">
        <TabsList><TabsTrigger value="reports">Certified payroll</TabsTrigger><TabsTrigger value="setup">Prevailing wage setup</TabsTrigger></TabsList>
        <Button variant="outline" size="sm" disabled={pending || reports.length === 0} onClick={() => run(async () => {
          const csv = unwrapAction(await certifiedPayrollRegisterCsvAction(projectId))
          const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
          const link = document.createElement("a"); link.href = url; link.download = "certified-payroll-register.csv"; link.click(); URL.revokeObjectURL(url)
        })}>Export register CSV</Button>
      </div>

      <TabsContent value="reports" className="mt-4 space-y-4">
        <form className="grid gap-3 border p-3 sm:grid-cols-[180px_auto_auto_auto]" onSubmit={(event) => {
          event.preventDefault(); const form = new FormData(event.currentTarget); const weekEnding = String(form.get("week_ending") || "")
          run(async () => { const created = unwrapAction(await createCertifiedPayrollAction({ project_id: projectId, week_ending: weekEnding, is_no_work: noWork, is_final: finalPayroll })); setSelected(created); toast.success(`Payroll #${created.payroll_number} drafted`); router.refresh() })
        }}>
          <Input name="week_ending" type="date" required disabled={pending} />
          <Label className="flex items-center gap-2 text-xs"><Checkbox checked={noWork} onCheckedChange={(value) => setNoWork(value === true)} />No work</Label>
          <Label className="flex items-center gap-2 text-xs"><Checkbox checked={finalPayroll} onCheckedChange={(value) => setFinalPayroll(value === true)} />Final payroll</Label>
          <Button type="submit" disabled={pending}>Draft report</Button>
        </form>
        <div className="grid min-h-[480px] border lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="border-b lg:border-b-0 lg:border-r">
            {reports.length ? reports.map((report) => <button key={report.id} className="flex w-full items-center justify-between border-b px-3 py-3 text-left hover:bg-muted/40" onClick={() => { window.location.href = `/projects/${projectId}/time/certified-payroll?report=${report.id}` }}><span><span className="block text-sm font-medium">Payroll #{report.payroll_number}</span><span className="text-xs text-muted-foreground">Week ending {report.week_ending}</span></span><Badge variant={report.status === "finalized" ? "secondary" : "outline"}>{report.is_no_work ? "No work" : report.status}</Badge></button>) : <p className="p-6 text-sm text-muted-foreground">No payroll reports yet.</p>}
          </div>
          <div className="min-w-0 p-4">
            {selected ? <ReportReview projectId={projectId} report={selected} classifications={classifications} pending={pending} run={run} /> : <div className="py-24 text-center text-sm text-muted-foreground">Pick a week ending to draft the first certified payroll.</div>}
          </div>
        </div>
      </TabsContent>

      <TabsContent value="setup" className="mt-4 space-y-5">
        <section className="border p-4"><h2 className="text-sm font-semibold">Wage determination</h2><form className="mt-3 grid gap-2 sm:grid-cols-4" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); run(async () => { unwrapAction(await createWageDeterminationAction({ project_id: projectId, determination_number: String(form.get("number")), source: String(form.get("source") || "") || null, effective_date: String(form.get("effective_date") || "") || null })); toast.success("Determination added"); router.refresh() }) }}><Input name="number" placeholder="GA20260012" required /><Input name="source" placeholder="Source / reference" /><Input name="effective_date" type="date" /><Button type="submit" disabled={pending}>Add determination</Button></form><div className="mt-3 text-xs text-muted-foreground">{determinations.map((item) => `${item.determination_number}${item.effective_date ? ` (${item.effective_date})` : ""}`).join(" · ") || "No determination configured."}</div></section>

        <section className="border p-4"><h2 className="text-sm font-semibold">Classification rates</h2><p className="mt-1 text-xs text-muted-foreground">Paste one per line: Classification, base dollars, fringe dollars.</p><Textarea className="mt-3" value={classificationPaste} onChange={(event) => setClassificationPaste(event.target.value)} placeholder={"Electrician,42.50,12.10\nLaborer Group 1,28.00,8.50"} /><Button className="mt-2" disabled={pending || !determinations[0] || !classificationPaste.trim()} onClick={() => run(async () => { const determination = determinations[0]; if (!determination) return; for (const row of classificationPaste.split(/\r?\n/).filter(Boolean)) { const [name, base, fringe] = row.split(",").map((part) => part.trim()); if (!name || Number.isNaN(Number(base))) throw new Error(`Invalid classification row: ${row}`); unwrapAction(await createWageClassificationAction(projectId, { determination_id: determination.id, classification: name, base_rate_cents: Math.round(Number(base) * 100), fringe_rate_cents: Math.round(Number(fringe || 0) * 100) })) } setClassificationPaste(""); toast.success("Classification rates added"); router.refresh() })}>Add pasted rates</Button><div className="mt-4 border"><Table><TableHeader><TableRow><TableHead>Classification</TableHead><TableHead className="text-right">Base</TableHead><TableHead className="text-right">Fringe</TableHead></TableRow></TableHeader><TableBody>{classifications.map((item) => <TableRow key={item.id}><TableCell>{item.classification}</TableCell><TableCell className="text-right tabular-nums">{dollars(item.base_rate_cents)}</TableCell><TableCell className="text-right tabular-nums">{dollars(item.fringe_rate_cents)}</TableCell></TableRow>)}</TableBody></Table></div></section>

        <section className="border p-4"><h2 className="text-sm font-semibold">Worker profiles</h2><form className="mt-3 grid gap-2 sm:grid-cols-5" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); run(async () => { unwrapAction(await savePayrollWorkerProfileAction(projectId, { display_name: String(form.get("name")), address: String(form.get("address") || "") || null, tax_id_last4: String(form.get("last4") || "") || null, default_classification_id: String(form.get("classification") || "") || null, fringe_paid_in_cash: form.get("cash_fringe") === "on" })); toast.success("Worker profile added"); router.refresh() }) }}><Input name="name" placeholder="Worker name" required /><Input name="address" placeholder="Address" /><Input name="last4" inputMode="numeric" maxLength={4} placeholder="ID last 4" /><Select name="classification"><SelectTrigger><SelectValue placeholder="Classification" /></SelectTrigger><SelectContent>{classifications.map((item) => <SelectItem key={item.id} value={item.id}>{item.classification}</SelectItem>)}</SelectContent></Select><div className="flex gap-2"><Label className="flex items-center gap-1 text-xs"><Checkbox name="cash_fringe" />Cash fringe</Label><Button type="submit" disabled={pending}>Add</Button></div></form><div className="mt-4 divide-y border">{workers.map((worker) => <div key={worker.id} className="flex items-center justify-between px-3 py-2 text-sm"><span>{worker.display_name}<span className="ml-2 text-xs text-muted-foreground">{worker.user_id ? "Arc user" : "Non-user worker"}</span></span><span className="text-xs text-muted-foreground">{classifications.find((item) => item.id === worker.default_classification_id)?.classification ?? "Classification not set"}</span></div>)}</div></section>
      </TabsContent>
    </Tabs>
  )
}

function ReportReview({ projectId, report, classifications, pending, run }: { projectId: string; report: CertifiedPayrollDetail; classifications: WageClassification[]; pending: boolean; run: (work: () => Promise<void>) => void }) {
  const router = useRouter()
  return <div><div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Payroll #{report.payroll_number}</h2><p className="text-xs text-muted-foreground">Week ending {report.week_ending}{report.is_final ? " · Final payroll" : ""}</p></div><div className="flex gap-2">{report.pdf_file_id ? <Button variant="outline" size="sm" asChild><a href={`/api/files/${report.pdf_file_id}/raw`}>PDF</a></Button> : null}{report.status === "draft" ? <Button size="sm" disabled={pending} onClick={() => run(async () => { unwrapAction(await finalizeCertifiedPayrollAction(projectId, report.id)); toast.success("Certified payroll finalized"); router.refresh() })}>Finalize & create PDF</Button> : <Badge variant="secondary">Finalized</Badge>}</div></div>{report.is_no_work ? <div className="mt-6 border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">No work performed. This numbered report preserves payroll sequence continuity.</div> : <div className="mt-4 overflow-auto border"><Table><TableHeader><TableRow><TableHead>Worker</TableHead><TableHead>Classification</TableHead><TableHead>Day hours ST/OT/DT</TableHead><TableHead className="text-right">Gross</TableHead><TableHead className="text-right">All projects</TableHead><TableHead className="text-right">Deductions</TableHead><TableHead className="text-right">Net</TableHead></TableRow></TableHeader><TableBody>{report.lines.map((line) => <TableRow key={line.id}><TableCell><div className="font-medium">{line.worker.display_name}</div><div className="text-xs text-muted-foreground">{line.worker.tax_id_last4 ? `xxx-xx-${line.worker.tax_id_last4}` : "ID not provided"}</div></TableCell><TableCell><Select disabled={report.status !== "draft" || pending} value={line.classification_id ?? ""} onValueChange={(classification_id) => run(async () => { unwrapAction(await updateCertifiedPayrollLineAction(projectId, line.id, { classification_id })); router.refresh() })}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent>{classifications.map((item) => <SelectItem key={item.id} value={item.id}>{item.classification}</SelectItem>)}</SelectContent></Select></TableCell><TableCell className="min-w-56 text-xs">{Object.entries(line.day_hours).sort(([a], [b]) => a.localeCompare(b)).map(([date, hours]) => <div key={date}><span className="inline-block w-16 text-muted-foreground">{date.slice(5)}</span>{hours.st}/{hours.ot}/{hours.dt}</div>)}</TableCell><TableCell className="text-right tabular-nums">{dollars(line.gross_this_project_cents)}</TableCell><TableCell><MoneyEditor disabled={report.status !== "draft" || pending} initial={line.gross_all_projects_cents} onSave={(value) => run(async () => { unwrapAction(await updateCertifiedPayrollLineAction(projectId, line.id, { gross_all_projects_cents: value })); router.refresh() })} /></TableCell><TableCell><MoneyEditor disabled={report.status !== "draft" || pending} initial={Object.values(line.deductions ?? {}).reduce((sum, value) => sum + value, 0)} onSave={(value) => run(async () => { unwrapAction(await updateCertifiedPayrollLineAction(projectId, line.id, { deductions: value == null ? null : { other: value } })); router.refresh() })} /></TableCell><TableCell><MoneyEditor disabled={report.status !== "draft" || pending} initial={line.net_pay_cents} placeholder="Payroll register" onSave={(value) => run(async () => { unwrapAction(await updateCertifiedPayrollLineAction(projectId, line.id, { net_pay_cents: value })); router.refresh() })} /></TableCell></TableRow>)}</TableBody></Table></div>}</div>
}

function MoneyEditor({ initial, disabled, placeholder, onSave }: { initial: number | null; disabled: boolean; placeholder?: string; onSave: (cents: number | null) => void }) {
  const [value, setValue] = useState(initial == null ? "" : (initial / 100).toFixed(2))
  return <Input className="w-28 text-right tabular-nums" value={value} disabled={disabled} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} onBlur={() => onSave(value.trim() ? Math.round(Number(value) * 100) : null)} />
}

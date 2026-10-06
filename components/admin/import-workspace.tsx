"use client"

import Link from "next/link"
import { QueuePagination } from "@/components/layout/queue-pagination"
import { useRouter } from "next/navigation"
import { useMemo, useRef, useState, useTransition } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { toast } from "sonner"

import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import type { ImportColumnSpec, ImporterKey } from "@/lib/services/import-definitions"

type Batch = { id: string; status: string; source_filename: string | null; row_count: number; valid_count: number; warning_count: number; error_count: number; committed_count: number; skipped_count: number; report: Record<string, unknown>; context: Record<string, unknown>; update_existing: boolean; created_at: string }
type Row = { id: string; row_number: number; parsed: Record<string, string | number | boolean | null>; status: string; issues: Array<{ level: string; code: string; message: string; column?: string }>; action: string | null }
type Suggestion = { mappings: Array<{ target: string; source: string | null; confidence: "high" | "medium" | "low"; note: string }>; unmatched_targets: string[]; unmapped_sources: string[] }

interface Props {
  canManage?: boolean
  orgId?: string
  onboardingRunId?: string | null
  importer: ImporterKey
  label: string
  description: string
  columns: readonly ImportColumnSpec[]
  fileKinds?: readonly { key: string; label: string }[]
  workspaceHref?: string
  batchPagination?: { total: number; page: number; limit: number }
  batches: Batch[]
  detail?: { batch: Batch; rows: Row[]; total: number; page?: number; limit?: number; status?: string } | null
  backHref: string
  previewAction: (input: { orgId?: string; importer: ImporterKey; csvText: string }) => Promise<ActionResult<{ headers: string[]; suggestion: Suggestion }>>
  stageAction: (input: { orgId?: string; importer: ImporterKey; csvText: string; sourceFilename?: string; mapping: Record<string, string | null>; context?: Record<string, unknown>; onboardingRunId?: string | null }) => Promise<ActionResult<Batch>>
  patchAction: (input: { orgId?: string; importer: ImporterKey; batchId: string; rowId: string; patch?: Record<string, string | number | boolean | null>; skip?: boolean }) => Promise<ActionResult<unknown>>
  updateExistingAction: (input: { orgId?: string; importer: ImporterKey; batchId: string; updateExisting: boolean }) => Promise<ActionResult<unknown>>
  commitAction: (input: { orgId?: string; importer: ImporterKey; batchId: string }) => Promise<ActionResult<unknown>>
  discardAction: (input: { orgId?: string; importer: ImporterKey; batchId: string }) => Promise<ActionResult<unknown>>
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "committed" || status === "valid") return "default"
  if (status === "error" || status === "failed") return "destructive"
  if (status === "warning") return "secondary"
  return "outline"
}

async function runImportTask<T>(task: () => Promise<ActionResult<T>>, refresh: () => void, success?: string, onSuccess?: (value: T) => void) {
  try {
    const value = unwrapAction(await task())
    onSuccess?.(value)
    if (success) {
      toast.success(success)
      refresh()
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Import action failed")
  }
}

export function ImportWorkspace(props: Props) {
  return <ImportWorkspaceSession key={`${props.orgId ?? "current"}:${props.importer}:${props.detail?.batch.id ?? "upload"}`} {...props} />
}

function ImportWorkspaceSession(props: Props) {
  const canManage = props.canManage ?? true
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [csvText, setCsvText] = useState("")
  const [filename, setFilename] = useState("")
  const [headers, setHeaders] = useState<string[]>([])
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [fileKind, setFileKind] = useState(props.fileKinds?.[0]?.key ?? "")
  const [asOfDate, setAsOfDate] = useState("")
  const [step, setStep] = useState(props.detail ? "review" : "upload")
  const [editing, setEditing] = useState<Row | null>(null)
  const statusFilter = props.detail?.status ?? "all"
  const navigationHref = (change: { batch?: string; rowStatus?: string; rowPage?: number } = {}) => {
    const search = new URLSearchParams()
    const batch = change.batch ?? props.detail?.batch.id
    if (batch) search.set("batch", batch)
    search.set("batchPage", String(props.batchPagination?.page ?? 1))
    search.set("rowPage", String(change.rowPage ?? props.detail?.page ?? 1))
    search.set("rowStatus", change.rowStatus ?? statusFilter)
    return `${props.workspaceHref ?? ""}?${search}`
  }
  const setStatusFilter = (status: string) => router.push(navigationHref({ rowStatus: status, rowPage: 1 }), { scroll: false })
  const rows = useMemo(() => props.detail?.rows ?? [], [props.detail?.rows])
  const filteredRows = rows
  const visibleColumns = useMemo(() => props.columns.filter((column) => filteredRows.some((row) => row.parsed[column.key] != null && row.parsed[column.key] !== "")).slice(0, 6), [props.columns, filteredRows])

  const run = <T,>(task: () => Promise<ActionResult<T>>, success?: string, onSuccess?: (value: T) => void) => {
    if (!canManage) return
    startTransition(() => runImportTask(task, () => router.refresh(), success, onSuccess))
  }

  const chooseFile = async (file?: File) => {
    if (!canManage || !file) return
    if (!file.name.toLowerCase().endsWith(".csv")) { toast.error("Choose a CSV file"); return }
    const text = await file.text()
    setCsvText(text); setFilename(file.name)
    run(() => props.previewAction({ orgId: props.orgId, importer: props.importer, csvText: text }), undefined, (result) => {
      setHeaders(result.headers); setSuggestion(result.suggestion)
      setMapping(Object.fromEntries(result.suggestion.mappings.map((item) => [item.target, item.source])))
      setStep("map")
    })
  }

  const missingRequired = props.columns.filter((column) => column.required && !mapping[column.key])

  const stage = () => {
    if (!canManage) return
    const context: Record<string, unknown> = {}
    if (fileKind) context.file_kind = fileKind
    if (props.importer === "open_wip") {
      if (!asOfDate) throw new Error("Choose the Open-WIP as-of date")
      context.as_of_date = asOfDate
    }
    run(() => props.stageAction({ orgId: props.orgId, importer: props.importer, csvText, sourceFilename: filename, mapping, context, onboardingRunId: props.onboardingRunId }), undefined, (result) => {
      toast.success("Import staged")
      router.push(`${window.location.pathname}?batch=${encodeURIComponent(result.id)}`, { scroll: false })
    })
  }

  const templateDownload = () => {
    const csv = `${props.columns.map((column) => column.key).join(",")}\n${props.columns.map((column) => column.example ?? "").join(",")}\n`
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }))
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${props.importer}-template.csv`; anchor.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      {!canManage ? <p role="status" className="text-sm text-muted-foreground">Read-only access. You can inspect batches and validation results.</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div><h1 className="text-xl font-semibold tracking-tight">{props.label}</h1><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{props.description}</p></div>
        <div className="flex gap-2"><Button asChild size="sm" variant="outline"><Link href={props.backHref}>Back</Link></Button><Button size="sm" variant="outline" onClick={templateDownload}><Download /> Template</Button></div>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className={step === "upload" ? "font-medium text-foreground" : ""}>Upload</span><span>→</span><span className={step === "map" ? "font-medium text-foreground" : ""}>Map</span><span>→</span><span className={step === "review" ? "font-medium text-foreground" : ""}>Review</span><span>→</span><span>Commit</span></div>

      <Tabs value={step} onValueChange={setStep}>
        <TabsList><TabsTrigger value="upload" disabled={!canManage}>Upload</TabsTrigger><TabsTrigger value="map" disabled={!canManage || !suggestion}>Map</TabsTrigger><TabsTrigger value="review" disabled={!props.detail}>Review</TabsTrigger></TabsList>
        <TabsContent value="upload" className="mt-4">
          <div className="grid gap-4 border border-dashed p-8 text-center">
            <FileSpreadsheet className="mx-auto size-8 text-muted-foreground" />
            <div><p className="text-sm font-medium">Stage a CSV for dry-run validation</p><p className="mt-1 text-xs text-muted-foreground">Up to 10MB and 10,000 rows. Staging never writes domain records.</p></div>
            {props.fileKinds ? <label className="mx-auto w-72 space-y-1 text-left text-xs font-medium">File type<Select disabled={!canManage} value={fileKind} onValueChange={setFileKind}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{props.fileKinds.map((kind) => <SelectItem key={kind.key} value={kind.key}>{kind.label}</SelectItem>)}</SelectContent></Select></label> : null}
            {props.importer === "open_wip" ? <label className="mx-auto w-72 space-y-1 text-left text-xs font-medium">As-of date<Input disabled={!canManage} type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} /></label> : null}
            <label className="mx-auto"><Input type="file" accept=".csv,text/csv" className="w-80" onChange={(event) => void chooseFile(event.target.files?.[0])} disabled={!canManage || pending} /></label>
          </div>
        </TabsContent>
        <TabsContent value="map" className="mt-4 space-y-4">
          <div className="border"><div className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_100px] border-b bg-muted/30 px-3 py-2 text-xs font-medium"><span>Arc column</span><span>Source header</span><span>Confidence</span></div>{props.columns.map((column) => {
            const item = suggestion?.mappings.find((candidate) => candidate.target === column.key)
            return <div key={column.key} className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_100px] items-center gap-3 border-b px-3 py-2 last:border-b-0"><span className="text-sm">{column.label}{column.required ? <span className="ml-1 text-destructive">*</span> : null}</span><Select disabled={!canManage} value={mapping[column.key] ?? "__none"} onValueChange={(value) => setMapping((current) => ({ ...current, [column.key]: value === "__none" ? null : value }))}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none">Not mapped</SelectItem>{headers.map((header) => <SelectItem key={header} value={header}>{header}</SelectItem>)}</SelectContent></Select><Badge variant="outline">{item?.confidence ?? "manual"}</Badge></div>
          })}</div>
          {missingRequired.length ? <p className="flex items-center gap-2 text-sm text-warning"><AlertTriangle className="size-4" /> Map all required columns before staging.</p> : <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4" /> Required columns are mapped. Review and stage the dry run.</p>}
          <Button onClick={stage} disabled={!canManage || pending || missingRequired.length > 0}>{pending ? <Loader2 className="animate-spin" /> : <Upload />} Stage & validate</Button>
        </TabsContent>
        <TabsContent value="review" className="mt-4 space-y-4">
          {props.detail ? <>
            <div className="flex flex-wrap items-center gap-2"><button type="button" aria-pressed={statusFilter === "all"} onClick={() => setStatusFilter("all")}><Badge variant="outline">{props.detail.batch.row_count} rows</Badge></button><button type="button" aria-pressed={statusFilter === "valid"} onClick={() => setStatusFilter("valid")}><Badge variant="default">{props.detail.batch.valid_count} valid</Badge></button><button type="button" aria-pressed={statusFilter === "warning"} onClick={() => setStatusFilter("warning")}><Badge variant="secondary">{props.detail.batch.warning_count} warnings</Badge></button><button type="button" aria-pressed={statusFilter === "error"} onClick={() => setStatusFilter("error")}><Badge variant={props.detail.batch.error_count ? "destructive" : "outline"}>{props.detail.batch.error_count} errors</Badge></button><span className="ml-auto flex items-center gap-2 text-xs"><Switch disabled={!canManage || pending || props.detail.batch.status !== "staged"} checked={props.detail.batch.update_existing} onCheckedChange={(checked) => run(() => props.updateExistingAction({ orgId: props.orgId, importer: props.importer, batchId: props.detail!.batch.id, updateExisting: checked }), "Update mode changed")} /> Update documented fields on matches</span></div>
            <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Row status</span><Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="h-8 w-40" aria-label="Filter import rows by status"><SelectValue /></SelectTrigger><SelectContent>{["all", "pending", "valid", "warning", "error", "skipped", "committed"].map(status => <SelectItem key={status} value={status}>{status === "all" ? "All rows" : status.charAt(0).toUpperCase() + status.slice(1)}</SelectItem>)}</SelectContent></Select></div>
            <ImportReviewTable rows={filteredRows} columns={visibleColumns} onEdit={canManage && props.detail.batch.status === "staged" ? setEditing : undefined} />
            <QueuePagination page={props.detail.page ?? 1} pageSize={props.detail.limit ?? 500} total={props.detail.total} href={navigationHref()} pageParam="rowPage" label="Import row pages" />
            <div className="flex items-center justify-between border-t pt-4"><Button variant="outline" disabled={!canManage || pending || props.detail.batch.status !== "staged"} onClick={() => run(() => props.discardAction({ orgId: props.orgId, importer: props.importer, batchId: props.detail!.batch.id }), "Batch discarded")}>Discard</Button><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{props.detail.batch.error_count ? "Fix or skip every error before commit." : "Matches skip unless update mode is on. Review all rows before committing."}</span><Button disabled={!canManage || pending || props.detail.batch.status !== "staged" || props.detail.batch.error_count > 0} onClick={() => run(() => props.commitAction({ orgId: props.orgId, importer: props.importer, batchId: props.detail!.batch.id }), "Import committed")}>{pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Commit</Button></div></div>
          </> : <div className="border p-8 text-center text-sm text-muted-foreground">Stage a file to open the review grid.</div>}
        </TabsContent>
      </Tabs>

      {props.batches.length ? <div className="space-y-2"><h2 className="text-sm font-medium">Recent batches</h2><div className="divide-y border">{props.batches.map((batch) => <Link key={batch.id} href={navigationHref({ batch: batch.id, rowPage: 1, rowStatus: "all" })} className="grid grid-cols-[1fr_100px_90px_90px] items-center px-3 py-2 text-sm hover:bg-muted/30"><span className="truncate">{batch.source_filename ?? "Untitled CSV"}<span className="ml-2 text-xs text-muted-foreground">{new Date(batch.created_at).toLocaleString()}</span></span><Badge variant={statusVariant(batch.status)}>{batch.status}</Badge><span className="text-right tabular-nums">{batch.row_count} rows</span><span className="text-right tabular-nums text-muted-foreground">{batch.error_count} errors</span></Link>)}</div></div> : null}

      {props.batchPagination ? <QueuePagination page={props.batchPagination.page} pageSize={props.batchPagination.limit} total={props.batchPagination.total} href={navigationHref()} pageParam="batchPage" label="Import batch pages" /> : null}

      <Dialog open={canManage && Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Edit staged row {editing?.row_number}</DialogTitle><DialogDescription>Corrections affect only this staged batch. Validate again before commit.</DialogDescription></DialogHeader>{editing ? <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const patch = Object.fromEntries(props.columns.map((column) => [column.key, data.get(column.key) === "" ? null : String(data.get(column.key) ?? "")])); run(() => props.patchAction({ orgId: props.orgId, importer: props.importer, batchId: props.detail!.batch.id, rowId: editing.id, patch }), "Row updated"); setEditing(null) }} className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-auto pr-1">{props.columns.map((column) => <label key={column.key} className="space-y-1 text-xs font-medium"><span>{column.label}</span><Input disabled={!canManage} name={column.key} defaultValue={String(editing.parsed[column.key] ?? "")} /></label>)}<DialogFooter className="col-span-2 mt-3"><Button disabled={!canManage || pending} type="button" variant="outline" onClick={() => { run(() => props.patchAction({ orgId: props.orgId, importer: props.importer, batchId: props.detail!.batch.id, rowId: editing.id, skip: true }), "Row skipped"); setEditing(null) }}>Skip row</Button><Button disabled={!canManage || pending} type="submit">Save & validate</Button></DialogFooter></form> : null}</DialogContent></Dialog>
    </div>
  )
}

function ImportReviewTable({ rows, columns, onEdit }: {
  rows: Row[]
  columns: readonly ImportColumnSpec[]
  onEdit?: (row: Row) => void
}) {
  "use no memo"
  // TanStack Virtual owns mutable layout state; keep its reads in this leaf.
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 42, overscan: 10 })
  const emptyColumns = 6 - columns.length

  return (
    <div className="border">
      <div className="grid grid-cols-[58px_92px_repeat(6,minmax(120px,1fr))_80px] gap-2 border-b bg-muted/30 px-2 py-2 text-xs font-medium">
        <span>Row</span><span>Status</span>
        {columns.map(column => <span key={column.key} className="truncate">{column.label}</span>)}
        {Array.from({ length: emptyColumns }, (_, index) => <span key={index} />)}
        <span>Action</span>
      </div>
      <div ref={scrollRef} className="h-[480px] overflow-auto" aria-label="Staged import rows">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map(item => {
            const row = rows[item.index]
            const issues = row.issues.map(issue => issue.message).join(" · ")
            return (
              <div key={row.id} className="absolute left-0 top-0 grid w-full grid-cols-[58px_92px_repeat(6,minmax(120px,1fr))_80px] items-center gap-2 border-b px-2 text-xs" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
                <span className="tabular-nums text-muted-foreground">{row.row_number}</span>
                <Badge variant={statusVariant(row.status)} title={issues}>{row.status}</Badge>
                {columns.map(column => <span key={column.key} className="truncate" title={String(row.parsed[column.key] ?? "")}>{String(row.parsed[column.key] ?? "—")}</span>)}
                {Array.from({ length: emptyColumns }, (_, index) => <span key={index} />)}
                {onEdit ? <Button size="sm" variant="ghost" onClick={() => onEdit(row)}>Edit</Button> : <span className="text-muted-foreground">Read only</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

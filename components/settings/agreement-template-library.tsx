"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState, useTransition } from "react"

import {
  createAgreementTemplateAction,
  createAgreementTemplateVersionAction,
  deleteAgreementTemplateDraftAction,
  getAgreementTemplateAction,
  publishAgreementTemplateVersionAction,
  retireAgreementTemplateAction,
  withdrawAgreementTemplateVersionAction,
} from "@/app/(app)/settings/templates/agreement-actions"
import { AlertTriangle, FileText, Plus } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import type { AgreementTemplateDto, AgreementTemplateKind, AgreementTemplateVersionDto, AgreementTemplateVersionStatus } from "@/lib/services/agreement-templates"
import { cn } from "@/lib/utils"

type Community = { id: string; name: string; state: string | null }
type Detail = { template: AgreementTemplateDto; versions: AgreementTemplateVersionDto[]; truncated: boolean }

const STATUS_LABEL: Record<AgreementTemplateVersionStatus, string> = { draft: "Draft", published: "Live", superseded: "Superseded", withdrawn: "Withdrawn" }
const STATUS_TONE: Record<AgreementTemplateVersionStatus, string> = {
  draft: "border-border text-muted-foreground",
  published: "border-success/40 bg-success/10 text-success",
  superseded: "border-border text-muted-foreground",
  withdrawn: "border-destructive/40 bg-destructive/10 text-destructive",
}

function StatusChip({ status }: { status: AgreementTemplateVersionStatus }) {
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
}

function appliesTo(version: AgreementTemplateVersionDto | null, communities: Community[]) {
  if (!version) return "—"
  const names = version.communityIds.map((id) => communities.find((community) => community.id === id)?.name ?? "Community")
  const parts = [version.states.length ? version.states.join(", ") : null, names.length > 2 ? `${names.length} communities` : names.join(", ") || null].filter(Boolean)
  return parts.length ? parts.join(" · ") : "Every home"
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"
}

/**
 * The organization's purchase agreement and addenda. Arc supplies no legal
 * text: each document is counsel's PDF, versioned, and immutable once live.
 * Where a version applies (states, communities) decides which homes are sold
 * on it; a required addendum is always in the packet for those homes.
 */
export function AgreementTemplateLibrary({
  templates,
  truncated,
  loadError,
  communities,
  canManage,
}: {
  templates: AgreementTemplateDto[]
  truncated: boolean
  loadError: string | null
  communities: Community[]
  canManage: boolean
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState<AgreementTemplateKind | null>(null)
  const [name, setName] = useState("")
  const [pending, startTransition] = useTransition()

  const create = () => {
    if (!creating || !name.trim()) return
    startTransition(async () => {
      try {
        const template = unwrapAction(await createAgreementTemplateAction({ kind: creating, name: name.trim() }))
        setCreating(null)
        setName("")
        setOpenId(template.id)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not create the template", description: (error as Error).message })
      }
    })
  }

  if (loadError) {
    return (
      <p className="flex items-start gap-2 border-l-2 border-l-destructive bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>Agreement templates could not be loaded. {loadError}</span>
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {creating ? (
            <>
              <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") create() }}
                placeholder={creating === "agreement" ? "Florida purchase agreement" : "HOA disclosure addendum"} className="h-8 w-72 text-sm" aria-label="Template name" />
              <Button size="sm" onClick={create} disabled={pending || !name.trim()}>{pending ? "Creating…" : "Create"}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setCreating(null); setName("") }} disabled={pending}>Cancel</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setCreating("agreement")}><Plus className="size-3.5" />Agreement</Button>
              <Button size="sm" variant="outline" onClick={() => setCreating("addendum")}><Plus className="size-3.5" />Addendum</Button>
            </>
          )}
        </div>
      ) : null}

      {templates.length === 0 ? (
        <div className="border border-dashed px-6 py-10 text-center">
          <FileText className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No agreement documents yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Homes cannot be put under contract until your purchase agreement is published here. Upload the PDF your counsel approved; Arc adds only Schedule A and the signature page.
          </p>
        </div>
      ) : (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-28">Type</TableHead>
                <TableHead>Applies to</TableHead>
                <TableHead className="w-24">Required</TableHead>
                <TableHead className="w-28">Live version</TableHead>
                <TableHead className="w-32 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.id} className="cursor-pointer" onClick={() => setOpenId(template.id)}>
                  <TableCell className="font-medium">
                    <button type="button" className="text-left hover:underline focus-visible:underline focus-visible:outline-none" onClick={(event) => { event.stopPropagation(); setOpenId(template.id) }}>
                      {template.name}
                    </button>
                    {template.hasDraft ? <span className="ml-2 text-[11px] text-muted-foreground">Draft pending</span> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{template.kind === "agreement" ? "Agreement" : "Addendum"}</TableCell>
                  <TableCell className="text-muted-foreground">{appliesTo(template.live, communities)}</TableCell>
                  <TableCell>{template.live ? (template.live.required ? "Yes" : "Optional") : "—"}</TableCell>
                  <TableCell className="tabular-nums">
                    {template.live ? `v${template.live.versionNumber}` : <span className="text-warning">None live</span>}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{formatDate(template.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {truncated ? <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">Showing the first {templates.length} templates.</p> : null}
        </div>
      )}

      <TemplateSheet templateId={openId} communities={communities} canManage={canManage} onClose={() => setOpenId(null)} />
    </div>
  )
}

function TemplateSheet({ templateId, communities, canManage, onClose }: { templateId: string | null; communities: Community[]; canManage: boolean; onClose: () => void }) {
  const router = useRouter()
  const { toast } = useToast()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const load = useCallback((id: string) => {
    setError(null)
    getAgreementTemplateAction(id).then(
      (result) => (result.success ? setDetail(result.data) : setError(result.error)),
      (failure: Error) => setError(failure.message),
    )
  }, [])

  useEffect(() => {
    setDetail(null)
    if (templateId) load(templateId)
  }, [templateId, load])

  const act = (label: string, work: () => Promise<unknown>) => {
    startTransition(async () => {
      try {
        await work()
        if (templateId) load(templateId)
        router.refresh()
      } catch (failure) {
        toast({ title: `Could not ${label}`, description: (failure as Error).message })
      }
    })
  }

  const template = detail?.template
  return (
    <Sheet open={Boolean(templateId)} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 rounded-none p-0 sm:max-w-xl">
        <SheetHeader className="space-y-1 border-b px-5 py-4 text-left">
          <SheetTitle className="text-base font-semibold">{template?.name ?? "Agreement template"}</SheetTitle>
          <SheetDescription className="text-xs">
            {template ? `${template.kind === "agreement" ? "Purchase agreement" : "Addendum"}${template.status === "retired" ? " · Retired" : ""}` : "Loading…"}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          {error ? (
            <p className="m-5 flex items-start gap-2 text-xs text-destructive" role="alert"><AlertTriangle className="mt-px size-3.5 shrink-0" />{error}</p>
          ) : !detail ? (
            <div className="space-y-2 px-5 py-4">{[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-10 w-full rounded-none" />)}</div>
          ) : (
            <div className="divide-y">
              <section className="px-5 py-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Versions</p>
                {detail.versions.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No versions yet. Upload the PDF below; it stays a draft until you publish it.</p>
                ) : (
                  <ul className="mt-2 divide-y border-y">
                    {detail.versions.map((version) => (
                      <li key={version.id} className="py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium">v{version.versionNumber} · {version.title}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {appliesTo(version, communities)}{template?.kind === "addendum" ? ` · ${version.required ? "Required" : "Optional"}` : ""} · {version.pageCount} pages
                            </p>
                          </div>
                          <StatusChip status={version.status} />
                        </div>
                        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={version.contentSha256}>SHA-256 {version.contentSha256}</p>
                        {version.withdrawnReason ? <p className="mt-1 text-[11px] text-destructive">Withdrawn: {version.withdrawnReason}</p> : null}
                        {canManage ? <VersionActions version={version} pending={pending} act={act} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
                {detail.truncated ? <p className="mt-2 text-[11px] text-muted-foreground">Showing the latest {detail.versions.length} versions.</p> : null}
              </section>
              {canManage && template?.status === "active" ? (
                <UploadVersion templateId={template.id} kind={template.kind} communities={communities} onUploaded={() => { load(template.id); router.refresh() }} />
              ) : null}
              {canManage && template?.status === "active" ? (
                <section className="px-5 py-4">
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={pending}
                    onClick={() => act("retire the template", async () => unwrapAction(await retireAgreementTemplateAction(template.id)))}>
                    Retire template
                  </Button>
                  <p className="mt-1 text-[11px] text-muted-foreground">A retired template stops applying to new agreements. Signed agreements keep their versions.</p>
                </section>
              ) : null}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function VersionActions({ version, pending, act }: { version: AgreementTemplateVersionDto; pending: boolean; act: (label: string, work: () => Promise<unknown>) => void }) {
  const [withdrawing, setWithdrawing] = useState(false)
  const [reason, setReason] = useState("")
  if (version.status === "draft") {
    return (
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => act("publish the version", async () => unwrapAction(await publishAgreementTemplateVersionAction(version.id)))}>
          Publish
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("discard the draft", async () => unwrapAction(await deleteAgreementTemplateDraftAction(version.id)))}>
          Discard
        </Button>
        <span className="self-center text-[11px] text-muted-foreground">Publishing makes it live and it can never be edited.</span>
      </div>
    )
  }
  if (version.status === "withdrawn") return null
  return withdrawing ? (
    <div className="mt-2 space-y-1.5">
      <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why counsel recalled this version" className="resize-none rounded-none text-xs" aria-label="Withdrawal reason" />
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={pending || reason.trim().length < 3}
          onClick={() => act("withdraw the version", async () => { unwrapAction(await withdrawAgreementTemplateVersionAction({ versionId: version.id, reason: reason.trim() })); setWithdrawing(false) })}>
          Withdraw
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setWithdrawing(false)}>Cancel</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Unsigned agreements holding this version cannot be sent until their documents are refreshed.</p>
    </div>
  ) : (
    <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" disabled={pending} onClick={() => setWithdrawing(true)}>Withdraw…</Button>
  )
}

function UploadVersion({ templateId, kind, communities, onUploaded }: { templateId: string; kind: AgreementTemplateKind; communities: Community[]; onUploaded: () => void }) {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState("")
  const [states, setStates] = useState("")
  const [required, setRequired] = useState(kind === "agreement")
  const [communityIds, setCommunityIds] = useState<string[]>([])
  const [changeNote, setChangeNote] = useState("")
  const [pending, startTransition] = useTransition()

  const upload = () => {
    if (!file || !title.trim()) return
    startTransition(async () => {
      const form = new FormData()
      form.append("file", file)
      form.append("fields", JSON.stringify({
        templateId, title: title.trim(), required, changeNote: changeNote.trim() || null, communityIds,
        states: states.split(/[,\s]+/).map((state) => state.trim().toUpperCase()).filter(Boolean),
      }))
      try {
        unwrapAction(await createAgreementTemplateVersionAction(form))
        setFile(null)
        setTitle("")
        setStates("")
        setCommunityIds([])
        setChangeNote("")
        toast({ title: "Draft saved", description: "Review it, then publish to make it live." })
        onUploaded()
      } catch (failure) {
        toast({ title: "Could not upload the version", description: (failure as Error).message })
      }
    })
  }

  return (
    <section className="space-y-3 px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Upload a new version</p>
      <div className="space-y-1">
        <Label htmlFor="agreement-template-file" className="text-xs">PDF</Label>
        <Input id="agreement-template-file" type="file" accept="application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="h-9 text-xs" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="agreement-template-title" className="text-xs">Title printed on the signature page</Label>
        <Input id="agreement-template-title" value={title} onChange={(event) => setTitle(event.target.value)} className="h-9 text-sm" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="agreement-template-states" className="text-xs">States (blank for every state)</Label>
        <Input id="agreement-template-states" value={states} onChange={(event) => setStates(event.target.value)} placeholder="FL, GA" className="h-9 text-sm uppercase" />
      </div>
      {communities.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs">Communities (none selected for every community)</p>
          <div className="max-h-40 space-y-0.5 overflow-y-auto border p-1">
            {communities.map((community) => {
              const picked = communityIds.includes(community.id)
              return (
                <button key={community.id} type="button" aria-pressed={picked}
                  onClick={() => setCommunityIds((previous) => picked ? previous.filter((id) => id !== community.id) : [...previous, community.id])}
                  className={cn("flex w-full items-center justify-between px-2 py-1 text-left text-xs transition-colors duration-150", picked ? "bg-muted font-medium" : "hover:bg-muted/50")}>
                  <span className="truncate">{community.name}</span>
                  <span className="text-muted-foreground">{community.state ?? ""}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      {kind === "addendum" ? (
        <div className="flex items-center gap-2">
          <Switch id="agreement-template-required" checked={required} onCheckedChange={setRequired} />
          <Label htmlFor="agreement-template-required" className="text-xs">Required for every home it applies to</Label>
        </div>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="agreement-template-note" className="text-xs">What changed</Label>
        <Textarea id="agreement-template-note" rows={2} value={changeNote} onChange={(event) => setChangeNote(event.target.value)} className="resize-none rounded-none text-xs" />
      </div>
      <Button size="sm" onClick={upload} disabled={pending || !file || !title.trim()}>{pending ? "Uploading…" : "Save as draft"}</Button>
    </section>
  )
}

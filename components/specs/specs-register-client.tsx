"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import {
  createManualSpecSectionAction,
  createSpecUploadAction,
  getSpecSectionAction,
  listSpecUploadsAction,
} from "@/app/(app)/projects/[id]/specs/actions"
import { uploadProjectFileAction } from "@/app/(app)/projects/[id]/actions"
import { unwrapAction } from "@/lib/action-result"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AlertCircle,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  RefreshCcw,
  Search,
  Upload,
} from "@/components/icons"
import type { SpecSectionView, SpecUploadView } from "@/components/specs/types"

interface SpecsRegisterClientProps {
  projectId: string
  initialSections: SpecSectionView[]
  initialUploads: SpecUploadView[]
  initialSectionId?: string
  canWrite: boolean
}

function currentRevision(section: SpecSectionView) {
  return section.revisions?.find((revision) => revision.id === section.current_revision_id) ?? section.revisions?.[0]
}

function uploadStatusLabel(status: string) {
  if (status === "complete") return "Processed"
  if (status === "failed") return "Needs attention"
  if (status === "processing") return "Splitting sections"
  return "Queued"
}

export function SpecsRegisterClient({
  projectId,
  initialSections,
  initialUploads,
  initialSectionId,
  canWrite,
}: SpecsRegisterClientProps) {
  const [sections, setSections] = useState(initialSections)
  const [uploads, setUploads] = useState(initialUploads)
  const [query, setQuery] = useState("")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [selected, setSelected] = useState<SpecSectionView | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerLoading, setViewerLoading] = useState(false)
  const [isPending, startTransition] = useTransition()
  const uploadInput = useRef<HTMLInputElement>(null)
  const manualInput = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return sections
    return sections.filter((section) =>
      `${section.section_number} ${section.title} ${section.division}`.toLowerCase().includes(normalized),
    )
  }, [query, sections])

  const grouped = useMemo(() => {
    const groups = new Map<string, SpecSectionView[]>()
    for (const section of filtered) {
      const current = groups.get(section.division) ?? []
      current.push(section)
      groups.set(section.division, current)
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  }, [filtered])

  const hasActiveUploads = uploads.some((upload) => upload.status === "pending" || upload.status === "processing")

  useEffect(() => {
    if (!hasActiveUploads) return
    const timer = window.setInterval(async () => {
      const result = await listSpecUploadsAction(projectId)
      if (result.success) {
        setUploads(result.data)
        if (result.data.some((upload) => upload.status === "complete")) window.location.reload()
      }
    }, 5000)
    return () => window.clearInterval(timer)
  }, [hasActiveUploads, projectId])

  useEffect(() => {
    if (!initialSectionId) return
    const section = initialSections.find((item) => item.id === initialSectionId)
    if (section) void openSection(section)
    // The initial deep-link is intentionally handled only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function openSection(section: SpecSectionView) {
    setSelected(section)
    setViewerOpen(true)
    setViewerLoading(true)
    try {
      const detail = unwrapAction(await getSpecSectionAction({ project_id: projectId, section_id: section.id }))
      setSelected(detail)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the spec section")
    } finally {
      setViewerLoading(false)
    }
  }

  function uploadManual(file: File | undefined) {
    if (!file) return
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Choose a PDF project manual")
      return
    }
    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("category", "plans")
        formData.append("folderPath", "/specifications")
        const uploaded = unwrapAction(await uploadProjectFileAction(projectId, formData))
        const job = unwrapAction(await createSpecUploadAction({ project_id: projectId, file_id: uploaded.id }))
        setUploads((current) => [job, ...current])
        setUploadOpen(false)
        toast.success("Project manual queued", { description: "Sections will appear as processing completes." })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not upload the project manual")
      } finally {
        if (uploadInput.current) uploadInput.current.value = ""
      }
    })
  }

  function submitManualSection(formData: FormData) {
    const file = manualInput.current?.files?.[0]
    if (!file) {
      toast.error("Attach the section PDF")
      return
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Choose a PDF section file")
      return
    }
    startTransition(async () => {
      try {
        const upload = new FormData()
        upload.append("file", file)
        upload.append("category", "plans")
        upload.append("folderPath", "/specifications/sections")
        const uploaded = unwrapAction(await uploadProjectFileAction(projectId, upload))
        const section = unwrapAction(
          await createManualSpecSectionAction({
            project_id: projectId,
            section_number: formData.get("section_number"),
            title: formData.get("title"),
            issued_date: formData.get("issued_date") || null,
            file_id: uploaded.id,
          }),
        )
        setSections((current) => [...current.filter((item) => item.id !== section.id), section])
        setManualOpen(false)
        toast.success("Spec section added", { description: `${section.section_number} · ${section.title}` })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not add the spec section")
      } finally {
        if (manualInput.current) manualInput.current.value = ""
      }
    })
  }

  return (
    <div className="flex min-h-full min-w-0 flex-col bg-muted/20">
      <header className="border-b bg-background px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="flex min-w-0 flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Project documents</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Specification register</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Every section, revision, and linked submittal in one place.
            </p>
          </div>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setManualOpen(true)}><Plus /> Add section</Button>
              <Button onClick={() => setUploadOpen(true)}><Upload /> Upload manual</Button>
            </div>
          ) : null}
        </div>
        <dl className="mt-6 grid grid-cols-3 divide-x border-t pt-5 sm:max-w-lg">
          {[
            { label: "Sections", value: sections.length },
            { label: "CSI divisions", value: new Set(sections.map((section) => section.division)).size },
            { label: "Submittals", value: sections.reduce((total, section) => total + (section.submittal_count ?? section.submittals?.length ?? 0), 0) },
          ].map(({ label, value }) => (
            <div key={label} className="min-w-0 px-3 first:pl-0 sm:px-6">
              <dd className="text-2xl font-semibold tabular-nums tracking-tight">{value.toLocaleString()}</dd>
              <dt className="mt-1 text-xs text-muted-foreground">{label}</dt>
            </div>
          ))}
        </dl>
      </header>

      <div className="min-w-0 space-y-5 p-4 sm:p-6 lg:p-8">
        {uploads.length > 0 ? (
          <section aria-label="Recent manual uploads" className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">Recent uploads</h2>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {uploads.slice(0, 4).map((upload) => (
                <div key={upload.id} className="flex min-w-0 items-start gap-3 rounded-lg border bg-background p-3 text-xs">
                  {upload.status === "pending" || upload.status === "processing" ? (
                    <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : upload.status === "failed" ? (
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  ) : (
                    <FileText className="mt-0.5 size-4 shrink-0 text-success" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={upload.file_name ?? undefined}>{upload.file_name ?? "Project manual"}</p>
                    <p className="mt-1 font-medium text-muted-foreground">{uploadStatusLabel(upload.status)}</p>
                    <p className="mt-1 break-words text-muted-foreground">
                      {upload.status === "failed" ? upload.error ?? "Processing failed" : upload.sections_detected != null ? `${upload.sections_detected} sections detected` : format(new Date(upload.created_at), "MMM d, h:mm a")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-label="Specification sections" className="min-w-0 overflow-hidden rounded-xl border bg-background">
          <div className="flex min-w-0 flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-sm">
              <Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search specification sections" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search number, title, or division…" className="bg-muted/30 pl-9" />
            </div>
            <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {filtered.length} of {sections.length} sections
            </p>
          </div>

          {sections.length === 0 ? (
            <div className="grid place-items-center px-5 py-16 text-center sm:py-24">
              <div className="max-w-sm">
                <div className="mx-auto grid size-14 place-items-center rounded-xl border bg-muted/40"><FileText className="size-6 text-muted-foreground" /></div>
                <h2 className="mt-5 text-lg font-semibold tracking-tight">Build your specification register</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">Upload a project manual to organize it into CSI sections, or add an individual section to get started.</p>
                {canWrite ? (
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setUploadOpen(true)}><Upload /> Upload manual</Button>
                    <Button variant="outline" onClick={() => setManualOpen(true)}><Plus /> Add section</Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : grouped.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <Search className="mx-auto size-6 text-muted-foreground" />
              <h2 className="mt-4 text-sm font-semibold">No matching sections</h2>
              <p className="mt-2 break-words text-sm text-muted-foreground">Try another section number, title, or CSI division.</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => setQuery("")}>Clear search</Button>
            </div>
          ) : (
            <Table className="table-fixed" containerClassName="min-w-0">
              <TableHeader className="bg-muted/20">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-24 pl-4 sm:w-32 sm:pl-5">Section</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="hidden w-24 md:table-cell">Revision</TableHead>
                  <TableHead className="hidden w-32 lg:table-cell">Issued</TableHead>
                  <TableHead className="hidden w-24 pr-5 text-right sm:table-cell">Submittals</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped.flatMap(([division, divisionSections]) => [
                  <TableRow key={`division-${division}`} className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={2} className="whitespace-normal px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Division {division}</span>
                        <span className="text-xs tabular-nums text-muted-foreground/70">/ {divisionSections.length} {divisionSections.length === 1 ? "section" : "sections"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell" />
                    <TableCell className="hidden lg:table-cell" />
                    <TableCell className="hidden sm:table-cell" />
                  </TableRow>,
                  ...divisionSections.map((section) => {
                    const revision = currentRevision(section)
                    const revisionNumber = section.revision_number ?? revision?.revision_number ?? 1
                    const issuedDate = section.issued_date ?? revision?.issued_date
                    const submittalCount = section.submittal_count ?? section.submittals?.length ?? 0
                    return (
                      <TableRow key={section.id} className="group cursor-pointer" onClick={() => void openSection(section)}>
                        <TableCell className="whitespace-normal break-words py-4 pl-4 align-top font-mono text-xs text-muted-foreground sm:pl-5">{section.section_number}</TableCell>
                        <TableCell className="whitespace-normal py-4 align-top">
                          <button type="button" className="max-w-full rounded-sm text-left text-sm font-medium leading-5 [overflow-wrap:anywhere] group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => { event.stopPropagation(); void openSection(section) }}>
                            {section.title}
                          </button>
                          <p className="mt-1.5 text-xs leading-5 text-muted-foreground lg:hidden">
                            <span className="md:hidden">Rev {revisionNumber} · </span>
                            {issuedDate ? format(new Date(`${issuedDate}T00:00:00`), "MMM d, yyyy") : "No issue date"}
                            <span className="sm:hidden"> · {submittalCount} submittals</span>
                          </p>
                        </TableCell>
                        <TableCell className="hidden py-4 align-top md:table-cell"><Badge variant="outline" className="font-normal">Rev {revisionNumber}</Badge></TableCell>
                        <TableCell className="hidden py-4 align-top text-xs text-muted-foreground lg:table-cell">{issuedDate ? format(new Date(`${issuedDate}T00:00:00`), "MMM d, yyyy") : "—"}</TableCell>
                        <TableCell className="hidden py-4 pr-5 text-right align-top tabular-nums text-muted-foreground sm:table-cell">{submittalCount}</TableCell>
                      </TableRow>
                    )
                  }),
                ])}
              </TableBody>
            </Table>
          )}
        </section>
      </div>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload project manual</DialogTitle>
            <DialogDescription>Upload a full manual or addendum PDF. Matching sections receive a new revision; existing history remains intact.</DialogDescription>
          </DialogHeader>
          <div className="border border-dashed p-8 text-center">
            <Upload className="mx-auto size-7 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">Choose a PDF</p>
            <p className="mt-1 text-xs text-muted-foreground">Processing continues in the background after upload.</p>
            <Input aria-label="Project manual PDF" ref={uploadInput} type="file" accept="application/pdf,.pdf" className="mt-4" disabled={isPending} onChange={(event) => uploadManual(event.target.files?.[0])} />
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setUploadOpen(false)} disabled={isPending}>Cancel</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
          <form action={submitManualSection}>
            <DialogHeader>
              <DialogTitle>Add spec section</DialogTitle>
              <DialogDescription>Fallback for scans or isolated sections. Reusing an existing section number adds a revision.</DialogDescription>
            </DialogHeader>
            <div className="mt-5 grid gap-4">
              <div className="grid gap-2"><Label htmlFor="spec-number">CSI section number</Label><Input id="spec-number" name="section_number" placeholder="09 91 23" required /></div>
              <div className="grid gap-2"><Label htmlFor="spec-title">Title</Label><Input id="spec-title" name="title" placeholder="Interior Painting" required /></div>
              <div className="grid gap-2"><Label htmlFor="spec-issued">Issued date</Label><Input id="spec-issued" name="issued_date" type="date" /></div>
              <div className="grid gap-2"><Label htmlFor="spec-file">Section PDF</Label><Input ref={manualInput} id="spec-file" type="file" accept="application/pdf,.pdf" required /></div>
            </div>
            <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => setManualOpen(false)} disabled={isPending}>Cancel</Button><Button type="submit" disabled={isPending}>{isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add section</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Sheet open={viewerOpen} onOpenChange={setViewerOpen}>
        <SheetContent side="right" className="flex w-full min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[92vw] xl:max-w-[1180px]">
          <SheetHeader className="shrink-0 border-b px-5 py-4 pr-12 text-left">
            <SheetTitle className="font-mono text-base">{selected?.section_number ?? "Spec section"}</SheetTitle>
            <SheetDescription className="[overflow-wrap:anywhere]">{selected?.title ?? "Loading section…"}</SheetDescription>
          </SheetHeader>
          {viewerLoading || !selected ? (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_300px]"><Skeleton className="m-4" /><div className="border-l p-4 space-y-3"><Skeleton className="h-7 w-28" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div></div>
          ) : (
            <SpecSectionViewer projectId={projectId} section={selected} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function SpecSectionViewer({ projectId, section }: { projectId: string; section: SpecSectionView }) {
  const revisions = [...(section.revisions ?? [])].sort((a, b) => b.revision_number - a.revision_number)
  const initial = currentRevision(section) ?? revisions[0]
  const [activeRevisionId, setActiveRevisionId] = useState(initial?.id)
  const active = revisions.find((revision) => revision.id === activeRevisionId) ?? initial

  return (
    <div className="grid min-h-0 min-w-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_300px] lg:overflow-hidden">
      <div className="min-h-0 min-w-0 bg-muted/30 p-3">
        {active ? (
          <iframe title={`${section.section_number} ${section.title}`} src={active.file_url ?? `/api/files/${active.file_id}/raw`} className="h-[55svh] w-full border bg-background lg:h-full" />
        ) : (
          <div className="grid h-full min-h-[55vh] place-items-center border border-dashed text-sm text-muted-foreground">No PDF is attached to this section.</div>
        )}
      </div>
      <aside className="min-h-0 min-w-0 border-t lg:overflow-y-auto lg:border-l lg:border-t-0">
        <div className="border-b p-4">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Revision history</h3>{active ? <Button variant="ghost" size="icon-sm" asChild><a href={active.file_url ?? `/api/files/${active.file_id}/raw`} target="_blank" rel="noreferrer" aria-label="Open PDF in a new tab"><ExternalLink /></a></Button> : null}</div>
          <div className="mt-3 space-y-2">
            {revisions.length ? revisions.map((revision) => (
              <button key={revision.id} type="button" onClick={() => setActiveRevisionId(revision.id)} className={`w-full border px-3 py-2 text-left text-xs transition-colors ${revision.id === active?.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                <span className="flex items-center justify-between font-medium"><span>Revision {revision.revision_number}</span>{revision.id === section.current_revision_id ? <Badge variant="secondary">Current</Badge> : null}</span>
                <span className="mt-1 block text-muted-foreground">{revision.issued_date ? format(new Date(`${revision.issued_date}T00:00:00`), "MMM d, yyyy") : format(new Date(revision.created_at), "MMM d, yyyy")}{revision.page_start ? ` · pp. ${revision.page_start}${revision.page_end && revision.page_end !== revision.page_start ? `–${revision.page_end}` : ""}` : ""}</span>
              </button>
            )) : <p className="text-xs text-muted-foreground">No revision history available.</p>}
          </div>
        </div>
        <div className="p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked submittals</h3>
          <div className="mt-3 space-y-2">
            {section.submittals?.length ? section.submittals.map((submittal) => (
              <Link key={submittal.id} href={`/projects/${projectId}/submittals?submittal=${submittal.id}`} className="block border px-3 py-2 text-xs hover:bg-muted/50">
                <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">#{submittal.submittal_number}{submittal.revision ? ` · Rev ${submittal.revision}` : ""}</span><Badge variant="outline">{submittal.status.replace(/_/g, " ")}</Badge></span>
                <span className="mt-1 block [overflow-wrap:anywhere] text-muted-foreground">{submittal.title}</span>
              </Link>
            )) : <p className="text-xs text-muted-foreground">No submittals reference this section yet.</p>}
          </div>
        </div>
      </aside>
    </div>
  )
}

export function SpecsRegisterError({ retry }: { retry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>Specification register unavailable</AlertTitle>
      <AlertDescription><p>The sections could not be loaded. Existing project files are unaffected.</p><Button variant="outline" size="sm" className="mt-2" onClick={retry}><RefreshCcw /> Try again</Button></AlertDescription>
    </Alert>
  )
}

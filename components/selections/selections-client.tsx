"use client"

import { useMemo, useState, useTransition, useEffect } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Project, Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import type { SelectionInput } from "@/lib/validation/selections"
import { createSelectionAction } from "@/app/(app)/selections/actions"
import { overrideGroupCutoffAction, revertGroupCutoffAction } from "@/app/(app)/design-studio/actions"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { SelectionForm } from "@/components/selections/selection-form"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/documents/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Plus, Calendar, List, Lock } from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"

const statusLabels: Record<string, string> = {
  pending: "Pending",
  selected: "Selected",
  confirmed: "Confirmed",
  ordered: "Ordered",
  received: "Received",
}

const statusStyles: Record<string, string> = {
  pending: "bg-muted text-muted-foreground border-muted",
  selected: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  confirmed: "bg-warning/20 text-warning border-warning/40",
  ordered: "bg-secondary/30 text-secondary-foreground border-secondary/50",
  received: "bg-success/20 text-success border-success/30",
}

function formatDate(date?: string | null) {
  if (!date) return ""
  return format(new Date(date), "MMM d, yyyy")
}

type BuilderSelection = Selection & {
  effective_due_date?: string | null
  locked?: boolean
  group?: {
    id: string
    name: string
    cutoff_date: string | null
    cutoff_source: "schedule" | "manual_override"
    override_reason: string | null
    status: "open" | "locked"
  } | null
}

interface SelectionsBuilderData {
  selections: BuilderSelection[]
  categories: SelectionCategory[]
  optionsByCategory: Record<string, SelectionOption[]>
}

interface Props {
  data: SelectionsBuilderData
  projects: Project[]
}

export function SelectionsBuilderClient({ data, projects }: Props) {
  const router = useRouter()
  const [items, setItems] = useState<BuilderSelection[]>(data.selections)
  const [filterProjectId, setFilterProjectId] = useState<string>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [signatureWizardOpen, setSignatureWizardOpen] = useState(false)
  const [signatureTarget, setSignatureTarget] = useState<EnvelopeWizardSourceEntity | null>(null)
  const [cutoffTarget, setCutoffTarget] = useState<{ projectId: string; groupId: string; name: string; date: string | null } | null>(null)
  const [isPending, startTransition] = useTransition()

  const filtered = useMemo(() => {
    if (filterProjectId === "all") return items
    return items.filter((item) => item.project_id === filterProjectId)
  }, [filterProjectId, items])

  const stats = useMemo(() => {
    return {
      total: items.length,
      pending: items.filter((s) => s.status === "pending").length,
      received: items.filter((s) => s.status === "received").length,
    }
  }, [items])

  const categoriesById = useMemo(
    () => Object.fromEntries(data.categories.map((c) => [c.id, c] as const)),
    [data.categories],
  )
  const optionsById = useMemo(() => {
    const map: Record<string, SelectionOption> = {}
    Object.values(data.optionsByCategory).forEach((opts) => {
      opts.forEach((opt) => {
        map[opt.id] = opt
      })
    })
    return map
  }, [data.optionsByCategory])
  const groupedItems = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; items: BuilderSelection[]; deadline: string | null; source: string; reason: string | null; locked: boolean }>()
    for (const selection of filtered) {
      if (!selection.group_id) continue
      const current = groups.get(selection.group_id) ?? {
        id: selection.group_id,
        name: selection.group?.name ?? "Selection group",
        items: [],
        deadline: selection.group?.cutoff_date ?? null,
        source: selection.group?.cutoff_source ?? "schedule",
        reason: selection.group?.override_reason ?? null,
        locked: Boolean(selection.locked || selection.group?.status === "locked"),
      }
      current.items.push(selection)
      groups.set(selection.group_id, current)
    }
    return Array.from(groups.values())
  }, [filtered])

  async function handleCreate(values: SelectionInput) {
    startTransition(async () => {
      try {
        const created = unwrapAction(await createSelectionAction(values))
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success("Selection created")
      } catch (error: any) {
        console.error(error)
        toast.error("Could not create selection", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleOpenSignatureWizard = (input: {
    selection: Selection
    categoryName?: string
    optionName?: string
  }) => {
    if (!input.selection.project_id) {
      toast.error("Selection must belong to a project before requesting signature.")
      return
    }
    if (!input.selection.selected_option_id) {
      toast.error("Select an option before requesting signature.")
      return
    }

    const documentTitle = [input.categoryName, input.optionName].filter(Boolean).join(" - ") || "Selection Approval"

    setSignatureTarget({
      type: "selection",
      id: input.selection.id,
      project_id: input.selection.project_id,
      title: documentTitle,
      document_type: "other",
    })
    setSignatureWizardOpen(true)
  }

  const handleSignatureWizardOpenChange = (open: boolean) => {
    setSignatureWizardOpen(open)
    if (!open) {
      setSignatureTarget(null)
    }
  }

  function handleCutoffOverride(formData: FormData) {
    if (!cutoffTarget) return
    startTransition(async () => {
      try {
        unwrapAction(await overrideGroupCutoffAction({ projectId: cutoffTarget.projectId, groupId: cutoffTarget.groupId, cutoffDate: String(formData.get("cutoffDate") ?? ""), reason: String(formData.get("reason") ?? "") }))
        setCutoffTarget(null)
        toast.success("Selection cutoff overridden")
        router.refresh()
      } catch (error) {
        toast.error("Could not override cutoff", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function handleCutoffRevert(projectId: string, groupId: string) {
    startTransition(async () => {
      try {
        unwrapAction(await revertGroupCutoffAction({ projectId, groupId }))
        toast.success("Cutoff restored from schedule")
        router.refresh()
      } catch (error) {
        toast.error("Could not restore cutoff", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  if (groupedItems.length > 0) {
    return (
      <>
      <div className="min-h-0 space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h1 className="text-xl font-semibold">Lot selections</h1><p className="text-sm text-muted-foreground">Schedule-derived deadlines and confirmed buyer choices.</p></div>
          <div className="flex gap-2"><Select value={filterProjectId} onValueChange={setFilterProjectId}><SelectTrigger className="h-8 w-[220px] rounded-none"><SelectValue placeholder="Filter by project" /></SelectTrigger><SelectContent><SelectItem value="all">All projects</SelectItem>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select><Button size="sm" className="h-8 rounded-none" onClick={() => setSheetOpen(true)}><Plus className="mr-1 h-4 w-4" />Selection</Button></div>
        </div>
        <SelectionForm open={sheetOpen} onOpenChange={setSheetOpen} projects={projects} categories={data.categories} defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id} onSubmit={handleCreate} isSubmitting={isPending} />
        {groupedItems.map((group) => {
          const remaining = group.deadline ? Math.ceil((Date.parse(`${group.deadline}T00:00:00`) - Date.now()) / 86_400_000) : null
          const projectId = group.items[0]?.project_id
          return <section key={group.id} className="border"><div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">{group.name}</h2><Badge variant={group.locked ? "destructive" : "secondary"} className="rounded-none">{group.locked ? "Locked" : "Open"}</Badge><Badge variant="outline" title={group.reason ?? undefined} className="rounded-none">{group.source === "manual_override" ? "Manual override" : "From schedule"}</Badge></div><div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{group.deadline ? `Cutoff ${formatDate(group.deadline)}` : "Unresolved cutoff"}</span>{remaining != null && <span className="tabular-nums">{remaining >= 0 ? `${remaining} days remaining` : `${Math.abs(remaining)} days overdue`}</span>}{projectId && group.source === "manual_override" && <Button size="sm" variant="ghost" className="h-7 rounded-none" disabled={isPending} onClick={() => handleCutoffRevert(projectId, group.id)}>Revert</Button>}{projectId && <Button size="sm" variant="outline" className="h-7 rounded-none" onClick={() => setCutoffTarget({ projectId, groupId: group.id, name: group.name, date: group.deadline })}>Override</Button>}</div></div><Table><TableHeader><TableRow><TableHead>Category</TableHead><TableHead>Chosen option</TableHead><TableHead>Scope</TableHead><TableHead className="text-right">Price</TableHead><TableHead>Status</TableHead><TableHead>Confirmed</TableHead><TableHead className="w-[130px]" /></TableRow></TableHeader><TableBody>{group.items.map((selection) => { const category = categoriesById[selection.category_id]; const option = selection.selected_option_id ? optionsById[selection.selected_option_id] : undefined; return <TableRow key={selection.id}><TableCell className="font-medium">{category?.name ?? "Selection"}</TableCell><TableCell><div className="flex items-center gap-2">{option?.image_url ? <img src={option.image_url} alt="" className="h-8 w-8 border object-cover" /> : <div className="h-8 w-8 border bg-muted" />}<span>{option?.name ?? "Not selected"}</span></div></TableCell><TableCell><Badge variant="outline" className="rounded-none text-[10px]">{option?.option_scope === "structural" ? "Structural" : "Design"}</Badge></TableCell><TableCell className="text-right tabular-nums">{selection.price_cents_snapshot == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(selection.price_cents_snapshot / 100)}</TableCell><TableCell><Badge variant="secondary" className="rounded-none">{selection.status}</Badge></TableCell><TableCell>{selection.confirmed_at ? formatDate(selection.confirmed_at) : "—"}</TableCell><TableCell className="text-right">{group.locked ? <Button asChild size="sm" variant="outline" className="h-7 rounded-none"><a href={`/projects/${selection.project_id}/change-orders?selection=${selection.id}`}><Lock className="mr-1 h-3.5 w-3.5" />Change via CO</a></Button> : option ? <Button size="sm" variant="outline" className="h-7 rounded-none" onClick={() => handleOpenSignatureWizard({ selection, categoryName: category?.name, optionName: option.name })}>Request signature</Button> : null}</TableCell></TableRow> })}</TableBody></Table></section>
        })}
      </div>
      <EnvelopeWizard open={signatureWizardOpen} onOpenChange={handleSignatureWizardOpenChange} sourceEntity={signatureTarget} sourceLabel="Selection" sheetTitle="Prepare selection approval for signature" sheetDescription="Attach the finalized selection PDF, place signer fields, and send for approval." />
      <Dialog open={Boolean(cutoffTarget)} onOpenChange={(open) => { if (!open) setCutoffTarget(null) }}><DialogContent className="rounded-none"><form action={handleCutoffOverride}><DialogHeader><DialogTitle>Override {cutoffTarget?.name} cutoff</DialogTitle><DialogDescription>This replaces the schedule-derived date until reverted. A reason is required and audited.</DialogDescription></DialogHeader><div className="space-y-3 py-4"><Label htmlFor="cutoff-date">Cutoff date</Label><Input id="cutoff-date" name="cutoffDate" type="date" required defaultValue={cutoffTarget?.date ?? ""} className="rounded-none" /><Label htmlFor="cutoff-reason">Reason</Label><Input id="cutoff-reason" name="reason" required minLength={5} maxLength={500} className="rounded-none" /></div><DialogFooter><Button type="submit" disabled={isPending} className="rounded-none">Save override</Button></DialogFooter></form></DialogContent></Dialog>
      </>
    )
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Selections</h1>
            <p className="text-muted-foreground text-sm">Assign categories, track choices, and status.</p>
            <div className="flex flex-wrap gap-2 mt-2">
              <Badge variant="secondary" className="text-xs">
                Total {stats.total}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                Pending {stats.pending}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                Received {stats.received}
              </Badge>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={filterProjectId} onValueChange={setFilterProjectId}>
              <SelectTrigger className="w-full sm:w-[220px]">
                <SelectValue placeholder="Filter by project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
              <Plus className="h-4 w-4 mr-2" />
              New selection
            </Button>
          </div>
        </div>

        <SelectionForm
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          projects={projects}
          categories={data.categories}
          defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
          onSubmit={handleCreate}
          isSubmitting={isPending}
        />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((sel) => {
            const category = categoriesById[sel.category_id]
            const selectedOption = sel.selected_option_id ? optionsById[sel.selected_option_id] : undefined
            const canRequestSignature = !!selectedOption
            return (
              <Card key={sel.id} className="h-full flex flex-col">
                <CardHeader className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base font-semibold">
                      {category?.name ?? "Selection"} {selectedOption ? `— ${selectedOption.name}` : ""}
                    </CardTitle>
                    <Badge variant="secondary" className={`capitalize border ${statusStyles[sel.status] ?? ""}`}>
                      {statusLabels[sel.status] ?? sel.status}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <List className="h-4 w-4" />
                      {category?.description ?? "No description"}
                    </span>
                    {sel.due_date && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-4 w-4" />
                        Due {formatDate(sel.due_date)}
                      </span>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="flex-1 space-y-3">
                  <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Selected option</span>
                      <Badge variant="outline" className="text-[11px]">
                        {selectedOption ? "Chosen" : "Not chosen"}
                      </Badge>
                    </div>
                    <p className="text-sm text-foreground">
                      {selectedOption
                        ? selectedOption.name
                        : "No option selected yet. Clients choose in the portal."}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canRequestSignature}
                    onClick={() =>
                      handleOpenSignatureWizard({
                        selection: sel,
                        categoryName: category?.name,
                        optionName: selectedOption?.name,
                      })
                    }
                  >
                    {canRequestSignature ? "Request signature" : "Select option before signature"}
                  </Button>
                  {sel.notes && <p className="text-xs text-muted-foreground">Notes: {sel.notes}</p>}
                  <SelectionAttachments selection={sel} />
                </CardContent>
              </Card>
            )
          })}

          {filtered.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">No selections yet.</p>
              <Button className="mt-3" onClick={() => setSheetOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create your first selection
              </Button>
            </div>
          )}

          {isPending && filtered.length === 0 && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[...Array(3)].map((_, idx) => (
                <Skeleton key={idx} className="h-44 w-full rounded-lg" />
              ))}
            </div>
          )}
        </div>
      </div>

      <EnvelopeWizard
        open={signatureWizardOpen}
        onOpenChange={handleSignatureWizardOpenChange}
        sourceEntity={signatureTarget}
        sourceLabel="Selection"
        sheetTitle="Prepare selection approval for signature"
        sheetDescription="Attach the finalized selection PDF, place signer fields, and send for approval."
      />
    </>
  )
}

function SelectionAttachments({ selection }: { selection: Selection }) {
  const [open, setOpen] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    listAttachmentsAction("selection", selection.id)
      .then((links) =>
        setAttachments(
          links.map((link) => ({
            id: link.file.id,
            linkId: link.id,
            file_name: link.file.file_name,
            mime_type: link.file.mime_type,
            size_bytes: link.file.size_bytes,
            download_url: link.file.download_url,
            thumbnail_url: link.file.thumbnail_url,
            created_at: link.created_at,
            link_role: link.link_role,
          }))
        )
      )
      .catch((error) => console.error("Failed to load selection attachments", error))
      .finally(() => setLoading(false))
  }, [open, selection.id])

  const handleAttach = async (files: File[], linkRole?: string) => {
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", selection.project_id)
      formData.append("category", "other")

      const uploaded = unwrapAction(await uploadFileAction(formData))
      unwrapAction(await attachFileAction(uploaded.id, "selection", selection.id, selection.project_id, linkRole))
    }

    const links = await listAttachmentsAction("selection", selection.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId))
    const links = await listAttachmentsAction("selection", selection.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  return (
    <div className="pt-2">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? "Hide attachments" : "Manage attachments"}
      </button>
      {open && (
        <div className="mt-2">
          <EntityAttachments
            entityType="selection"
            entityId={selection.id}
            projectId={selection.project_id}
            attachments={attachments}
            onAttach={handleAttach}
            onDetach={handleDetach}
            readOnly={loading}
            compact
          />
        </div>
      )}
    </div>
  )
}


"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Layers,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  DISCIPLINE_LABELS,
  DRAWING_ISSUANCE_TYPE_LABELS,
} from "@/lib/validation/drawings"
import type { DrawingDiscipline, DrawingIssuanceType } from "@/lib/validation/drawings"
import { DISCIPLINE_SORT_ORDER } from "@/lib/utils/drawing-utils"
import {
  getDraftRevisionStatusAction,
  getRevisionDiffAction,
  publishRevisionAction,
  discardRevisionAction,
} from "@/app/(app)/drawings/actions"
import type {
  RevisionDiff,
  RevisionDiffSheet,
  RevisionVersionPreview,
} from "@/lib/services/drawings"
import { toRenderableDrawingsUrl } from "./viewer/tiled-drawing-viewer"

interface RevisionReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  revisionId: string
  onPublished: () => void
  onDiscarded: () => void
}

type SheetEdit = { sheet_number?: string; sheet_title?: string; discipline?: DrawingDiscipline }

const ISSUANCE_TYPE_ORDER: DrawingIssuanceType[] = [
  "revision",
  "asi",
  "bulletin",
  "addendum",
  "ifc_set",
  "permit_set",
  "bid_set",
  "sketch",
  "record_set",
  "other",
]

export function RevisionReviewDialog({
  open,
  onOpenChange,
  revisionId,
  onPublished,
  onDiscarded,
}: RevisionReviewDialogProps) {
  const [diff, setDiff] = useState<RevisionDiff | null>(null)
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const [issuanceType, setIssuanceType] = useState<DrawingIssuanceType>("revision")
  const [issuedDate, setIssuedDate] = useState("")
  const [receivedFrom, setReceivedFrom] = useState("")
  const [notes, setNotes] = useState("")
  const [edits, setEdits] = useState<Record<string, SheetEdit>>({})
  const [decisions, setDecisions] = useState<Record<string, boolean>>({})
  const [publishing, setPublishing] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [unchangedOpen, setUnchangedOpen] = useState(false)
  const [previewRetries, setPreviewRetries] = useState(0)

  const loadDiff = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getRevisionDiffAction(revisionId)
      setDiff(data)
      setLabel((prev) => prev || data.revision.revision_label || "")
      setIssuanceType((data.revision.issuance_type as DrawingIssuanceType | null) ?? "revision")
      setIssuedDate(data.revision.issued_date?.slice(0, 10) ?? "")
      setReceivedFrom(data.revision.received_from ?? "")
      setNotes(data.revision.notes ?? "")
    } catch (err) {
      console.error("Failed to load revision diff:", err)
      toast.error("Failed to load revision for review")
    } finally {
      setLoading(false)
    }
  }, [revisionId])

  // Thumbnails/tiles are generated just after the draft becomes ready, so the
  // first diff load can have missing previews. Refresh a few times to fill them.
  useEffect(() => {
    if (!open || !diff || processing || previewRetries >= 6) return
    const pending = [...diff.updated, ...diff.added].some(
      (s) => !s.draft.thumbnail_url,
    )
    if (!pending) return
    const timer = setTimeout(() => {
      setPreviewRetries((n) => n + 1)
      void loadDiff()
    }, 4000)
    return () => clearTimeout(timer)
  }, [open, diff, processing, previewRetries, loadDiff])

  // Poll until the draft finishes processing, then load the diff.
  useEffect(() => {
    if (!open) return
    setPreviewRetries(0)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const status = await getDraftRevisionStatusAction(revisionId)
        if (cancelled) return
        if (!status) {
          setFailed("This revision no longer exists.")
          setProcessing(false)
          setLoading(false)
          return
        }
        if (
          status.processing_stage === "failed" ||
          status.processing_stage === "worker_unavailable"
        ) {
          setFailed(status.error_message || "Processing failed.")
          setProcessing(false)
          setLoading(false)
          return
        }
        if (status.status === "processing") {
          setProcessing(true)
          setDiff((prev) =>
            prev
              ? prev
              : ({
                  revision: status,
                  updated: [],
                  added: [],
                  unchanged: [],
                } as RevisionDiff),
          )
          timer = setTimeout(tick, 2000)
          return
        }
        // draft ready
        setProcessing(false)
        await loadDiff()
      } catch (err) {
        if (cancelled) return
        console.error("Failed to poll draft status:", err)
        timer = setTimeout(tick, 3000)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [open, revisionId, loadDiff])

  const setEdit = (sheetId: string, patch: SheetEdit) =>
    setEdits((prev) => ({ ...prev, [sheetId]: { ...prev[sheetId], ...patch } }))

  const accepted = (sheetId: string) => decisions[sheetId] ?? true
  const toggleAccept = (sheetId: string, value: boolean) =>
    setDecisions((prev) => ({ ...prev, [sheetId]: value }))

  const acceptedCount = useMemo(() => {
    if (!diff) return 0
    return [...diff.updated, ...diff.added].filter((s) => accepted(s.sheet_id)).length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, decisions])

  const handlePublish = async () => {
    if (!diff) return
    setPublishing(true)
    try {
      await publishRevisionAction({
        revisionId,
        label: label.trim() || undefined,
        issuanceType,
        issuedDate: issuedDate || undefined,
        receivedFrom: receivedFrom.trim() || undefined,
        notes: notes.trim() || undefined,
        decisions,
        sheetEdits: edits,
      })
      toast.success("Issuance published")
      onPublished()
      onOpenChange(false)
    } catch (err) {
      console.error("Failed to publish issuance:", err)
      toast.error(err instanceof Error ? err.message : "Failed to publish issuance")
    } finally {
      setPublishing(false)
    }
  }

  const handleDiscard = async () => {
    setPublishing(true)
    try {
      await discardRevisionAction(revisionId)
      toast.success("Draft discarded")
      onDiscarded()
      onOpenChange(false)
    } catch (err) {
      console.error("Failed to discard revision:", err)
      toast.error(err instanceof Error ? err.message : "Failed to discard revision")
    } finally {
      setPublishing(false)
      setConfirmDiscard(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90vh] w-[min(1100px,96vw)] max-w-none flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Review issuance</DialogTitle>
            <DialogDescription>
              Nothing changes in the live drawings until you publish. Review what
              this package changes, then publish or discard it.
            </DialogDescription>
          </DialogHeader>

          {failed ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm font-medium text-destructive">Processing failed</p>
              <p className="text-xs text-muted-foreground">{failed}</p>
            </div>
          ) : processing || (loading && !diff) ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center">
              <RefreshCw className="h-6 w-6 animate-spin text-chart-1" />
              <p className="text-sm font-medium">Processing your package…</p>
              <p className="text-xs text-muted-foreground">
                We&apos;re rendering pages and detecting sheets. This stays a draft
                until you publish.
              </p>
              <Progress
                value={
                  diff?.revision.total_pages
                    ? ((diff.revision.processed_pages ?? 0) /
                        diff.revision.total_pages) *
                      100
                    : 8
                }
                className="mt-2 h-1.5 w-64"
              />
            </div>
          ) : diff ? (
            <div className="flex-1 space-y-5 overflow-y-auto pr-1">
              {/* Issuance metadata */}
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="revision-label">Package label</Label>
                  <Input
                    id="revision-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Permit Set, ASI 03, Bulletin 02"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="issuance-type">Package type</Label>
                  <Select
                    value={issuanceType}
                    onValueChange={(value) => setIssuanceType(value as DrawingIssuanceType)}
                  >
                    <SelectTrigger id="issuance-type" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ISSUANCE_TYPE_ORDER.map((type) => (
                        <SelectItem key={type} value={type}>
                          {DRAWING_ISSUANCE_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="issued-date">Issued date</Label>
                  <Input
                    id="issued-date"
                    type="date"
                    value={issuedDate}
                    onChange={(e) => setIssuedDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="received-from">Received from</Label>
                  <Input
                    id="received-from"
                    value={receivedFrom}
                    onChange={(e) => setReceivedFrom(e.target.value)}
                    placeholder="Architect, owner, consultant"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="issuance-notes">Notes</Label>
                  <Input
                    id="issuance-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional package notes"
                  />
                </div>
              </div>

              {/* Summary */}
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary" className="gap-1">
                  <Layers className="h-3 w-3" /> {diff.updated.length} updated
                </Badge>
                <Badge variant="secondary" className="gap-1">
                  <FilePlus2 className="h-3 w-3" /> {diff.added.length} new
                </Badge>
                <Badge variant="outline">{diff.unchanged.length} not in this upload</Badge>
              </div>

              {diff.updated.length > 0 && (
                <Section title="Updated sheets" hint="A new version replaces the current one when published.">
                  {diff.updated.map((sheet) => (
                    <UpdatedRow
                      key={sheet.sheet_id}
                      sheet={sheet}
                      edit={edits[sheet.sheet_id]}
                      accepted={accepted(sheet.sheet_id)}
                      onAccept={(v) => toggleAccept(sheet.sheet_id, v)}
                      onEdit={(patch) => setEdit(sheet.sheet_id, patch)}
                    />
                  ))}
                </Section>
              )}

              {diff.added.length > 0 && (
                <Section title="New sheets" hint="Sheets not in the current register. Added when published.">
                  {diff.added.map((sheet) => (
                    <AddedRow
                      key={sheet.sheet_id}
                      sheet={sheet}
                      edit={edits[sheet.sheet_id]}
                      accepted={accepted(sheet.sheet_id)}
                      onAccept={(v) => toggleAccept(sheet.sheet_id, v)}
                      onEdit={(patch) => setEdit(sheet.sheet_id, patch)}
                    />
                  ))}
                </Section>
              )}

              {diff.unchanged.length > 0 && (
                <Collapsible open={unchangedOpen} onOpenChange={setUnchangedOpen}>
                  <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md border p-3 text-left text-sm hover:bg-muted/50">
                    {unchangedOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    <span className="font-medium">Not in this upload</span>
                    <span className="text-muted-foreground">
                      ({diff.unchanged.length} kept as-is)
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1 px-3 pb-2 pt-2">
                    {diff.unchanged.map((s) => (
                      <div
                        key={s.sheet_id}
                        className="flex items-center gap-3 py-1 text-sm"
                      >
                        <span className="font-mono w-20 shrink-0">{s.sheet_number}</span>
                        <span className="truncate text-muted-foreground">
                          {s.sheet_title}
                        </span>
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          ) : null}

          {diff && !processing && !failed && (
            <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDiscard(true)}
                disabled={publishing}
              >
                Discard draft
              </Button>
              <Button onClick={handlePublish} disabled={publishing || acceptedCount === 0}>
                {publishing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Publishing…
                  </>
                ) : (
                  `Publish ${acceptedCount} sheet${acceptedCount === 1 ? "" : "s"}`
                )}
              </Button>
            </DialogFooter>
          )}

          {failed && (
            <DialogFooter>
              <Button
                variant="outline"
                className="text-destructive"
                onClick={() => setConfirmDiscard(true)}
              >
                Discard draft
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              The uploaded pages will be deleted and the live drawings stay
              exactly as they are. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishing}>Keep draft</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDiscard}
              disabled={publishing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Thumb({ preview, label }: { preview?: RevisionVersionPreview | null; label: string }) {
  const src = toRenderableDrawingsUrl(preview?.thumbnail_url)
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex h-24 w-20 items-center justify-center overflow-hidden rounded border bg-muted">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={label}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-[10px] text-muted-foreground">no preview</span>
        )}
      </div>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  )
}

function MetaEditor({
  sheet,
  edit,
  onEdit,
}: {
  sheet: RevisionDiffSheet
  edit?: SheetEdit
  onEdit: (patch: SheetEdit) => void
}) {
  return (
    <div className="grid min-w-[240px] flex-1 gap-2">
      <div className="flex flex-wrap gap-2">
        <Input
          value={edit?.sheet_number ?? sheet.sheet_number}
          onChange={(e) => onEdit({ sheet_number: e.target.value })}
          className="h-8 w-28 font-mono"
          placeholder="Sheet #"
        />
        <Select
          value={(edit?.discipline ?? sheet.discipline ?? "X") as string}
          onValueChange={(v) => onEdit({ discipline: v as DrawingDiscipline })}
        >
          <SelectTrigger className="h-8 w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DISCIPLINE_SORT_ORDER.map((code) => (
              <SelectItem key={code} value={code}>
                {DISCIPLINE_LABELS[code as DrawingDiscipline]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Input
        value={edit?.sheet_title ?? sheet.sheet_title ?? ""}
        onChange={(e) => onEdit({ sheet_title: e.target.value })}
        className="h-8"
        placeholder="Sheet title"
      />
    </div>
  )
}

function UpdatedRow({
  sheet,
  edit,
  accepted,
  onAccept,
  onEdit,
}: {
  sheet: RevisionDiffSheet
  edit?: SheetEdit
  accepted: boolean
  onAccept: (v: boolean) => void
  onEdit: (patch: SheetEdit) => void
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border p-3",
        !accepted && "opacity-60",
      )}
    >
      <Checkbox
        checked={accepted}
        onCheckedChange={(v) => onAccept(Boolean(v))}
        className="mt-1 shrink-0"
      />
      <div className="flex shrink-0 items-center gap-2">
        <Thumb preview={sheet.current} label="current" />
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Thumb preview={sheet.draft} label="new" />
      </div>
      <MetaEditor sheet={sheet} edit={edit} onEdit={onEdit} />
    </div>
  )
}

function AddedRow({
  sheet,
  edit,
  accepted,
  onAccept,
  onEdit,
}: {
  sheet: RevisionDiffSheet
  edit?: SheetEdit
  accepted: boolean
  onAccept: (v: boolean) => void
  onEdit: (patch: SheetEdit) => void
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border p-3",
        !accepted && "opacity-60",
      )}
    >
      <Checkbox
        checked={accepted}
        onCheckedChange={(v) => onAccept(Boolean(v))}
        className="mt-1 shrink-0"
      />
      <Thumb preview={sheet.draft} label="new" />
      <MetaEditor sheet={sheet} edit={edit} onEdit={onEdit} />
    </div>
  )
}

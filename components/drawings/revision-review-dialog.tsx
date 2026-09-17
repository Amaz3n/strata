"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
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
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react"
import { toast } from "sonner"
import { duplicateIssuanceNumbers, issuanceNumberConflictMessage } from "@/lib/drawings/publish-validation"
import {
  DRAWING_ISSUANCE_TYPE_LABELS,
} from "@/lib/validation/drawings"
import type { DrawingDiscipline, DrawingIssuanceType } from "@/lib/validation/drawings"
import { Textarea } from "@/components/ui/textarea"
import {
  getDraftRevisionStatusAction,
  getRevisionDiffAction,
  publishRevisionAction,
  discardRevisionAction,
  retryDraftRevisionAction,
  listRevisionRecipientsAction,
  distributeRevisionAction,
  listRecentlyDeletedSheetNumbersAction,
} from "@/app/(app)/drawings/actions"
import type { DraftRevisionSheetPreview } from "@/app/(app)/drawings/types"
import type {
  RevisionDiff,
} from "@/lib/services/drawings"
import type {
  RevisionDistributionRecipient,
  RevisionDistributionRecord,
} from "@/lib/services/drawings-distribution"
import { DrawingPreviewImage } from "@/components/drawings/drawing-preview-image"
import { IssuanceSheetReview } from "@/components/drawings/issuance-sheet-review"

import { unwrapAction } from "@/lib/action-result"

interface RevisionReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  revisionId: string
  onPublished: () => void
  onDiscarded: () => void
  /** Called after a successful publish so the owner can offer distribution. */
  onDistribute?: (revisionId: string) => void
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
  onDistribute,
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
  const [retryNonce, setRetryNonce] = useState(0)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [reviewTab, setReviewTab] = useState<"sheets" | "details">("sheets")
  const [previewRetries, setPreviewRetries] = useState(0)
  // Pages already split out of the draft, shown live while processing runs.
  const initializedRevision = useRef<string | null>(null)
  // Sheet numbers deleted from this register before — annotates "new" sheets.
  const [deletedSheetNumbers, setDeletedSheetNumbers] = useState<Set<string>>(
    () => new Set(),
  )

  const loadDiff = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const data = await getRevisionDiffAction(revisionId)
      setDiff(data)
      // Image refreshes must not overwrite details the reviewer is editing.
      if (initializedRevision.current !== revisionId) {
        setLabel(data.revision.revision_label || "")
        setIssuanceType((data.revision.issuance_type as DrawingIssuanceType | null) ?? "revision")
        setIssuedDate(data.revision.issued_date?.slice(0, 10) ?? "")
        setReceivedFrom(data.revision.received_from ?? "")
        setNotes(data.revision.notes ?? "")
        initializedRevision.current = revisionId
      }

      // A sheet with no live predecessor may still have existed here before
      // someone deleted it. Best-effort: the review reads fine without this.
      if (data.added.length > 0) {
        const deleted = await listRecentlyDeletedSheetNumbersAction(
          data.revision.project_id,
        )
        setDeletedSheetNumbers(new Set(deleted.success ? deleted.data : []))
      } else {
        setDeletedSheetNumbers(new Set())
      }
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
    if (!open || !diff || processing || diff.revision.processing_stage === "rendering_pages" || previewRetries >= 6) return
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
          // Review available pages immediately; preserve local edits across updates.
          await loadDiff(true)
          timer = setTimeout(tick, 2000)
          return
        }
        // draft ready
        setProcessing(false)
        await loadDiff(true)
        if (status.status === "draft" && status.processing_stage === "rendering_pages") {
          timer = setTimeout(tick, 2000)
        }
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
  }, [open, revisionId, loadDiff, retryNonce])

  const reviewSheets = diff ? [...diff.updated, ...diff.added] : []
  const hasSheets = reviewSheets.length > 0
  const labelingCount = reviewSheets.filter(sheet => sheet.verification_pending).length
  const rendering = !!diff && (diff.revision.processed_pages ?? 0) < (diff.revision.total_pages ?? 0)

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

  const unresolvedNumberCount = diff
    ? [...diff.updated, ...diff.added].filter((sheet) =>
        decisions[sheet.sheet_id] !== false && sheet.needs_number_review &&
        !edits[sheet.sheet_id]?.sheet_number?.trim()).length
    : 0

  const conflictingNumbers = useMemo(() => diff
    ? duplicateIssuanceNumbers([...diff.updated, ...diff.added], decisions, edits)
    : [], [diff, decisions, edits])

  const handlePublish = async () => {
    if (!diff) return
    if (unresolvedNumberCount) {
      toast.error("Confirm the sheet numbers marked Needs review before publishing.")
      return
    }
    if (conflictingNumbers.length) {
      toast.error(issuanceNumberConflictMessage(conflictingNumbers))
      return
    }
    setPublishing(true)
    try {
      unwrapAction(await publishRevisionAction({
        revisionId,
        label: label.trim() || undefined,
        issuanceType,
        issuedDate: issuedDate || undefined,
        receivedFrom: receivedFrom.trim() || undefined,
        notes: notes.trim() || undefined,
        decisions,
        sheetEdits: edits,
      }))
      toast.success("Issuance published")
      onPublished()
      onOpenChange(false)
      onDistribute?.(revisionId)
    } catch (err) {
      console.error("Failed to publish issuance:", err)
      toast.error(err instanceof Error ? err.message : "Failed to publish issuance")
    } finally {
      setPublishing(false)
    }
  }

  const handleRetry = async () => {
    setPublishing(true)
    try {
      unwrapAction(await retryDraftRevisionAction(revisionId))
      toast.success("Reprocessing started")
      setFailed(null)
      setProcessing(true)
      setRetryNonce((prev) => prev + 1)
    } catch (err) {
      console.error("Failed to retry revision:", err)
      toast.error(err instanceof Error ? err.message : "Failed to retry processing")
    } finally {
      setPublishing(false)
    }
  }

  const handleDiscard = async () => {
    setPublishing(true)
    try {
      unwrapAction(await discardRevisionAction(revisionId))
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
      <Dialog open={open} onOpenChange={(nextOpen) => { if (!publishing) onOpenChange(nextOpen) }}>
        <DialogContent
          className="flex h-[94dvh] max-h-[960px] w-[96vw] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[1440px]"
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => { if (publishing) event.preventDefault() }}
          showCloseButton={!publishing}
        >
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 text-left sm:px-6 sm:py-5 sm:pr-12">
            <div className="mb-1 hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
              <Check className="h-3.5 w-3.5" /> Upload received
            </div>
            <DialogTitle className="text-xl tracking-tight">{processing && !hasSheets ? "Preparing your drawings" : "Review issuance"}</DialogTitle>
            <DialogDescription className="sr-only sm:not-sr-only">
              {processing || rendering ? "Review available previews now. Full-resolution drawings are processing in the background." : "Review the sheets, confirm the details, then publish to your register."}
            </DialogDescription>
          </DialogHeader>

          {failed ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <AlertTriangle className="h-7 w-7 text-destructive" />
              <p className="text-lg font-medium">We couldn’t finish this package</p>
              <p className="max-w-md text-sm text-muted-foreground">{failed}</p>
            </div>
          ) : (processing && !hasSheets) || (loading && !diff) ? (
            <ProcessingPanel processedPages={diff?.revision.processed_pages ?? 0}
              totalPages={diff?.revision.total_pages ?? null} sheets={[]} />
          ) : diff ? (
            <>
              {(processing || rendering) && <div role="status" className="shrink-0 border-b bg-muted/30 px-6 py-2 text-xs text-muted-foreground">
                {labelingCount > 0 ? `Reading ${labelingCount} sheet labels. ` : "Available sheet labels are ready for review. "}
                {rendering ? `Full-resolution drawings: ${diff.revision.processed_pages ?? 0} of ${diff.revision.total_pages ?? "…"} ready. Previews upgrade automatically.` : ""}
              </div>}
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
                <div className="flex gap-1 rounded-lg bg-muted/60 p-1" aria-label="Review sections">
                  <Button size="sm" variant={reviewTab === "sheets" ? "secondary" : "ghost"} aria-pressed={reviewTab === "sheets"} onClick={() => setReviewTab("sheets")}>Sheets <span className="ml-1 text-muted-foreground">{diff.updated.length + diff.added.length}</span></Button>
                  <Button size="sm" variant={reviewTab === "details" ? "secondary" : "ghost"} aria-pressed={reviewTab === "details"} onClick={() => setReviewTab("details")}>Issuance details</Button>
                </div>
                <p className="text-xs text-muted-foreground">{diff.updated.length} updated · {diff.added.length} new{diff.unchanged.length > 0 ? ` · ${diff.unchanged.length} kept as-is` : ""}</p>
              </div>
              <div className={reviewTab === "sheets" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                <IssuanceSheetReview sheets={[...diff.updated, ...diff.added]} edits={edits} decisions={decisions}
                  deletedSheetNumbers={deletedSheetNumbers} onEdit={setEdit} onAccept={toggleAccept} disabled={publishing} />
              </div>
              {reviewTab === "details" && (
                <fieldset disabled={publishing} className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-10">
              {/* Issuance metadata */}
              <div className="mx-auto grid w-full max-w-2xl gap-6 sm:grid-cols-2">
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
                    disabled={publishing}
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

                  {diff.unchanged.length > 0 && <details className="mx-auto mt-8 max-w-2xl border-t pt-5 text-sm">
                    <summary className="cursor-pointer text-muted-foreground">{diff.unchanged.length} existing sheets remain unchanged</summary>
                    <div className="mt-4 max-h-48 space-y-2 overflow-y-auto">{diff.unchanged.map((sheet) => <p key={sheet.sheet_id}><span className="mr-3 font-medium">{sheet.sheet_number}</span><span className="text-muted-foreground">{sheet.sheet_title}</span></p>)}</div>
                  </details>}
                </fieldset>
              )}
            </>
          ) : <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">Unable to load this issuance.<Button variant="outline" onClick={() => void loadDiff()}>Try again</Button></div>}

          {processing && !failed && <DialogFooter className="shrink-0 border-t px-6 py-4 sm:justify-between">
            <p className="text-xs text-muted-foreground">Your live drawings stay unchanged until you publish.</p>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Continue in background</Button>
          </DialogFooter>}

          {diff && !processing && !failed && (
            <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-t px-6 py-4 sm:justify-between">
              {unresolvedNumberCount > 0 && (
                <p role="alert" className="w-full text-sm text-muted-foreground">
                  {unresolvedNumberCount} sheet numbers need review. Use the Needs review filter to confirm them.
                </p>
              )}
              {conflictingNumbers.length > 0 && (
                <p role="alert" className="w-full text-sm text-destructive">
                  {issuanceNumberConflictMessage(conflictingNumbers)}
                </p>
              )}
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDiscard(true)}
                disabled={publishing}
              >
                Discard draft
              </Button>
              <Button onClick={handlePublish} disabled={publishing || acceptedCount === 0 || conflictingNumbers.length > 0 || unresolvedNumberCount > 0}>
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
            <DialogFooter className="shrink-0 border-t px-6 py-4">
              <Button
                variant="outline"
                className="text-destructive"
                onClick={() => setConfirmDiscard(true)}
                disabled={publishing}
              >
                Discard draft
              </Button>
              <Button onClick={handleRetry} disabled={publishing}>
                {publishing ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Retrying…
                  </>
                ) : (
                  "Retry processing"
                )}
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

// ============================================================================
// DISTRIBUTION — email portal contacts a link to the current set
// ============================================================================

interface DistributeRevisionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  revisionId: string
  /** Shown in the title so the user knows which issuance they are sending. */
  revisionLabel?: string | null
}

function formatDistributionDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function DistributeRevisionDialog({
  open,
  onOpenChange,
  revisionId,
  revisionLabel,
}: DistributeRevisionDialogProps) {
  const [recipients, setRecipients] = useState<RevisionDistributionRecipient[]>([])
  const [lastDistribution, setLastDistribution] = useState<RevisionDistributionRecord | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [note, setNote] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const loadRecipients = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = unwrapAction(await listRevisionRecipientsAction(revisionId))
      setRecipients(data.recipients)
      setLastDistribution(data.last_distribution)
      setSelected(new Set(data.recipients.map((r) => r.token_id + " " + r.email)))
    } catch (err) {
      console.error("Failed to load distribution recipients:", err)
      setLoadError(err instanceof Error ? err.message : "Failed to load recipients")
    } finally {
      setLoading(false)
    }
  }, [revisionId])

  useEffect(() => {
    if (!open) return
    setNote("")
    void loadRecipients()
  }, [open, loadRecipients])

  const keyOf = (r: RevisionDistributionRecipient) => r.token_id + " " + r.email
  const toggle = (recipient: RevisionDistributionRecipient, value: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (value) next.add(keyOf(recipient))
      else next.delete(keyOf(recipient))
      return next
    })
  }

  const selectedRecipients = recipients.filter((r) => selected.has(keyOf(r)))
  const clients = recipients.filter((r) => r.portal_type === "client")
  const subs = recipients.filter((r) => r.portal_type === "sub")

  const handleSend = async () => {
    if (selectedRecipients.length === 0) return
    setSending(true)
    try {
      const result = unwrapAction(
        await distributeRevisionAction({
          revision_id: revisionId,
          token_ids: [...new Set(selectedRecipients.map((r) => r.token_id))],
          message: note.trim() || undefined,
        }),
      )
      toast.success(
        `Sent to ${result.sent} recipient${result.sent === 1 ? "" : "s"}` +
          (result.failed > 0 ? ` (${result.failed} failed)` : ""),
      )
      onOpenChange(false)
    } catch (err) {
      console.error("Failed to distribute revision:", err)
      toast.error(err instanceof Error ? err.message : "Failed to send")
    } finally {
      setSending(false)
    }
  }

  const renderGroup = (title: string, group: RevisionDistributionRecipient[]) => {
    if (group.length === 0) return null
    return (
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <div className="divide-y border">
          {group.map((recipient) => (
            <label
              key={keyOf(recipient)}
              className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40"
            >
              <Checkbox
                checked={selected.has(keyOf(recipient))}
                onCheckedChange={(v) => toggle(recipient, Boolean(v))}
                className="shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {recipient.name ?? recipient.company_name ?? recipient.email}
                  {recipient.name && recipient.company_name && (
                    <span className="text-muted-foreground"> · {recipient.company_name}</span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">{recipient.email}</p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {recipient.last_accessed_at
                  ? `Opened portal ${formatDistributionDate(recipient.last_accessed_at)}`
                  : "Never opened"}
              </span>
            </label>
          ))}
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(560px,96vw)] max-w-none flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            Distribute {revisionLabel ? `“${revisionLabel}”` : "issuance"}
          </DialogTitle>
          <DialogDescription>
            Email portal contacts which sheets changed with a link to the current
            drawing set. Sends are recorded.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading portal contacts…
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 border border-destructive/40 bg-destructive/5 p-6 text-center">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-destructive">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => void loadRecipients()}>
              Retry
            </Button>
          </div>
        ) : recipients.length === 0 ? (
          <div className="border bg-muted/20 p-6 text-center">
            <p className="text-sm font-medium">No portal contacts with drawings access</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Share sheets or create portal links first, then distribute this
              issuance from the drawings register.
            </p>
          </div>
        ) : (
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {renderGroup("Clients", clients)}
            {renderGroup("Subcontractors", subs)}
            <div className="space-y-1.5">
              <Label htmlFor="distribute-note">Note (optional)</Label>
              <Textarea
                id="distribute-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Included in the email, e.g. what to look out for in this issuance."
                rows={2}
                maxLength={1000}
              />
            </div>
          </div>
        )}

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {lastDistribution
              ? `Sent to ${lastDistribution.recipient_count} recipient${lastDistribution.recipient_count === 1 ? "" : "s"} on ${formatDistributionDate(lastDistribution.sent_at)}`
              : recipients.length > 0
                ? "Not sent yet"
                : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
              {recipients.length === 0 ? "Close" : "Skip"}
            </Button>
            {recipients.length > 0 && (
              <Button onClick={handleSend} disabled={sending || selectedRecipients.length === 0}>
                {sending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…
                  </>
                ) : (
                  `Send to ${selectedRecipients.length}`
                )}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A small, paginated preview tray keeps processing calm at any package size. */
function ProcessingPanel({ processedPages, totalPages, sheets }: {
  processedPages: number
  totalPages: number | null
  sheets: DraftRevisionSheetPreview[]
}) {
  const [page, setPage] = useState(0)
  const pageSize = 8
  const pages = Math.max(1, Math.ceil(sheets.length / pageSize))
  const percent = totalPages ? Math.min(100, Math.round(processedPages / totalPages * 100)) : 0
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-12">
      <div className="mx-auto max-w-4xl">
        <div className="mx-auto mb-10 max-w-lg space-y-4 text-center" role="status" aria-live="polite">
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{totalPages ? `${processedPages} of ${totalPages}` : "Reading your PDF"}</p>
          <p className="text-sm text-muted-foreground">{totalPages ? "sheets prepared for review" : "Finding sheets and their details…"}</p>
          <Progress value={percent} aria-label="Sheets prepared" className="h-1.5" />
        </div>
        {sheets.length > 0 ? <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">PACKAGE PREVIEW</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Button variant="ghost" size="icon" aria-label="Previous previews" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              {page + 1} / {pages}
              <Button variant="ghost" size="icon" aria-label="Next previews" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {sheets.slice(page * pageSize, (page + 1) * pageSize).map((sheet) => <div key={sheet.version_id} className="min-w-0">
              <DrawingPreviewImage url={sheet.thumbnail_url} alt={sheet.sheet_number} className="aspect-[4/3] rounded-lg border" />
              <p className="mt-2 truncate text-sm font-medium">{sheet.sheet_number}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{sheet.sheet_title || "Preparing sheet details"}</p>
            </div>)}
          </div>
          {totalPages && totalPages > 400 && <p className="mt-4 text-xs text-muted-foreground">Previewing the first 400 sheets. All {totalPages} sheets will be available for review.</p>}
        </> : <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">Previews will appear here as sheets are prepared.</div>}
      </div>
    </div>
  )
}

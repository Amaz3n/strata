"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidScopeItem, BidSubmission } from "@/lib/services/bids"
import { listAttachmentsAction } from "@/app/(app)/documents/actions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Download, Loader2, Paperclip, Gavel, X } from "@/components/icons"
import { computeSubmissionTotals, money } from "@/components/bids/bid-workbench-helpers"

interface AttachmentRow {
  id: string
  fileName: string
  downloadUrl?: string
}

interface BidSubmissionPanelProps {
  submission: BidSubmission
  allSubmissions: BidSubmission[]
  scopeItems: BidScopeItem[]
  awarded: boolean
  canAward: boolean
  onAward: (submission: BidSubmission) => void
  onClose: () => void
}

export function BidSubmissionPanel({
  submission,
  allSubmissions,
  scopeItems,
  awarded,
  canAward,
  onAward,
  onClose,
}: BidSubmissionPanelProps) {
  const [attachments, setAttachments] = useState<AttachmentRow[]>([])
  const [loadingAttachments, setLoadingAttachments] = useState(false)

  useEffect(() => {
    let active = true
    setLoadingAttachments(true)
    listAttachmentsAction("bid_submission", submission.id)
      .then((links) => {
        if (!active) return
        setAttachments(
          (links ?? []).map((link) => {
            const record = link as unknown as {
              id: string
              file?: { id?: string; file_name?: string; download_url?: string }
            }
            return {
              id: record.id,
              fileName: record.file?.file_name ?? "Attachment",
              downloadUrl: record.file?.download_url,
            }
          }),
        )
      })
      .catch(() => {
        if (active) toast.error("Failed to load attachments")
      })
      .finally(() => {
        if (active) setLoadingAttachments(false)
      })
    return () => {
      active = false
    }
  }, [submission.id])

  const versions = useMemo(
    () =>
      allSubmissions
        .filter((entry) => entry.bid_invite_id === submission.bid_invite_id)
        .sort((a, b) => b.version - a.version),
    [allSubmissions, submission.bid_invite_id],
  )

  const totals = computeSubmissionTotals(submission, scopeItems)
  const benchmark = submission.benchmark

  return (
    <aside className="flex w-full flex-col rounded-lg border lg:w-96 lg:shrink-0">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {submission.is_awarded ? <Gavel className="h-4 w-4 text-success" /> : null}
            <h3 className="truncate text-sm font-semibold">
              {submission.invite?.company?.name ?? "Vendor"}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {submission.submitted_by_name ?? submission.submitted_by_email ?? "—"}
            {submission.source ? ` · ${submission.source.replace("_", " ")}` : ""}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Base total</span>
            <span className="tabular-nums text-sm">{money(totals.base)}</span>
          </div>
          {totals.plugs !== 0 ? (
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">GC plugs</span>
              <span className="tabular-nums text-sm">{money(totals.plugs)}</span>
            </div>
          ) : null}
          {totals.lump !== 0 ? (
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">Leveling adj</span>
              <span className="tabular-nums text-sm">{money(totals.lump)}</span>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between border-t pt-1">
            <span className="text-xs font-medium">Leveled total</span>
            <span className="tabular-nums text-sm font-medium">{money(totals.leveled)}</span>
          </div>
        </div>

        {benchmark?.has_benchmark ? (
          <p className="text-xs text-muted-foreground">
            Market {money(benchmark.p25_cents)}–{money(benchmark.p75_cents)} across {benchmark.sample_size} bids
            {benchmark.org_count ? ` from ${benchmark.org_count} GCs` : ""}. {benchmark.message}
          </p>
        ) : null}

        <DetailBlock label="Exclusions" value={submission.exclusions} />
        <DetailBlock label="Clarifications" value={submission.clarifications} />
        <DetailBlock label="Notes" value={submission.notes} />
        {submission.leveling_notes ? <DetailBlock label="Leveling notes" value={submission.leveling_notes} /> : null}

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Attachments</p>
          {loadingAttachments ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : attachments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No attachments.</p>
          ) : (
            <ul className="space-y-1">
              {attachments.map((attachment) => (
                <li key={attachment.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{attachment.fileName}</span>
                  </span>
                  {attachment.downloadUrl ? (
                    <a
                      href={attachment.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {versions.length > 1 ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Version history</p>
            <ul className="space-y-1">
              {versions.map((version) => (
                <li key={version.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5">
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      v{version.version}
                    </Badge>
                    {version.is_current ? <span className="text-muted-foreground">current</span> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {money(version.total_cents)}
                    {version.submitted_at ? ` · ${format(new Date(version.submitted_at), "MMM d")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {canAward && !awarded ? (
        <div className="border-t px-4 py-3">
          <Button size="sm" className="w-full" onClick={() => onAward(submission)}>
            <Gavel className="mr-1.5 h-3.5 w-3.5" />
            Award this bid
          </Button>
        </div>
      ) : null}
    </aside>
  )
}

function DetailBlock({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap text-xs">{value}</p>
    </div>
  )
}

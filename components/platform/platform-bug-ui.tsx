"use client"

import type React from "react"

import { Ban, CheckCircle2 } from "@/components/icons"
import type { FileWithDetails } from "@/components/files/types"
import { cn } from "@/lib/utils"
import type {
  PlatformBug,
  PlatformBugAiFix,
  PlatformBugAiReview,
  PlatformBugAttachment,
  PlatformBugEvent,
  PlatformBugPerson,
  PlatformBugPriority,
  PlatformBugStatus,
} from "@/lib/platform-bugs/types"

export const STATUS_LABELS: Record<PlatformBugStatus, string> = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  wont_fix: "Won't Fix",
}

export const PRIORITY_LABELS: Record<PlatformBugPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
}

export const statusOrder: PlatformBugStatus[] = ["triage", "in_progress", "in_review", "todo", "backlog", "done", "wont_fix"]
export const activeStatuses = new Set<PlatformBugStatus>(["triage", "todo", "in_progress", "in_review"])

export function initials(person?: PlatformBugPerson | null) {
  const name = person?.full_name || person?.email || "Arc"
  return name
    .split(/\s|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

export function formatDate(value?: string | null) {
  if (!value) return "No date"
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value))
}

export function priorityClass(priority: PlatformBugPriority) {
  if (priority === "urgent") return "text-red-500"
  if (priority === "high") return "text-orange-500"
  if (priority === "medium") return "text-yellow-500"
  return "text-muted-foreground"
}

export function priorityDot(priority: PlatformBugPriority) {
  if (priority === "urgent") return "bg-red-500"
  if (priority === "high") return "bg-orange-500"
  if (priority === "medium") return "bg-yellow-500"
  return "bg-muted-foreground/40"
}

const STATUS_FILL: Record<PlatformBugStatus, { color: string; fraction: number; dashed?: boolean }> = {
  triage: { color: "text-muted-foreground", fraction: 0, dashed: true },
  backlog: { color: "text-muted-foreground", fraction: 0, dashed: true },
  todo: { color: "text-muted-foreground", fraction: 0 },
  in_progress: { color: "text-yellow-500", fraction: 0.5 },
  in_review: { color: "text-yellow-500", fraction: 0.85 },
  done: { color: "text-green-600", fraction: 1 },
  wont_fix: { color: "text-muted-foreground", fraction: 0 },
}

// Linear-style status glyph: empty ring for todo, a growing yellow pie for
// in-progress/in-review, a green check when done, and a slashed circle for won't fix.
export function StatusCircle({ status, className }: { status: PlatformBugStatus; className?: string }) {
  if (status === "done") return <CheckCircle2 className={cn("size-4 text-green-600", className)} />
  if (status === "wont_fix") return <Ban className={cn("size-4 text-muted-foreground", className)} />

  const { color, fraction, dashed } = STATUS_FILL[status]
  const pieR = 2.5
  const circ = 2 * Math.PI * pieR
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4", color, className)} aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dashed ? "1.8 1.8" : undefined} />
      {fraction > 0 && (
        <circle
          cx="8"
          cy="8"
          r={pieR}
          stroke="currentColor"
          strokeWidth={pieR * 2}
          strokeDasharray={`${circ * fraction} ${circ}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}

export function eventText(event: PlatformBugEvent) {
  if (event.event_type === "created") return "created this issue"
  if (event.event_type === "commented") return "commented"
  if (event.event_type === "status_changed") return `moved from ${event.from_value} to ${event.to_value}`
  if (event.event_type === "priority_changed") return `changed priority from ${event.from_value} to ${event.to_value}`
  if (event.event_type === "severity_changed") return `changed severity from ${event.from_value} to ${event.to_value}`
  if (event.event_type === "assignee_changed") return "changed assignee"
  if (event.event_type === "archived") return "archived this issue"
  return "updated this issue"
}

export function getReviewStatusLabel(status: PlatformBugAiReview["status"]) {
  if (status === "proposal_ready") return "Proposal ready"
  if (status === "failed") return "Failed"
  if (status === "cancelled") return "Cancelled"
  if (status === "running") return "Running"
  if (status === "dispatched") return "Dispatched"
  return "Queued"
}

export function getFixStatusLabel(status: PlatformBugAiFix["status"]) {
  if (status === "pr_ready") return "PR ready"
  if (status === "failed") return "Failed"
  if (status === "cancelled") return "Cancelled"
  if (status === "running") return "Running"
  if (status === "dispatched") return "Dispatched"
  return "Queued"
}

export function isAiRunning(status?: PlatformBugAiReview["status"] | PlatformBugAiFix["status"]) {
  return status === "queued" || status === "dispatched" || status === "running"
}

export function canRequestCodexFix(bug: PlatformBug) {
  const source = bug.source.toLowerCase()
  const title = bug.title.toLowerCase()
  if (source === "support:feedback" || title.startsWith("feature request:")) return false
  return bug.status !== "triage" && bug.status !== "done" && bug.status !== "wont_fix"
}

export function attachmentToViewerFile(attachment: PlatformBugAttachment): FileWithDetails {
  return {
    id: attachment.id,
    org_id: "",
    file_name: attachment.file_name,
    storage_path: "",
    mime_type: attachment.content_type ?? undefined,
    size_bytes: attachment.size_bytes ?? undefined,
    visibility: "private",
    created_at: attachment.created_at,
    download_url: attachment.download_url,
    thumbnail_url: attachment.content_type?.startsWith("image/") ? attachment.download_url : undefined,
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function proposalText(proposal: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = proposal[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

export function AiReviewProposal({ review }: { review: PlatformBugAiReview }) {
  const proposal = review.proposal ?? {}
  const likelyFiles = stringArray(proposal.likely_affected_files ?? proposal.relevant_files)
  const plan = stringArray(proposal.implementation_plan ?? proposal.proposed_plan ?? proposal.plan)
  const risks = stringArray(proposal.risks)
  const tests = stringArray(proposal.tests_to_run ?? proposal.tests)
  const rootCause = proposalText(proposal, ["root_cause_hypothesis", "rootCauseHypothesis", "root_cause"])

  if (Object.keys(proposal).length === 0 || review.status !== "proposal_ready") return null

  return (
    <div className="space-y-3">
      {rootCause && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Hypothesis</p>
          <p className="mt-1 whitespace-pre-wrap leading-6">{rootCause}</p>
        </div>
      )}
      {likelyFiles.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Likely files</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {likelyFiles.slice(0, 8).map((file) => (
              <code key={file} className="border bg-background px-1.5 py-0.5 text-xs">{file}</code>
            ))}
          </div>
        </div>
      )}
      {plan.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Plan</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            {plan.slice(0, 8).map((item) => <li key={item}>{item}</li>)}
          </ol>
        </div>
      )}
      {risks.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Risks</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {risks.slice(0, 6).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      {tests.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tests</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {tests.slice(0, 6).map((test) => (
              <code key={test} className="border bg-background px-1.5 py-0.5 text-xs">{test}</code>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Attachment picking — shared by the desktop dialog and the mobile composer.
// Both write the chosen files back into a real <input type="file"> so the
// server action still receives them through the form submission.
// ---------------------------------------------------------------------------

export type AttachmentPreview = {
  id: string
  name: string
  type: string
  size: number
  url?: string
}

export function isSupportedAttachment(file: File) {
  const lowerName = file.name.toLowerCase()
  return file.type.startsWith("image/") || file.type === "application/pdf" || lowerName.endsWith(".pdf")
}

export function isPdfPreview(preview: AttachmentPreview) {
  return preview.type === "application/pdf" || preview.name.toLowerCase().endsWith(".pdf")
}

export function previewsForFiles(files: File[]): AttachmentPreview[] {
  return files.map((file, index) => ({
    id: `${file.name}-${file.lastModified}-${index}`,
    name: file.name,
    type: file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream"),
    size: file.size,
    url: URL.createObjectURL(file),
  }))
}

export function applyFilesToInput(input: HTMLInputElement, files: File[]) {
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  input.files = transfer.files
}

export function isFileDrag(event: React.DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files")
}

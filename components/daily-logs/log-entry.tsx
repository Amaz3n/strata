"use client"

import { useState } from "react"
import { format, parseISO } from "date-fns"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { MessageSquare, MoreHorizontal, Paperclip, AlertTriangle } from "@/components/icons"
import { HighlightedMentionsText, MentionTextarea } from "./mention-textarea"
import type { DailyLogsWorkspaceProps } from "./types"
import type { DailyLog } from "@/lib/types"
import type { EnhancedFileMetadata } from "@/app/(app)/projects/[id]/actions"
import { cn } from "@/lib/utils"

interface LogEntryProps {
  log: DailyLog
  files: EnhancedFileMetadata[]
  locked: boolean
  highlighted: boolean
  addendum?: boolean
  context: Pick<
    DailyLogsWorkspaceProps,
    | "mentionableUsers"
    | "scheduleItems"
    | "tasks"
    | "punchItems"
    | "onUpdateLog"
    | "onDeleteLog"
    | "onCreateComment"
    | "onLoadContext"
  >
  onImageClick: (file: EnhancedFileMetadata) => void
  onDownloadFile: (file: EnhancedFileMetadata) => void
}

const ENTRY_LABELS: Record<string, string> = {
  work: "Work performed",
  inspection: "Inspection",
  task_update: "Task",
  punch_update: "Punch item",
  delivery: "Delivery",
  constraint: "Delay / constraint",
  safety: "Safety",
  note: "Note",
}

export function LogEntry({
  log,
  files,
  locked,
  highlighted,
  addendum,
  context,
  onImageClick,
  onDownloadFile,
}: LogEntryProps) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(log.notes ?? "")
  const [mentions, setMentions] = useState<string[]>((log.mentions ?? []).map((m) => m.mentioned_user_id))
  const [threadOpen, setThreadOpen] = useState(false)
  const [reply, setReply] = useState("")
  const [replyMentions, setReplyMentions] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const comments = log.comments ?? []
  const images = files.filter((f) => f.mime_type?.startsWith("image/") || /\.hei[cf]$/i.test(f.file_name))
  const attachments = files.filter((f) => !images.includes(f))
  async function save() {
    setBusy(true)
    try {
      await context.onUpdateLog(log.id, { summary: text.trim(), weather: log.weather, mentioned_user_ids: mentions })
      setEditing(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save this log")
    } finally {
      setBusy(false)
    }
  }
  async function respond() {
    if (!reply.trim()) return
    setBusy(true)
    try {
      await context.onCreateComment(log.id, { body: reply.trim(), mentioned_user_ids: replyMentions })
      setReply("")
      setReplyMentions([])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to add reply")
    } finally {
      setBusy(false)
    }
  }
  return (
    <article
      id={`daily-log-${log.id}`}
      className={cn(
        "scroll-mt-6 border-b border-border/70 py-6 last:border-0",
        highlighted && "border-l-2 border-l-primary pl-4",
      )}
    >
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{log.author?.full_name ?? log.author?.email ?? "Teammate"}</span>
        <time className="text-muted-foreground" dateTime={log.created_at}>
          {format(parseISO(log.created_at), "h:mm a")}
        </time>
        {addendum && <span className="text-xs font-medium text-muted-foreground">Addendum</span>}
        {log.created_via_portal && <span className="text-muted-foreground">From subcontractor</span>}
        {!locked && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" aria-label="Log actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setText(log.notes ?? "")
                  setEditing(true)
                  void context.onLoadContext().catch(() => {})
                }}
              >
                Edit note
              </DropdownMenuItem>
              {context.onDeleteLog && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={async () => {
                    if (!window.confirm("Delete this log and its comments?")) return
                    try {
                      await context.onDeleteLog?.(log.id)
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Unable to delete log")
                    }
                  }}
                >
                  Delete log
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      {editing ? (
        <div className="space-y-2">
          <MentionTextarea
            value={text}
            onChange={setText}
            mentionableUsers={context.mentionableUsers}
            mentionedUserIds={mentions}
            onMentionedUserIdsChange={setMentions}
            placeholder="What happened on site?"
            rows={3}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : (
        log.notes && (
          <p className="whitespace-pre-wrap text-sm leading-7">
            <HighlightedMentionsText value={log.notes} mentionableUsers={context.mentionableUsers} />
          </p>
        )
      )}
      {images.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {images.map((photo) => (
            <button
              key={photo.id}
              onClick={() => onImageClick(photo)}
              className="h-24 w-28 shrink-0 overflow-hidden bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={`Open ${photo.file_name}`}
            >
              <img
                src={photo.thumbnail_url ?? photo.download_url}
                alt={photo.description ?? photo.file_name}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {attachments.map((file) => (
            <Button key={file.id} size="sm" variant="outline" onClick={() => onDownloadFile(file)}>
              <Paperclip className="mr-1.5 h-3.5 w-3.5" />
              {file.file_name}
            </Button>
          ))}
        </div>
      )}
      {(log.entries?.length ?? 0) > 0 && (
        <div className="mt-3 space-y-1.5">
          {log.entries?.map((entry) => {
            const issue =
              entry.entry_type === "safety" || entry.entry_type === "constraint" || entry.inspection_result === "fail"
            const linked =
              context.scheduleItems.find((item) => item.id === entry.schedule_item_id)?.name ??
              context.tasks.find((item) => item.id === entry.task_id)?.title ??
              context.punchItems.find((item) => item.id === entry.punch_item_id)?.title
            return (
              <div
                key={entry.id}
                className={cn(
                  "flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground",
                  issue && "text-destructive",
                )}
              >
                {issue && <AlertTriangle className="h-3 w-3 self-center" />}
                <span className="font-medium">{ENTRY_LABELS[entry.entry_type] ?? "Detail"}</span>
                {entry.description && <span className="text-foreground">{entry.description}</span>}
                {linked && linked !== entry.description && <span>{linked}</span>}
                {entry.inspection_result && (
                  <span className={entry.inspection_result === "pass" ? "text-success" : undefined}>
                    {entry.inspection_result === "pass"
                      ? "Passed"
                      : entry.inspection_result === "fail"
                        ? "Failed"
                        : entry.inspection_result.replaceAll("_", " ")}
                  </span>
                )}
                {entry.hours != null && <span>{entry.hours} hours</span>}
                {entry.progress != null && <span>{entry.progress}% complete</span>}
                {entry.trade && <span>{entry.trade}</span>}
                {entry.location && <span>{entry.location}</span>}
                {entry.metadata?.mark_complete === true && <span className="text-success">Completed</span>}
                {entry.metadata?.mark_closed === true && <span className="text-success">Closed</span>}
              </div>
            )
          })}
        </div>
      )}
      <button
        className="mt-3 inline-flex items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={threadOpen}
        onClick={() => {
          setThreadOpen(!threadOpen)
          void context.onLoadContext().catch(() => {})
        }}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        {comments.length ? `${comments.length} ${comments.length === 1 ? "reply" : "replies"}` : "Reply"}
      </button>
      {threadOpen && (
        <div className="mt-2 space-y-3 border-l-2 border-border pl-4">
          {comments.map((comment) => (
            <div key={comment.id}>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {comment.author?.full_name ?? comment.author?.email ?? "Teammate"}
                </span>{" "}
                · {format(parseISO(comment.created_at), "MMM d, h:mm a")}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6">
                <HighlightedMentionsText value={comment.body} mentionableUsers={context.mentionableUsers} />
              </p>
            </div>
          ))}
          <MentionTextarea
            value={reply}
            onChange={setReply}
            mentionableUsers={context.mentionableUsers}
            mentionedUserIds={replyMentions}
            onMentionedUserIdsChange={setReplyMentions}
            placeholder="Reply or @mention someone…"
            rows={2}
          />
          <Button size="sm" disabled={busy || !reply.trim()} onClick={() => void respond()}>
            {busy ? "Saving…" : "Add reply"}
          </Button>
        </div>
      )}
    </article>
  )
}

"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { toast } from "sonner"

import {
  CLASSIFICATION_HINTS,
  CLASSIFICATION_LABELS,
  CORRESPONDENCE_CLASSIFICATIONS,
  linkedEntityHref,
  linkedEntityLabel,
  type CorrespondenceClassification,
} from "@/lib/correspondence"
import { unwrapAction } from "@/lib/action-result"
import type { CorrespondenceMessage, ProjectEmailDetail } from "@/lib/services/correspondence"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Archive,
  ArchiveRestore,
  Check,
  Download,
  FileText,
  Link2,
  Paperclip,
} from "@/components/icons"
import {
  ClassificationBadge,
  DirectionIcon,
  ReviewState,
  formatBytes,
  formatTimestamp,
} from "@/components/correspondence/correspondence-shared"
import {
  archiveProjectEmailsAction,
  confirmProjectEmailClassificationsAction,
  getCorrespondenceThreadAction,
  getProjectEmailAction,
  reclassifyProjectEmailsAction,
  unlinkProjectEmailAction,
} from "@/app/(app)/projects/[id]/correspondence/actions"

export type DetailTarget = { kind: "thread"; threadId: string } | { kind: "message"; emailId: string }

/**
 * Everything from the first quoted line down is the conversation the reader has
 * already read. Splitting it off is what makes a long chain legible; before
 * this, every message re-rendered the whole history inline.
 */
function splitQuoted(body: string): { visible: string; quoted: string | null } {
  const lines = body.split("\n")
  const index = lines.findIndex(
    (line) => line.startsWith(">") || /^on .+ wrote:$/i.test(line.trim()) || line.trim().startsWith("---------- Forwarded"),
  )
  if (index < 0) return { visible: body, quoted: null }
  return { visible: lines.slice(0, index).join("\n").trimEnd(), quoted: lines.slice(index).join("\n") }
}

function MessageBody({ body }: { body: string }) {
  const [showQuoted, setShowQuoted] = useState(false)
  const { visible, quoted } = useMemo(() => splitQuoted(body), [body])

  if (!body) {
    return <p className="text-sm text-muted-foreground">The stored message body could not be loaded.</p>
  }
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{visible || "(No message body)"}</p>
      {quoted && (
        <>
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setShowQuoted((value) => !value)}>
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </Button>
          {showQuoted && (
            <p className="whitespace-pre-wrap border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground">
              {quoted}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function MessageCard({
  projectId,
  message,
  expanded,
  canWrite,
  pending,
  onToggle,
  onReclassify,
  onConfirm,
  onUnlink,
  onLink,
  onArchive,
}: {
  projectId: string
  message: ProjectEmailDetail
  expanded: boolean
  canWrite: boolean
  pending: boolean
  onToggle: () => void
  onReclassify: (classification: CorrespondenceClassification) => void
  onConfirm: () => void
  onUnlink: (linkId: string) => void
  onLink: () => void
  onArchive: (archived: boolean) => void
}) {
  return (
    <div className="border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 p-3 text-left hover:bg-muted/40"
      >
        <span className="mt-0.5">
          <DirectionIcon direction={message.direction} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-medium">{message.from_address}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatTimestamp(message.occurred_at)}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-2">
            <ClassificationBadge classification={message.classification} />
            <ReviewState classifiedBy={message.classified_by} confidence={message.classification_confidence} />
            {message.attachment_count > 0 && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Paperclip className="size-3" />
                {message.attachment_count}
              </span>
            )}
          </span>
          {!expanded && message.body_preview && (
            <span className="mt-1 block truncate text-xs text-muted-foreground">{message.body_preview}</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="space-y-5 border-t p-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">To</dt>
            <dd className="break-all">{message.to_addresses.join(", ") || "—"}</dd>
            {message.cc_addresses.length > 0 && (
              <>
                <dt className="text-muted-foreground">Cc</dt>
                <dd className="break-all">{message.cc_addresses.join(", ")}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Filed</dt>
            <dd>{formatTimestamp(message.received_at)}</dd>
          </dl>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">Classification</p>
            {canWrite ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={message.classification}
                  disabled={pending}
                  onValueChange={(value) => onReclassify(value as CorrespondenceClassification)}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="Classification">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CORRESPONDENCE_CLASSIFICATIONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        <span className="flex flex-col items-start">
                          <span>{CLASSIFICATION_LABELS[value]}</span>
                          <span className="text-xs text-muted-foreground">{CLASSIFICATION_HINTS[value]}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/*
                  Picking the value that is already selected fires no change, so
                  agreeing with the model needs its own control. Without it a
                  suggestion could never become a human ruling.
                */}
                {message.classified_by !== "user" && (
                  <Button variant="outline" size="sm" disabled={pending} onClick={onConfirm}>
                    <Check className="size-4" />
                    Confirm
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ClassificationBadge classification={message.classification} />
                <ReviewState classifiedBy={message.classified_by} confidence={message.classification_confidence} />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">Linked records</p>
            <div className="flex flex-wrap items-center gap-2">
              {message.links.map((link) => {
                const href = linkedEntityHref(projectId, link.entity_type, link.entity_id)
                return (
                  <Badge key={link.id} variant="outline" className="gap-1.5 font-normal">
                    {href ? (
                      <Link href={href} className="underline-offset-4 hover:underline">
                        {linkedEntityLabel(link.entity_type)}
                      </Link>
                    ) : (
                      linkedEntityLabel(link.entity_type)
                    )}
                    {canWrite && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => onUnlink(link.id)}
                        aria-label={`Remove ${linkedEntityLabel(link.entity_type)} link`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        ×
                      </button>
                    )}
                  </Badge>
                )
              })}
              {message.links.length === 0 && (
                <span className="text-sm text-muted-foreground">Not linked to anything yet.</span>
              )}
              {canWrite && (
                <Button variant="ghost" size="sm" disabled={pending} onClick={onLink}>
                  <Link2 className="size-4" />
                  Link…
                </Button>
              )}
            </div>
          </div>

          <Separator />

          <MessageBody body={message.body} />
          {message.body_truncated && message.body_file_id && (
            <p className="text-xs text-muted-foreground">
              This is the start of a long message.{" "}
              <a
                href={`/api/files/${message.body_file_id}/raw`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                Open the full text
              </a>
              .
            </p>
          )}

          {message.attachments.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                Attachments ({message.attachments.length})
              </p>
              <ul className="divide-y border">
                {message.attachments.map((attachment) => (
                  <li key={attachment.file_id} className="flex items-center justify-between gap-3 p-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{attachment.file_name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(attachment.size_bytes)}
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`/api/files/${attachment.file_id}/raw`} target="_blank" rel="noreferrer">
                        <Download className="size-4" />
                        Open
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {canWrite && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => onArchive(!message.archived_at)}
              >
                {message.archived_at ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                {message.archived_at ? "Restore" : "Unfile"}
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <a
                href={`/projects/${projectId}/exports/correspondence?email=${message.id}`}
                target="_blank"
                rel="noreferrer"
              >
                <FileText className="size-4" />
                PDF
              </a>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function CorrespondenceDetailSheet({
  projectId,
  target,
  canWrite,
  onClose,
  onMessagesChanged,
  onLink,
}: {
  projectId: string
  target: DetailTarget | null
  canWrite: boolean
  onClose: () => void
  onMessagesChanged: (messages: CorrespondenceMessage[]) => void
  onLink: (emailId: string) => void
}) {
  const [messages, setMessages] = useState<ProjectEmailDetail[] | null>(null)
  const [truncatedFrom, setTruncatedFrom] = useState<number | null>(null)
  const [subject, setSubject] = useState("")
  const [threadId, setThreadId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const requested = useRef<string | null>(null)

  const key = target ? (target.kind === "thread" ? `thread:${target.threadId}` : `message:${target.emailId}`) : null

  useEffect(() => {
    if (!key || !target) {
      requested.current = null
      setMessages(null)
      setLoadError(null)
      setExpanded(new Set())
      setThreadId(null)
      setTruncatedFrom(null)
      return
    }
    if (requested.current === key) return
    requested.current = key
    setMessages(null)
    setLoadError(null)

    let active = true
    const load = async () => {
      if (target.kind === "thread") {
        const result = await getCorrespondenceThreadAction({ projectId, threadId: target.threadId })
        if (!active) return
        if (!result.success) {
          setLoadError(result.error)
          return
        }
        setMessages(result.data.messages)
        setSubject(result.data.subject)
        setThreadId(result.data.thread_id)
        setTruncatedFrom(result.data.truncated ? result.data.total_message_count : null)
        // The newest message is what the reader came for; the history stays
        // collapsed until they ask for it.
        const newest = result.data.messages[result.data.messages.length - 1]
        setExpanded(new Set(newest ? [newest.id] : []))
        return
      }

      const result = await getProjectEmailAction({ projectId, emailId: target.emailId })
      if (!active) return
      if (!result.success) {
        setLoadError(result.error)
        return
      }
      const email = result.data
      // An unfiled message is not part of any conversation the log shows, so it
      // is rendered on its own.
      if (email.archived_at) {
        setMessages([email])
        setSubject(email.subject)
        setThreadId(null)
        setExpanded(new Set([email.id]))
        return
      }
      const thread = await getCorrespondenceThreadAction({ projectId, threadId: email.thread_id })
      if (!active) return
      if (!thread.success) {
        setMessages([email])
        setSubject(email.subject)
        setThreadId(null)
        setExpanded(new Set([email.id]))
        return
      }
      setMessages(thread.data.messages)
      setSubject(thread.data.subject)
      setThreadId(thread.data.thread_id)
      setTruncatedFrom(thread.data.truncated ? thread.data.total_message_count : null)
      setExpanded(new Set([email.id]))
    }
    void load()
    return () => {
      active = false
    }
  }, [key, projectId, target])

  const apply = useCallback(
    (updated: CorrespondenceMessage[]) => {
      const byId = new Map(updated.map((message) => [message.id, message]))
      setMessages((current) =>
        current
          ? current.map((message) => {
              const next = byId.get(message.id)
              return next ? { ...message, ...next } : message
            })
          : current,
      )
      onMessagesChanged(updated)
    },
    [onMessagesChanged],
  )

  const run = (work: () => Promise<CorrespondenceMessage[]>, success: string) => {
    startTransition(async () => {
      try {
        apply(await work())
        toast.success(success)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong")
      }
    })
  }

  const unreviewed = (messages ?? []).filter((message) => message.classified_by !== "user")

  return (
    <Sheet open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="text-left">{loadError ? "Conversation unavailable" : subject || "Loading…"}</SheetTitle>
          <SheetDescription className="text-left">
            {loadError ??
              (messages
                ? `${messages.length} ${messages.length === 1 ? "message" : "messages"}`
                : "Loading the conversation…")}
          </SheetDescription>
        </SheetHeader>

        {!loadError && messages && threadId && (
          <div className="flex flex-wrap items-center gap-2 border-b px-4 pb-3">
            {canWrite && unreviewed.length > 0 && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    async () =>
                      unwrapAction(
                        await confirmProjectEmailClassificationsAction({
                          projectId,
                          emailIds: unreviewed.map((message) => message.id),
                        }),
                      ),
                    "Classifications confirmed",
                  )
                }
              >
                <Check className="size-4" />
                Confirm {unreviewed.length}
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/projects/${projectId}/exports/correspondence?thread=${encodeURIComponent(threadId)}`}
                target="_blank"
                rel="noreferrer"
              >
                <FileText className="size-4" />
                Export conversation
              </a>
            </Button>
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {loadError ? null : !messages ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-48 w-full" />
            </>
          ) : (
            <>
              {truncatedFrom !== null && (
                <p className="text-xs text-muted-foreground">
                  Showing the most recent {messages.length} of {truncatedFrom} messages. Export the conversation for
                  the full record.
                </p>
              )}
              {messages.map((message) => (
              <MessageCard
                key={message.id}
                projectId={projectId}
                message={message}
                canWrite={canWrite}
                pending={pending}
                expanded={expanded.has(message.id)}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(message.id)) next.delete(message.id)
                    else next.add(message.id)
                    return next
                  })
                }
                onReclassify={(classification) =>
                  run(
                    async () =>
                      unwrapAction(
                        await reclassifyProjectEmailsAction({
                          projectId,
                          emailIds: [message.id],
                          classification,
                        }),
                      ),
                    "Classification updated",
                  )
                }
                onConfirm={() =>
                  run(
                    async () =>
                      unwrapAction(
                        await confirmProjectEmailClassificationsAction({ projectId, emailIds: [message.id] }),
                      ),
                    "Classification confirmed",
                  )
                }
                onUnlink={(linkId) =>
                  run(
                    async () => [
                      unwrapAction(await unlinkProjectEmailAction({ projectId, emailId: message.id, linkId })),
                    ],
                    "Link removed",
                  )
                }
                onLink={() => onLink(message.id)}
                onArchive={(archived) =>
                  run(
                    async () =>
                      unwrapAction(
                        await archiveProjectEmailsAction({ projectId, emailIds: [message.id], archived }),
                      ),
                    archived ? "Message unfiled" : "Message restored",
                  )
                }
                />
              ))}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

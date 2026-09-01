"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
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
import type { CorrespondenceReaderTarget, ProjectEmailDetail } from "@/lib/services/correspondence"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
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
  reclassifyProjectEmailsAction,
  unlinkProjectEmailAction,
} from "@/app/(app)/projects/[id]/correspondence/actions"
import { cn } from "@/lib/utils"

/**
 * Everything from the first quoted line down is the conversation the reader has
 * already read. Splitting it off is what makes a long chain legible; before
 * this, every message re-rendered the whole history inline.
 */
function splitQuoted(body: string): { visible: string; quoted: string | null } {
  const lines = body.split("\n")
  const index = lines.findIndex(
    (line) =>
      line.startsWith(">") ||
      /^on .+ wrote:$/i.test(line.trim()) ||
      line.trim().startsWith("---------- Forwarded"),
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
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-muted-foreground"
            onClick={() => setShowQuoted((value) => !value)}
          >
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

/**
 * One conversation, read in a centred dialog.
 *
 * Fixed height rather than content height: a chain of forty messages and a
 * one-line acknowledgement should open the same window, and the scroll belongs
 * to the message stack rather than to the page behind it.
 *
 * Data arrives as props from the server, which is the point of the rewrite: the
 * sheet this replaces loaded its messages from an effect keyed on an object
 * rebuilt every render, so the cleanup for render N cancelled the fetch started
 * by render N and it sat on "Loading…" forever.
 */
export function CorrespondenceDialog({
  projectId,
  target,
  open,
  loading,
  canWrite,
  onOpenChange,
  onLink,
}: {
  projectId: string
  target: CorrespondenceReaderTarget | null
  open: boolean
  /** The click landed but the server has not sent this conversation back yet. */
  loading: boolean
  canWrite: boolean
  onOpenChange: (open: boolean) => void
  onLink: (emailId: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[46rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {loading || !target ? (
          <DialogSkeleton />
        ) : (
          <DialogBody
            key={target.id}
            projectId={projectId}
            target={target}
            canWrite={canWrite}
            onLink={onLink}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DialogSkeleton() {
  return (
    <>
      <DialogHeader className="shrink-0 gap-1.5 border-b px-5 py-3 pr-12">
        <DialogTitle className="sr-only">Loading conversation</DialogTitle>
        <DialogDescription className="sr-only">
          The messages in this conversation are still loading.
        </DialogDescription>
        <Skeleton className="h-5 w-72 max-w-full" />
        <Skeleton className="h-3.5 w-24" />
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 p-5">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </>
  )
}

function DialogBody({
  projectId,
  target,
  canWrite,
  onLink,
}: {
  projectId: string
  target: CorrespondenceReaderTarget
  canWrite: boolean
  onLink: (emailId: string) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Newest first is what anyone opening a chain came for; the history stays
  // folded until asked for. Seeded once — the dialog is keyed on the
  // conversation, so a different one mounts fresh.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(target.messages.length ? [target.messages[target.messages.length - 1].id] : []),
  )

  const run = (work: () => Promise<unknown>, success: string) => {
    startTransition(async () => {
      try {
        await work()
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong")
      }
    })
  }

  const unreviewed = target.messages.filter((message) => message.classified_by !== "user")
  const archived = target.messages.every((message) => message.archived_at)
  const exportHref = target.thread_id
    ? `/projects/${projectId}/exports/correspondence?thread=${encodeURIComponent(target.thread_id)}`
    : `/projects/${projectId}/exports/correspondence?email=${target.messages[0]?.id ?? ""}`

  return (
    <>
      {/* pr-12 keeps the subject clear of the dialog's own close button. */}
      <DialogHeader className="shrink-0 gap-1 border-b px-5 py-3 pr-12">
        <DialogTitle className="truncate text-base">{target.subject}</DialogTitle>
        <DialogDescription>
          {target.total_message_count} {target.total_message_count === 1 ? "message" : "messages"}
          {archived && " · unfiled"}
        </DialogDescription>
      </DialogHeader>

      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-1 border-b px-5 py-2",
          pending && "opacity-70",
        )}
      >
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
          {canWrite && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  async () =>
                    unwrapAction(
                      await archiveProjectEmailsAction({
                        projectId,
                        ...(target.kind === "thread"
                          ? { threadIds: [target.id] }
                          : { emailIds: [target.id] }),
                        archived: !archived,
                      }),
                    ),
                  archived ? "Restored to the log" : "Taken out of the log",
                )
              }
            >
              {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              {archived ? "Restore" : "Unfile"}
            </Button>
          )}
        <Button variant="ghost" size="sm" asChild>
          <a href={exportHref} target="_blank" rel="noreferrer">
            <FileText className="size-4" />
            PDF
          </a>
        </Button>
      </div>

      {/* The scroll lives here, not on the page: the window stays put and the
          conversation moves inside it. */}
      <div className={cn("min-h-0 flex-1 overflow-y-auto", pending && "opacity-70")}>
        <div className="space-y-3 p-5">
          {target.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the most recent {target.messages.length} of {target.total_message_count} messages. Export
              the conversation for the full record.
            </p>
          )}
          {target.messages.map((message) => (
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
                  async () =>
                    unwrapAction(await unlinkProjectEmailAction({ projectId, emailId: message.id, linkId })),
                  "Link removed",
                )
              }
              onLink={() => onLink(message.id)}
            />
          ))}
        </div>
      </div>
    </>
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
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <article className="border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 p-3 text-left transition-colors duration-150 hover:bg-muted/40"
      >
        <Chevron className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <DirectionIcon direction={message.direction} className="mt-0.5" />
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
        <div className="space-y-5 border-t p-4">
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
              <p className="microlabel">Attachments ({message.attachments.length})</p>
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

          <Separator />

          {/* Ruling on the message comes after reading it. The sheet put these
              controls above the body, so you scrolled past the decision to
              reach the thing the decision is about. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="microlabel">Classification</p>
              {canWrite ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={message.classification}
                    disabled={pending}
                    onValueChange={(value) => onReclassify(value as CorrespondenceClassification)}
                  >
                    <SelectTrigger className="w-full" aria-label="Classification">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CORRESPONDENCE_CLASSIFICATIONS.map((value) => (
                        <SelectItem key={value} value={value} description={CLASSIFICATION_HINTS[value]}>
                          {CLASSIFICATION_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/*
                    Picking the value that is already selected fires no change,
                    so agreeing with the model needs its own control. Without it
                    a suggestion could never become a human ruling.
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
                  <ReviewState
                    classifiedBy={message.classified_by}
                    confidence={message.classification_confidence}
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="microlabel">Linked records</p>
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
                {message.links.length === 0 && !canWrite && (
                  <span className="text-sm text-muted-foreground">Not linked to anything.</span>
                )}
                {canWrite && (
                  <Button variant="outline" size="sm" disabled={pending} onClick={onLink}>
                    <Link2 className="size-4" />
                    Link…
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

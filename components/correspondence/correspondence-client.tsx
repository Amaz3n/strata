"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import {
  CLASSIFICATION_HINTS,
  CLASSIFICATION_LABELS,
  CORRESPONDENCE_CLASSIFICATIONS,
  linkedEntityHref,
  linkedEntityLabel,
  type CorrespondenceClassification,
} from "@/lib/correspondence"
import type {
  ProjectCorrespondenceInbox,
  ProjectCorrespondenceRow,
  ProjectEmailDetail,
} from "@/lib/services/project-email-ingest"
import { unwrapAction } from "@/lib/action-result"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Copy, Download, Mail, Paperclip, Search, Send } from "@/components/icons"
import { cn } from "@/lib/utils"
import {
  enableProjectCorrespondenceAction,
  getProjectEmailAction,
  logProjectEmailAsChangeEventAction,
  reclassifyProjectEmailAction,
  unlinkProjectEmailAction,
} from "@/app/(app)/projects/[id]/correspondence/actions"

function formatTimestamp(value: string | null) {
  if (!value) return "—"
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function formatBytes(value: number | null) {
  if (!value) return ""
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** Timestamp of record: when the message was written, else when Arc filed it. */
function occurredAt(email: Pick<ProjectCorrespondenceRow, "sent_at" | "received_at" | "created_at">) {
  return email.sent_at ?? email.received_at ?? email.created_at
}

/**
 * Only `co_trigger` carries colour: it is the one classification that means
 * someone has to act. The rest are categories, and colour here is state.
 */
function ClassificationBadge({ email }: { email: ProjectCorrespondenceRow }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] font-normal",
        email.classification === "co_trigger" && "border-warning/30 bg-warning/15 text-warning",
      )}
    >
      {CLASSIFICATION_LABELS[email.classification]}
    </Badge>
  )
}

/**
 * `classified_by` is the difference between "a model guessed this" and "a person
 * decided this". On a log that gets read back during a dispute, that distinction
 * belongs on the row, not buried in the table.
 */
function ClassificationSource({ email }: { email: ProjectCorrespondenceRow }) {
  if (email.classified_by === "user") return <span className="text-xs text-muted-foreground">Confirmed</span>
  const confidence = email.classification_confidence
  return (
    <span className="text-xs text-muted-foreground">
      AI{confidence === null ? "" : ` · ${Math.round(confidence * 100)}%`}
    </span>
  )
}

function DirectionIcon({ direction }: { direction: ProjectCorrespondenceRow["direction"] }) {
  const Icon = direction === "outbound" ? Send : Mail
  return (
    <Icon
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-label={direction === "outbound" ? "Sent" : "Received"}
    />
  )
}

function InboxPanel({
  projectId,
  inbox,
  canWrite,
}: {
  projectId: string
  inbox: ProjectCorrespondenceInbox
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const enable = () => {
    startTransition(async () => {
      try {
        unwrapAction(await enableProjectCorrespondenceAction({ projectId }))
        toast.success("Email filing is on for this project")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not enable email filing")
      }
    })
  }

  if (!inbox.inboundConfigured) {
    return (
      <div className="border bg-card p-4">
        <p className="text-xs font-medium uppercase text-muted-foreground">File email into this project</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Inbound email filing isn&apos;t set up for this workspace yet. Your Arc administrator can turn it on.
        </p>
      </div>
    )
  }

  if (!inbox.address) {
    return (
      <div className="flex flex-wrap items-end justify-between gap-4 border bg-card p-4">
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">File email into this project</p>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Give this project its own email address. Anything sent or BCC&apos;d to it lands in the log below, with
            attachments filed to the project.
          </p>
        </div>
        {canWrite ? (
          <Button onClick={enable} disabled={pending}>
            <Mail className="size-4" />
            {pending ? "Setting up…" : "Enable email filing"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Ask a project manager to turn this on.</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border bg-card p-4">
      <div>
        <p className="text-xs font-medium uppercase text-muted-foreground">File email into this project</p>
        <p className="mt-1 font-mono text-sm break-all">{inbox.address}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(inbox.address ?? "").then(
            () => toast.success("Address copied"),
            () => toast.error("Could not copy the address"),
          )
        }}
      >
        <Copy className="size-4" />
        Copy
      </Button>
    </div>
  )
}

function DetailSheet({
  projectId,
  emailId,
  canWrite,
  canWriteChangeEvents,
  onClose,
  onOpenEmail,
  onRowChange,
}: {
  projectId: string
  emailId: string | null
  canWrite: boolean
  canWriteChangeEvents: boolean
  onClose: () => void
  onOpenEmail: (emailId: string) => void
  onRowChange: (row: ProjectCorrespondenceRow) => void
}) {
  const [detail, setDetail] = useState<ProjectEmailDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const requestedId = useRef<string | null>(null)

  useEffect(() => {
    if (!emailId) {
      requestedId.current = null
      setDetail(null)
      setLoadError(null)
      return
    }
    if (requestedId.current === emailId) return
    requestedId.current = emailId
    setDetail(null)
    setLoadError(null)
    let active = true
    void getProjectEmailAction({ projectId, emailId }).then((result) => {
      if (!active) return
      if (result.success) setDetail(result.data)
      else setLoadError(result.error)
    })
    return () => {
      active = false
    }
  }, [emailId, projectId])

  const apply = useCallback(
    (row: ProjectCorrespondenceRow) => {
      onRowChange(row)
      setDetail((current) => (current ? { ...current, ...row } : current))
    },
    [onRowChange],
  )

  const run = (work: () => Promise<ProjectCorrespondenceRow>, success: string) => {
    startTransition(async () => {
      try {
        apply(await work())
        toast.success(success)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong")
      }
    })
  }

  const linkHref = detail ? linkedEntityHref(projectId, detail.linked_entity_type, detail.linked_entity_id) : null

  return (
    <Sheet open={Boolean(emailId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl">
        {loadError ? (
          <>
            <SheetHeader>
              <SheetTitle>Email unavailable</SheetTitle>
              <SheetDescription>{loadError}</SheetDescription>
            </SheetHeader>
          </>
        ) : !detail ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-start gap-2 text-left">
                <DirectionIcon direction={detail.direction} />
                <span>{detail.subject}</span>
              </SheetTitle>
              <SheetDescription className="text-left">
                {detail.direction === "outbound" ? "Sent by" : "From"} {detail.from_address} ·{" "}
                {formatTimestamp(occurredAt(detail))}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 overflow-y-auto px-4 pb-6">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">To</dt>
                <dd className="break-all">{detail.to_addresses.join(", ") || "—"}</dd>
                {detail.cc_addresses.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Cc</dt>
                    <dd className="break-all">{detail.cc_addresses.join(", ")}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Filed</dt>
                <dd>{formatTimestamp(detail.received_at)}</dd>
              </dl>

              <Separator />

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Classification</p>
                  <ClassificationSource email={detail} />
                </div>
                {canWrite ? (
                  <Select
                    value={detail.classification}
                    disabled={pending}
                    onValueChange={(value) =>
                      run(
                        async () =>
                          unwrapAction(
                            await reclassifyProjectEmailAction({
                              projectId,
                              emailId: detail.id,
                              classification: value as CorrespondenceClassification,
                            }),
                          ),
                        "Classification updated",
                      )
                    }
                  >
                    <SelectTrigger className="w-full sm:w-72">
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
                ) : (
                  <ClassificationBadge email={detail} />
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">Linked record</p>
                {linkHref ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Link href={linkHref} className="text-sm underline underline-offset-4">
                      {linkedEntityLabel(detail.linked_entity_type)}
                    </Link>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          run(
                            async () =>
                              unwrapAction(await unlinkProjectEmailAction({ projectId, emailId: detail.id })),
                            "Link removed",
                          )
                        }
                      >
                        Remove link
                      </Button>
                    )}
                  </div>
                ) : canWrite && canWriteChangeEvents ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm text-muted-foreground">Not linked to anything yet.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        run(
                          async () =>
                            unwrapAction(
                              await logProjectEmailAsChangeEventAction({ projectId, emailId: detail.id }),
                            ),
                          "Change event created",
                        )
                      }
                    >
                      Log as change event
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Not linked to anything yet.</p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">Message</p>
                {detail.body ? (
                  <>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{detail.body}</p>
                    {detail.body_truncated && (
                      <p className="text-xs text-muted-foreground">
                        Showing the start of a long message. The full text is filed with the project&apos;s documents.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">The stored message body could not be loaded.</p>
                )}
              </div>

              {detail.attachments.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Attachments ({detail.attachments.length})
                  </p>
                  <ul className="divide-y border">
                    {detail.attachments.map((attachment) => (
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

              {detail.thread.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Rest of this thread ({detail.thread.length})
                  </p>
                  <ul className="divide-y border">
                    {detail.thread.map((sibling) => (
                      <li key={sibling.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 p-2 text-left hover:bg-muted/50"
                          onClick={() => onOpenEmail(sibling.id)}
                        >
                          <DirectionIcon direction={sibling.direction} />
                          <span className="min-w-0 flex-1 truncate text-sm">{sibling.from_address}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {formatTimestamp(sibling.occurred_at)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export function CorrespondenceClient({
  projectId,
  inbox,
  emails: initialEmails,
  truncated,
  limit,
  canWrite,
  canWriteChangeEvents,
}: {
  projectId: string
  inbox: ProjectCorrespondenceInbox
  emails: ProjectCorrespondenceRow[]
  truncated: boolean
  limit: number
  canWrite: boolean
  canWriteChangeEvents: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [emails, setEmails] = useState(initialEmails)
  useEffect(() => setEmails(initialEmails), [initialEmails])

  const activeSearch = searchParams.get("q") ?? ""
  const activeClassification = searchParams.get("classification") ?? "all"
  const activeDirection = searchParams.get("direction") ?? "all"
  const openEmailId = searchParams.get("email")

  const [searchDraft, setSearchDraft] = useState(activeSearch)
  useEffect(() => setSearchDraft(activeSearch), [activeSearch])

  const setParams = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "" || value === "all") next.delete(key)
        else next.set(key, value)
      }
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const onRowChange = useCallback((row: ProjectCorrespondenceRow) => {
    setEmails((current) => current.map((email) => (email.id === row.id ? { ...email, ...row } : email)))
  }, [])

  const filtersActive = Boolean(activeSearch) || activeClassification !== "all" || activeDirection !== "all"

  const emptyMessage = useMemo(() => {
    if (filtersActive) return "No email matches these filters."
    if (!inbox.inboundConfigured) return "This project has no correspondence on file."
    if (!inbox.address) return "Enable email filing above to start this project's correspondence log."
    return "No correspondence yet. Send or BCC the address above to start the log."
  }, [filtersActive, inbox.address, inbox.inboundConfigured])

  return (
    <div className="space-y-4">
      <InboxPanel projectId={projectId} inbox={inbox} canWrite={canWrite} />

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault()
            setParams({ q: searchDraft.trim() || null })
          }}
        >
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search subject or sender…"
            className="w-64 pl-8"
          />
        </form>
        <Select value={activeClassification} onValueChange={(value) => setParams({ classification: value })}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All classifications" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classifications</SelectItem>
            {CORRESPONDENCE_CLASSIFICATIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {CLASSIFICATION_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={activeDirection} onValueChange={(value) => setParams({ direction: value })}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All mail" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All mail</SelectItem>
            <SelectItem value="inbound">Received</SelectItem>
            <SelectItem value="outbound">Sent</SelectItem>
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setParams({ q: null, classification: null, direction: null })}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="overflow-hidden border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>Correspondent</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead className="text-right">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {emails.map((email) => {
              const href = linkedEntityHref(projectId, email.linked_entity_type, email.linked_entity_id)
              return (
                <TableRow
                  key={email.id}
                  tabIndex={0}
                  role="button"
                  className="cursor-pointer"
                  onClick={() => setParams({ email: email.id })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      setParams({ email: email.id })
                    }
                  }}
                >
                  <TableCell>
                    <div className="flex items-start gap-2">
                      <span className="mt-1">
                        <DirectionIcon direction={email.direction} />
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium">{email.subject}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          {href && (
                            <Link
                              href={href}
                              onClick={(event) => event.stopPropagation()}
                              className="text-xs text-muted-foreground underline underline-offset-4"
                            >
                              {linkedEntityLabel(email.linked_entity_type)}
                            </Link>
                          )}
                          {email.attachment_count > 0 && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Paperclip className="size-3" />
                              {email.attachment_count}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{email.from_address}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ClassificationBadge email={email} />
                      <ClassificationSource email={email} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums whitespace-nowrap">
                    {formatTimestamp(occurredAt(email))}
                  </TableCell>
                </TableRow>
              )
            })}
            {emails.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the {limit} most recent messages. Narrow the search or classification to reach older mail.
        </p>
      )}

      <DetailSheet
        projectId={projectId}
        emailId={openEmailId}
        canWrite={canWrite}
        canWriteChangeEvents={canWriteChangeEvents}
        onClose={() => setParams({ email: null })}
        onOpenEmail={(id) => setParams({ email: id })}
        onRowChange={onRowChange}
      />
    </div>
  )
}

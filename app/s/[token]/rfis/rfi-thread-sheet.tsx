"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { format } from "date-fns"
import { Lock, Paperclip, Send, X } from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { formatFileSize } from "@/components/files/types"
import { subRfiBucket } from "@/lib/portal/rfi-buckets"
import type { Rfi, RfiAttachment, RfiThread, RfiThreadMessage } from "@/lib/types"
import { cn, formatLocalDate } from "@/lib/utils"
import { addSubPortalRfiResponseAction, loadSubPortalRfiThreadAction } from "./actions"
import { RfiPriorityBadge, RfiStateBadge } from "./rfi-status"

interface RfiThreadSheetProps {
  rfi: Rfi | null
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string
  companyId: string | null
  canRespond: boolean
  canDownload: boolean
  /** Refreshes the list behind the sheet once the thread changes. */
  onChanged: () => void
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?"
}

function authorOf(message: RfiThreadMessage) {
  if (message.responder_name) return message.responder_name
  return message.created_via_portal ? "Your team" : "The builder"
}

function AttachmentLink({
  attachment,
  token,
  canDownload,
}: {
  attachment: RfiAttachment
  token: string
  canDownload: boolean
}) {
  const href = `/api/portal/files/${token}/${attachment.file_id}${canDownload ? "?download=1" : ""}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 flex w-fit max-w-full items-center gap-2 border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-accent/50"
    >
      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{attachment.file_name}</span>
      {attachment.size_bytes ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatFileSize(attachment.size_bytes)}
        </span>
      ) : null}
    </a>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{value}</dd>
    </div>
  )
}

function ThreadMessage({
  message,
  token,
  canDownload,
}: {
  message: RfiThreadMessage
  token: string
  canDownload: boolean
}) {
  const author = authorOf(message)
  const isAnswer = message.response_type === "answer"

  return (
    <li className="flex gap-3">
      <Avatar className="mt-0.5 size-7 shrink-0">
        <AvatarFallback className="text-[10px] font-medium">{initialsOf(author)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{author}</span>
          {isAnswer ? (
            <span className="border border-success/40 bg-success/10 px-1.5 py-px text-[11px] font-medium text-success">
              Answer
            </span>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {format(new Date(message.created_at), "MMM d, h:mm a")}
          </span>
        </div>
        <p
          className={cn(
            "mt-1 whitespace-pre-line text-sm text-muted-foreground",
            isAnswer && "border-l-2 border-l-success pl-3 text-foreground",
          )}
        >
          {message.body}
        </p>
        {message.attachment ? (
          <AttachmentLink attachment={message.attachment} token={token} canDownload={canDownload} />
        ) : null}
      </div>
    </li>
  )
}

export function RfiThreadSheet({
  rfi,
  open,
  onOpenChange,
  token,
  companyId,
  canRespond,
  canDownload,
  onChanged,
}: RfiThreadSheetProps) {
  const [thread, setThread] = useState<RfiThread | null>(null)
  const [loading, setLoading] = useState(false)
  const [body, setBody] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const rfiId = rfi?.id ?? null

  const loadThread = useCallback(async () => {
    if (!rfiId) return
    setLoading(true)
    const result = await loadSubPortalRfiThreadAction(token, rfiId)
    if (result.success) {
      setThread(result.data)
      setError(null)
    } else {
      setThread(null)
      setError(result.error)
    }
    setLoading(false)
  }, [rfiId, token])

  useEffect(() => {
    if (!open || !rfiId) return
    setThread(null)
    setBody("")
    setFile(null)
    setError(null)
    void loadThread()
  }, [open, rfiId, loadThread])

  if (!rfi) return null

  const bucket = subRfiBucket(rfi, companyId)
  const owesAnswer = bucket === "needs-you"
  const readOnly = bucket === "closed" || !canRespond

  const send = (responseType: "answer" | "comment") => {
    if (!body.trim()) return
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.append("rfi_id", rfi.id)
      formData.append("body", body.trim())
      formData.append("response_type", responseType)
      if (file) formData.append("file", file)

      const result = await addSubPortalRfiResponseAction(token, formData)
      if (!result.success) {
        setError(result.error)
        return
      }
      setBody("")
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
      onChanged()

      if (responseType === "answer") {
        // The question is off their plate — keeping the thread open would just
        // show a composer they can no longer use.
        toast.success("Answer sent to the builder")
        onOpenChange(false)
        return
      }

      toast.success("Message sent")
      await loadThread()
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="gap-1.5 border-b border-border px-6 py-5 pr-14">
          <p className="font-mono text-xs tracking-wide text-muted-foreground">
            RFI {rfi.display_number ?? rfi.rfi_number}
          </p>
          <SheetTitle className="text-base leading-snug">{rfi.subject}</SheetTitle>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <RfiStateBadge rfi={rfi} companyId={companyId} />
            <RfiPriorityBadge priority={rfi.priority} />
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-border px-6 py-4">
            {rfi.due_date ? (
              <MetaRow label="Needed by" value={formatLocalDate(rfi.due_date, "MMM d, yyyy")} />
            ) : null}
            {rfi.location ? <MetaRow label="Location" value={rfi.location} /> : null}
            {rfi.drawing_reference ? (
              <MetaRow label="Drawing" value={rfi.drawing_reference} />
            ) : null}
            {rfi.spec_reference ? <MetaRow label="Spec" value={rfi.spec_reference} /> : null}
            <MetaRow
              label="Asked"
              value={formatLocalDate(rfi.submitted_at ?? rfi.created_at, "MMM d, yyyy")}
            />
          </dl>

          <section className="border-b border-border px-6 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Question
            </p>
            <p className="mt-2 whitespace-pre-line text-sm">{rfi.question}</p>
            {thread?.attachment ? (
              <AttachmentLink
                attachment={thread.attachment}
                token={token}
                canDownload={canDownload}
              />
            ) : null}
          </section>

          <section className="px-6 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Conversation
            </p>

            {loading ? (
              <div className="mt-4 space-y-4">
                {[0, 1].map((row) => (
                  <div key={row} className="flex gap-3">
                    <Skeleton className="size-7 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3.5 w-full" />
                      <Skeleton className="h-3.5 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : error && !thread ? (
              <p className="mt-3 text-sm text-destructive">{error}</p>
            ) : thread && thread.messages.length > 0 ? (
              <ul className="mt-4 space-y-5">
                {thread.messages.map((message) => (
                  <ThreadMessage
                    key={message.id}
                    message={message}
                    token={token}
                    canDownload={canDownload}
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Nothing yet. {owesAnswer ? "Your reply starts the thread." : "No replies so far."}
              </p>
            )}
          </section>
        </div>

        {readOnly ? (
          <div className="flex items-center gap-2 border-t border-border px-6 py-4 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" />
            {bucket === "closed"
              ? "This RFI is closed. Ask a new question if something changed."
              : "Your access to this project is read-only."}
          </div>
        ) : (
          <div className="border-t border-border px-6 py-4">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={owesAnswer ? "Write your answer…" : "Add a message…"}
              rows={3}
              disabled={isPending}
            />

            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />

            {file ? (
              <div className="mt-2 flex items-center justify-between gap-3 border border-border bg-muted/40 px-3 py-2">
                <span className="min-w-0 truncate text-sm">{file.name}</span>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatFileSize(file.size)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => {
                      setFile(null)
                      if (fileInputRef.current) fileInputRef.current.value = ""
                    }}
                  >
                    <X className="size-4" />
                    <span className="sr-only">Remove attachment</span>
                  </Button>
                </div>
              </div>
            ) : null}

            {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}

            <div className="mt-3 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPending}
              >
                <Paperclip className="size-4" />
                Attach
              </Button>

              <div className="flex items-center gap-2">
                {owesAnswer ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => send("comment")}
                    disabled={isPending || !body.trim()}
                  >
                    Comment
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => send(owesAnswer ? "answer" : "comment")}
                  disabled={isPending || !body.trim()}
                >
                  {isPending ? <Spinner className="size-4" /> : <Send className="size-4" />}
                  {owesAnswer ? "Submit answer" : "Send"}
                </Button>
              </div>
            </div>

            {owesAnswer ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Submitting an answer marks this RFI answered and hands it back to the builder.
                Use Comment to ask something back first.
              </p>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

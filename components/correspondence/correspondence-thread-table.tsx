"use client"

import Link from "next/link"

import { linkedEntityHref, linkedEntityLabel } from "@/lib/correspondence"
import type { CorrespondenceMessage, CorrespondenceThread } from "@/lib/services/correspondence"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Paperclip } from "@/components/icons"
import {
  ClassificationBadge,
  DirectionIcon,
  formatDate,
  formatTimestamp,
} from "@/components/correspondence/correspondence-shared"
import { cn } from "@/lib/utils"

function SelectCell({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    // The row is a link target; the checkbox is a separate control inside it, so
    // its events must not reach the row.
    <div
      className="flex items-center"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} aria-label={label} />
    </div>
  )
}

export function CorrespondenceThreadTable({
  threads,
  selected,
  canWrite,
  onToggle,
  onToggleAll,
  onOpen,
  emptyMessage,
}: {
  threads: CorrespondenceThread[]
  selected: Set<string>
  canWrite: boolean
  onToggle: (threadId: string, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  onOpen: (threadId: string) => void
  emptyMessage: string
}) {
  const allSelected = threads.length > 0 && threads.every((thread) => selected.has(thread.thread_id))

  return (
    <div className="overflow-hidden border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {canWrite && (
              <TableHead className="w-10">
                <SelectCell
                  checked={allSelected}
                  label="Select every conversation on this page"
                  onCheckedChange={onToggleAll}
                />
              </TableHead>
            )}
            <TableHead>Conversation</TableHead>
            <TableHead className="w-56">Correspondent</TableHead>
            <TableHead className="w-64">Classification</TableHead>
            <TableHead className="w-32 text-right">Last</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {threads.map((thread) => (
            <TableRow
              key={thread.thread_id}
              tabIndex={0}
              className={cn("cursor-pointer", selected.has(thread.thread_id) && "bg-muted/40")}
              aria-label={thread.subject}
              onClick={() => onOpen(thread.thread_id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onOpen(thread.thread_id)
                }
              }}
            >
              {canWrite && (
                <TableCell>
                  <SelectCell
                    checked={selected.has(thread.thread_id)}
                    label={`Select ${thread.subject}`}
                    onCheckedChange={(checked) => onToggle(thread.thread_id, checked)}
                  />
                </TableCell>
              )}
              <TableCell>
                <div className="flex items-start gap-2">
                  <span className="mt-1">
                    <DirectionIcon direction={thread.last_direction} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{thread.subject}</p>
                      {thread.message_count > 1 && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {thread.message_count}
                        </span>
                      )}
                    </div>
                    {thread.snippet && (
                      <p className="truncate text-xs text-muted-foreground">{thread.snippet}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {thread.link_count > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {thread.link_count} linked {thread.link_count === 1 ? "record" : "records"}
                        </span>
                      )}
                      {thread.attachment_count > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Paperclip className="size-3" />
                          {thread.attachment_count}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className="min-w-0">
                  {thread.counterparty_contact_id || thread.counterparty_company_id ? (
                    <Link
                      href={`/directory/${thread.counterparty_contact_id ?? thread.counterparty_company_id}`}
                      onClick={(event) => event.stopPropagation()}
                      className="block truncate underline-offset-4 hover:underline"
                    >
                      {thread.counterparty_name}
                    </Link>
                  ) : (
                    <p className="truncate">{thread.counterparty_name}</p>
                  )}
                  <p className="truncate text-xs text-muted-foreground">{thread.counterparty_address}</p>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  {thread.classifications.map((classification) => (
                    <ClassificationBadge key={classification} classification={classification} />
                  ))}
                  {thread.unreviewed_count > 0 && (
                    <span className="text-xs text-warning">
                      {thread.unreviewed_count} to review
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell
                className="whitespace-nowrap text-right tabular-nums text-muted-foreground"
                title={formatTimestamp(thread.last_message_at)}
              >
                {formatDate(thread.last_message_at)}
              </TableCell>
            </TableRow>
          ))}
          {threads.length === 0 && (
            <TableRow>
              <TableCell colSpan={canWrite ? 5 : 4} className="h-32 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

/** Unfiled mail, listed as messages — an archived thread is not a conversation. */
export function ArchivedCorrespondenceTable({
  projectId,
  messages,
  selected,
  canWrite,
  onToggle,
  onOpen,
}: {
  projectId: string
  messages: CorrespondenceMessage[]
  selected: Set<string>
  canWrite: boolean
  onToggle: (emailId: string, checked: boolean) => void
  onOpen: (emailId: string) => void
}) {
  return (
    <div className="overflow-hidden border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {canWrite && <TableHead className="w-10" />}
            <TableHead>Subject</TableHead>
            <TableHead className="w-56">From</TableHead>
            <TableHead className="w-56">Linked</TableHead>
            <TableHead className="w-32 text-right">Unfiled</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {messages.map((message) => (
            <TableRow
              key={message.id}
              tabIndex={0}
              className="cursor-pointer"
              onClick={() => onOpen(message.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onOpen(message.id)
                }
              }}
            >
              {canWrite && (
                <TableCell>
                  <SelectCell
                    checked={selected.has(message.id)}
                    label={`Select ${message.subject}`}
                    onCheckedChange={(checked) => onToggle(message.id, checked)}
                  />
                </TableCell>
              )}
              <TableCell>
                <p className="truncate font-medium">{message.subject}</p>
                {message.body_preview && (
                  <p className="truncate text-xs text-muted-foreground">{message.body_preview}</p>
                )}
              </TableCell>
              <TableCell className="truncate text-muted-foreground">{message.from_address}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-2">
                  {message.links.map((link) => {
                    const href = linkedEntityHref(projectId, link.entity_type, link.entity_id)
                    return href ? (
                      <Link
                        key={link.id}
                        href={href}
                        onClick={(event) => event.stopPropagation()}
                        className="text-xs text-muted-foreground underline underline-offset-4"
                      >
                        {linkedEntityLabel(link.entity_type)}
                      </Link>
                    ) : null
                  })}
                </div>
              </TableCell>
              <TableCell
                className="whitespace-nowrap text-right tabular-nums text-muted-foreground"
                title={formatTimestamp(message.archived_at)}
              >
                {formatDate(message.archived_at)}
              </TableCell>
            </TableRow>
          ))}
          {messages.length === 0 && (
            <TableRow>
              <TableCell colSpan={canWrite ? 5 : 4} className="h-32 text-center text-muted-foreground">
                Nothing has been unfiled from this project.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

"use client"

import Link from "next/link"

import type { CorrespondenceListItem, CorrespondenceListPage } from "@/lib/services/correspondence"
import type { CorrespondenceFilterInput } from "@/lib/validation/correspondence"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Paperclip, Search } from "@/components/icons"
import {
  ClassificationBadge,
  DirectionIcon,
  formatDate,
  formatTimestamp,
} from "@/components/correspondence/correspondence-shared"
import { cn } from "@/lib/utils"

/**
 * The log, as one dense full-bleed table.
 *
 * Filed mail is a row per conversation and unfiled mail a row per loose
 * message, but the reader is scanning one list either way — the service already
 * flattened both into `CorrespondenceListItem`, so there is one row shape and
 * no tab bar above it.
 */
export function CorrespondenceTable({
  filters,
  list,
  openId,
  selected,
  canWrite,
  onOpen,
  onToggle,
  onToggleAll,
}: {
  filters: CorrespondenceFilterInput
  list: CorrespondenceListPage
  openId: string | null
  selected: Set<string>
  canWrite: boolean
  onOpen: (item: CorrespondenceListItem) => void
  onToggle: (item: CorrespondenceListItem, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
}) {
  const allSelected = list.items.length > 0 && list.items.every((item) => selected.has(item.id))

  if (list.items.length === 0) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>No matches</EmptyTitle>
            <EmptyDescription>
              {filters.status === "unfiled"
                ? "Nothing has been unfiled from this project."
                : "Nothing in the log fits these filters."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    // table-fixed is load-bearing: under auto layout the subject and snippet
    // set the column's width, so a long forwarded header pushed every other
    // column off the right edge instead of truncating.
    //
    // The scroll goes on the table's own container so the header has something
    // to stick to — see the note on `containerClassName`.
    <Table className="table-fixed" containerClassName="h-full overflow-auto">
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          {canWrite && (
            <TableHead className="w-10">
              {/* The header cell is a control, so its own click must not reach
                  the sort/scroll surface behind it. */}
              <span
                className="flex items-center"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(value) => onToggleAll(value === true)}
                  aria-label="Select everything on this page"
                />
              </span>
            </TableHead>
          )}
          <TableHead>Conversation</TableHead>
          {/* Narrow screens drop the two widest columns and fold what they say
              into the conversation cell — table-fixed would otherwise squeeze
              five columns into 375px and overlap the headings. */}
          <TableHead className="hidden w-56 md:table-cell">Correspondent</TableHead>
          <TableHead className="hidden w-56 lg:table-cell">Classification</TableHead>
          <TableHead className="w-28 text-right md:w-32">
            {filters.status === "unfiled" ? "Unfiled" : "Last"}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.items.map((item) => (
          <TableRow
            key={item.id}
            tabIndex={0}
            aria-label={item.subject}
            aria-current={item.id === openId ? "true" : undefined}
            className={cn("cursor-pointer", item.id === openId && "bg-accent/60")}
            onClick={() => onOpen(item)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onOpen(item)
              }
            }}
          >
            {canWrite && (
              <TableCell>
                <span
                  className="flex items-center"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Checkbox
                    checked={selected.has(item.id)}
                    onCheckedChange={(value) => onToggle(item, value === true)}
                    aria-label={`Select ${item.subject}`}
                  />
                </span>
              </TableCell>
            )}

            <TableCell>
              <div className="flex items-start gap-2">
                <DirectionIcon direction={item.direction} className="mt-1" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{item.subject}</p>
                    {item.message_count > 1 && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {item.message_count}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground md:hidden">
                    {item.counterparty_name}
                  </p>
                  {item.snippet && <p className="truncate text-xs text-muted-foreground">{item.snippet}</p>}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="flex flex-wrap items-center gap-1.5 lg:hidden">
                      {item.classifications.map((classification) => (
                        <ClassificationBadge key={classification} classification={classification} />
                      ))}
                      {item.unreviewed_count > 0 && (
                        <span className="text-xs text-warning">{item.unreviewed_count} to review</span>
                      )}
                    </span>
                    {item.link_count > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {item.link_count} linked {item.link_count === 1 ? "record" : "records"}
                      </span>
                    )}
                    {item.attachment_count > 0 && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Paperclip className="size-3" />
                        {item.attachment_count}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </TableCell>

            <TableCell className="hidden md:table-cell">
              <div className="min-w-0">
                {item.counterparty_contact_id || item.counterparty_company_id ? (
                  <Link
                    href={`/directory/${item.counterparty_contact_id ?? item.counterparty_company_id}`}
                    onClick={(event) => event.stopPropagation()}
                    className="block truncate underline-offset-4 hover:underline"
                  >
                    {item.counterparty_name}
                  </Link>
                ) : (
                  <p className="truncate">{item.counterparty_name}</p>
                )}
                <p className="truncate text-xs text-muted-foreground">{item.counterparty_address}</p>
              </div>
            </TableCell>

            <TableCell className="hidden lg:table-cell">
              <div className="flex flex-wrap items-center gap-1.5">
                {item.classifications.map((classification) => (
                  <ClassificationBadge key={classification} classification={classification} />
                ))}
                {item.unreviewed_count > 0 && (
                  <span className="text-xs text-warning">{item.unreviewed_count} to review</span>
                )}
              </div>
            </TableCell>

            <TableCell
              className="whitespace-nowrap text-right tabular-nums text-muted-foreground"
              title={formatTimestamp(item.occurred_at)}
            >
              {formatDate(item.occurred_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

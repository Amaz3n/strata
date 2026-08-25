"use client"

import { useEffect, useState } from "react"
import type { DateRange } from "react-day-picker"

import {
  CLASSIFICATION_LABELS,
  CORRESPONDENCE_CLASSIFICATIONS,
} from "@/lib/correspondence"
import type { CorrespondenceFilterInput } from "@/lib/validation/correspondence"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Search } from "@/components/icons"
import { cn } from "@/lib/utils"

export type FilterChanges = Record<string, string | null>

function toDate(value: string | undefined) {
  if (!value) return undefined
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function toIsoDate(value: Date | undefined) {
  if (!value) return null
  const offset = value.getTimezoneOffset() * 60_000
  return new Date(value.getTime() - offset).toISOString().slice(0, 10)
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className={cn("h-9", active && "border-foreground/30 bg-secondary text-secondary-foreground")}
    >
      {children}
    </Button>
  )
}

export function CorrespondenceFilters({
  filters,
  showArchived,
  pending,
  reviewCount,
  onChange,
}: {
  filters: CorrespondenceFilterInput
  showArchived: boolean
  /** True while the server is producing the filtered page. */
  pending: boolean
  reviewCount: number
  onChange: (changes: FilterChanges) => void
}) {
  const [searchDraft, setSearchDraft] = useState(filters.search ?? "")
  useEffect(() => setSearchDraft(filters.search ?? ""), [filters.search])

  const range: DateRange | undefined = filters.from || filters.to
    ? { from: toDate(filters.from), to: toDate(filters.to) }
    : undefined

  const filtersActive =
    Boolean(filters.search) ||
    Boolean(filters.classification) ||
    Boolean(filters.direction) ||
    Boolean(filters.linked) ||
    Boolean(filters.from) ||
    Boolean(filters.to) ||
    filters.needsReview === true ||
    filters.hasAttachments === true

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault()
            onChange({ q: searchDraft.trim() || null, page: null })
          }}
        >
          {pending ? (
            <Loader2 className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          )}
          <Input
            name="q"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search subject, people, message text…"
            aria-label="Search correspondence"
            className="w-72 pl-8"
          />
        </form>

        {!showArchived && (
          <>
            <Select
              value={filters.classification ?? "all"}
              onValueChange={(value) => onChange({ classification: value === "all" ? null : value, page: null })}
            >
              <SelectTrigger className="w-44" aria-label="Classification">
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

            <Select
              value={filters.direction ?? "all"}
              onValueChange={(value) => onChange({ direction: value === "all" ? null : value, page: null })}
            >
              <SelectTrigger className="w-32" aria-label="Direction">
                <SelectValue placeholder="All mail" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All mail</SelectItem>
                <SelectItem value="inbound">Received</SelectItem>
                <SelectItem value="outbound">Sent</SelectItem>
              </SelectContent>
            </Select>

            <div className="w-56">
              <DateRangePicker
                dateRange={range}
                placeholder="Any date"
                onDateRangeChange={(next) =>
                  onChange({ from: toIsoDate(next?.from), to: toIsoDate(next?.to), page: null })
                }
              />
            </div>
          </>
        )}
      </div>

      {!showArchived && (
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            active={filters.needsReview === true}
            onClick={() => onChange({ review: filters.needsReview ? null : "1", page: null })}
          >
            Needs review
            {reviewCount > 0 && <span className="ml-1.5 tabular-nums text-warning">{reviewCount}</span>}
          </Chip>
          <Chip
            active={filters.hasAttachments === true}
            onClick={() => onChange({ attachments: filters.hasAttachments ? null : "1", page: null })}
          >
            Has attachments
          </Chip>
          <Chip
            active={filters.linked === "linked"}
            onClick={() => onChange({ linked: filters.linked === "linked" ? null : "linked", page: null })}
          >
            Linked
          </Chip>
          <Chip
            active={filters.linked === "unlinked"}
            onClick={() => onChange({ linked: filters.linked === "unlinked" ? null : "unlinked", page: null })}
          >
            Not linked
          </Chip>
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange({
                  q: null,
                  classification: null,
                  direction: null,
                  review: null,
                  attachments: null,
                  linked: null,
                  from: null,
                  to: null,
                  page: null,
                })
              }
            >
              Clear
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

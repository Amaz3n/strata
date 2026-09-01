"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { DateRange } from "react-day-picker"

import { CLASSIFICATION_LABELS, CORRESPONDENCE_CLASSIFICATIONS } from "@/lib/correspondence"
import type { CorrespondenceFilterInput } from "@/lib/validation/correspondence"
import { Button } from "@/components/ui/button"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { SlidersHorizontal } from "@/components/icons"
import {
  activeFilterCount,
  correspondenceFilterHref,
  type CorrespondenceUrlChanges,
} from "@/components/correspondence/correspondence-url"
import { cn } from "@/lib/utils"

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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="text-sm font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

/**
 * Every filter the log has, behind one control.
 *
 * The page used to wear its filters: two selects, a date range and four chips
 * strung across the top, plus a tab bar for the unfiled pile. That is a lot of
 * chrome to look past on a screen whose job is reading mail, and the tabs made
 * two views of one corpus look like two features. Here the pile is just the
 * first filter in the list.
 */
export function CorrespondenceFilterMenu({
  projectId,
  filters,
}: {
  projectId: string
  filters: CorrespondenceFilterInput
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const unfiled = filters.status === "unfiled"
  const count = unfiled ? 0 : activeFilterCount(filters)

  const apply = (changes: CorrespondenceUrlChanges) => {
    router.push(correspondenceFilterHref(projectId, filters, changes), { scroll: false })
  }

  const range: DateRange | undefined =
    filters.from || filters.to ? { from: toDate(filters.from), to: toDate(filters.to) } : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn((count > 0 || unfiled) && "border-foreground/30 bg-secondary")}
        >
          <SlidersHorizontal className="size-4" />
          Filters
          {count > 0 && <span className="tabular-nums text-muted-foreground">{count}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="space-y-3 p-3">
          <Row label="Show">
            <Select
              value={filters.status}
              onValueChange={(value) => apply({ view: value === "unfiled" ? "unfiled" : null })}
            >
              <SelectTrigger className="w-44" aria-label="Which mail to show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="filed">Filed mail</SelectItem>
                <SelectItem value="unfiled">Unfiled mail</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </div>

        {unfiled ? (
          <>
            <Separator />
            <p className="p-3 text-xs text-muted-foreground">
              Mail taken out of the log. Search is the only filter that applies here — everything else
              describes a conversation, and these are loose messages.
            </p>
          </>
        ) : (
          <>
            <Separator />
            <div className="space-y-3 p-3">
              <Row label="Classification">
                <Select
                  value={filters.classification ?? "all"}
                  onValueChange={(value) => apply({ classification: value === "all" ? null : value })}
                >
                  <SelectTrigger className="w-44" aria-label="Classification">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any</SelectItem>
                    {CORRESPONDENCE_CLASSIFICATIONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {CLASSIFICATION_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>

              <Row label="Direction">
                <Select
                  value={filters.direction ?? "all"}
                  onValueChange={(value) => apply({ direction: value === "all" ? null : value })}
                >
                  <SelectTrigger className="w-44" aria-label="Direction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any</SelectItem>
                    <SelectItem value="inbound">Received</SelectItem>
                    <SelectItem value="outbound">Sent</SelectItem>
                  </SelectContent>
                </Select>
              </Row>

              <Row label="Linked">
                <Select
                  value={filters.linked ?? "all"}
                  onValueChange={(value) => apply({ linked: value === "all" ? null : value })}
                >
                  <SelectTrigger className="w-44" aria-label="Linked records">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any</SelectItem>
                    <SelectItem value="linked">Linked to a record</SelectItem>
                    <SelectItem value="unlinked">Not linked</SelectItem>
                  </SelectContent>
                </Select>
              </Row>

              <Row label="Last message">
                <div className="w-44">
                  <DateRangePicker
                    dateRange={range}
                    placeholder="Any date"
                    onDateRangeChange={(next) =>
                      apply({ from: toIsoDate(next?.from), to: toIsoDate(next?.to) })
                    }
                  />
                </div>
              </Row>
            </div>

            <Separator />
            <div className="space-y-3 p-3">
              <Row label="Needs review">
                <Switch
                  checked={filters.needsReview === true}
                  aria-label="Only conversations nobody has ruled on"
                  onCheckedChange={(checked) => apply({ review: checked ? "1" : null })}
                />
              </Row>
              <Row label="Has attachments">
                <Switch
                  checked={filters.hasAttachments === true}
                  aria-label="Only conversations carrying attachments"
                  onCheckedChange={(checked) => apply({ attachments: checked ? "1" : null })}
                />
              </Row>
            </div>
          </>
        )}

        {(count > 0 || unfiled) && (
          <>
            <Separator />
            <div className="p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false)
                  apply({
                    view: null,
                    classification: null,
                    direction: null,
                    review: null,
                    attachments: null,
                    linked: null,
                    from: null,
                    to: null,
                  })
                }}
              >
                Reset filters
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

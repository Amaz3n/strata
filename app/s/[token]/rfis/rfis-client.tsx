"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, CircleCheck, Clock, MessageSquareText } from "lucide-react"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemGroup, ItemSeparator } from "@/components/ui/item"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isSubRfiAuthor, isSubRfiOverdue, subRfiBucket, type SubRfiBucket } from "@/lib/portal/rfi-buckets"
import type { Rfi } from "@/lib/types"
import { cn, formatLocalDate } from "@/lib/utils"
import { RfiStateBadge } from "./rfi-status"
import { RfiThreadSheet } from "./rfi-thread-sheet"

interface RfisPortalClientProps {
  rfis: Rfi[]
  token: string
  companyId: string | null
  canRespond: boolean
  canDownload: boolean
  /** The link opens exactly one RFI, so the tabs would be noise. */
  scoped: boolean
}

const BUCKET_ORDER: SubRfiBucket[] = ["needs-you", "waiting", "closed"]

const BUCKET_LABELS: Record<SubRfiBucket, string> = {
  "needs-you": "Needs you",
  waiting: "Waiting",
  closed: "Closed",
}

const EMPTY_COPY: Record<SubRfiBucket, { icon: typeof Clock; title: string; description: string }> = {
  "needs-you": {
    icon: CircleCheck,
    title: "Nothing waiting on you",
    description: "Questions the builder puts to your company land here.",
  },
  waiting: {
    icon: Clock,
    title: "Nothing with the builder",
    description: "Questions you ask stay here until the builder answers them.",
  },
  closed: {
    icon: MessageSquareText,
    title: "No closed RFIs yet",
    description: "Answered and closed questions are kept here for the record.",
  },
}

function RfiRow({
  rfi,
  companyId,
  onOpen,
}: {
  rfi: Rfi
  companyId: string | null
  onOpen: (rfi: Rfi) => void
}) {
  const overdue = isSubRfiOverdue(rfi, companyId)
  const mine = isSubRfiAuthor(rfi, companyId)
  const number = rfi.display_number ?? `#${rfi.rfi_number}`

  return (
    <Item
      size="sm"
      className="relative items-start gap-3 py-3.5 transition-colors focus-within:bg-accent/40 hover:bg-accent/40"
    >
      <ItemContent className="min-w-0 gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {number}
          </span>
          <span className="min-w-0 truncate text-sm font-medium">{rfi.subject}</span>
        </div>

        <p className="line-clamp-1 text-sm text-muted-foreground">{rfi.question}</p>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <RfiStateBadge rfi={rfi} companyId={companyId} />
          {rfi.due_date ? (
            <span className={cn("tabular-nums", overdue && "font-medium text-destructive")}>
              {overdue ? "Was due " : "Due "}
              {formatLocalDate(rfi.due_date, "MMM d")}
            </span>
          ) : null}
          <span>{mine ? "You asked" : "From the builder"}</span>
        </div>
      </ItemContent>

      <ItemActions className="shrink-0 items-start">
        <ChevronRight className="mt-0.5 size-4 text-muted-foreground" />
      </ItemActions>

      {/* Overlay keeps the whole row clickable without nesting block content
          inside a button, which browsers render but the spec forbids. */}
      <button
        type="button"
        onClick={() => onOpen(rfi)}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="sr-only">Open RFI {number}</span>
      </button>
    </Item>
  )
}

function RfiRows({
  rfis,
  companyId,
  onOpen,
}: {
  rfis: Rfi[]
  companyId: string | null
  onOpen: (rfi: Rfi) => void
}) {
  return (
    <ItemGroup className="border border-border bg-card">
      {rfis.map((rfi, index) => (
        <div key={rfi.id}>
          {index > 0 ? <ItemSeparator /> : null}
          <RfiRow rfi={rfi} companyId={companyId} onOpen={onOpen} />
        </div>
      ))}
    </ItemGroup>
  )
}

function BucketEmpty({ bucket }: { bucket: SubRfiBucket }) {
  const copy = EMPTY_COPY[bucket]
  const Icon = copy.icon
  return (
    <Empty className="border border-dashed border-border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export function RfisPortalClient({
  rfis,
  token,
  companyId,
  canRespond,
  canDownload,
  scoped,
}: RfisPortalClientProps) {
  const router = useRouter()
  // The id, not the row — `router.refresh()` hands back new objects, and the
  // sheet has to follow the RFI as it changes state, not the copy it opened on.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const selected = rfis.find((rfi) => rfi.id === selectedId) ?? null

  const buckets = useMemo(() => {
    const grouped: Record<SubRfiBucket, Rfi[]> = { "needs-you": [], waiting: [], closed: [] }
    for (const rfi of rfis) grouped[subRfiBucket(rfi, companyId)].push(rfi)
    // Soonest deadline first inside each bucket — an RFI without a date is
    // never more urgent than one with one.
    for (const bucket of BUCKET_ORDER) {
      grouped[bucket].sort((a, b) => {
        if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date)
        if (a.due_date) return -1
        if (b.due_date) return 1
        return b.created_at.localeCompare(a.created_at)
      })
    }
    return grouped
  }, [rfis, companyId])

  const [tab, setTab] = useState<SubRfiBucket>(
    () => BUCKET_ORDER.find((bucket) => buckets[bucket].length > 0) ?? "needs-you",
  )

  const openRfi = (rfi: Rfi) => {
    setSelectedId(rfi.id)
    setSheetOpen(true)
  }

  const sheet = (
    <RfiThreadSheet
      rfi={selected}
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      token={token}
      companyId={companyId}
      canRespond={canRespond}
      canDownload={canDownload}
      onChanged={() => router.refresh()}
    />
  )

  if (rfis.length === 0) {
    return (
      <Empty className="border border-dashed border-border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareText />
          </EmptyMedia>
          <EmptyTitle>No RFIs on this project yet</EmptyTitle>
          <EmptyDescription>
            {canRespond
              ? "When the builder sends you a question it shows up here — and you can ask them one at any time."
              : "Questions the builder sends your company will show up here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  // A scoped link resolves to a single RFI, so the tab row would be three
  // headings over one row.
  if (scoped) {
    return (
      <>
        <RfiRows rfis={rfis} companyId={companyId} onOpen={openRfi} />
        {sheet}
      </>
    )
  }

  return (
    <>
      <Tabs value={tab} onValueChange={(value) => setTab(value as SubRfiBucket)}>
        <TabsList className="w-full sm:w-auto">
          {BUCKET_ORDER.map((bucket) => (
            <TabsTrigger key={bucket} value={bucket} className="flex-1 sm:flex-none">
              {BUCKET_LABELS[bucket]}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {buckets[bucket].length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        {BUCKET_ORDER.map((bucket) => (
          <TabsContent key={bucket} value={bucket} className="mt-4">
            {buckets[bucket].length === 0 ? (
              <BucketEmpty bucket={bucket} />
            ) : (
              <RfiRows rfis={buckets[bucket]} companyId={companyId} onOpen={openRfi} />
            )}
          </TabsContent>
        ))}
      </Tabs>
      {sheet}
    </>
  )
}

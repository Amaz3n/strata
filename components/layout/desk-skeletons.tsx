import { Skeleton } from "@/components/ui/skeleton"

/**
 * Loading shapes for the org desks, one per desk, each following the real
 * page's header band and body so nothing jumps when data lands. They render
 * inside the desk's content region (the route's `loading.tsx` or the page's own
 * Suspense fallback) and never replace the shared app chrome.
 */

function DeskStatus({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label={`Loading ${label}`}>
      {children}
    </div>
  )
}

function TableSkeleton({ columns, rows }: { columns: string; rows: number }) {
  const cells = columns.split("_").length
  return (
    <>
      <div className="grid items-center gap-4 border-b px-4 py-2" style={{ gridTemplateColumns: columns.replaceAll("_", " ") }}>
        {Array.from({ length: cells }, (_, index) => (
          <Skeleton key={index} className="h-3 w-16" />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="grid items-center gap-4 px-4 py-3" style={{ gridTemplateColumns: columns.replaceAll("_", " ") }}>
            {Array.from({ length: cells }, (__, cell) => (
              <Skeleton key={cell} className={cell === 0 ? "h-4 w-4/5" : "h-4 w-3/5"} />
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

/** Starts: scope bar, then the launch lane's week columns of house cards. */
export function StartsSkeleton() {
  return (
    <DeskStatus label="starts">
      <div className="flex items-center justify-between gap-5 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-16" />
        </div>
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="flex min-h-0 flex-1">
        {Array.from({ length: 5 }, (_, column) => (
          <div key={column} className="flex min-w-0 flex-1 flex-col border-r last:border-r-0">
            <div className="space-y-2 border-b px-2.5 py-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="flex flex-col gap-1.5 p-2">
              {Array.from({ length: column % 2 === 0 ? 4 : 3 }, (__, card) => (
                <Skeleton key={card} className="h-14 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </DeskStatus>
  )
}

/** Design Studio: four counters, then the group-by-bucket matrix. */
export function DesignStudioSkeleton() {
  return (
    <DeskStatus label="design studio">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="grid grid-cols-2 border-b lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2 border-r px-4 py-3 last:border-r-0">
            <Skeleton className="h-7 w-10" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[200px_repeat(5,minmax(0,1fr))] border-b">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="px-3 py-2">
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      {Array.from({ length: 5 }, (_, row) => (
        <div key={row} className="grid grid-cols-[200px_repeat(5,minmax(0,1fr))] border-b">
          <div className="space-y-1.5 px-3 py-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          {Array.from({ length: 5 }, (__, cell) => (
            <div key={cell} className="space-y-1.5 border-l p-2">
              <Skeleton className="h-9 w-full" />
              {(row + cell) % 2 === 0 ? <Skeleton className="h-9 w-full" /> : null}
            </div>
          ))}
        </div>
      ))}
    </DeskStatus>
  )
}

/** Purchasing: health stats, the tab strip, a section header, then the agreements table. */
export function PurchasingSkeleton() {
  return (
    <DeskStatus label="purchasing">
      <div className="grid border-b bg-muted/20 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="space-y-2 border-b px-4 py-3 sm:border-b-0 sm:border-r">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-6 w-12" />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4 border-b px-4 py-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-5 w-24" />
        ))}
      </div>
      <div className="flex min-h-14 items-center justify-between border-b px-4 py-2">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>
      <TableSkeleton columns="1.2fr_1fr_1.4fr_.7fr_.7fr_1fr_.6fr_.6fr" rows={10} />
    </DeskStatus>
  )
}

/** Schedule: scope filters, the label column plus timeline header, then project rows with bars. */
export function ScheduleSkeleton() {
  return (
    <DeskStatus label="schedule">
      <div className="flex items-center justify-between border-b px-4 py-2.5 sm:px-6">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-7 w-48" />
      </div>
      <div className="grid grid-cols-[300px_minmax(0,1fr)] border-b">
        <div className="flex h-[46px] items-center px-4">
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="flex h-[46px] items-center gap-10 border-l px-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-3 w-14" />
          ))}
        </div>
      </div>
      {Array.from({ length: 10 }, (_, row) => (
        <div key={row} className="grid h-[54px] grid-cols-[300px_minmax(0,1fr)] border-b">
          <div className="flex flex-col justify-center gap-1.5 px-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="flex items-center border-l px-4">
            <Skeleton className="h-[22px]" style={{ marginLeft: `${(row * 7) % 30}%`, width: `${28 + ((row * 11) % 40)}%` }} />
          </div>
        </div>
      ))}
    </DeskStatus>
  )
}

/** Tasks: the waiting-on-me band, then the task toolbar and list. */
export function TasksSkeleton() {
  return (
    <DeskStatus label="tasks">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-8 w-32" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <TableSkeleton columns="2.5rem_2.5fr_1fr_1fr_.8fr_.8fr" rows={12} />
    </DeskStatus>
  )
}

/** Reports: category rail on the left, search row and report cards on the right. */
export function ReportsSkeleton() {
  return (
    <DeskStatus label="reports">
      <div className="mx-auto grid w-full max-w-[1600px] flex-1 gap-8 px-5 py-5 sm:px-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:px-10">
        <div className="hidden space-y-2 lg:block">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
        <div className="space-y-5">
          <div className="flex items-center gap-3 border-b pb-4">
            <Skeleton className="h-8 flex-1" />
            <Skeleton className="h-8 w-28" />
          </div>
          <Skeleton className="h-6 w-40" />
          <div className="grid gap-3 xl:grid-cols-2">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-32 w-full" />
            ))}
          </div>
        </div>
      </div>
    </DeskStatus>
  )
}

/** Billing: scope bar, then the book's Up next and Open bands as dense rows. */
export function BillingSkeleton() {
  return (
    <DeskStatus label="billing">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-8 w-28" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="border-b px-4 py-2">
        <Skeleton className="h-3 w-24" />
      </div>
      <TableSkeleton columns="2fr_1.2fr_1fr_1fr_.8fr" rows={3} />
      <div className="border-b border-t px-4 py-2">
        <Skeleton className="h-3 w-16" />
      </div>
      <TableSkeleton columns="1fr_2fr_1fr_1fr_.8fr_.8fr" rows={8} />
    </DeskStatus>
  )
}

/** Bids: the 14-day strip, the filter row, then the banded package table. */
export function BidsSkeleton() {
  return (
    <DeskStatus label="bids">
      <div className="border-b px-4 py-3 sm:px-6">
        <Skeleton className="mb-2 h-3 w-24" />
        <div className="flex gap-1">
          {Array.from({ length: 14 }, (_, index) => (
            <Skeleton key={index} className="h-14 min-w-[64px] flex-1" />
          ))}
        </div>
      </div>
      <div className="border-b px-4 py-2.5 sm:px-6">
        <div className="grid gap-2 sm:grid-cols-[minmax(200px,1fr)_180px_180px]">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
      <TableSkeleton columns="2fr_1.4fr_1fr_.8fr_.8fr_.8fr" rows={10} />
    </DeskStatus>
  )
}

/** Warranty: the tab strip with its action, then the queue table. */
export function WarrantySkeleton() {
  return (
    <DeskStatus label="warranty">
      <div className="flex items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-1">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-20" />
          ))}
        </div>
        <Skeleton className="h-8 w-44" />
      </div>
      <div className="border">
        <TableSkeleton columns=".8fr_1.4fr_2fr_.8fr_.8fr_1.2fr_1.2fr_1fr_.8fr" rows={10} />
      </div>
    </DeskStatus>
  )
}

/** Plans: the filter row, then the plan ladder as thumbnail rows. */
export function PlansSkeleton() {
  return (
    <DeskStatus label="plans">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-12 w-16 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-72" />
            </div>
            <Skeleton className="hidden h-8 w-64 md:block" />
          </div>
        ))}
      </div>
    </DeskStatus>
  )
}

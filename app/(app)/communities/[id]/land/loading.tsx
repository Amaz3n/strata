import { CommunityEntitlementsSkeleton } from "@/components/communities/community-entitlements"
import { Skeleton } from "@/components/ui/skeleton"

/** The Land tab's shape: the runway, then phases, takedowns, entitlements and contracts as dense tables. */
function TableSkeleton({ label, rows }: { label: string; rows: number }) {
  return (
    <section>
      <div className="mb-3 space-y-1.5">
        <p className="microlabel">{label}</p>
        <Skeleton className="h-3 w-72" />
      </div>
      <div className="border">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="border-t px-2 py-2">
            <Skeleton className="h-5 w-full" />
          </div>
        ))}
      </div>
    </section>
  )
}

export default function CommunityLandLoading() {
  return (
    <div className="space-y-8 p-4" role="status" aria-label="Loading land" aria-busy="true">
      <Skeleton className="h-48 w-full" />
      <TableSkeleton label="Phases" rows={3} />
      <TableSkeleton label="Lot takedowns" rows={3} />
      <CommunityEntitlementsSkeleton />
      <TableSkeleton label="Land contracts" rows={2} />
    </div>
  )
}

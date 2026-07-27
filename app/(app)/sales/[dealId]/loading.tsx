import { Skeleton } from "@/components/ui/skeleton"

const BAND_X = "px-5 sm:px-8 lg:px-12"

/**
 * Mirrors the deal file's real shape — header, stage spine, work line, then the
 * log and the meta column — so nothing jumps when the data lands.
 */
export default function DealDetailLoading() {
  return (
    <div className="flex flex-col">
      <div className={`${BAND_X} flex items-center gap-4 border-b py-5`}>
        <Skeleton className="size-12 shrink-0 rounded-none" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-6 w-56 rounded-none" />
          <Skeleton className="h-3 w-64 rounded-none" />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Skeleton className="size-8 rounded-none" />
            <Skeleton className="h-8 w-36 rounded-none" />
          </div>
          <Skeleton className="hidden h-3 w-48 rounded-none sm:block" />
        </div>
      </div>

      <div className="flex divide-x border-b">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="flex-1">
            <Skeleton className="h-1 w-full rounded-none" />
            <div className="flex justify-center px-2 py-2">
              <Skeleton className="h-2.5 w-14 rounded-none" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2">
        <div className="border-b lg:border-b-0 lg:border-r">
          <div className={`${BAND_X} flex items-center justify-between gap-3 pt-10 pb-5`}>
            <div className="flex items-baseline gap-3">
              <Skeleton className="h-2.5 w-16 rounded-none" />
              <Skeleton className="h-2.5 w-32 rounded-none" />
            </div>
            <Skeleton className="h-7 w-28 rounded-none" />
          </div>
          <div className={`${BAND_X} space-y-7 pb-10`}>
            {[0, 1, 2].map((group) => (
              <div key={group}>
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="h-px w-4 shrink-0 bg-muted-foreground/30" />
                  <Skeleton className="h-2.5 w-20 rounded-none" />
                </div>
                <div className="space-y-1.5">
                  {Array.from({ length: 3 }).map((_, row) => (
                    <div key={row} className="flex items-center gap-3 py-2">
                      <Skeleton className="size-7 shrink-0 rounded-none" />
                      <Skeleton className="h-4 flex-1 rounded-none" />
                      <Skeleton className="h-3 w-12 shrink-0 rounded-none" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={`${BAND_X} space-y-9 py-10`}>
          <div>
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-2.5 w-32 rounded-none" />
              <Skeleton className="h-8 w-36 rounded-none" />
            </div>
            <div className="mt-4 space-y-1.5">
              {Array.from({ length: 3 }).map((_, row) => (
                <div key={row} className="flex items-center gap-3 py-2">
                  <Skeleton className="size-7 shrink-0 rounded-none" />
                  <Skeleton className="h-4 flex-1 rounded-none" />
                  <Skeleton className="h-3 w-16 shrink-0 rounded-none" />
                </div>
              ))}
            </div>
          </div>
          {[4, 6, 5].map((rows, block) => (
            <div key={block}>
              <Skeleton className="h-2.5 w-24 rounded-none" />
              <div className="mt-4 space-y-4">
                {Array.from({ length: rows }).map((_, row) => (
                  <Skeleton key={row} className="h-4 w-full rounded-none" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

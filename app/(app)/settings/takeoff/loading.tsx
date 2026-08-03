import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8">
      {Array.from({ length: 3 }).map((_, group) => (
        <div key={group} className="space-y-3">
          <Skeleton className="h-3 w-28 rounded-none" />
          {Array.from({ length: 4 }).map((_, row) => (
            <Skeleton key={row} className="h-12 w-full rounded-none" />
          ))}
        </div>
      ))}
    </div>
  )
}

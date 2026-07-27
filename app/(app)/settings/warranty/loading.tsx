import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8">
      {Array.from({ length: 2 }).map((_, group) => (
        <div key={group} className="space-y-3">
          <Skeleton className="h-3 w-32 rounded-none" />
          {Array.from({ length: 3 }).map((_, row) => (
            <Skeleton key={row} className="h-14 w-full rounded-none" />
          ))}
        </div>
      ))}
    </div>
  )
}

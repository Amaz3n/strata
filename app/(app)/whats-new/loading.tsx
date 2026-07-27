import { Skeleton } from "@/components/ui/skeleton"

export default function WhatsNewLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl pb-16">
      <div className="border-b border-border pb-5">
        <Skeleton className="h-4 w-80" />
      </div>

      <Skeleton className="mt-6 h-8 w-72" />

      <div className="mt-12 flex flex-col">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="grid gap-x-10 gap-y-4 border-t border-border py-10 first:border-t-0 first:pt-0 sm:grid-cols-[8rem_minmax(0,1fr)]"
          >
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="max-w-2xl space-y-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="mt-6 h-20 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

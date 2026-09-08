import { Skeleton } from "@/components/ui/skeleton"
export default function Loading() {
  return (
    <div className="space-y-4 p-6" aria-label="Loading waiver register">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  )
}

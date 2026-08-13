import { Skeleton } from "@/components/ui/skeleton"

export default function AuthRouteLoading() {
  return (
    <div className="mx-auto grid w-full max-w-sm gap-6" aria-busy="true">
      <div className="grid gap-2 text-center">
        <Skeleton className="mx-auto h-8 w-48" />
        <Skeleton className="mx-auto h-4 w-64" />
      </div>
      <div className="grid gap-4">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  )
}

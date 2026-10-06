import { Skeleton } from "@/components/ui/skeleton"

/** Stands in for an auth form while it loads: headline, subtitle, one field and the button. */
export function AuthFormSkeleton() {
  return (
    <div className="grid gap-7" aria-busy="true">
      <div className="grid gap-3">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="grid gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  )
}

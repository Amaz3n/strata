import { Skeleton } from "@/components/ui/skeleton"

export default function PlanDetailLoading() {
  return <div className="space-y-4 p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-10 w-96" />{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
}

import { Skeleton } from "@/components/ui/skeleton"

export default function PurchasingLoading() {
  return <div className="space-y-4 p-6"><Skeleton className="h-16 w-full rounded-none" /><Skeleton className="h-10 w-full rounded-none" /><Skeleton className="h-80 w-full rounded-none" /></div>
}

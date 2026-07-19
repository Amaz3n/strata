import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() { return <div className="space-y-3 p-6">{Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="h-16 w-full rounded-none" />)}</div> }

import { Skeleton } from "@/components/ui/skeleton"
export default function SalesLoading() { return <div className="space-y-3 p-4">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-14 w-full" />)}</div> }

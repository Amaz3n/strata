import { Skeleton } from "@/components/ui/skeleton"
export default function LoadingPaymentRun() { return <div className="mx-auto max-w-6xl space-y-4 p-6"><Skeleton className="h-24 w-full"/><Skeleton className="h-32 w-full"/><Skeleton className="h-72 w-full"/><div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-48"/><Skeleton className="h-48"/></div></div> }

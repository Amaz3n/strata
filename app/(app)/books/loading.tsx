import { Skeleton } from "@/components/ui/skeleton"

export default function BooksLoading() {
  return <div className="mx-auto w-full max-w-[1500px] space-y-5 px-4 py-6 sm:px-6"><Skeleton className="h-32 w-full" /><div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div><Skeleton className="h-[420px]" /></div>
}

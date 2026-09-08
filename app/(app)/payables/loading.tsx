import { Skeleton } from "@/components/ui/skeleton"

export default function LoadingPayables() {
  return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center justify-between border-b px-6 py-3"><Skeleton className="h-8 w-96"/><Skeleton className="h-8 w-52"/></div><div className="grid grid-cols-[2.5rem_1.5fr_1fr_.7fr_.7fr_.8fr_.8fr] border-b px-6 py-2">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-3 w-16"/>)}</div><div className="divide-y">{Array.from({ length: 10 }).map((_, index) => <div key={index} className="grid grid-cols-[2.5rem_1.5fr_1fr_.7fr_.7fr_.8fr_.8fr] items-center px-6 py-4"><Skeleton className="size-4"/>{Array.from({ length: 6 }).map((__, cell) => <Skeleton key={cell} className="h-4 w-4/5"/>)}</div>)}</div></div>
}

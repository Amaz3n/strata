import { ArcLoadingMark } from "@/components/brand/arc-loading-mark"

export default function RootRouteLoading() {
  return (
    <div
      className="flex min-h-svh items-center justify-center bg-background"
      role="status"
      aria-busy="true"
      aria-label="Loading Arc"
    >
      <div className="arc-loading-presence">
        <ArcLoadingMark className="h-16 w-auto sm:h-[4.5rem]" />
      </div>
    </div>
  )
}

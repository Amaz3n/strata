import { ArcLoadingMark } from "@/components/brand/arc-loading-mark"
import { DelayedLoadingStatus } from "@/components/brand/delayed-loading-status"

export default function RootRouteLoading() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <DelayedLoadingStatus label="Loading Arc">
        <ArcLoadingMark className="h-16 w-auto sm:h-[4.5rem]" />
      </DelayedLoadingStatus>
    </div>
  )
}

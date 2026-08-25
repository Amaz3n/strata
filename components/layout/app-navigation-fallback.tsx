import { ArcLoadingMark } from "@/components/brand/arc-loading-mark"
import { DelayedLoadingStatus } from "@/components/brand/delayed-loading-status"

/**
 * The cold-entry fallback for the authenticated group — a full page load, or a
 * navigation arriving before any app chrome exists. It is deliberately NOT used
 * for client navigations between routes inside the group: those keep the shared
 * layout mounted and show each destination's own skeletons.
 *
 * The mark reads `--arc-loading-light`, published by the authenticated chrome,
 * so it carries the org's product tier without being told which one it is.
 */
export function AppNavigationFallback() {
  return (
    // The content region holds its geometry immediately; only the mark and its
    // announcement wait. `data-navigation-pending` is UI state, not a status
    // role — it must stay here, where it is true from the first frame.
    <div
      className="flex min-h-full w-full flex-1 items-center justify-center"
      data-navigation-pending="true"
    >
      <DelayedLoadingStatus
        label="Loading page"
        className="flex min-h-56 items-center justify-center"
      >
        <ArcLoadingMark className="h-16 w-auto sm:h-[4.5rem]" />
      </DelayedLoadingStatus>
    </div>
  )
}

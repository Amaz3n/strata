import { ArcLoadingMark } from "@/components/brand/arc-loading-mark"
import type { ProductTier } from "@/lib/product-tier"

export function AppNavigationFallback({ tier = "residential" }: { tier?: ProductTier }) {
  return (
    <div
      className="flex min-h-full w-full flex-1 items-center justify-center"
      data-navigation-pending="true"
      role="status"
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="arc-loading-presence flex min-h-56 items-center justify-center">
        <ArcLoadingMark tier={tier} className="h-16 w-auto sm:h-[4.5rem]" />
      </div>
    </div>
  )
}

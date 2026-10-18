import { Suspense, type ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { WarrantyDeskNavigation } from "./warranty-desk-navigation"

function WarrantyDeskLoading() {
  return <div aria-label="Loading warranty desk" aria-busy="true" className="space-y-3">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
}

export default function WarrantyLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<WarrantyDeskLoading />}><WarrantyDeskNavigation fallback={<WarrantyDeskLoading />}>{children}</WarrantyDeskNavigation></Suspense>
}

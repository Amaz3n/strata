import { Suspense, type ReactNode } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { CostCodingNavigation, CostCodingRosterSkeleton } from "./cost-coding-navigation"

export default function CostCodingLayout({ children }: { children: ReactNode }) {
  return (
    <PageLayout fullBleed title="Cost coding" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Cost coding" }]}>
      <Suspense fallback={<CostCodingRosterSkeleton />}>
        <CostCodingNavigation>{children}</CostCodingNavigation>
      </Suspense>
    </PageLayout>
  )
}

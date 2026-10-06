import { Suspense, type ReactNode } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { TemplatesNavigation, TemplateLibraryLoading } from "./templates-navigation"

export default function TemplatesLayout({ children }: { children: ReactNode }) {
  return (
    <PageLayout title="Templates" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Templates" }]}>
      <Suspense fallback={<TemplateLibraryLoading />}>
        <TemplatesNavigation>{children}</TemplatesNavigation>
      </Suspense>
    </PageLayout>
  )
}

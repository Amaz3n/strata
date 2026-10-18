import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { OnboardingWorkbench } from "@/components/admin/onboarding-workbench"
import { hasAnyPlatformPermission } from "@/lib/services/platform-access"
import { getOnboardingRun } from "@/lib/services/onboarding"
import { completeOnboardingStageAction, createOnboardingRunAction, markRunLiveAction, skipOnboardingStageAction, updateOnboardingRunAction } from "./actions"


async function ProductionOnboardingPageContent({ params }: { params: Promise<{ orgId: string }> }) {
  await connection()
  const { orgId } = await params
  const data = await getOnboardingRun(orgId)
  if (!data.org) notFound()
  const canManage = await hasAnyPlatformPermission(["platform.support.write"])
  if (!data.run) {
    return <PageLayout title="Production onboarding" breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: data.org.name }]}><div className="border p-6"><h2 className="text-base font-semibold">Start production onboarding</h2><p className="mt-1 text-sm text-muted-foreground">Create the staged checklist and importer workspace for this organization.</p>{canManage ? <form action={async () => { "use server"; await createOnboardingRunAction(orgId) }} className="mt-4"><button className="inline-flex h-9 items-center border bg-primary px-3 text-sm font-medium text-primary-foreground">Create onboarding run</button></form> : <p className="mt-4 text-sm text-muted-foreground">Read-only access. An onboarding operator can create the run.</p>}</div></PageLayout>
  }
  return <PageLayout title="Production onboarding" breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: data.org.name }]}><OnboardingWorkbench canManage={canManage} org={data.org} run={data.run} stages={data.stages} onComplete={completeOnboardingStageAction} onSkip={skipOnboardingStageAction} onUpdate={updateOnboardingRunAction} onMarkLive={markRunLiveAction} /></PageLayout>
}

export default function ProductionOnboardingPage(props: Parameters<typeof ProductionOnboardingPageContent>[0]) {
  return (
    <Suspense fallback={
      <PageLayout title="Production onboarding" breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: "Production onboarding" }]}>
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <ProductionOnboardingPageContent {...props} />
    </Suspense>
  )
}

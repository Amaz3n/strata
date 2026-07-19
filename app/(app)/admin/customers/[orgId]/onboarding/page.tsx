import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { OnboardingWorkbench } from "@/components/admin/onboarding-workbench"
import { getOnboardingRun } from "@/lib/services/onboarding"
import { completeOnboardingStageAction, createOnboardingRunAction, markRunLiveAction, resetSampleCommunityAction, skipOnboardingStageAction, updateOnboardingRunAction } from "./actions"

export const dynamic = "force-dynamic"

export default async function ProductionOnboardingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const data = await getOnboardingRun(orgId)
  if (!data.org) notFound()
  if (!data.run) {
    return <PageLayout title="Production onboarding" breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: data.org.name }]}><div className="border p-6"><h2 className="text-base font-semibold">Start production onboarding</h2><p className="mt-1 text-sm text-muted-foreground">Create the staged checklist and importer workspace for this organization.</p><form action={async () => { "use server"; await createOnboardingRunAction(orgId) }} className="mt-4"><button className="inline-flex h-9 items-center border bg-primary px-3 text-sm font-medium text-primary-foreground">Create onboarding run</button></form></div></PageLayout>
  }
  return <PageLayout title="Production onboarding" breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Customers", href: "/admin/customers" }, { label: data.org.name }]}><OnboardingWorkbench org={data.org} run={data.run} stages={data.stages} onComplete={completeOnboardingStageAction} onSkip={skipOnboardingStageAction} onUpdate={updateOnboardingRunAction} onMarkLive={markRunLiveAction} onResetSample={resetSampleCommunityAction} /></PageLayout>
}

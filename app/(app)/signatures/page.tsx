import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { SignaturesHubClient } from "@/components/esign/signatures-hub-client"
import {
  listSignatureEnvelopeProjectsAction,
  listSignaturesHubAction,
} from "./actions"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = "force-dynamic"

async function SignaturesData() {
  const [data, projectsForNewEnvelope] = await Promise.all([
    listSignaturesHubAction(),
    listSignatureEnvelopeProjectsAction(),
  ])

  return (
    <SignaturesHubClient
      initialData={data}
      scope="org"
      projectsForNewEnvelope={projectsForNewEnvelope}
    />
  )
}

export default function SignaturesHubPage() {
  return (
    <PageLayout title="Signatures">
      <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
        <SignaturesData />
      </Suspense>
    </PageLayout>
  )
}

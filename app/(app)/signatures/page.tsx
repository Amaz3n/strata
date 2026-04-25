import { PageLayout } from "@/components/layout/page-layout"
import { SignaturesHubClient } from "@/components/esign/signatures-hub-client"
import {
  listSignatureEnvelopeProjectsAction,
  listSignaturesHubAction,
} from "./actions"

export const dynamic = "force-dynamic"

export default async function SignaturesHubPage() {
  const [data, projectsForNewEnvelope] = await Promise.all([
    listSignaturesHubAction(),
    listSignatureEnvelopeProjectsAction(),
  ])

  return (
    <PageLayout title="Signatures">
      <SignaturesHubClient
        initialData={data}
        scope="org"
        projectsForNewEnvelope={projectsForNewEnvelope}
      />
    </PageLayout>
  )
}

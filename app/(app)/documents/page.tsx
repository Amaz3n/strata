import { PageLayout } from "@/components/layout/page-layout"
import { SignaturesHubClient } from "@/components/esign/signatures-hub-client"
import { listSignaturesHubAction } from "./actions"

export const dynamic = "force-dynamic"

export default async function SignaturesHubPage() {
  const data = await listSignaturesHubAction()

  return (
    <PageLayout title="Signatures">
      <div className="px-6 py-4 h-full">
        <SignaturesHubClient initialData={data} scope="org" />
      </div>
    </PageLayout>
  )
}

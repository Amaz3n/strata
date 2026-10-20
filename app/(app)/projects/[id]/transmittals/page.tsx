import { guardProjectTab } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { listFiles } from "@/lib/services/files"
import { listTransmittals } from "@/lib/services/transmittals"
import { TransmittalsClient } from "./transmittals-client"

async function TransmittalsPageContent({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  const { id } = await params
  const [, transmittals, filesResult] = await Promise.all([guardProjectTab(id, "transmittals"), listTransmittals(id), listFiles({ project_id: id, limit: 200 })])
  return <PageLayout title="Transmittals" breadcrumbs={[{ label: "Project" }, { label: "Transmittals" }]}><TransmittalsClient projectId={id} transmittals={transmittals} files={filesResult.data} /></PageLayout>
}


export default function TransmittalsPage(props: Parameters<typeof TransmittalsPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Transmittals">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <TransmittalsPageContent {...props} />
    </Suspense>
  )
}

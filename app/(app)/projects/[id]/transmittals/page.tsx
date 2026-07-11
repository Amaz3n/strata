import { PageLayout } from "@/components/layout/page-layout"
import { listFiles } from "@/lib/services/files"
import { listTransmittals } from "@/lib/services/transmittals"
import { TransmittalsClient } from "./transmittals-client"

export default async function TransmittalsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [transmittals, filesResult] = await Promise.all([listTransmittals(id), listFiles({ project_id: id, limit: 200 })])
  return <PageLayout title="Transmittals" breadcrumbs={[{ label: "Project" }, { label: "Transmittals" }]}><TransmittalsClient projectId={id} transmittals={transmittals} files={filesResult.data} /></PageLayout>
}


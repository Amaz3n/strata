import { notFound } from "next/navigation"

import { ClosingWorkbench } from "@/components/sales/closing-workbench"
import { getClosing } from "@/lib/services/closings"

export const dynamic = "force-dynamic"

export default async function ProjectClosingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getClosing(id)
  if (!detail) notFound()
  return <ClosingWorkbench projectId={id} detail={detail} />
}

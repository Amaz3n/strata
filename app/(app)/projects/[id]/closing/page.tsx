import { notFound } from "next/navigation"

import { ClosingWorkbench } from "@/components/sales/closing-workbench"
import { getClosing } from "@/lib/services/closings"


export default async function ProjectClosingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getClosing(id)
  if (!detail) notFound()
  const {getProjectWaiverReadiness}=await import("@/lib/services/waiver-register")
  const waivers=await getProjectWaiverReadiness(id,"sales.read")
  return <><div className="border-b p-4 text-sm"><a className="underline" href={waivers.href}>Final waivers</a> · {waivers.ready?"Ready":`${waivers.missing.length} outstanding`}</div><ClosingWorkbench projectId={id} detail={detail} /></>
}

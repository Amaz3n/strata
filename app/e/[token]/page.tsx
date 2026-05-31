import { notFound } from "next/navigation"

import { loadEstimateByToken } from "@/lib/services/estimate-portal"
import { EstimatePortalClient } from "@/components/portal/estimate-portal-client"

export const revalidate = 0

interface Params {
  params: Promise<{ token: string }>
}

export default async function EstimatePortalPage({ params }: Params) {
  const { token } = await params
  const estimate = await loadEstimateByToken(token)

  if (!estimate) {
    notFound()
  }

  const expired = !!estimate.valid_until && new Date(estimate.valid_until) < new Date()

  return (
    <EstimatePortalClient
      token={token}
      estimate={estimate}
      pdfUrl={`/e/${token}/pdf`}
      expired={expired}
    />
  )
}

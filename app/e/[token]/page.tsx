import { notFound } from "next/navigation"

import { loadEstimateByToken } from "@/lib/services/estimate-portal"
import { EstimatePortalClient } from "@/components/portal/estimate-portal-client"
import { isDateExpired } from "@/lib/utils"

export const revalidate = 0
export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

interface Params {
  params: Promise<{ token: string }>
}

export default async function EstimatePortalPage({ params }: Params) {
  const { token } = await params
  const estimate = await loadEstimateByToken(token)

  if (!estimate) {
    notFound()
  }

  const expired = isDateExpired(estimate.valid_until)

  return (
    <EstimatePortalClient
      token={token}
      estimate={estimate}
      pdfUrl={`/e/${token}/pdf`}
      expired={expired}
    />
  )
}

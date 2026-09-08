import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"

import { loadEstimateByToken } from "@/lib/services/estimate-portal"
import { EstimatePortalClient } from "@/components/portal/estimate-portal-client"
import { isDateExpired } from "@/lib/utils"

export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

interface Params {
  params: Promise<{ token: string }>
}

async function EstimatePortalPageContent({ params }: Params) {
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

export default function EstimatePortalPage(props: Parameters<typeof EstimatePortalPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <EstimatePortalPageContent {...props} />
    </Suspense>
  )
}

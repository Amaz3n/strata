import { PageLayout } from "@/components/layout/page-layout"
import { FinancialControlClient } from "@/components/financial-control/financial-control-client"
import { getPortfolioFinancialControlData } from "@/lib/services/portfolio-financials"
import { getPortfolioTrustCenterData } from "@/lib/services/trust-center"

export default async function FinancialControlPage() {
  const [data, trustCenterData] = await Promise.all([
    getPortfolioFinancialControlData(),
    getPortfolioTrustCenterData(),
  ])

  return (
    <>
      <PageLayout
        title="Financial Control"
        breadcrumbs={[{ label: "Company" }, { label: "Financial Control" }]}
        fullBleed
      />
      <FinancialControlClient data={data} trustCenterData={trustCenterData} />
    </>
  )
}

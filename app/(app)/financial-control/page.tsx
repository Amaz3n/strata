import { PageLayout } from "@/components/layout/page-layout"
import { FinancialControlClient } from "@/components/financial-control/financial-control-client"
import { getPortfolioFinancialControlData } from "@/lib/services/portfolio-financials"

export default async function FinancialControlPage() {
  const data = await getPortfolioFinancialControlData()

  return (
    <>
      <PageLayout
        title="Financial Control"
        breadcrumbs={[{ label: "Company" }, { label: "Financial Control" }]}
        fullBleed
      />
      <FinancialControlClient data={data} />
    </>
  )
}

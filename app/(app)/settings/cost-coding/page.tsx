import { CostCodingRosterSkeleton } from "./cost-coding-navigation"
import { resolveCostCodingSection } from "./sections"
import { connection } from "next/server"
import { Suspense } from "react"

import { CostCodeManager } from "@/components/cost-codes/cost-code-manager"
import { CostCodesEnabledSwitch } from "@/components/cost-codes/cost-codes-enabled-switch"

import { listCostCodesAction } from "../cost-codes/actions"
import { getCostCodingSettingsAction } from "./actions"
import { BillingRatesSection } from "./billing-rates-section"
import { MarkupRulesSection } from "./markup-rules-section"


async function CostCodingPageContent({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const section = resolveCostCodingSection((await searchParams).section)
  if (section === "markup") return <MarkupRulesSection />
  if (section === "rates") return <BillingRatesSection />
  return <CostCodesSection />
}

async function CostCodesSection() {
  await connection()
  const [costCodes, settings] = await Promise.all([listCostCodesAction(true), getCostCodingSettingsAction()])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CostCodesEnabledSwitch initialEnabled={settings.costCodesEnabled} canManage={settings.canManage} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <CostCodeManager costCodes={costCodes} canManage={settings.canManage} />
      </div>
    </div>
  )
}

export default function CostCodingPage(props: Parameters<typeof CostCodingPageContent>[0]) {
  return (
    <Suspense fallback={<CostCodingRosterSkeleton />}>
      <CostCodingPageContent {...props} />
    </Suspense>
  )
}

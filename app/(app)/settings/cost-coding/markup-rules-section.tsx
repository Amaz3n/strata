import { MarkupRulesRoster } from "@/components/cost-codes/markup-rules-roster"

import { getCostCodingSettingsAction } from "./actions"
import { listMarkupRuleOptionsAction, listMarkupRulesAction } from "./markup-rules-actions"

export async function MarkupRulesSection() {
  const [rules, options, settings] = await Promise.all([
    listMarkupRulesAction(),
    listMarkupRuleOptionsAction(),
    getCostCodingSettingsAction(),
  ])

  return <MarkupRulesRoster rules={rules} options={options} canManage={settings.canManage} />
}

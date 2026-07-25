import { BillingRatesRoster } from "@/components/cost-codes/billing-rates-roster"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

import {
  listBillingRateOptionsAction,
  listBillingRateOverridesAction,
  listBillingRateSchedulesAction,
} from "./billing-rates-actions"

export async function BillingRatesSection() {
  const [schedules, overrides, options, permissionResult] = await Promise.all([
    listBillingRateSchedulesAction(),
    listBillingRateOverridesAction(),
    listBillingRateOptionsAction(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canManage = permissions.includes("*") || permissions.includes("org.admin")

  return <BillingRatesRoster schedules={schedules} overrides={overrides} options={options} canManage={canManage} />
}

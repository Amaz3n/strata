import { PageLayout } from "@/components/layout/page-layout"
import { listWarrantyPrograms, listWarrantySlaTargets } from "@/lib/services/warranty"
import { WarrantySettingsClient } from "./warranty-settings-client"

export const dynamic = "force-dynamic"

export default async function WarrantySettingsPage() {
  const [programs, targets] = await Promise.all([listWarrantyPrograms(), listWarrantySlaTargets()])
  return <PageLayout title="Warranty settings" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Warranty" }]}><WarrantySettingsClient programs={programs} targets={targets} /></PageLayout>
}

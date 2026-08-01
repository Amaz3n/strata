import { ControlTowerDesk } from "@/components/control-tower/control-tower-desk"
import { PageLayout } from "@/components/layout/page-layout"

export const dynamic = "force-dynamic"

export default function ControlTowerPage() {
  return (
    <>
      <PageLayout title="Custom project control tower" fullBleed />
      <ControlTowerDesk />
    </>
  )
}

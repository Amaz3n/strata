import { PageLayout } from "@/components/layout/page-layout"
import { MyHousesClient } from "@/components/my-houses/my-houses-client"
import { listMyHouses, listMyHouseWork } from "@/lib/services/my-houses"
import { getAmbientDeskContext } from "@/lib/services/desk-context"

export const dynamic = "force-dynamic"

export default async function MyHousesPage() {
  const context = await getAmbientDeskContext()
  const [houses, work] = await Promise.all([
    listMyHouses({ pageSize: 100, divisionId: context.divisionId }),
    listMyHouseWork({ window: "week", divisionId: context.divisionId }),
  ])
  return <PageLayout title="My Houses" fullBleed><div className="p-4"><MyHousesClient houses={houses.houses} work={work} /></div></PageLayout>
}

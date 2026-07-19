import { PageLayout } from "@/components/layout/page-layout"
import { MyHousesClient } from "@/components/my-houses/my-houses-client"
import { listMyHouses, listMyHouseWork } from "@/lib/services/my-houses"

export const dynamic = "force-dynamic"

export default async function MyHousesPage() {
  const [houses, work] = await Promise.all([listMyHouses({ pageSize: 100 }), listMyHouseWork({ window: "week" })])
  return <PageLayout title="My Houses" fullBleed><div className="p-4"><MyHousesClient houses={houses.houses} work={work} /></div></PageLayout>
}

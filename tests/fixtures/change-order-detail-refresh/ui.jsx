import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { ChangeOrderDetailSheet } from "@/components/change-orders/change-order-detail-sheet"
const initial = { id: "order", project_id: "project", title: "Fixture change order", co_number: 1, status: "approved", lines: [], total_cents: 10000, metadata: {} }
function Fixture() {
  const [changeOrder, setChangeOrder] = useState(initial)
  const [open, setOpen] = useState(true)
  useEffect(() => { window.orderFixture = { refresh: () => setChangeOrder({ ...initial }), close: () => setOpen(false), reopen: () => setOpen(true) } }, [])
  return <ChangeOrderDetailSheet key={changeOrder.id} changeOrder={changeOrder} open={open} onOpenChange={setOpen} />
}
createRoot(document.getElementById("root")).render(<Fixture />)

import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { InventoryWorkspace } from "@/components/books/inventory-workspace"

function Fixture() {
  const [project, setProject] = useState({id:"first",name:"First home",policy:null})
  const [mounted, setMounted] = useState(true)
  useEffect(() => { window.inventoryFixture = { refresh: setProject, unmount: () => setMounted(false) } }, [])
  return mounted ? <InventoryWorkspace initialProject={project} canManage /> : <p>Inventory removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture />)

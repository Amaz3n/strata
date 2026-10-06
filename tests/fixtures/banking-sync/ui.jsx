import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { BankingSyncControl } from "@/components/books/banking-sync-control"
function Fixture() {
  const [mounted,setMounted] = useState(true)
  const [timestamp,setTimestamp] = useState(null)
  useEffect(() => { window.bankFixture = { unmount:()=>setMounted(false),refresh:setTimestamp } },[])
  return mounted ? <BankingSyncControl initialLastSyncedAt={timestamp} canEdit onRefresh={()=>{window.bankRefreshes=(window.bankRefreshes??0)+1}} /> : <p>Sync control removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture />)

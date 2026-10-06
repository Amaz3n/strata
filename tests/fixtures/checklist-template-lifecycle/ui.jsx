import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { ChecklistsClient } from "@/app/(app)/settings/templates/checklists-client"
const template=(id,name)=>({id,name,kind:"quality",description:null,trade:null,item_count:1,is_active:true})
function Fixture(){
  const [templates,setTemplates]=useState([template("a","Checklist A"),template("b","Checklist B")])
  const [mounted,setMounted]=useState(true)
  const [capabilities,setCapabilities]=useState({manage:true,seed:true})
  useEffect(()=>{window.checklistFixture={capabilities:(manage,seed)=>setCapabilities({manage,seed}),unmount:()=>setMounted(false),empty:()=>setTemplates([]),refresh:()=>setTemplates([template("a","Fresh A"),template("b","Fresh B")])}},[])
  return mounted?<ChecklistsClient templates={templates} canManage={capabilities.manage} canSeed={capabilities.seed}/>:<p>Library removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture/> )

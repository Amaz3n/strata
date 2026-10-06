import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { ScheduleTemplatesClient } from "@/components/schedule/schedule-templates-client"
const template = name => ({id:"one",name,description:null,items:[{name:"Foundation",duration_days:1}]})
function Fixture() {
  const [templates,setTemplates]=useState([template("Original schedule")])
  const [mounted,setMounted]=useState(true)
  useEffect(()=>{window.templateFixture={refresh:name=>setTemplates([template(name)]),unmount:()=>setMounted(false)}},[])
  return mounted ? <ScheduleTemplatesClient initialTemplates={templates}/> : <p>Library removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture/> )

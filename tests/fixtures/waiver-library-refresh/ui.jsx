import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { WaiverTemplateLibrary } from "@/components/settings/waiver-template-library"
import { documentFromBody } from "@/lib/templates/waiver-document"
sessionStorage.clear()
const template=name=>({id:"one",familyId:"family",editToken:"token",createdAt:"2026-10-04",name,title:"Conditional waiver",body:"Project {{project_name}}",document:documentFromBody("Project {{project_name}}"),status:"draft",reviewed:false,waiverType:"conditional_progress"})
function Fixture(){
  const [templates,setTemplates]=useState([template("Original waiver")])
  const [mounted,setMounted]=useState(true)
  const [canManage,setCanManage]=useState(true)
  useEffect(()=>{window.waiverFixture={refresh:name=>setTemplates([template(name)]),unmount:()=>setMounted(false),deny:()=>setCanManage(false),result:template}},[])
  return mounted?<WaiverTemplateLibrary initialTemplates={templates} canManage={canManage} orgId="fixture-org"/>:<p>Library removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture/> )

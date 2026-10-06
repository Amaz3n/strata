import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { BudgetTemplatesClient } from "@/components/financials/budget-templates-client"
import { EstimateTemplatesClient } from "@/components/estimates/estimate-templates-client"
const kind = new URLSearchParams(window.location.search).get("kind")
const costCodes=[]
function template(name,id="one") {
  const line=kind==="budget" ? {description:"Foundation",cost_code_id:null,cost_type:null,amount_cents:10000,quantity:null,uom:null,unit_cost_cents:null} : {description:"Foundation",item_type:"line",quantity:1,unit_cost_cents:10000,cost_code_id:null,is_optional:false}
  return {id,name,description:null,property_type:null,line_count:1,total_cents:10000,lines:[line]}
}
function Fixture() {
  const [templates,setTemplates]=useState([template("Original template")])
  const [mounted,setMounted]=useState(true)
  useEffect(()=>{window.templateFixture={refresh:(name,id)=>setTemplates([template(name,id)]),unmount:()=>setMounted(false),result:template}},[])
  if(!mounted)return <p>Library removed</p>
  return kind==="budget" ? <BudgetTemplatesClient initialTemplates={templates} costCodes={costCodes}/> : <EstimateTemplatesClient initialTemplates={templates} costCodes={costCodes}/>
}
createRoot(document.getElementById("root")).render(<Fixture/> )

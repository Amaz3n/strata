import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { PayrollCorrectionWorkspace } from "@/components/time/payroll-correction-workspace"
const mode=new URLSearchParams(window.location.search).get("mode")
const source={id:"source",provider:"Provider",status:"draft",runReference:"Fixture register",periodStart:"2026-10-01",periodEnd:"2026-10-02",revision:1,reason:"Correct provider totals"}
const workspace={projectId:"project",projectName:"Fixture project",sources:[source]}
const detail={sourceId:"source",sourceStatus:mode==="source"?"draft":"reviewed",runReference:"Fixture register",reason:"Correct provider totals",accountingDate:"2026-10-04",sourceFileName:"fixture.csv",registerTotals:{gross_cents:100,net_cents:100,funding_cents:100,employee_taxes_cents:0,employee_deductions_cents:0,employer_taxes_cents:0,employer_benefits_cents:0},costDeltaCents:0,remainingNetPayCents:0,workers:[],costs:[],budgetLines:[],blockers:[],reviewHistory:[],canReviewSource:true,ready:true,currentError:null,receipt:null,proposal:["post","review","withdraw"].includes(mode)?{id:"proposal",status:mode==="post"?"reviewed":"draft",digest:"digest",canReview:true,preparationNotes:"Reviewed proposal"}:null}
function Fixture(){
  const [mounted,setMounted]=useState(true)
  const [props,setProps]=useState({initial:workspace,initialDetail:mode==="select"?null:detail})
  useEffect(()=>{window.payrollFixture={unmount:()=>setMounted(false),refresh:patch=>setProps(current=>({...current,...patch})),workspace,detail}},[])
  return mounted?<PayrollCorrectionWorkspace {...props}/>:<p>Workspace removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture/> )

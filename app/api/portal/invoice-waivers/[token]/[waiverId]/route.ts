import { NextResponse } from "next/server"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { readWaiverWorkflow,isWaiverPublic } from "@/lib/lien-waivers/invoice-waiver"
import { downloadFilesObject } from "@/lib/storage/files-storage"
export async function GET(_request:Request,{params}:{params:Promise<{token:string;waiverId:string}>}) {
 try {
  const {token,waiverId}=await params
  const access=await assertPortalActionAccess(token,{portalType:"client",requireProject:true,permission:"can_view_invoices"})
  const supabase=createServiceSupabaseClient()
  const {data:waiver,error}=await supabase.from("invoice_lien_waivers").select("*").eq("org_id",access.org_id).eq("project_id",access.project_id).eq("id",waiverId).maybeSingle()
  const flow=waiver?readWaiverWorkflow(waiver):null
  if(error||!waiver||!flow||!isWaiverPublic(waiver))return new NextResponse("Not found",{status:404})
  const {data:invoice}=await supabase.from("invoices").select("client_visible,status").eq("org_id",access.org_id).eq("project_id",access.project_id).eq("id",waiver.invoice_id).maybeSingle()
  if(!invoice || invoice.status==="void")return new NextResponse("Not found",{status:404})
  if(!invoice.client_visible){
   const {data:application}=await supabase.from("pay_applications").select("id").eq("org_id",access.org_id).eq("project_id",access.project_id).eq("invoice_id",waiver.invoice_id).not("status","in","(draft,void)").limit(1).maybeSingle()
   if(!application)return new NextResponse("Not found",{status:404})
  }
  const bytes=await downloadFilesObject({supabase,orgId:access.org_id,path:flow.document_path})
  return new NextResponse(new Uint8Array(bytes),{headers:{"Content-Type":"application/pdf","Content-Disposition":'inline; filename="signed-waiver.pdf"',"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}})
 }catch{return new NextResponse("Not found",{status:404})}
}

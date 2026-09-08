import { listPublicInvoiceLienWaivers } from "@/lib/services/invoice-lien-waivers"
import { readWaiverWorkflow } from "@/lib/lien-waivers/invoice-waiver"
import { INVOICE_WAIVER_TYPE_LABELS } from "@/lib/types"
export async function InvoiceWaiverLinks({orgId,invoiceId,token}:{orgId:string;invoiceId:string;token:string}) {
 const waivers=(await listPublicInvoiceLienWaivers({orgId,invoiceId})).filter(w=>readWaiverWorkflow(w)?.lifecycle==="signed")
 if(!waivers.length)return null
 return <section className="space-y-3 border bg-card p-4"><h2 className="text-sm font-medium">Included signed waivers</h2>{waivers.map(w=><a key={w.id} href={`/api/portal/invoice-waivers/${token}/${w.id}`} target="_blank" rel="noreferrer" className="block text-sm underline underline-offset-4">{INVOICE_WAIVER_TYPE_LABELS[w.waiver_type]}</a>)}<p className="text-xs text-muted-foreground">Signed by your contractor. No client signature is needed.</p></section>
}

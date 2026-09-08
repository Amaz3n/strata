"use client"
import { useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { submitDocumentSignatureAction } from "@/app/d/[token]/actions"
import { SignatureCapture } from "@/app/d/[token]/components/signature-capture"
const WaiverPdfPreview = dynamic(() => import("@/components/invoices/waiver-pdf-preview").then(module => module.WaiverPdfPreview), { ssr: false, loading: () => <div className="m-auto text-sm text-muted-foreground">Opening document…</div> })
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Check, PenLine } from "lucide-react"

const CONSENT = "I am authorized to sign this waiver for my company. I have reviewed this document, agree to electronic records and signatures, and intend my signature to be legally binding."
export function WaiverSigningClient({ token, title, signerEmail, signerName, fields }: {
  token: string; title: string; signerEmail: string; signerName: string;
  fields: Array<{ id: string; field_type: string }>
}) {
  const [name,setName] = useState(signerName)
  const [signature,setSignature] = useState<string | null>(null)
  const [capture,setCapture] = useState(false)
  const [consent,setConsent] = useState(false)
  const [complete,setComplete] = useState(false)
  const [previewUrl,setPreviewUrl] = useState(`/d/${token}/file`)
  const [ready,setReady] = useState(false)
  const [error,setError] = useState("")
  const [pending,startTransition] = useTransition()
  function sign() {
    if (!ready || !signature || !consent || !name.trim() || pending) return
    setError("")
    startTransition(async () => {
      try {
        const values = Object.fromEntries(fields.map(field => [field.id,field.field_type === "signature" ? signature : field.field_type === "date" ? new Date().toISOString().slice(0,10) : name.trim()]))
        const result = await submitDocumentSignatureAction({ token, signerName: name.trim(), signerEmail, values, consentText: CONSENT })
        if (result.executedDocumentUrl) setPreviewUrl(result.executedDocumentUrl)
        setComplete(true)
      } catch (error) { setError(error instanceof Error ? error.message : "Could not sign this waiver") }
    })
  }
  return <main className="flex h-dvh min-h-0 bg-background text-foreground">
    <aside className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-r p-8">
      <p className="text-xs text-muted-foreground">Company signature</p>
      <h1 className="mt-2 text-xl font-medium tracking-tight">{title}</h1>
      {complete ? <div className="my-auto space-y-3 py-8"><Check className="size-7 text-success"/><h2 className="text-lg font-medium">Waiver signed</h2><p className="text-sm text-muted-foreground">Your signature is recorded. The invoice workspace will update with the signed PDF.</p></div> : <div className="mt-8 space-y-5">
        <p className="text-sm leading-relaxed text-muted-foreground">Review the waiver, then sign on behalf of your company. Your signature will appear on the final PDF.</p>
        <div className="space-y-2"><Label htmlFor="waiver-signing-name">Full name</Label><Input id="waiver-signing-name" value={name} disabled={pending} onChange={event=>setName(event.target.value)}/><p className="text-xs text-muted-foreground">{signerEmail}</p></div>
        <Button variant="outline" disabled={pending} onClick={()=>setCapture(true)} className="h-24 w-full rounded-none border-dashed">
          {signature ? <img src={signature} alt="Your adopted signature" className="h-16 max-w-full object-contain"/> : <><PenLine className="mr-2 size-4"/>Draw or type signature</>}
        </Button>
        <label className="flex items-start gap-3 text-xs leading-relaxed text-muted-foreground"><Checkbox checked={consent} disabled={pending} onCheckedChange={value=>setConsent(value===true)}/><span>{CONSENT} <a href="/esign-terms" target="_blank" rel="noreferrer" className="underline">Electronic signature terms</a></span></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button className="w-full rounded-none" disabled={pending || !ready || !signature || !consent || !name.trim()} onClick={sign}>{pending ? "Signing…" : "Sign waiver"}</Button>
      </div>}
    </aside>
    <WaiverPdfPreview url={previewUrl} onReady={()=>setReady(true)}/>
    <Dialog open={capture} onOpenChange={setCapture}><DialogContent className="rounded-none sm:max-w-xl"><DialogHeader><DialogTitle>Your signature</DialogTitle><DialogDescription>Draw, type, or upload the signature to place on this waiver.</DialogDescription></DialogHeader><SignatureCapture fieldLabel="Waiver signature" onApply={value=>{setSignature(value);setCapture(false)}}/></DialogContent></Dialog>
  </main>
}

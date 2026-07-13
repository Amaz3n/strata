"use client"

import Link from "next/link"
import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2, FileUp, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { uploadFileAction } from "@/app/(app)/documents/actions"
import { saveProjectOwnComplianceAction } from "@/app/(app)/projects/[id]/financials/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { ProjectOwnComplianceDocument } from "@/lib/services/project-own-compliance"

export function OurComplianceCard({
  projectId,
  documents,
  documentTypes,
}: {
  projectId: string
  documents: ProjectOwnComplianceDocument[]
  documentTypes: Array<{ id: string; name: string; has_expiry: boolean }>
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [documentTypeId, setDocumentTypeId] = useState(documentTypes[0]?.id ?? "")
  const [carrierName, setCarrierName] = useState("")
  const [policyNumber, setPolicyNumber] = useState("")
  const [expiryDate, setExpiryDate] = useState("")

  function upload() {
    const file = fileRef.current?.files?.[0]
    if (!file || !documentTypeId) return
    startTransition(async () => {
      try {
        const form = new FormData()
        form.set("file", file)
        form.set("projectId", projectId)
        form.set("category", "contracts")
        form.set("folderPath", "/Financials/Our compliance")
        form.set("visibility", "private")
        const uploaded = unwrapAction(await uploadFileAction(form))
        unwrapAction(await saveProjectOwnComplianceAction({
          projectId,
          documentTypeId,
          fileId: uploaded.id,
          carrierName: carrierName || null,
          policyNumber: policyNumber || null,
          expiryDate: expiryDate || null,
        }))
        toast.success("Compliance document added")
        setCarrierName("")
        setPolicyNumber("")
        setExpiryDate("")
        if (fileRef.current) fileRef.current.value = ""
        router.refresh()
      } catch (error) {
        toast.error("Could not add compliance document", { description: error instanceof Error ? error.message : "Try again." })
      }
    })
  }

  return (
    <Card className="mx-4 mt-4 sm:mx-6 lg:mx-8">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Our compliance</CardTitle>
        <p className="text-sm text-muted-foreground">Project-specific bonds, insurance certificates, and licenses that can travel with an owner billing package.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {documents.length ? (
          <div className="divide-y border">
            {documents.map((document) => {
              const expired = document.status === "expired"
              return (
                <div key={document.id} className="grid gap-2 p-3 text-sm md:grid-cols-[1.2fr_1fr_1fr_auto] md:items-center">
                  <div><p className="font-medium">{document.document_type_name}</p><Link className="text-xs text-primary hover:underline" href={`/projects/${projectId}/documents?file=${document.file_id}`}>{document.file_name}</Link></div>
                  <div><p>{document.carrier_name || "No carrier / surety"}</p><p className="text-xs text-muted-foreground">{document.policy_number || "No policy number"}</p></div>
                  <div className={expired ? "text-destructive" : "text-muted-foreground"}>{document.expiry_date ? `Expires ${document.expiry_date}` : "No expiry"}</div>
                  <Badge variant={expired ? "destructive" : "secondary"} className="w-fit gap-1">{expired ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}{document.status.replaceAll("_", " ")}</Badge>
                </div>
              )
            })}
          </div>
        ) : <p className="border border-dashed p-4 text-sm text-muted-foreground">No GC compliance documents have been added for this project.</p>}

        <div className="grid gap-3 border bg-muted/10 p-3 md:grid-cols-4">
          <div className="space-y-1.5"><Label>Document type</Label><Select value={documentTypeId} onValueChange={setDocumentTypeId}><SelectTrigger><SelectValue placeholder="Choose type" /></SelectTrigger><SelectContent>{documentTypes.map((type) => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Carrier / surety</Label><Input value={carrierName} onChange={(event) => setCarrierName(event.target.value)} placeholder="Travelers" /></div>
          <div className="space-y-1.5"><Label>Policy / bond no.</Label><Input value={policyNumber} onChange={(event) => setPolicyNumber(event.target.value)} /></div>
          <div className="space-y-1.5"><Label>Expiry</Label><Input type="date" value={expiryDate} onChange={(event) => setExpiryDate(event.target.value)} /></div>
          <div className="space-y-1.5 md:col-span-3"><Label>File</Label><Input ref={fileRef} type="file" accept="application/pdf,image/*" /></div>
          <div className="flex items-end"><Button className="w-full" disabled={pending || !documentTypeId} onClick={upload}><FileUp className="h-4 w-4" />{pending ? "Uploading…" : "Add document"}</Button></div>
        </div>
      </CardContent>
    </Card>
  )
}

"use client"

import Link from "next/link"
import { useEffect, useRef, useState, useTransition } from "react"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"

import { uploadFileAction } from "@/app/(app)/documents/actions"
import {
  saveProjectComplianceDocumentAction,
  type ProjectComplianceSettings,
} from "@/app/(app)/projects/[id]/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { ProjectOwnComplianceDocument } from "@/lib/services/project-own-compliance"

export function ProjectComplianceManager({
  projectId,
  compliance,
}: {
  projectId: string
  compliance: ProjectComplianceSettings | null
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [documents, setDocuments] = useState<ProjectOwnComplianceDocument[]>(compliance?.documents ?? [])
  const [documentTypeId, setDocumentTypeId] = useState("")
  const [carrierName, setCarrierName] = useState("")
  const [policyNumber, setPolicyNumber] = useState("")
  const [expiryDate, setExpiryDate] = useState("")
  const [pending, startTransition] = useTransition()

  const documentTypes = compliance?.documentTypes ?? []

  useEffect(() => {
    setDocuments(compliance?.documents ?? [])
    setDocumentTypeId(compliance?.documentTypes[0]?.id ?? "")
  }, [compliance])

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
        const saved = unwrapAction(
          await saveProjectComplianceDocumentAction({
            projectId,
            documentTypeId,
            fileId: uploaded.id,
            carrierName: carrierName || null,
            policyNumber: policyNumber || null,
            expiryDate: expiryDate || null,
          }),
        )
        setDocuments((current) => {
          const next = current.filter((document) => document.id !== saved.id)
          return [...next, saved]
        })
        toast.success("Compliance document added")
        setCarrierName("")
        setPolicyNumber("")
        setExpiryDate("")
        if (fileRef.current) fileRef.current.value = ""
      } catch (error) {
        toast.error("Could not add compliance document", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  return (
    <div className="space-y-3 border-t pt-5">
      <div>
        <Label className="text-sm">Our compliance</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Project-specific bonds, insurance certificates, and licenses that travel with an owner billing package.
        </p>
      </div>

      {compliance === null ? (
        <p className="border px-3 py-4 text-sm text-muted-foreground">Loading compliance documents…</p>
      ) : documents.length === 0 ? (
        <p className="border px-3 py-4 text-sm text-muted-foreground">
          No compliance documents have been added for this project.
        </p>
      ) : (
        <div className="divide-y border">
          {documents.map((document) => {
            const expired = document.status === "expired"
            return (
              <div key={document.id} className="grid gap-2 p-3 text-sm sm:grid-cols-[1.2fr_1fr_1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="font-medium">{document.document_type_name}</p>
                  <Link
                    className="truncate text-xs text-primary hover:underline"
                    href={`/projects/${projectId}/documents?file=${document.file_id}`}
                  >
                    {document.file_name}
                  </Link>
                </div>
                <div className="min-w-0">
                  <p className="truncate">{document.carrier_name || "No carrier / surety"}</p>
                  <p className="truncate text-xs text-muted-foreground">{document.policy_number || "No policy number"}</p>
                </div>
                <div className={expired ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {document.expiry_date ? `Expires ${document.expiry_date}` : "No expiry"}
                </div>
                <Badge variant={expired ? "destructive" : "secondary"} className="w-fit gap-1">
                  {expired ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                  {document.status.replaceAll("_", " ")}
                </Badge>
              </div>
            )
          })}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={documentTypeId} onValueChange={setDocumentTypeId} disabled={pending || documentTypes.length === 0}>
          <SelectTrigger>
            <SelectValue placeholder="Document type" />
          </SelectTrigger>
          <SelectContent>
            {documentTypes.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={carrierName}
          onChange={(event) => setCarrierName(event.target.value)}
          placeholder="Carrier / surety"
          disabled={pending}
        />
        <Input
          value={policyNumber}
          onChange={(event) => setPolicyNumber(event.target.value)}
          placeholder="Policy / bond no."
          disabled={pending}
        />
        <Input
          type="date"
          value={expiryDate}
          onChange={(event) => setExpiryDate(event.target.value)}
          aria-label="Expiry date"
          disabled={pending}
        />
        <Input ref={fileRef} type="file" accept="application/pdf,image/*" disabled={pending} aria-label="Compliance file" />
        <Button type="button" disabled={pending || !documentTypeId} onClick={upload}>
          {pending ? "Uploading…" : "Add document"}
        </Button>
      </div>
    </div>
  )
}

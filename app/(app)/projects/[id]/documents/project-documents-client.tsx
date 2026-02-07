"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { Document } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  createDocumentAction,
  listDocumentFieldsAction,
  saveDocumentFieldsAction,
  uploadESignDocumentFileAction,
} from "@/app/(app)/documents/actions"
import { ESignDocumentViewer, type ESignFieldDraft } from "@/components/esign/esign-document-viewer"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FileText, Plus, Sparkles } from "@/components/icons"

interface ProjectDocumentsClientProps {
  projectId: string
  initialDocuments: Document[]
}

export function ProjectDocumentsClient({ projectId, initialDocuments }: ProjectDocumentsClientProps) {
  const [documents, setDocuments] = useState<Document[]>(initialDocuments)
  const [selectedId, setSelectedId] = useState<string | null>(initialDocuments[0]?.id ?? null)
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [fields, setFields] = useState<ESignFieldDraft[]>([])
  const [loadingFields, setLoadingFields] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)

  const selectedDoc = useMemo(() => documents.find((doc) => doc.id === selectedId) ?? null, [documents, selectedId])

  const refreshFields = useCallback(async (docId: string) => {
    setLoadingFields(true)
    try {
      const data = await listDocumentFieldsAction(docId, 1)
      const mapped = (data ?? []).map((field: any) => ({
        id: field.id,
        page_index: field.page_index,
        field_type: field.field_type,
        label: field.label ?? undefined,
        required: field.required ?? true,
        signer_role: field.signer_role ?? undefined,
        x: field.x,
        y: field.y,
        w: field.w,
        h: field.h,
        sort_order: field.sort_order ?? undefined,
        metadata: field.metadata ?? undefined,
      }))
      setFields(mapped)
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to load fields", { description: error?.message ?? "Please try again." })
    } finally {
      setLoadingFields(false)
    }
  }, [])

  const refreshFileUrl = useCallback((doc: Document) => {
    setFileUrl(`/api/files/${doc.source_file_id}/raw`)
  }, [])

  useEffect(() => {
    if (!selectedDoc) {
      setFileUrl(null)
      setFields([])
      return
    }
    refreshFileUrl(selectedDoc)
    refreshFields(selectedDoc.id)
  }, [selectedDoc, refreshFileUrl, refreshFields])

  async function handleCreateDocument(form: {
    title: string
    type: Document["document_type"]
    file?: File | null
  }) {
    if (!form.file) return
    setCreating(true)
    try {
      const formData = new FormData()
      formData.append("file", form.file)
      const uploaded = await uploadESignDocumentFileAction(projectId, formData)
      const document = await createDocumentAction({
        project_id: projectId,
        document_type: form.type,
        title: form.title,
        source_file_id: uploaded.id,
      })
      setDocuments((prev) => [document as Document, ...prev])
      setSelectedId(document.id)
      setCreateOpen(false)
      toast.success("Document created")
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to create document", { description: error?.message ?? "Please try again." })
    } finally {
      setCreating(false)
    }
  }

  const handleSaveFields = async () => {
    if (!selectedDoc) return
    try {
      await saveDocumentFieldsAction(
        selectedDoc.id,
        1,
        fields.map((field, index) => ({
          page_index: field.page_index,
          field_type: field.field_type,
          label: field.label,
          required: field.required,
          signer_role: field.signer_role,
          x: field.x,
          y: field.y,
          w: field.w,
          h: field.h,
          sort_order: field.sort_order ?? index,
          metadata: field.metadata ?? {},
        })),
      )
      toast.success("Fields saved")
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to save fields", { description: error?.message ?? "Please try again." })
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px,1fr] h-full">
      <Card className="h-full">
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Documents</CardTitle>
              <CardDescription>PDFs prepared for signature.</CardDescription>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New
            </Button>
          </div>
        </CardHeader>
        <CardContent className="h-[calc(100%-110px)]">
          <ScrollArea className="h-full pr-2">
            <div className="space-y-3">
              {documents.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => setSelectedId(doc.id)}
                  className={cn(
                    "w-full rounded-lg border px-3 py-3 text-left transition",
                    selectedId === doc.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/60",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{doc.title}</p>
                      <p className="text-xs text-muted-foreground capitalize">{doc.document_type.replace("_", " ")}</p>
                    </div>
                    <Badge variant="secondary" className="capitalize">
                      {doc.status}
                    </Badge>
                  </div>
                </button>
              ))}
              {documents.length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No documents yet. Upload a PDF to get started.
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="h-full">
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Field Placement</CardTitle>
              <CardDescription>Open the viewer to place signature fields.</CardDescription>
            </div>
            <Button onClick={() => setViewerOpen(true)} disabled={!selectedDoc || !fileUrl || loadingFields}>
              Prepare in viewer
            </Button>
          </div>
        </CardHeader>
        <CardContent className="h-[calc(100%-120px)]">
          {!selectedDoc ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a document to place fields.
            </div>
          ) : !fileUrl ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading PDF…
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <div className="rounded-full border bg-muted/40 p-3">
                <FileText className="h-5 w-5" />
              </div>
              <p>Open the viewer to place fields on the document.</p>
              <Button onClick={() => setViewerOpen(true)}>Open viewer</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedDoc && fileUrl && (
        <ESignDocumentViewer
          open={viewerOpen}
          onClose={() => setViewerOpen(false)}
          title={selectedDoc.title}
          documentType={selectedDoc.document_type}
          fileUrl={fileUrl}
          fields={fields}
          setFields={setFields}
          onSave={handleSaveFields}
        />
      )}

      <CreateDocumentSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreateDocument}
        loading={creating}
      />
    </div>
  )
}

function CreateDocumentSheet({
  open,
  onOpenChange,
  onCreate,
  loading,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: { title: string; type: Document["document_type"]; file?: File | null }) => void
  loading: boolean
}) {
  const [title, setTitle] = useState("")
  const [type, setType] = useState<Document["document_type"]>("proposal")
  const [file, setFile] = useState<File | null>(null)

  const canSubmit = title.trim().length > 0 && !!file

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)]">
        <SheetHeader className="space-y-2">
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            New E‑Sign Document
          </SheetTitle>
          <SheetDescription>Upload a PDF and prepare it for signature.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-5">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Owner Agreement" />
          </div>
          <div className="space-y-2">
            <Label>Document type</Label>
            <Select value={type} onValueChange={(value) => setType(value as Document["document_type"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="proposal">Proposal</SelectItem>
                <SelectItem value="contract">Contract</SelectItem>
                <SelectItem value="change_order">Change order</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>PDF file</Label>
            <Input
              type="file"
              accept="application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              Upload the exact PDF you want the client to sign.
            </p>
          </div>
          <Separator />
          <Button
            className="w-full"
            onClick={() => onCreate({ title: title.trim(), type, file })}
            disabled={!canSubmit || loading}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 animate-pulse" />
                Creating…
              </span>
            ) : (
              "Create document"
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import {
  createDocumentAction,
  getSourceEntityDraftAction,
  listEnvelopeRecipientSuggestionsAction,
  saveDocumentDraftEnvelopeAction,
  saveDocumentFieldsAction,
  sendDocumentEnvelopeAction,
  uploadESignDocumentFileAction,
} from "@/app/(app)/documents/actions"
import { type UnifiedSignableEntityType } from "@/lib/esign/unified-contracts"
import { cn } from "@/lib/utils"
import { ESignDocumentViewer, type ESignFieldDraft } from "@/components/esign/esign-document-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  FileText,
  GripVertical,
  Mail,
  Loader2,
  Plus,
  Trash2,
  Upload,
  User,
} from "@/components/icons"

type RecipientRole = "signer" | "cc"
type PrepareStep = "envelope" | "fields"
type DocumentType = "proposal" | "contract" | "change_order" | "other"

type EnvelopeRecipient = {
  id: string
  name: string
  email: string
  role: RecipientRole
  signer_role: string
}

type DraftRecipientPayload = {
  name?: string
  email?: string
  role?: RecipientRole
  signer_role?: string
}

type HydrateRecipientPayload = {
  name?: string | null
  email?: string | null
  role?: RecipientRole | null
  signer_role?: string | null
}

type UploadedPdf = {
  id: string
  fileName: string
  url: string
}

type RecipientSuggestion = {
  name: string
  email: string
  source: "contact" | "team"
}

const sourceEntityMetadataIdKeyByType: Record<UnifiedSignableEntityType, string> = {
  proposal: "proposal_id",
  change_order: "change_order_id",
  lien_waiver: "lien_waiver_id",
  selection: "selection_id",
  subcontract: "subcontract_id",
  closeout: "closeout_id",
  other: "source_entity_id",
}

export type EnvelopeWizardSourceEntity = {
  type: UnifiedSignableEntityType
  id: string
  project_id: string | null
  title: string
  document_type: DocumentType
}

type EnvelopeWizardSendResult = {
  documentId: string
  envelopeId: string | null
}

interface EnvelopeWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceEntity: EnvelopeWizardSourceEntity | null
  sheetTitle?: string
  sheetDescription?: string
  sourceLabel?: string
  onEnvelopeSent?: (result: EnvelopeWizardSendResult) => void
}

function createRecipient(role: RecipientRole = "signer"): EnvelopeRecipient {
  const id = crypto.randomUUID()
  return {
    id,
    name: "",
    email: "",
    role,
    signer_role: `signer_${id.replace(/-/g, "").slice(0, 8)}`,
  }
}

function serializeDraftRecipients(recipients: EnvelopeRecipient[]): DraftRecipientPayload[] {
  return recipients.map((recipient, index) => ({
    name: recipient.name.trim(),
    email: recipient.email.trim(),
    role: recipient.role,
    signer_role: recipient.signer_role || `signer_${index + 1}`,
  }))
}

function hydrateDraftRecipients(recipients: HydrateRecipientPayload[]): EnvelopeRecipient[] {
  return (recipients ?? []).map((recipient, index) => {
    const role: RecipientRole = recipient.role === "cc" ? "cc" : "signer"
    const fallback = createRecipient(role)
    return {
      id: fallback.id,
      role,
      name: recipient.name?.trim() ?? "",
      email: recipient.email?.trim() ?? "",
      signer_role: recipient.signer_role?.trim() || fallback.signer_role || `signer_${index + 1}`,
    }
  })
}

export function EnvelopeWizard({
  open,
  onOpenChange,
  sourceEntity,
  sheetTitle = "Prepare for signature",
  sheetDescription = "Set up recipients and upload the PDF before placing fields.",
  sourceLabel = "Signable",
  onEnvelopeSent,
}: EnvelopeWizardProps) {
  const [prepareStep, setPrepareStep] = useState<PrepareStep>("envelope")
  const [documentTitle, setDocumentTitle] = useState("")
  const [signingOrderEnabled, setSigningOrderEnabled] = useState(true)
  const [recipients, setRecipients] = useState<EnvelopeRecipient[]>([createRecipient("signer")])
  const [uploadedPdf, setUploadedPdf] = useState<UploadedPdf | null>(null)
  const [uploadingPdf, setUploadingPdf] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadDragActive, setUploadDragActive] = useState(false)
  const [hydratingDraft, setHydratingDraft] = useState(false)
  const [movingToFields, setMovingToFields] = useState(false)
  const [sendingEnvelope, setSendingEnvelope] = useState(false)
  const [recipientSuggestions, setRecipientSuggestions] = useState<RecipientSuggestion[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftHydrationRef = useRef(0)

  const [viewerFields, setViewerFields] = useState<ESignFieldDraft[]>([])
  const [viewerDocument, setViewerDocument] = useState<{ id: string; title: string; document_type: string } | null>(null)
  const [viewerFileUrl, setViewerFileUrl] = useState<string | null>(null)

  const signerRecipients = useMemo(
    () => recipients.filter((recipient) => recipient.role === "signer"),
    [recipients],
  )

  const signerRoleOptions = useMemo(
    () => signerRecipients.map((recipient, index) => ({
      value: recipient.signer_role,
      label: recipient.name.trim() || `Signer ${index + 1}`,
    })),
    [signerRecipients],
  )

  const signerOrderById = useMemo(() => {
    return new Map(
      recipients
        .filter((recipient) => recipient.role === "signer")
        .map((recipient, index) => [recipient.id, index + 1]),
    )
  }, [recipients])

  const recipientSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  )
  const sourceEntityId = sourceEntity?.id ?? null
  const sourceEntityType = sourceEntity?.type ?? null
  const sourceEntityTitle = sourceEntity?.title ?? ""

  useEffect(() => {
    if (signerRoleOptions.length === 0) return
    const allowedRoles = new Set(signerRoleOptions.map((option) => option.value))
    const fallbackRole = signerRoleOptions[0].value

    setViewerFields((prev) => {
      let changed = false
      const next = prev.map((field) => {
        if (field.signer_role && allowedRoles.has(field.signer_role)) return field
        changed = true
        return { ...field, signer_role: fallbackRole }
      })
      return changed ? next : prev
    })
  }, [signerRoleOptions])

  useEffect(() => {
    if (!uploadingPdf) {
      setUploadProgress(0)
      return
    }

    setUploadProgress((prev) => (prev > 0 ? prev : 8))
    const timer = window.setInterval(() => {
      setUploadProgress((prev) => Math.min(92, prev + Math.max(2, Math.random() * 10)))
    }, 180)

    return () => window.clearInterval(timer)
  }, [uploadingPdf])

  useEffect(() => {
    if (!open) return
    void import("react-pdf").catch(() => null)
  }, [open])

  useEffect(() => {
    if (!open || !sourceEntityId || !sourceEntityType) return

    const hydrationId = draftHydrationRef.current + 1
    draftHydrationRef.current = hydrationId

    setPrepareStep("envelope")
    setDocumentTitle(sourceEntityTitle)
    setSigningOrderEnabled(true)
    setRecipients([createRecipient("signer")])
    setUploadedPdf(null)
    setUploadingPdf(false)
    setUploadProgress(0)
    setUploadDragActive(false)
    setHydratingDraft(true)
    setMovingToFields(false)
    setSendingEnvelope(false)
    setRecipientSuggestions([])
    setViewerFields([])
    setViewerDocument(null)
    setViewerFileUrl(null)

    void (async () => {
      try {
        const [draft, suggestions] = await Promise.all([
          getSourceEntityDraftAction({
            source_entity_type: sourceEntityType,
            source_entity_id: sourceEntityId,
          }),
          listEnvelopeRecipientSuggestionsAction(),
        ])

        if (hydrationId !== draftHydrationRef.current) return
        setRecipientSuggestions(suggestions ?? [])

        if (!draft) return

        const mappedFields = (draft.fields ?? []).map((field: any) => ({
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

        setDocumentTitle(draft.document.title || sourceEntityTitle)
        setUploadedPdf({
          id: draft.file.id,
          fileName: draft.file.file_name,
          url: `/api/files/${draft.file.id}/raw`,
        })
        setViewerDocument({
          id: draft.document.id,
          title: draft.document.title,
          document_type: draft.document.document_type,
        })
        setViewerFields(mappedFields)
        setViewerFileUrl(`/api/files/${draft.file.id}/raw`)
        setSigningOrderEnabled(draft.signing_order_enabled !== false)

        const restoredRecipients = hydrateDraftRecipients(draft.recipients ?? [])
        if (restoredRecipients.length > 0) {
          setRecipients(restoredRecipients)
        }

        if (mappedFields.length > 0) {
          setPrepareStep("fields")
        }
      } catch (error: any) {
        if (hydrationId !== draftHydrationRef.current) return
        console.error(error)
        toast.error("Failed to restore draft", { description: error?.message ?? "Please try again." })
      } finally {
        if (hydrationId === draftHydrationRef.current) {
          setHydratingDraft(false)
        }
      }
    })()
  }, [open, sourceEntityId, sourceEntityTitle, sourceEntityType])

  const handleRecipientDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    setRecipients((prev) => {
      const oldIndex = prev.findIndex((recipient) => recipient.id === String(active.id))
      const newIndex = prev.findIndex((recipient) => recipient.id === String(over.id))
      if (oldIndex < 0 || newIndex < 0) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  const updateRecipient = (id: string, patch: Partial<EnvelopeRecipient>) => {
    setRecipients((prev) => prev.map((recipient) => (recipient.id === id ? { ...recipient, ...patch } : recipient)))
  }

  const updateSignerOrder = (recipientId: string, nextOrder: number) => {
    setRecipients((prev) => {
      const signerIds = prev.filter((recipient) => recipient.role === "signer").map((recipient) => recipient.id)
      const fromIndex = signerIds.indexOf(recipientId)
      if (fromIndex < 0) return prev

      const targetIndex = Math.max(0, Math.min(nextOrder - 1, signerIds.length - 1))
      if (targetIndex === fromIndex) return prev

      const reorderedSignerIds = [...signerIds]
      const [movedId] = reorderedSignerIds.splice(fromIndex, 1)
      reorderedSignerIds.splice(targetIndex, 0, movedId)

      const signerById = new Map(
        prev
          .filter((recipient) => recipient.role === "signer")
          .map((recipient) => [recipient.id, recipient]),
      )

      let signerPointer = 0
      return prev.map((recipient) => {
        if (recipient.role !== "signer") return recipient
        const nextSignerId = reorderedSignerIds[signerPointer]
        signerPointer += 1
        return signerById.get(nextSignerId) ?? recipient
      })
    })
  }

  const addRecipient = () => {
    setRecipients((prev) => [...prev, createRecipient("signer")])
  }

  const removeRecipient = (id: string) => {
    setRecipients((prev) => {
      if (prev.length <= 1) return prev
      return prev.filter((recipient) => recipient.id !== id)
    })
  }

  const closeWizard = (nextOpen: boolean) => {
    if (!nextOpen) {
      draftHydrationRef.current += 1
      setPrepareStep("envelope")
      setDocumentTitle(sourceEntity?.title ?? "")
      setSigningOrderEnabled(true)
      setRecipients([createRecipient("signer")])
      setUploadedPdf(null)
      setUploadingPdf(false)
      setUploadProgress(0)
      setUploadDragActive(false)
      setHydratingDraft(false)
      setMovingToFields(false)
      setSendingEnvelope(false)
      setRecipientSuggestions([])
      setViewerFields([])
      setViewerDocument(null)
      setViewerFileUrl(null)
    }
    onOpenChange(nextOpen)
  }

  const handleFileSelected = async (file: File | null) => {
    if (!file || !sourceEntity) return
    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are supported")
      return
    }
    if (!sourceEntity.project_id) {
      toast.error("This record must be attached to a project before requesting signature")
      return
    }

    const baseName = file.name.replace(/\.pdf$/i, "")
    setDocumentTitle(baseName)
    setUploadedPdf(null)
    setUploadingPdf(true)
    setUploadProgress(8)

    try {
      const formData = new FormData()
      formData.append("file", file)
      const uploaded = await uploadESignDocumentFileAction(sourceEntity.project_id, formData)
      setUploadedPdf({
        id: uploaded.id,
        fileName: file.name,
        url: `/api/files/${uploaded.id}/raw`,
      })
      setUploadProgress(100)
      setViewerDocument(null)
      setViewerFields([])
      setViewerFileUrl(null)
      toast.success("PDF uploaded")
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to upload PDF", { description: error?.message ?? "Please try again." })
      setUploadedPdf(null)
      setUploadProgress(0)
    } finally {
      setUploadingPdf(false)
    }
  }

  const saveDraftEnvelope = async (documentId: string, nextTitle: string) => {
    if (!sourceEntity) {
      throw new Error("Missing source entity")
    }

    await saveDocumentDraftEnvelopeAction({
      document_id: documentId,
      source_entity_type: sourceEntity.type,
      source_entity_id: sourceEntity.id,
      title: nextTitle,
      signing_order_enabled: signingOrderEnabled,
      recipients: serializeDraftRecipients(recipients),
    })
  }

  const goToFieldPlacement = async () => {
    if (!sourceEntity?.project_id) {
      toast.error("Source project is missing")
      return
    }
    if (!uploadedPdf) {
      toast.error("Upload a PDF first")
      return
    }

    const signersWithEmail = signerRecipients.filter((recipient) => recipient.email.trim().length > 0)
    if (signersWithEmail.length === 0) {
      toast.error("Add at least one signer email")
      return
    }

    setMovingToFields(true)
    try {
      const draftTitle = documentTitle.trim() || uploadedPdf.fileName.replace(/\.pdf$/i, "")
      const draftRecipients = serializeDraftRecipients(recipients)
      let activeDocument = viewerDocument

      if (!activeDocument) {
        const metadataEntityKey = sourceEntityMetadataIdKeyByType[sourceEntity.type]
        const document = await createDocumentAction({
          project_id: sourceEntity.project_id,
          document_type: sourceEntity.document_type,
          title: draftTitle,
          source_file_id: uploadedPdf.id,
          source_entity_type: sourceEntity.type,
          source_entity_id: sourceEntity.id,
          metadata: {
            [metadataEntityKey]: sourceEntity.id,
            source_entity_type: sourceEntity.type,
            source_entity_id: sourceEntity.id,
            draft_recipients: draftRecipients,
            draft_signing_order_enabled: signingOrderEnabled,
          },
        })

        const hydratedDocument = { id: document.id, title: document.title, document_type: document.document_type }
        activeDocument = hydratedDocument
        setViewerDocument(hydratedDocument)
        setViewerFields([])
        setViewerFileUrl(uploadedPdf.url)
      }

      if (!activeDocument) {
        throw new Error("Draft document is unavailable")
      }

      await saveDraftEnvelope(activeDocument.id, draftTitle)
      setPrepareStep("fields")
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to open field placement", { description: error?.message ?? "Please try again." })
    } finally {
      setMovingToFields(false)
    }
  }

  const handleSaveFields = async (showToast = true) => {
    if (!viewerDocument) return false

    try {
      const draftTitle = documentTitle.trim() || viewerDocument.title
      await saveDocumentFieldsAction(
        viewerDocument.id,
        1,
        viewerFields.map((field, index) => ({
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
      await saveDraftEnvelope(viewerDocument.id, draftTitle)
      if (viewerDocument.title !== draftTitle) {
        setViewerDocument((prev) => (prev ? { ...prev, title: draftTitle } : prev))
      }
      if (showToast) toast.success("Fields saved")
      return true
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to save fields", { description: error?.message ?? "Please try again." })
      return false
    }
  }

  const handleSendEnvelope = async () => {
    if (!viewerDocument) return
    if (viewerFields.length === 0) {
      toast.error("Add at least one field before sending")
      return
    }
    setSendingEnvelope(true)

    try {
      const hasSaved = await handleSaveFields(false)
      if (!hasSaved) return

      const signerSequenceById = new Map(
        recipients
          .filter((recipient) => recipient.role === "signer")
          .map((recipient, index) => [recipient.id, index + 1]),
      )
      const preparedRecipients = recipients
        .map((recipient) => ({
          name: recipient.name.trim(),
          email: recipient.email.trim(),
          role: recipient.role,
          signer_role: recipient.signer_role,
          sequence:
            recipient.role === "signer"
              ? signingOrderEnabled
                ? signerSequenceById.get(recipient.id) ?? 1
                : 1
              : undefined,
        }))
        .filter((recipient) => recipient.email.length > 0)

      const signerCount = preparedRecipients.filter((recipient) => recipient.role === "signer").length
      if (signerCount === 0) {
        toast.error("Add at least one signer")
        return
      }

      const result = await sendDocumentEnvelopeAction({
        document_id: viewerDocument.id,
        recipients: preparedRecipients,
      })
      onEnvelopeSent?.({
        documentId: viewerDocument.id,
        envelopeId: result?.envelopeId ?? null,
      })
      toast.success("Envelope sent")
      closeWizard(false)
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to send envelope", { description: error?.message ?? "Please try again." })
    } finally {
      setSendingEnvelope(false)
    }
  }

  const canAdvanceToFields = !!uploadedPdf && !uploadingPdf && !hydratingDraft

  return (
    <Sheet open={open} onOpenChange={closeWizard}>
      <SheetContent
        side="right"
        mobileFullscreen
        className={cn(
          "sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0",
          "transition-[max-width] duration-400 ease-[cubic-bezier(0.32,0.72,0,1)]",
        )}
        style={{
          maxWidth: prepareStep === "fields" ? "min(84rem, calc(100vw - 2rem))" : "42rem",
        }}
      >
        <SheetHeader
          className={cn(
            "px-6 pt-6 border-b bg-muted/30",
            prepareStep === "fields" ? "pb-0" : "pb-4",
          )}
        >
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {prepareStep === "fields" ? viewerDocument?.title || "Document" : sheetTitle}
          </SheetTitle>
          {prepareStep === "envelope" && (
            <SheetDescription>{sheetDescription}</SheetDescription>
          )}
        </SheetHeader>

        {prepareStep === "envelope" ? (
          <>
            {hydratingDraft && (
              <div className="border-b px-6 py-2 text-xs text-muted-foreground">
                Restoring saved draft...
              </div>
            )}
            <ScrollArea className="flex-1 min-h-0">
              <div className="px-6 py-4 space-y-6">
                <div className="space-y-2">
                  <Label>{sourceLabel}</Label>
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    {sourceEntity?.title ?? "—"}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Document name</Label>
                  <Input
                    value={documentTitle}
                    onChange={(event) => setDocumentTitle(event.target.value)}
                    placeholder="Document title"
                  />
                </div>

                <div className="space-y-2">
                  <Label>PDF file</Label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(event) => void handleFileSelected(event.target.files?.[0] ?? null)}
                  />
                  <div
                    className={cn(
                      "rounded-lg border-2 border-dashed p-6 text-center transition",
                      uploadDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/30",
                    )}
                    onDragOver={(event) => {
                      event.preventDefault()
                      setUploadDragActive(true)
                    }}
                    onDragLeave={() => setUploadDragActive(false)}
                    onDrop={(event) => {
                      event.preventDefault()
                      setUploadDragActive(false)
                      const file = event.dataTransfer.files?.[0] ?? null
                      void handleFileSelected(file)
                    }}
                  >
                    <Upload className="mx-auto h-5 w-5 text-muted-foreground" />
                    <p className="mt-2 text-sm">Drag and drop PDF here</p>
                    <p className="text-xs text-muted-foreground">or</p>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-2"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingPdf}
                    >
                      Choose file
                    </Button>
                    {uploadingPdf && (
                      <div className="mx-auto mt-3 w-full max-w-sm space-y-1.5">
                        <Progress value={uploadProgress} className="h-1.5" />
                        <p className="text-xs text-muted-foreground">Uploading PDF... {Math.round(uploadProgress)}%</p>
                      </div>
                    )}
                    {uploadedPdf && !uploadingPdf && (
                      <p className="mt-2 text-xs text-emerald-600">Uploaded: {uploadedPdf.fileName}</p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Label>Recipients</Label>
                      <div className="flex items-center gap-2 rounded-md border bg-background/70 px-2 py-1">
                        <Switch
                          id="envelope-signing-order"
                          checked={signingOrderEnabled}
                          onCheckedChange={setSigningOrderEnabled}
                        />
                        <Label htmlFor="envelope-signing-order" className="text-xs font-normal text-muted-foreground">
                          Enforce signing order
                        </Label>
                      </div>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addRecipient}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add recipient
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {signingOrderEnabled
                      ? "Signers receive email one at a time based on order."
                      : "All signer emails are sent at once; CC receives the executed document."}
                  </p>

                  <DndContext sensors={recipientSensors} collisionDetection={closestCenter} onDragEnd={handleRecipientDragEnd}>
                    <SortableContext items={recipients.map((recipient) => recipient.id)} strategy={verticalListSortingStrategy}>
                      <div className="space-y-2">
                        {recipients.map((recipient, index) => (
                          <RecipientCard
                            key={recipient.id}
                            recipient={recipient}
                            index={index}
                            suggestions={recipientSuggestions}
                            signerOrder={signerOrderById.get(recipient.id)}
                            signerCount={signerRecipients.length}
                            signingOrderEnabled={signingOrderEnabled}
                            canDelete={recipients.length > 1}
                            onChange={updateRecipient}
                            onSignerOrderChange={updateSignerOrder}
                            onDelete={removeRecipient}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              </div>
            </ScrollArea>

            <div className="border-t px-6 py-4 flex items-center justify-end">
              <Button type="button" onClick={() => void goToFieldPlacement()} disabled={!canAdvanceToFields || movingToFields}>
                {hydratingDraft || movingToFields ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {hydratingDraft ? "Restoring draft..." : movingToFields ? "Opening field placement..." : "Next: Place fields"}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 -mt-px">
            {viewerDocument && viewerFileUrl ? (
              <ESignDocumentViewer
                open={prepareStep === "fields"}
                title={viewerDocument.title}
                documentType={viewerDocument.document_type}
                fileUrl={viewerFileUrl}
                fields={viewerFields}
                setFields={setViewerFields}
                onSave={() => void handleSaveFields(true)}
                signerRoles={signerRoleOptions}
                onSend={() => void handleSendEnvelope()}
                sendDisabled={sendingEnvelope}
                sendLoading={sendingEnvelope}
                sendLabel={sendingEnvelope ? "Sending..." : "Send"}
                embedded
                className="h-full"
                onBack={() => setPrepareStep("envelope")}
              />
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function RecipientCard({
  recipient,
  index,
  suggestions,
  signerOrder,
  signerCount,
  signingOrderEnabled,
  canDelete,
  onChange,
  onSignerOrderChange,
  onDelete,
}: {
  recipient: EnvelopeRecipient
  index: number
  suggestions: RecipientSuggestion[]
  signerOrder?: number
  signerCount: number
  signingOrderEnabled: boolean
  canDelete: boolean
  onChange: (id: string, patch: Partial<EnvelopeRecipient>) => void
  onSignerOrderChange: (id: string, nextOrder: number) => void
  onDelete: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: recipient.id })
  const [nameSuggestionsOpen, setNameSuggestionsOpen] = useState(false)
  const [emailSuggestionsOpen, setEmailSuggestionsOpen] = useState(false)
  const normalizedSuggestions = useMemo(
    () =>
      suggestions
        .map((suggestion) => ({
          name: suggestion.name.trim(),
          email: suggestion.email.trim(),
        }))
        .filter((suggestion) => suggestion.name.length > 0 && suggestion.email.length > 0),
    [suggestions],
  )
  const nameQuery = recipient.name.trim().toLowerCase()
  const emailQuery = recipient.email.trim().toLowerCase()
  const nameMatches = useMemo(() => {
    if (!nameQuery) return normalizedSuggestions.slice(0, 8)
    return normalizedSuggestions
      .filter(
        (suggestion) =>
          suggestion.name.toLowerCase().includes(nameQuery) ||
          suggestion.email.toLowerCase().includes(nameQuery),
      )
      .slice(0, 8)
  }, [nameQuery, normalizedSuggestions])
  const emailMatches = useMemo(() => {
    if (!emailQuery) return normalizedSuggestions.slice(0, 8)
    return normalizedSuggestions
      .filter(
        (suggestion) =>
          suggestion.email.toLowerCase().includes(emailQuery) ||
          suggestion.name.toLowerCase().includes(emailQuery),
      )
      .slice(0, 8)
  }, [emailQuery, normalizedSuggestions])

  return (
    <div
      ref={setNodeRef}
      className="rounded-lg border bg-muted/20 px-3 py-2"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className="flex items-center gap-2">
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted cursor-grab active:cursor-grabbing"
            aria-label="Reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          {recipient.role === "signer" ? (
            <Select
              value={String(signerOrder ?? 1)}
              onValueChange={(value) => onSignerOrderChange(recipient.id, Number(value))}
              disabled={!signingOrderEnabled}
            >
              <SelectTrigger className="h-9 w-[56px] px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: Math.max(signerCount, 1) }).map((_, idx) => (
                  <SelectItem key={idx + 1} value={String(idx + 1)}>
                    {idx + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex h-9 w-[56px] items-center justify-center rounded-md border text-xs text-muted-foreground">CC</div>
          )}
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
          <Popover open={nameSuggestionsOpen && nameMatches.length > 0} onOpenChange={setNameSuggestionsOpen}>
            <PopoverAnchor asChild>
              <Input
                placeholder={`Recipient ${index + 1} name`}
                value={recipient.name}
                autoComplete="off"
                onFocus={() => setNameSuggestionsOpen(true)}
                onChange={(event) => {
                  const nextName = event.target.value
                  const matched = normalizedSuggestions.find(
                    (suggestion) => suggestion.name.toLowerCase() === nextName.trim().toLowerCase(),
                  )
                  onChange(recipient.id, {
                    name: nextName,
                    ...(matched && !recipient.email.trim() ? { email: matched.email } : {}),
                  })
                  setNameSuggestionsOpen(true)
                }}
              />
            </PopoverAnchor>
            <PopoverContent align="start" className="w-[min(26rem,calc(100vw-3rem))] p-0" sideOffset={6}>
              <Command>
                <CommandList>
                  <CommandEmpty>No matching recipients.</CommandEmpty>
                  <CommandGroup>
                    {nameMatches.map((suggestion) => (
                      <CommandItem
                        key={`name-${suggestion.source}-${suggestion.email.toLowerCase()}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onSelect={() => {
                          onChange(recipient.id, {
                            name: suggestion.name,
                            email: recipient.email.trim() || suggestion.email,
                          })
                          setNameSuggestionsOpen(false)
                        }}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span>{suggestion.name}</span>
                          <span className="text-xs text-muted-foreground">{suggestion.email}</span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          <Popover open={emailSuggestionsOpen && emailMatches.length > 0} onOpenChange={setEmailSuggestionsOpen}>
            <PopoverAnchor asChild>
              <Input
                placeholder="email@client.com"
                value={recipient.email}
                autoComplete="off"
                onFocus={() => setEmailSuggestionsOpen(true)}
                onChange={(event) => {
                  const nextEmail = event.target.value
                  const matched = normalizedSuggestions.find(
                    (suggestion) => suggestion.email.toLowerCase() === nextEmail.trim().toLowerCase(),
                  )
                  onChange(recipient.id, {
                    email: nextEmail,
                    ...(matched && !recipient.name.trim() ? { name: matched.name } : {}),
                  })
                  setEmailSuggestionsOpen(true)
                }}
              />
            </PopoverAnchor>
            <PopoverContent align="start" className="w-[min(26rem,calc(100vw-3rem))] p-0" sideOffset={6}>
              <Command>
                <CommandList>
                  <CommandEmpty>No matching recipients.</CommandEmpty>
                  <CommandGroup>
                    {emailMatches.map((suggestion) => (
                      <CommandItem
                        key={`email-${suggestion.source}-${suggestion.email.toLowerCase()}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onSelect={() => {
                          onChange(recipient.id, {
                            email: suggestion.email,
                            name: recipient.name.trim() || suggestion.name,
                          })
                          setEmailSuggestionsOpen(false)
                        }}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span>{suggestion.email}</span>
                          <span className="text-xs text-muted-foreground">{suggestion.name}</span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <Select value={recipient.role} onValueChange={(value) => onChange(recipient.id, { role: value as RecipientRole })}>
            <SelectTrigger className="h-9 w-12 gap-1 px-1.5" aria-label="Recipient role">
              {recipient.role === "signer" ? <User className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="signer">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4" />
                  <span>Signer</span>
                </div>
              </SelectItem>
              <SelectItem value="cc">
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  <span>CC</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="icon" onClick={() => onDelete(recipient.id)} disabled={!canDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

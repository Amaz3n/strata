"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  completeESignDocumentUploadAction,
  createESignDocumentUploadUrlAction,
  createVersionedSourceDocumentDraftAction,
  createDocumentAction,
  getDraftDocumentByIdAction,
  getSourceEntityVersionContextAction,
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
  standalone?: boolean
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
  resumeDocumentId?: string | null
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

function uploadFileToSignedUrl(input: {
  uploadUrl: string
  file: File
  onProgress: (percent: number) => void
}) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", input.uploadUrl, true)
    xhr.setRequestHeader("Content-Type", input.file.type || "application/pdf")
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      const percent = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)))
      input.onProgress(percent)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        input.onProgress(99)
        resolve()
        return
      }
      reject(new Error(`Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error("Upload failed"))
    xhr.send(input.file)
  })
}

export function EnvelopeWizard({
  open,
  onOpenChange,
  sourceEntity,
  resumeDocumentId = null,
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
  const [documentType, setDocumentType] = useState<DocumentType>("other")
  const [nextVersionNumber, setNextVersionNumber] = useState<number | null>(null)
  const [latestSourceDocumentType, setLatestSourceDocumentType] = useState<DocumentType | null>(null)
  const [hydratingDraft, setHydratingDraft] = useState(false)
  const [movingToFields, setMovingToFields] = useState(false)
  const [prewarmingFieldsStep, setPrewarmingFieldsStep] = useState(false)
  const [fieldsStepReady, setFieldsStepReady] = useState(false)
  const [sendingEnvelope, setSendingEnvelope] = useState(false)
  const [recipientSuggestions, setRecipientSuggestions] = useState<RecipientSuggestion[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftHydrationRef = useRef(0)
  const prepareKeyRef = useRef<string | null>(null)
  const preparePromiseRef = useRef<Promise<void> | null>(null)
  const prewarmedPdfUrlRef = useRef<string | null>(null)
  const directUploadDisabledRef = useRef(false)

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
  const sourceEntityId = sourceEntity?.standalone ? null : (sourceEntity?.id ?? null)
  const sourceEntityType = sourceEntity?.standalone ? null : (sourceEntity?.type ?? null)
  const sourceEntityTitle = sourceEntity?.title ?? ""
  const sourceEntityDocumentType = sourceEntity?.document_type ?? "other"
  const signerRecipientsWithEmail = useMemo(
    () => signerRecipients.filter((recipient) => recipient.email.trim().length > 0),
    [signerRecipients],
  )
  const recipientSignature = useMemo(
    () =>
      JSON.stringify(
        recipients.map((recipient) => ({
          role: recipient.role,
          name: recipient.name.trim(),
          email: recipient.email.trim().toLowerCase(),
          signer_role: recipient.signer_role,
        })),
      ),
    [recipients],
  )

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
    if (!open) return
    void import("react-pdf").catch(() => null)
  }, [open])

  useEffect(() => {
    if (!open || !resumeDocumentId) return

    const hydrationId = draftHydrationRef.current + 1
    draftHydrationRef.current = hydrationId

    setPrepareStep("envelope")
    setDocumentTitle(sourceEntityTitle)
    setDocumentType(sourceEntityDocumentType)
    setNextVersionNumber(null)
    setLatestSourceDocumentType(null)
    setSigningOrderEnabled(true)
    setRecipients([createRecipient("signer")])
    setUploadedPdf(null)
    setUploadingPdf(false)
    setUploadProgress(0)
    setUploadDragActive(false)
    setHydratingDraft(true)
    setMovingToFields(false)
    setPrewarmingFieldsStep(false)
    setFieldsStepReady(false)
    prepareKeyRef.current = null
    preparePromiseRef.current = null
    prewarmedPdfUrlRef.current = null
    directUploadDisabledRef.current = false
    setSendingEnvelope(false)
    setRecipientSuggestions([])
    setViewerFields([])
    setViewerDocument(null)
    setViewerFileUrl(null)

    void (async () => {
      try {
        const [draft, suggestions] = await Promise.all([
          getDraftDocumentByIdAction(resumeDocumentId),
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

        setDocumentTitle(draft.document.title || sourceEntityTitle || "Document")
        setDocumentType((draft.document.document_type as DocumentType) ?? sourceEntityDocumentType)
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
  }, [open, resumeDocumentId, sourceEntityDocumentType, sourceEntityTitle])

  useEffect(() => {
    if (resumeDocumentId) return
    if (!open || !sourceEntityId || !sourceEntityType) return

    const hydrationId = draftHydrationRef.current + 1
    draftHydrationRef.current = hydrationId

    setPrepareStep("envelope")
    setDocumentTitle(sourceEntityTitle)
    setDocumentType(sourceEntityDocumentType)
    setNextVersionNumber(null)
    setLatestSourceDocumentType(null)
    setSigningOrderEnabled(true)
    setRecipients([createRecipient("signer")])
    setUploadedPdf(null)
    setUploadingPdf(false)
    setUploadProgress(0)
    setUploadDragActive(false)
    setHydratingDraft(true)
    setMovingToFields(false)
    setPrewarmingFieldsStep(false)
    setFieldsStepReady(false)
    prepareKeyRef.current = null
    preparePromiseRef.current = null
    prewarmedPdfUrlRef.current = null
    directUploadDisabledRef.current = false
    setSendingEnvelope(false)
    setRecipientSuggestions([])
    setViewerFields([])
    setViewerDocument(null)
    setViewerFileUrl(null)

    void (async () => {
      try {
        const [draft, suggestions, versionContext] = await Promise.all([
          getSourceEntityDraftAction({
            source_entity_type: sourceEntityType,
            source_entity_id: sourceEntityId,
          }),
          listEnvelopeRecipientSuggestionsAction(),
          getSourceEntityVersionContextAction({
            source_entity_type: sourceEntityType,
            source_entity_id: sourceEntityId,
          }),
        ])

        if (hydrationId !== draftHydrationRef.current) return
        setRecipientSuggestions(suggestions ?? [])
        setNextVersionNumber(versionContext?.next_version_number ?? null)
        setLatestSourceDocumentType((versionContext?.latest_document_type as DocumentType | null) ?? null)

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
        setDocumentType((draft.document.document_type as DocumentType) ?? sourceEntityDocumentType)
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
  }, [open, resumeDocumentId, sourceEntityDocumentType, sourceEntityId, sourceEntityTitle, sourceEntityType])

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
      setDocumentType(sourceEntity?.document_type ?? "other")
      setNextVersionNumber(null)
      setLatestSourceDocumentType(null)
      setSigningOrderEnabled(true)
      setRecipients([createRecipient("signer")])
      setUploadedPdf(null)
      setUploadingPdf(false)
      setUploadProgress(0)
      setUploadDragActive(false)
      setHydratingDraft(false)
      setMovingToFields(false)
      setPrewarmingFieldsStep(false)
      setFieldsStepReady(false)
      prepareKeyRef.current = null
      preparePromiseRef.current = null
      prewarmedPdfUrlRef.current = null
      directUploadDisabledRef.current = false
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

    const applyUploadedFile = (uploaded: { id: string }) => {
      setUploadedPdf({
        id: uploaded.id,
        fileName: file.name,
        url: `/api/files/${uploaded.id}/raw`,
      })
      setUploadProgress(100)
      setViewerDocument(null)
      setViewerFields([])
      setViewerFileUrl(null)
      setFieldsStepReady(false)
      prepareKeyRef.current = null
      preparePromiseRef.current = null
      prewarmedPdfUrlRef.current = null
    }

    const uploadWithServerFallback = async () => {
      const formData = new FormData()
      formData.append("file", file)
      const uploaded = await uploadESignDocumentFileAction(sourceEntity.project_id as string, formData)
      applyUploadedFile(uploaded)
    }

    try {
      if (directUploadDisabledRef.current) {
        await uploadWithServerFallback()
      } else {
        try {
          const directUpload = await createESignDocumentUploadUrlAction({
            projectId: sourceEntity.project_id,
            fileName: file.name,
            fileType: file.type || "application/pdf",
            fileSize: file.size,
          })

          await uploadFileToSignedUrl({
            uploadUrl: directUpload.uploadUrl,
            file,
            onProgress: (percent) => setUploadProgress(percent),
          })

          const uploaded = await completeESignDocumentUploadAction({
            projectId: sourceEntity.project_id,
            storagePath: directUpload.storagePath,
            uploadToken: directUpload.uploadToken,
            fileName: file.name,
            fileType: file.type || "application/pdf",
            fileSize: file.size,
          })
          applyUploadedFile(uploaded)
        } catch {
          // Usually R2 CORS/network in browser. Disable direct mode for this session.
          directUploadDisabledRef.current = true
          await uploadWithServerFallback()
        }
      }
    } catch (error: any) {
      toast.error("Failed to upload PDF", { description: error?.message ?? "Please try again." })
      setUploadedPdf(null)
      setUploadProgress(0)
    } finally {
      setUploadingPdf(false)
    }
  }

  const saveDraftEnvelope = useCallback(async (documentId: string, nextTitle: string) => {
    await saveDocumentDraftEnvelopeAction({
      document_id: documentId,
      ...(sourceEntity?.standalone
        ? {}
        : {
            source_entity_type: sourceEntity?.type,
            source_entity_id: sourceEntity?.id,
          }),
      title: nextTitle,
      signing_order_enabled: signingOrderEnabled,
      recipients: serializeDraftRecipients(recipients),
    })
  }, [recipients, signingOrderEnabled, sourceEntity])

  const buildPreparationKey = useCallback(() => {
    const projectId = sourceEntity?.project_id ?? "none"
    const sourceKey =
      sourceEntity && !sourceEntity.standalone ? `${sourceEntity.type}:${sourceEntity.id}` : "standalone"
    const fileId = uploadedPdf?.id ?? "none"
    const titleKey = (documentTitle.trim() || uploadedPdf?.fileName?.replace(/\.pdf$/i, "") || "").toLowerCase()
    return [projectId, sourceKey, fileId, documentType, signingOrderEnabled ? "ordered" : "unordered", titleKey, recipientSignature].join("::")
  }, [documentTitle, documentType, recipientSignature, signingOrderEnabled, sourceEntity, uploadedPdf])

  const prewarmPdfInBackground = useCallback(async (fileUrl: string) => {
    if (!fileUrl || prewarmedPdfUrlRef.current === fileUrl) return

    try {
      await fetch(fileUrl, { credentials: "include" }).catch(() => null)
      const { pdfjs } = await import("react-pdf")
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
      const task = pdfjs.getDocument({ url: fileUrl, withCredentials: true })
      const pdf = await task.promise
      pdf.destroy()
      prewarmedPdfUrlRef.current = fileUrl
    } catch {
      // Best-effort prewarm; ignore and allow normal loading path.
    }
  }, [])

  const ensurePreparedForFields = useCallback(async (key: string) => {
    if (!sourceEntity?.project_id || !uploadedPdf) return false

    if (fieldsStepReady && prepareKeyRef.current === key && viewerDocument && viewerFileUrl === uploadedPdf.url) {
      return true
    }

    if (preparePromiseRef.current && prepareKeyRef.current === key) {
      await preparePromiseRef.current
      return true
    }

    const run = async () => {
      setPrewarmingFieldsStep(true)
      try {
        const draftTitle = documentTitle.trim() || uploadedPdf.fileName.replace(/\.pdf$/i, "")
        const draftRecipients = serializeDraftRecipients(recipients)
        let activeDocument = viewerDocument
        const needsNewDocumentForTypeChange = !!activeDocument && activeDocument.document_type !== documentType

        if (!activeDocument || needsNewDocumentForTypeChange) {
          const linkedSourceMetadata =
            sourceEntity && !sourceEntity.standalone
              ? (() => {
                  const metadataEntityKey = sourceEntityMetadataIdKeyByType[sourceEntity.type]
                  return {
                    source_entity_type: sourceEntity.type,
                    source_entity_id: sourceEntity.id,
                    metadata: {
                      [metadataEntityKey]: sourceEntity.id,
                      source_entity_type: sourceEntity.type,
                      source_entity_id: sourceEntity.id,
                    },
                  }
                })()
              : null

          const draftMetadata = {
            ...(linkedSourceMetadata?.metadata ?? {}),
            draft_recipients: draftRecipients,
            draft_signing_order_enabled: signingOrderEnabled,
          }

          const document = linkedSourceMetadata
            ? (
                await createVersionedSourceDocumentDraftAction({
                  project_id: sourceEntity.project_id,
                  document_type: documentType,
                  title: draftTitle,
                  source_file_id: uploadedPdf.id,
                  source_entity_type: linkedSourceMetadata.source_entity_type,
                  source_entity_id: linkedSourceMetadata.source_entity_id,
                  metadata: draftMetadata,
                })
              ).document
            : await createDocumentAction({
                project_id: sourceEntity.project_id,
                document_type: documentType,
                title: draftTitle,
                source_file_id: uploadedPdf.id,
                metadata: draftMetadata,
              })

          activeDocument = { id: document.id, title: document.title, document_type: document.document_type }
          setViewerDocument(activeDocument)
          setViewerFields([])
          setViewerFileUrl(uploadedPdf.url)
        } else if (viewerFileUrl !== uploadedPdf.url) {
          setViewerFileUrl(uploadedPdf.url)
        }

        if (!activeDocument) {
          throw new Error("Draft document is unavailable")
        }

        await saveDraftEnvelope(activeDocument.id, draftTitle)
        await prewarmPdfInBackground(uploadedPdf.url)
        setFieldsStepReady(true)
      } finally {
        setPrewarmingFieldsStep(false)
      }
    }

    prepareKeyRef.current = key
    preparePromiseRef.current = run()
    try {
      await preparePromiseRef.current
      return true
    } finally {
      if (prepareKeyRef.current === key) {
        preparePromiseRef.current = null
      }
    }
  }, [
    documentTitle,
    documentType,
    fieldsStepReady,
    recipients,
    saveDraftEnvelope,
    signingOrderEnabled,
    sourceEntity,
    uploadedPdf,
    viewerDocument,
    viewerFileUrl,
    prewarmPdfInBackground,
  ])

  useEffect(() => {
    if (!open || prepareStep !== "envelope") return
    if (!sourceEntity?.project_id || !uploadedPdf || uploadingPdf || hydratingDraft || movingToFields || sendingEnvelope) {
      return
    }

    const key = buildPreparationKey()
    if (prepareKeyRef.current !== key) {
      setFieldsStepReady(false)
    }

    const timer = window.setTimeout(() => {
      void ensurePreparedForFields(key).catch(() => {
        // Keep the manual Next path available; errors surface there.
      })
    }, 320)

    return () => window.clearTimeout(timer)
  }, [
    buildPreparationKey,
    documentTitle,
    documentType,
    hydratingDraft,
    movingToFields,
    open,
    prepareStep,
    recipientSignature,
    ensurePreparedForFields,
    sendingEnvelope,
    signerRecipientsWithEmail.length,
    signingOrderEnabled,
    sourceEntity,
    uploadedPdf,
    uploadingPdf,
  ])

  const goToFieldPlacement = async () => {
    if (!sourceEntity?.project_id) {
      toast.error("Source project is missing")
      return
    }
    if (!uploadedPdf) {
      toast.error("Upload a PDF first")
      return
    }

    if (signerRecipientsWithEmail.length === 0) {
      toast.error("Add at least one signer email")
      return
    }

    setMovingToFields(true)
    try {
      const key = buildPreparationKey()
      const prepared = await ensurePreparedForFields(key)
      if (!prepared) {
        toast.error("Complete recipients and upload a PDF first")
        return
      }
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
                  <Label>Document type</Label>
                  <Select value={documentType} onValueChange={(value) => setDocumentType(value as DocumentType)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select document type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="proposal">Proposal</SelectItem>
                      <SelectItem value="contract">Contract</SelectItem>
                      <SelectItem value="change_order">Change order</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  {sourceEntity && !sourceEntity.standalone && latestSourceDocumentType && latestSourceDocumentType !== documentType ? (
                    <p className="text-xs text-amber-700">
                      Changing type from {latestSourceDocumentType.replaceAll("_", " ")} to{" "}
                      {documentType.replaceAll("_", " ")} creates a new version. Older versions remain visible.
                    </p>
                  ) : null}
                  {sourceEntity && !sourceEntity.standalone && nextVersionNumber ? (
                    <p className="text-xs text-muted-foreground">This draft will be saved as version {nextVersionNumber}.</p>
                  ) : null}
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
                        <p className="text-xs text-muted-foreground">
                          {uploadProgress >= 96 ? "Finalizing upload..." : "Uploading PDF..."}
                        </p>
                      </div>
                    )}
                    {uploadedPdf && !uploadingPdf && (
                      <p className="mt-2 text-xs text-emerald-600">Uploaded: {uploadedPdf.fileName}</p>
                    )}
                    {prewarmingFieldsStep ? (
                      <p className="mt-1 text-xs text-muted-foreground">Preloading next step...</p>
                    ) : null}
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
                {hydratingDraft || movingToFields || prewarmingFieldsStep ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {hydratingDraft
                  ? "Restoring draft..."
                  : movingToFields
                    ? "Opening field placement..."
                    : prewarmingFieldsStep
                      ? "Preloading..."
                      : fieldsStepReady
                        ? "Next: Place fields"
                        : "Next: Place fields"}
              </Button>
            </div>

            {viewerDocument && viewerFileUrl ? (
              <div className="h-0 overflow-hidden pointer-events-none opacity-0">
                <ESignDocumentViewer
                  open
                  title={viewerDocument.title}
                  documentType={viewerDocument.document_type}
                  fileUrl={viewerFileUrl}
                  fields={viewerFields}
                  setFields={setViewerFields}
                  onSave={() => undefined}
                  signerRoles={signerRoleOptions}
                  embedded
                  className="h-0"
                />
              </div>
            ) : null}
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

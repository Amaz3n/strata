"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  listContractTemplatesAction,
  removeContractTemplateAction,
  uploadContractTemplateAction,
  type ContractTemplateFor,
  type ContractTemplateSummary,
} from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import { FileText, Loader2, Trash2, Upload } from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"

const TEMPLATE_TYPES: Array<{ value: ContractTemplateFor; label: string }> = [
  { value: "estimate", label: "Estimate" },
  { value: "change_order", label: "Change order" },
  { value: "subcontract", label: "Subcontract" },
  { value: "subcontract_change_order", label: "Subcontract change order" },
]

function formatSize(bytes?: number | null) {
  if (!bytes) return "PDF"
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ContractTemplateSettings({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<ContractTemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadingFor, setUploadingFor] = useState<ContractTemplateFor | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const loadTemplates = async () => {
    setLoading(true)
    try {
      setTemplates(await listContractTemplatesAction())
    } catch (error) {
      console.error(error)
      toast.error("Unable to load contract templates")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadTemplates()
  }, [])

  const byType = new Map(templates.map((template) => [template.template_for, template]))

  const uploadTemplate = async (templateFor: ContractTemplateFor, file?: File | null) => {
    if (!file) return
    const formData = new FormData()
    formData.append("file", file)
    setUploadingFor(templateFor)
    try {
      const result = unwrapAction(await uploadContractTemplateAction(templateFor, formData))
      if (result?.error) {
        toast.error("Unable to upload template", { description: result.error })
        return
      }
      toast.success("Contract template updated")
      await loadTemplates()
    } catch (error) {
      console.error(error)
      toast.error("Unable to upload template", { description: (error as Error).message })
    } finally {
      setUploadingFor(null)
      const input = inputRefs.current[templateFor]
      if (input) input.value = ""
    }
  }

  const removeTemplate = async (template: ContractTemplateSummary) => {
    setRemovingId(template.id)
    try {
      const result = unwrapAction(await removeContractTemplateAction(template.id))
      if (result?.error) {
        toast.error("Unable to remove template", { description: result.error })
        return
      }
      toast.success("Contract template removed")
      await loadTemplates()
    } catch (error) {
      console.error(error)
      toast.error("Unable to remove template", { description: (error as Error).message })
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-5 border-t border-border/70 pt-6">
      <div>
        <p className="text-sm font-semibold">Contract templates</p>
        <p className="text-xs text-muted-foreground">
          Standard terms PDFs can be prepended to signature packets as the paper terms, with the Arc document as the exhibit.
        </p>
      </div>
      <div className="divide-y rounded-md border">
        {TEMPLATE_TYPES.map((type) => {
          const template = byType.get(type.value)
          const busy = uploadingFor === type.value || (template ? removingId === template.id : false)
          return (
            <div key={type.value} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="text-sm font-medium">{type.label}</p>
                {loading ? (
                  <p className="text-xs text-muted-foreground">Loading...</p>
                ) : template ? (
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{template.file_name}</span>
                    <span>{formatSize(template.size_bytes)}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No PDF uploaded.</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={(node) => {
                    inputRefs.current[type.value] = node
                  }}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(event) => void uploadTemplate(type.value, event.target.files?.[0] ?? null)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canManage || busy}
                  onClick={() => inputRefs.current[type.value]?.click()}
                >
                  {uploadingFor === type.value ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {template ? "Replace" : "Upload"}
                </Button>
                {template ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={!canManage || busy}
                    onClick={() => void removeTemplate(template)}
                    aria-label={`Remove ${type.label} template`}
                  >
                    {removingId === template.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

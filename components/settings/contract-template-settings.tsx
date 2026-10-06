"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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

import { unwrapAction, type ActionResult } from "@/lib/action-result"

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

export function ContractTemplateSettings({ canManage, initialTemplates }: {
  canManage: boolean
  initialTemplates: ActionResult<ContractTemplateSummary[]>
}) {
  const [state, setState] = useState(() => ({
    source: initialTemplates,
    templates: initialTemplates.success ? initialTemplates.data : [],
    error: initialTemplates.success ? null : initialTemplates.error,
  }))
  if (state.source !== initialTemplates) {
    setState({
      source: initialTemplates,
      templates: initialTemplates.success ? initialTemplates.data : [],
      error: initialTemplates.success ? null : initialTemplates.error,
    })
  }
  const [loading, setLoading] = useState(false)
  const [uploadingFor, setUploadingFor] = useState<ContractTemplateFor | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const epoch = useRef(0)
  const canManageRef = useRef(canManage)
  const sourceRef = useRef(initialTemplates)
  const invalidateRequests = useCallback(() => {
    epoch.current++
    inFlight.current = false
  }, [])

  useEffect(() => {
    mounted.current = true
    setLoading(false)
    setUploadingFor(null)
    setRemovingId(null)
    for (const input of Object.values(inputRefs.current)) if (input) input.value = ""
    return () => {
      mounted.current = false
      invalidateRequests()
    }
  }, [invalidateRequests])

  useEffect(() => {
    sourceRef.current = initialTemplates
    canManageRef.current = canManage
    if (!canManage) {
      invalidateRequests()
      setLoading(false)
      setUploadingFor(null)
      setRemovingId(null)
      for (const input of Object.values(inputRefs.current)) if (input) input.value = ""
    }
  }, [initialTemplates, canManage, invalidateRequests])

  const isCurrent = (request: number) => mounted.current && canManageRef.current && epoch.current === request

  const loadTemplates = async (request: number, source: typeof initialTemplates) => {
    setLoading(true)
    try {
      const templates = await listContractTemplatesAction()
      if (!isCurrent(request)) return
      setState(current => current.source === source ? { ...current, templates, error: null } : current)
    } catch (error) {
      if (!isCurrent(request)) return
      setState(current => current.source === source ? {
        ...current,
        error: error instanceof Error ? error.message : "Unable to load contract templates",
      } : current)
    } finally {
      if (isCurrent(request)) setLoading(false)
    }
  }

  const retry = async () => {
    if (!mounted.current || !canManageRef.current || inFlight.current) return
    inFlight.current = true
    const request = epoch.current
    try {
      await loadTemplates(request, initialTemplates)
    } finally {
      if (isCurrent(request)) inFlight.current = false
    }
  }

  const byType = new Map(state.templates.map((template) => [template.template_for, template]))
  const busy = loading || uploadingFor !== null || removingId !== null

  const uploadTemplate = async (templateFor: ContractTemplateFor, file?: File | null) => {
    if (!file || !mounted.current || !canManageRef.current || inFlight.current) return
    inFlight.current = true
    const request = epoch.current
    const formData = new FormData()
    formData.append("file", file)
    setUploadingFor(templateFor)
    try {
      const reply = await uploadContractTemplateAction(templateFor, formData)
      if (!isCurrent(request)) return
      const result = unwrapAction(reply)
      if (result?.error) {
        toast.error("Unable to upload template", { description: result.error })
        return
      }
      toast.success("Contract template updated")
      if (sourceRef.current === initialTemplates) await loadTemplates(request, initialTemplates)
    } catch (error) {
      if (!isCurrent(request)) return
      toast.error("Unable to upload template", { description: error instanceof Error ? error.message : undefined })
    } finally {
      if (isCurrent(request)) {
        inFlight.current = false
        setUploadingFor(null)
        const input = inputRefs.current[templateFor]
        if (input) input.value = ""
      }
    }
  }

  const removeTemplate = async (template: ContractTemplateSummary) => {
    if (!mounted.current || !canManageRef.current || inFlight.current) return
    inFlight.current = true
    const request = epoch.current
    setRemovingId(template.id)
    try {
      const reply = await removeContractTemplateAction(template.id)
      if (!isCurrent(request)) return
      const result = unwrapAction(reply)
      if (result?.error) {
        toast.error("Unable to remove template", { description: result.error })
        return
      }
      toast.success("Contract template removed")
      if (sourceRef.current === initialTemplates) await loadTemplates(request, initialTemplates)
    } catch (error) {
      if (!isCurrent(request)) return
      toast.error("Unable to remove template", { description: error instanceof Error ? error.message : undefined })
    } finally {
      if (isCurrent(request)) {
        inFlight.current = false
        setRemovingId(null)
      }
    }
  }

  return (
    <>
      {state.error ? (
        <div role="alert" className="flex items-center justify-between gap-3 py-3 text-sm text-destructive">
          <p>{state.error}</p>
          <Button variant="outline" size="sm" disabled={!canManage || busy} onClick={() => void retry()}>
            Retry template loading
          </Button>
        </div>
      ) : null}
      {TEMPLATE_TYPES.map((type) => {
        const template = byType.get(type.value)
        return (
          <div
            key={type.value}
            className="grid gap-2 py-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-center sm:gap-8"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium leading-5 text-foreground">{type.label}</p>
              {loading ? (
                <p className="mt-1 text-xs text-muted-foreground">Loading…</p>
              ) : template ? (
                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <FileText className="size-3.5 shrink-0" />
                  <span className="truncate">{template.file_name}</span>
                  <span className="shrink-0 tabular-nums">· {formatSize(template.size_bytes)}</span>
                </span>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">No PDF uploaded.</p>
              )}
            </div>
            <div className="flex items-center gap-2 sm:justify-end">
              <input
                ref={(node) => {
                  inputRefs.current[type.value] = node
                }}
                type="file"
                aria-label={`Upload ${type.label} template`}
                disabled={!canManage || busy}
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
                {uploadingFor === type.value ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
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
                  {removingId === template.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
    </>
  )
}

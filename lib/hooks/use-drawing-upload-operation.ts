"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { reserveDrawingUploadAction, createDrawingSetFromUpload, cancelDrawingUploadAction, getDrawingUploadOperationAction, renewDrawingUploadAction } from "@/app/(app)/drawings/actions"
import { unwrapAction } from "@/lib/action-result"
import { acknowledgeDrawingUpload, uploadDrawingFileToStorage } from "@/lib/services/drawings-client"
import { fingerprintUpload, type UploadProgress, type TransferState } from "@/lib/services/multipart-upload-client"

type Intent = Omit<Parameters<typeof createDrawingSetFromUpload>[0], "operationId" | "storagePath" | "generation">
type Saved = { operationId: string; fingerprint: string; intent: Intent }
const keyFor = (orgId: string, projectId: string) => `arc-drawing-operation:v1:${orgId}:${projectId}`

/** One owner for both upload entry points. Only the receipt survives navigation; file bytes do not. */
export function useDrawingUploadOperation(projectId: string | null | undefined) {
  const [saved, setSaved] = useState<Saved | null>(null)
  const [state, setState] = useState<TransferState>("idle")
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const cancelling = useRef(false)
  const registered = useRef(false)
  const settled = useRef<Promise<void> | null>(null)
  const receipt = useRef<Saved | null>(null)
  const storageKey = useRef<string | null>(null)
  const persist = useCallback((value: Saved | null) => {
    receipt.current = value; setSaved(value)
    try { if (storageKey.current) {
      if (value) localStorage.setItem(storageKey.current, JSON.stringify(value))
      else localStorage.removeItem(storageKey.current)
    } } catch { /* Persistence is optional; server receipts remain authoritative. */ }
  }, [])
  useEffect(() => {
    const orgId = document.cookie.match(/(?:^|; )org_id=([^;]+)/)?.[1]
    if (!orgId || !projectId) return
    storageKey.current = keyFor(orgId, projectId)
    let value: Saved | null = null
    try { value = JSON.parse(localStorage.getItem(storageKey.current) || "null") } catch { /* Ignore invalid local hints. */ }
    if (value?.operationId && value?.intent?.projectId === projectId) {
      receipt.current = value; setSaved(value); setState("paused")
      let active = true
      void getDrawingUploadOperationAction(value.operationId, projectId).then(result => {
        if (!active || controller.current) return
        if (result.success && result.data && ["registered", "cancelled"].includes(result.data.status)) { persist(null); setState("idle") }
      }).catch(() => { /* The saved receipt can be retried after a transient read failure. */ })
      return () => { active = false; controller.current?.abort("pause") }
    } else { receipt.current = null; setSaved(null); setState("idle") }
    return () => { controller.current?.abort("pause") }
  }, [projectId, persist])
  const run = useCallback(async (file: File, intent: Intent) => {
    if (controller.current) throw new Error("An upload is already running")
    const abort = new AbortController(); controller.current = abort
    cancelling.current = false
    registered.current = false
    let resolveSettled!: () => void
    settled.current = new Promise(resolve => { resolveSettled = resolve })
    const orgId = document.cookie.match(/(?:^|; )org_id=([^;]+)/)?.[1]
    if (!orgId) { controller.current = null; resolveSettled(); settled.current = null; throw new Error("Organization not found. Please refresh.") }
    storageKey.current = keyFor(orgId, intent.projectId)
    let renewal: ReturnType<typeof setInterval> | undefined
    const execute = async () => { try {
      setState("transferring"); setStage("Checking PDF…")
      const fingerprint = await fingerprintUpload(file, abort.signal)
      let operation = receipt.current
      if (operation && (operation.fingerprint !== fingerprint || operation.intent.targetSheetId !== intent.targetSheetId)) throw new Error("Reselect the same PDF to resume, or cancel the saved upload first.")
      if (!operation) { operation = { operationId: crypto.randomUUID(), fingerprint, intent: { ...intent, fingerprint } }; persist(operation) }
      const reservation = unwrapAction(await reserveDrawingUploadAction({ ...operation.intent, operationId: operation.operationId, fingerprint }))
      let renewing = false
      if (reservation.status === "reserved") renewal = setInterval(() => {
        if (renewing || abort.signal.aborted) return
        renewing = true
        void renewDrawingUploadAction(operation!.operationId, intent.projectId, reservation.generation).catch(() => undefined).finally(() => { renewing = false })
      }, 5 * 60 * 1000)
      let storagePath = reservation.storage_path
      if (reservation.status !== "registered") {
        const result = await uploadDrawingFileToStorage(file, intent.projectId, orgId, {
          operationId: operation.operationId, generation: reservation.generation, fingerprint,
          initialTransferId: reservation.transfer_id ?? undefined,
          initialSession: reservation.transfer_id && reservation.multipart_upload_id ? { transferId: reservation.transfer_id, uploadId: reservation.multipart_upload_id, storagePath: reservation.storage_path, partSize: 16 * 1024 * 1024 } : undefined,
          signal: abort.signal, onState: setState, onProgress: setProgress,
          onStage: value => setStage(value === "preparing" ? "Preparing upload…" : value === "uploading" ? "Uploading PDF…" : "Finalizing upload…"),
        })
        storagePath = result.storagePath
      }
      if (abort.signal.aborted) throw new DOMException("Upload paused", "AbortError")
      setStage("Registering PDF…")
      const result = unwrapAction(await createDrawingSetFromUpload({ ...operation.intent, fingerprint, operationId: operation.operationId, generation: reservation.generation, storagePath }))
      acknowledgeDrawingUpload(file, intent.projectId, orgId, operation.operationId, reservation.generation)
      registered.current = true
      persist(null); setState("completed"); setProgress(null); setStage(null)
      return result
    } catch (error) {
      if (!cancelling.current) { setState("paused"); setStage("Upload paused. Resume with the same PDF; after reloading, reselect it first.") }
      throw error
    } }
    try {
      if (navigator.locks) return await navigator.locks.request(`arc-drawing-upload:${orgId}:${intent.projectId}`, { ifAvailable: true }, lock => {
        if (!lock) throw new Error("This project has an upload running in another tab.")
        return execute()
      })
      return await execute()
    } finally { clearInterval(renewal); controller.current = null; resolveSettled(); settled.current = null }
  }, [persist])
  const pause = useCallback(() => controller.current?.abort("pause"), [])
  const cancel = useCallback(async () => {
    cancelling.current = true
    controller.current?.abort("pause")
    await settled.current
    const operation = receipt.current
    if (!operation) {
      if (!registered.current) { setState("cancelled"); setProgress(null); setStage(null) }
      return
    }
    const current = unwrapAction(await getDrawingUploadOperationAction(operation.operationId, operation.intent.projectId))
    if (!current) { persist(null); setState("cancelled"); setProgress(null); setStage(null); return }
    const result = unwrapAction(await cancelDrawingUploadAction(operation.operationId, operation.intent.projectId))
    if (result.status === "registered") {
      persist(null); setState("completed"); setProgress(null); setStage("The PDF was already registered. Processing continues in the drawing package.")
      return
    }
    persist(null); setState("cancelled"); setProgress(null); setStage(null)
  }, [persist])
  return { run, pause, cancel, saved, state, progress, stage }
}

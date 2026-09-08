"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { invoiceFileError, type IntakeRow } from "@/lib/payables/intake"

/** Keep uploads bounded; each accepted request starts its own durable scan. */
export function usePayableIntake(projectId: string | undefined, onReady: () => void) {
  const [rows, setRows] = useState<IntakeRow[]>([])
  const pending = useRef<Array<{ id: string; file: File; projectId?: string }>>([])
  const files = useRef(new Map<string, File>())
  const running = useRef(0)
  const ready = useRef(onReady)
  ready.current = onReady
  const scope = useRef(projectId)
  scope.current = projectId
  const patch = useCallback((row: IntakeRow) => setRows(current => {
    const index = current.findIndex(item => item.id === row.id)
    return index < 0 ? [...current, row] : current.map(item => item.id === row.id ? row : item)
  }), [])

  const drain = useCallback(function drainQueue() {
    while (running.current < 3 && pending.current.length) {
      const next = pending.current.shift()!
      running.current += 1
      if (scope.current === next.projectId) patch({ id: next.id, name: next.file.name, stage: "uploading" })
      void (async () => {
        try {
          const form = new FormData()
          form.set("id", next.id)
          form.set("invoice", next.file)
          if (next.projectId) form.set("projectId", next.projectId)
          const response = await fetch("/api/payables/intake", { method: "POST", body: form })
          const result = await response.json()
          if (!response.ok) throw new Error(result.error || "Upload failed")
          files.current.delete(next.id)
          if (scope.current === next.projectId) { patch(result.row); ready.current() }
        } catch (error) {
          if (scope.current === next.projectId) patch({ id: next.id, name: next.file.name, stage: "failed", error: (error as Error).message })
        } finally {
          running.current -= 1
          drainQueue()
        }
      })()
    }
  }, [patch])

  const add = useCallback((incoming: File[]) => {
    for (const file of incoming) {
      const id = crypto.randomUUID()
      const error = invoiceFileError(file)
      patch({ id, name: file.name, stage: error ? "failed" : "queued", error: error ?? undefined })
      if (!error) {
        files.current.set(id, file)
        pending.current.push({ id, file, projectId })
      }
    }
    drain()
  }, [projectId, patch, drain])

  const retry = useCallback((id: string) => {
    const file = files.current.get(id)
    if (!file) {
      void (async () => {
        try {
          const form = new FormData(); form.set("id", id)
          if (projectId) form.set("projectId", projectId)
          const response = await fetch("/api/payables/intake", { method: "POST", body: form })
          const result = await response.json()
          if (!response.ok) throw new Error(result.error || "Could not restart scan")
          patch(result.row)
        } catch (error) { setRows(current => current.map(row => row.id === id ? { ...row, stage: "failed", error: (error as Error).message } : row)) }
      })()
      return
    }
    pending.current.push({ id, file, projectId })
    drain()
  }, [projectId, drain, patch])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    let previous = new Map<string, string>()
    setRows([])
    async function poll() {
      let active = false
      try {
        const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
        const response = await fetch(`/api/payables/intake${query}`, { signal: controller.signal })
        if (!response.ok) throw new Error("Could not load intake")
        const { rows: saved } = await response.json() as { rows: IntakeRow[] }
        if (stopped) return
        active = saved.some(row => ["queued", "reading", "checking"].includes(row.stage))
        if (saved.some(row => ["ready", "failed"].includes(row.stage) && previous.get(row.id) !== row.stage)) ready.current()
        previous = new Map(saved.map(row => [row.id, row.stage]))
        setRows(current => {
          const local = current.filter(row => !row.billId && !saved.some(item => item.id === row.id))
          return [...local, ...saved]
        })
      } catch { /* Upload rows stay intact during a temporary polling failure. */ }
      if (!stopped) timer = setTimeout(poll, active || running.current ? 1500 : 5000)
    }
    void poll()
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [projectId])

  const dismiss = (id: string) => { files.current.delete(id); setRows(current => current.filter(row => row.id !== id)) }
  return { rows, add, retry, dismiss, canRetry: (id: string) => files.current.has(id) }
}

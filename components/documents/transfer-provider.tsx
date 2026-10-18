"use client"

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { del, getMany, keys, set } from "idb-keyval"
import { Pause, Play, RotateCcw, Upload, X, ChevronDown, ChevronUp } from "lucide-react"
import { toast } from "sonner"
import { TransferQueue, type TransferEntry } from "@/lib/files/transfer-queue"
import type { DocumentTransferOptions, DocumentTransferResult as Result, DocumentTransferQueue as Queue } from "@/lib/files/document-transfer-types"
import { setActiveDocumentTransferQueue } from "@/lib/files/active-transfer-queue"
import { Button } from "@/components/ui/button"

const QueueContext = createContext<Queue | null>(null)
const EMPTY: TransferEntry<DocumentTransferOptions, Result>[] = []

export function useDocumentTransfers() {
  const queue = useContext(QueueContext)
  if (!queue) throw new Error("Document transfers require the authenticated app shell")
  return queue
}

export function DocumentTransferProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [queue] = useState(() => {
    const prefix = `document-transfer:v1:${scope}:`
    return new TransferQueue<DocumentTransferOptions, Result>({
      load: async () => {
        const storedKeys = (await keys()).filter(key => typeof key === "string" && key.startsWith(prefix))
        return (await getMany<TransferEntry<DocumentTransferOptions, Result>>(storedKeys)).filter(Boolean)
      },
      save: entry => set(prefix + entry.id, entry),
      remove: id => del(prefix + id),
      run: async (entry, signal, update, checkpoint) => {
        const { uploadDocumentFileDirect, uploadDocumentVersionDirect } = await import("@/lib/services/files-client")
        const { version, attachment, ...options } = entry.options
        const callbacks = {
          signal,
          transferId: entry.id,
          onProgress: ({ percent }: { percent: number }) => update({ progress: percent }),
          onStage: (stage: "preparing" | "uploading" | "finalizing") => update({ stage }),
        }
        const result = entry.result ?? (version
          ? await uploadDocumentVersionDirect(entry.file, { ...version, projectId: options.projectId, ...callbacks })
          : await uploadDocumentFileDirect(entry.file, { ...options, ...callbacks }))
        // Persist the uploaded identity before linking: retrying a failed link
        // must never upload or register the bytes again.
        await checkpoint(result)
        if (attachment) {
          const { attachFileAction } = await import("@/app/(app)/documents/actions")
          const linked = await attachFileAction(result.id, attachment.entityType, attachment.entityId, options.projectId, attachment.linkRole)
          if (!linked.success) throw new Error(linked.error)
        }
        return result
      },
      cancel: async entry => {
        const { cancelDocumentTransfer } = await import("@/lib/services/files-client")
        await cancelDocumentTransfer(entry.id, entry.options.projectId)
      },
      completed: entry => {
        window.dispatchEvent(new CustomEvent("arc:documents-changed", { detail: { projectId: entry.options.projectId, attachment: entry.options.attachment } }))
      },
    })
  })
  useEffect(() => {
    const unregister = setActiveDocumentTransferQueue(queue)
    void queue.start()
    let disposed = false
    let stopExports: (() => void) | undefined
    void import("@/components/files/download").then(({ resumeDocumentExports }) => {
      if (!disposed) stopExports = resumeDocumentExports(scope)
    })
    return () => { disposed = true; stopExports?.(); unregister(); queue.stop() }
  }, [queue, scope])
  return <QueueContext.Provider value={queue}>{children}<TransferPanel queue={queue} /></QueueContext.Provider>
}

function TransferPanel({ queue }: { queue: Queue }) {
  const entries = useSyncExternalStore(queue.subscribe, queue.getSnapshot, () => EMPTY)
  const [expanded, setExpanded] = useState(true)
  const active = entries.filter(entry => entry.status === "queued" || entry.status === "uploading").length
  const failed = entries.filter(entry => entry.status === "failed").length
  if (!entries.length) return null
  const act = (operation: Promise<unknown>) => { void operation.catch(error => toast.error(error instanceof Error ? error.message : "Could not update transfer")) }
  return (
    <section aria-label="File transfers" className="fixed bottom-20 right-3 z-50 w-[min(24rem,calc(100vw-1.5rem))] border bg-background text-foreground shadow-lg md:bottom-4 md:right-4">
      <div className="flex items-center gap-2 px-3 py-2">
        <Upload className="h-4 w-4" aria-hidden="true" />
        <span className="flex-1 text-sm font-medium">Transfers{active ? ` · ${active} active` : failed ? ` · ${failed} need attention` : ""}</span>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={expanded ? "Collapse transfers" : "Expand transfers"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </Button>
      </div>
      {expanded && <>
        <ul className="max-h-72 overflow-y-auto border-t">
          {entries.map(entry => <li key={entry.id} className="flex items-start gap-2 border-b px-3 py-2 last:border-0">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={entry.file.name}>{entry.file.name}</p>
              <p className="text-xs text-muted-foreground">{entry.status === "uploading" ? `${entry.stage} · ${entry.progress}%` : entry.status}</p>
              {entry.error && <p className="mt-1 text-xs text-destructive">{entry.error}</p>}
              {entry.status === "uploading" && <div role="progressbar" aria-label={entry.file.name} aria-valuenow={entry.progress} aria-valuemin={0} aria-valuemax={100} className="mt-2 h-1 bg-muted"><div className="h-full bg-primary" style={{ width: `${entry.progress}%` }} /></div>}
            </div>
            {entry.stage !== "finalizing" && ["queued", "uploading"].includes(entry.status) && <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Pause ${entry.file.name}`} onClick={() => queue.pause(entry.id)}><Pause className="h-4 w-4" /></Button>}
            {["paused", "failed"].includes(entry.status) && <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`${entry.status === "failed" ? "Retry" : "Resume"} ${entry.file.name}`} onClick={() => act(queue.retry(entry.id))}>{entry.status === "failed" ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button>}
            {!(entry.stage === "finalizing" && entry.status === "uploading") && !["completed", "cancelled"].includes(entry.status) && <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Cancel ${entry.file.name}`} onClick={() => act(queue.cancel(entry.id))}><X className="h-4 w-4" /></Button>}
          </li>)}
        </ul>
        <div className="flex items-center justify-between border-t px-3 py-2">
          <span className="text-xs text-muted-foreground">You can keep working in other pages.</span>
          <Button size="sm" variant="ghost" onClick={() => queue.dismissFinished()}>Clear finished</Button>
        </div>
      </>}
    </section>
  )
}

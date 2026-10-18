import type { DocumentTransferQueue } from "./document-transfer-types"

let activeQueue: DocumentTransferQueue | null = null
export function setActiveDocumentTransferQueue(queue: DocumentTransferQueue) {
  activeQueue = queue
  return () => { if (activeQueue === queue) activeQueue = null }
}
export function getActiveDocumentTransferQueue(): DocumentTransferQueue {
  if (!activeQueue) throw new Error("The upload queue is unavailable. Refresh and try again.")
  return activeQueue
}

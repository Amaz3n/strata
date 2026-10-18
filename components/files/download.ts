import { toast } from "sonner"

export function getDownloadFileName(contentDisposition: string | null, fallback?: string) {
  if (fallback) return fallback

  if (!contentDisposition) return "download"

  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }

  const quotedMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i)
  if (quotedMatch?.[1]) {
    return quotedMatch[1]
  }

  const bareMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i)
  return bareMatch?.[1]?.trim() || "download"
}

/** Hands a blob to the browser as a download and cleans up after itself. */
export function saveBlobAsFile(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  try {
    link.href = objectUrl
    link.download = fileName
    link.rel = "noopener"
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }
}

/**
 * Package a selection of files into one ZIP and save it.
 *
 * The route enforces its own ceilings on count and total bytes and says which
 * one was hit; that message is passed straight through rather than replaced with
 * a generic failure, because "select 100 files or fewer" is actionable and
 * "download failed" is not.
 */
export async function downloadFilesAsZip(fileIds: string[], fallbackName: string): Promise<void> {
  const response = await fetch("/api/documents/download-zip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileIds, prepare: true }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error ?? "Failed to create ZIP download")
  }

  const { downloadUrl, exportRequired } = await response.json()
  if (exportRequired) {
    await queueDocumentExport(fileIds, fallbackName)
    return
  }
  if (typeof downloadUrl !== "string" || !downloadUrl.startsWith("/api/documents/download-zip?")) throw new Error("Invalid download response")
  startBrowserDownload(downloadUrl, fallbackName)
}

/** Hand attachment URLs to the browser so it streams straight to disk. */
function startBrowserDownload(url: string, fileName?: string) {
  const link = document.createElement("a")
  link.href = url
  if (fileName) link.download = fileName
  link.rel = "noopener"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export async function downloadUrlToFile(url: string, fileName?: string) {
  const parsed = new URL(url, window.location.origin)
  const rawFile = parsed.origin === window.location.origin && parsed.pathname.match(/^\/api\/files\/([^/]+)\/raw$/)
  if (rawFile) {
    startBrowserDownload(`/api/documents/download?fileId=${encodeURIComponent(rawFile[1])}`, fileName)
    return
  }
  const disposition = parsed.searchParams.get("response-content-disposition")
  if ((parsed.origin === window.location.origin && parsed.pathname === "/api/documents/download") || disposition?.startsWith("attachment")) {
    startBrowserDownload(parsed.toString(), fileName)
    return
  }
  // Legacy integrations may still supply inline cross-origin URLs. They cannot
  // be changed after signing, and an <a download> cannot force attachment there.
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download request failed with status ${response.status}`)
  saveBlobAsFile(await response.blob(), getDownloadFileName(response.headers.get("content-disposition"), fileName))
}


type PendingExport = { id: string; name: string; fileIds?: string[] }
const EXPORTS_KEY = "arc-document-exports"
const watchedExports = new Set<string>()
let exportScope: string | null = null
let exportGeneration = 0
function registryKey(scope: string) { return `${EXPORTS_KEY}:${scope}` }
function pendingExports(scope: string): PendingExport[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(registryKey(scope)) ?? "[]")
    if (!Array.isArray(value)) return []
    return value.filter((item): item is PendingExport => typeof item?.id === "string" && typeof item?.name === "string")
  } catch { return [] }
}
function saveExports(scope: string, exports: PendingExport[]) {
  try { localStorage.setItem(registryKey(scope), JSON.stringify(exports)) } catch { /* Server job remains durable. */ }
}
function removeExport(scope: string, id: string) {
  saveExports(scope, pendingExports(scope).filter(item => item.id !== id))
}
async function queueDocumentExport(fileIds: string[], name: string) {
  const scope = exportScope
  if (!scope) throw new Error("Your workspace is still loading. Try the download again.")
  const generation = exportGeneration
  const sorted = [...new Set(fileIds)].sort()
  const pending = pendingExports(scope)
  const prior = pending.find(item => JSON.stringify(item.fileIds) === JSON.stringify(sorted))
  const item = prior ?? { id: crypto.randomUUID(), name, fileIds: sorted }
  if (!prior) saveExports(scope, [...pending, item])
  const response = await fetch("/api/documents/exports", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exportId: item.id, fileIds: sorted }) })
  if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) removeExport(scope, item.id)
  const result = await response.json()
  if (!response.ok) throw new Error(result?.error || "Unable to queue export")
  if (exportScope !== scope || exportGeneration !== generation) return
  toast.info("Your ZIP is being prepared. You can leave this page; we’ll notify you when it is ready.")
  watchExport(scope, item)
}
function watchExport(scope: string, item: PendingExport) {
  const key = `${scope}:${item.id}`
  const generation = exportGeneration
  if (watchedExports.has(key)) return
  watchedExports.add(key)
  let delay = 2500
  const current = () => exportScope === scope && exportGeneration === generation
  async function poll() {
    if (!current()) { watchedExports.delete(key); return }
    try {
      const response = await fetch(`/api/documents/exports/${encodeURIComponent(item.id)}`, { cache: "no-store" })
      if (!current()) { watchedExports.delete(key); return }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        if (response.status === 404) removeExport(scope, item.id)
        watchedExports.delete(key)
        return
      }
      if (!response.ok) throw new Error("Export status unavailable")
      const result = await response.json()
      if (!current()) { watchedExports.delete(key); return }
      if (result.status === "ready" && typeof result.downloadUrl === "string" && result.downloadUrl.startsWith("/api/documents/exports/")) {
        toast.success("Your document ZIP is ready", { id: key, duration: Infinity, action: { label: "Download", onClick: () => {
          if (!current()) return
          startBrowserDownload(result.downloadUrl, item.name)
          removeExport(scope, item.id)
          watchedExports.delete(key)
        } } })
        return
      }
      if (result.status === "failed" || result.status === "expired") {
        toast.error(result.status === "expired" ? "Your document export expired. Select the files to generate it again." : "Your document export failed. Select the files to retry.")
        removeExport(scope, item.id)
        watchedExports.delete(key)
        return
      }
    } catch { /* Network loss is retried without discarding the durable receipt. */ }
    delay = Math.min(30000, Math.round(delay * 1.5))
    setTimeout(() => { void poll() }, delay)
  }
  void poll()
}

/** Mount from the persistent transfer provider with its actor:org scope. */
export function resumeDocumentExports(scope: string) {
  exportScope = scope
  exportGeneration++
  for (const key of watchedExports) toast.dismiss(key)
  watchedExports.clear()
  for (const item of pendingExports(scope)) watchExport(scope, item)
  const generation = exportGeneration
  return () => {
    if (generation !== exportGeneration) return
    exportScope = null
    exportGeneration++
    for (const key of watchedExports) toast.dismiss(key)
    watchedExports.clear()
  }
}

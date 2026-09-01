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
    body: JSON.stringify({ fileIds }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error ?? "Failed to create ZIP download")
  }

  saveBlobAsFile(
    await response.blob(),
    getDownloadFileName(response.headers.get("content-disposition"), fallbackName),
  )
}

/** Pulls a URL through the browser and saves it, so cross-origin signed URLs still land as a file. */
export async function downloadUrlToFile(url: string, fileName?: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Download request failed with status ${response.status}`)
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  const resolvedFileName = getDownloadFileName(response.headers.get("content-disposition"), fileName)

  try {
    link.href = objectUrl
    link.download = resolvedFileName
    link.rel = "noopener"
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }
}

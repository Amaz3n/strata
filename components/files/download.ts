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

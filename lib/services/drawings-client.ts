type UploadUrlResponse = {
  storagePath: string
  uploadUrl: string
  provider: "r2"
}

/**
 * Client-side upload utilities for drawings
 * These functions are safe to import in client components
 */

/**
 * Upload a drawing file directly to R2 from the client
 * This bypasses Next.js Server Actions body size limits
 */
export async function uploadDrawingFileToStorage(
  file: File,
  projectId: string,
  orgId?: string
): Promise<{ storagePath: string }> {
  const hostname =
    typeof window !== "undefined" ? window.location.hostname.toLowerCase() : ""
  const useAppProxy =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local")

  if (useAppProxy) {
    const formData = new FormData()
    formData.append("projectId", projectId)
    formData.append("file", file)

    const response = await fetch("/api/drawings/upload-file", {
      method: "POST",
      body: formData,
    })

    if (!response.ok) {
      throw new Error("Failed to upload file to storage.")
    }

    const payload = (await response.json()) as { storagePath?: string }
    if (!payload?.storagePath) {
      throw new Error("Invalid upload response.")
    }

    return { storagePath: payload.storagePath }
  }

  const response = await fetch("/api/drawings/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      fileName: file.name,
      contentType: file.type,
    }),
  })

  if (!response.ok) {
    throw new Error("Failed to prepare upload.")
  }

  const payload = (await response.json()) as UploadUrlResponse
  const storagePath = payload?.storagePath

  if (!storagePath || !payload?.provider) {
    throw new Error("Invalid upload response.")
  }

  if (payload.provider !== "r2") {
    throw new Error("R2 uploads are required for drawings.")
  }

  const uploadResponse = await fetch(payload.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
    },
    body: file,
  })

  if (!uploadResponse.ok) {
    throw new Error("Failed to upload file to storage.")
  }

  return { storagePath }
}

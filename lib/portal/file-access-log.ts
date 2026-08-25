import type { FileAccessAction } from "@/lib/validation/files"

/**
 * Portal visitors have no org membership, so view/download logging goes through
 * the public gated route. This must run in the browser: a server action would
 * execute on the server, where a relative fetch URL cannot resolve — which is
 * how portal access logging silently recorded nothing for so long.
 */
export function logPortalFileAccess(
  fileId: string,
  portalToken: string,
  action: FileAccessAction,
): void {
  if (typeof window === "undefined") return

  void fetch("/api/portal/log-file-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, portalToken, action }),
    keepalive: true,
  }).catch((error) => {
    // Logging must never block the visitor's click.
    console.warn("Failed to log portal file access:", error)
  })
}

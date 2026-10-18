import { invoiceHref, projectBillingHref } from "@/lib/financials/invoice-destinations"

export function getNotificationHref(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const values = payload as Record<string, unknown>
  const explicit = typeof values.href === "string" ? values.href : null
  if (explicit?.startsWith("/") && !explicit.startsWith("//") && !explicit.includes("\\") && !/[\u0000-\u001f]/.test(explicit)) return explicit
  const projectId = typeof values.project_id === "string" && values.project_id ? encodeURIComponent(values.project_id) : null
  if (!projectId) return null
  const entityId = typeof values.entity_id === "string" && values.entity_id ? encodeURIComponent(values.entity_id) : null
  const logId = typeof values.daily_log_id === "string" && values.daily_log_id ? encodeURIComponent(values.daily_log_id) : entityId
  const project = `/projects/${projectId}`
  switch (values.entity_type) {
    case "rfi": return `${project}/rfis${entityId ? `?rfi=${entityId}` : ""}`
    case "submittal": return `${project}/submittals${entityId ? `?submittal=${entityId}` : ""}`
    case "invoice": return entityId ? invoiceHref(entityId, projectId) : projectBillingHref(projectId)
    case "change_order": return `${project}/change-orders`
    case "file": return `${project}/documents${entityId ? `?fileId=${entityId}` : ""}`
    case "drawing_set":
    case "drawing_sheet":
    case "drawing_revision": return `${project}/drawings`
    case "task": return `/tasks?project=${projectId}${entityId ? `&task=${entityId}` : ""}`
    case "daily_log": return `${project}/daily-logs${logId ? `?logId=${logId}` : ""}`
    default: return project
  }
}

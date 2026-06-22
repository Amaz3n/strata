export type QBOFaultIdentity = {
  status?: number | null
  faultCode?: string | null
}

/** QBO uses fault 610 (HTTP 400) for a deleted entity on direct lookups. */
export function isQboMissingEntityFault(error: QBOFaultIdentity): boolean {
  return error.status === 404 || error.faultCode === "610"
}

// Keep the unfinished model page out of Lifestyle's client sandbox.
// Remove this restriction when the organization is ready to preview models.
const LIFESTYLE_SANDBOX_ORG_ID = "fafc5e08-24d5-50a1-9ab4-7819306a2768"

export function isProjectModelEnabled(orgId: string | undefined): boolean {
  return orgId !== LIFESTYLE_SANDBOX_ORG_ID
}

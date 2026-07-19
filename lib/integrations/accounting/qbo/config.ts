const PROD_API_BASE_URL = "https://quickbooks.api.intuit.com"
const SANDBOX_API_BASE_URL = "https://sandbox-quickbooks.api.intuit.com"

function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return undefined
}

const explicitSandbox = parseBooleanEnv(process.env.QBO_SANDBOX)
export const hasExplicitQboSandboxSetting = explicitSandbox !== undefined

// Backwards-compatible fallback: local/dev defaults to sandbox.
export const isQboSandbox = explicitSandbox ?? process.env.NODE_ENV !== "production"

export const qboApiBaseUrl = isQboSandbox ? SANDBOX_API_BASE_URL : PROD_API_BASE_URL
export const qboCompanyBaseUrl = `${qboApiBaseUrl}/v3/company`
export const qboEnvironmentLabel = isQboSandbox ? "sandbox" : "production"


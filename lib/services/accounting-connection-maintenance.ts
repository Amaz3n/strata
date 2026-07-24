import { listProviders } from "@/lib/integrations/accounting/registry"

export async function keepAliveAccountingConnections(limit = 10) {
  const providers = listProviders().filter((provider) => provider.keepAliveConnections)
  let remaining = Math.max(0, limit)
  let scanned = 0
  let refreshed = 0
  let failed = 0

  for (const provider of providers) {
    if (remaining === 0) break
    const result = await provider.keepAliveConnections!(remaining)
    scanned += result.scanned
    refreshed += result.refreshed
    failed += result.failed
    remaining = Math.max(0, remaining - result.scanned)
  }

  return { scanned, refreshed, failed }
}

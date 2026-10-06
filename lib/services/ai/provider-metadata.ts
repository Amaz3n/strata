/** Only retain billing metadata, never a provider's echoed prompt or response. */
export function openRouterMetadata(body: unknown) {
  const value = body as { provider?: unknown } | null
  return typeof value?.provider === "string" ? { openrouter: { upstreamProvider: value.provider } } : undefined
}

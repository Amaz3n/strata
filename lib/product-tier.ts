export const PRODUCT_TIERS = ["residential", "commercial", "production"] as const

export type ProductTier = (typeof PRODUCT_TIERS)[number]
export type ProjectPosture = "residential" | "commercial" | "production"

export const PRODUCT_TIER_LABELS: Record<ProductTier, string> = {
  residential: "Arc",
  commercial: "Arc Commercial",
  production: "Arc Production",
}

/**
 * Customer-facing product names — the full marketing brand, matching the
 * website. Distinct from PRODUCT_TIER_LABELS on purpose: that map's residential
 * entry is the short internal "Arc", whereas customers see "Arc Residential".
 * Use these on customer-facing surfaces (e.g. Settings → Billing).
 */
export const PRODUCT_TIER_BRAND_NAMES: Record<ProductTier, string> = {
  residential: "Arc Residential",
  commercial: "Arc Commercial",
  production: "Arc Production",
}

export function isProductTier(value: unknown): value is ProductTier {
  return value === "residential" || value === "commercial" || value === "production"
}

export function normalizeProductTier(value: unknown): ProductTier {
  return isProductTier(value) ? value : "residential"
}

export function getProjectPosture(
  propertyType: string | null | undefined,
  orgTier: ProductTier,
): ProjectPosture {
  if (propertyType === "production") return "production"
  if (propertyType === "commercial") return "commercial"
  if (propertyType === "residential") return "residential"
  if (orgTier === "commercial") return "commercial"
  if (orgTier === "production") return "production"
  return "residential"
}

export function getDefaultProjectPropertyType(orgTier: ProductTier): ProjectPosture {
  if (orgTier === "commercial") return "commercial"
  if (orgTier === "production") return "production"
  return "residential"
}

export function shouldShowProductionOrgNavigation(
  orgTier: ProductTier,
  hasProductionProjects: boolean,
): boolean {
  return orgTier === "production" || hasProductionProjects
}

export function isProductionProjectPosture(posture: ProjectPosture): boolean {
  return posture === "production"
}

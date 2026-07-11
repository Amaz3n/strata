export const PRODUCT_TIERS = ["residential", "commercial", "production"] as const

export type ProductTier = (typeof PRODUCT_TIERS)[number]
export type ProjectPosture = "residential" | "commercial"

export const PRODUCT_TIER_LABELS: Record<ProductTier, string> = {
  residential: "Arc",
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
  if (propertyType === "commercial") return "commercial"
  if (propertyType === "residential") return "residential"
  return orgTier === "commercial" ? "commercial" : "residential"
}

export function getDefaultProjectPropertyType(orgTier: ProductTier): ProjectPosture {
  return orgTier === "commercial" ? "commercial" : "residential"
}

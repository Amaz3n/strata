import { z } from "zod";
import { PRODUCT_TIER_BRAND_NAMES, type ProductTier } from "@/lib/product-tier";

// Company role and project posture are independent. A trade can work on both
// residential and commercial jobs without becoming a different organization.
export const businessProfileSchema = z.object({
  kind: z.enum(["builder", "trade"]).default("builder"),
  specialty: z
    .string()
    .trim()
    .min(1, "Enter your trade specialty")
    .max(80)
    .default("Electrical"),
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;
export const BUILDER_PROFILE: BusinessProfile = {
  kind: "builder",
  specialty: "Electrical",
};

export function resolveBusinessProfile(
  settings: Record<string, unknown>,
): BusinessProfile {
  const result = businessProfileSchema.safeParse(settings.business_profile);
  return result.success ? result.data : BUILDER_PROFILE;
}

export function defaultTradeJobType(
  tier: ProductTier,
): "residential" | "commercial" {
  return tier === "commercial" ? "commercial" : "residential";
}

export function businessBrand(profile: BusinessProfile, tier: ProductTier) {
  return profile.kind === "trade"
    ? "Arc Trade"
    : PRODUCT_TIER_BRAND_NAMES[tier];
}

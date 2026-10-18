import type { PreconBrief } from "./workspace";

export function pricingBriefVersion(brief: PreconBrief, recordVersion: number) {
  return brief.pricing_revision ?? recordVersion;
}

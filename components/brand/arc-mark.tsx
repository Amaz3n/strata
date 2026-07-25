"use client"

import { useId } from "react"

import type { ProductTier } from "@/lib/product-tier"
import { cn } from "@/lib/utils"

/**
 * The Arc mark, recolored per product tier — the same geometry as
 * /public/logo.svg (the drawing frame plus the rising-arc field), with the
 * radial gradient keyed to the tier's brand tokens (`--tier-*` in globals.css).
 * App and marketing site (arc-website/src/components/arc-mark.tsx) render the
 * same mark, so the three products read as one family.
 */
const TIER_STOPS: Record<ProductTier, { deep: string; light: string }> = {
  residential: { deep: "var(--tier-residential-deep)", light: "var(--tier-residential-light)" },
  commercial: { deep: "var(--tier-commercial-deep)", light: "var(--tier-commercial-light)" },
  production: { deep: "var(--tier-production-deep)", light: "var(--tier-production-light)" },
}

export function ArcMark({
  tier,
  className,
  /** Frame stroke in viewBox units. ~14 reads as a 1px hairline near 48px. */
  frameWidth = 14,
}: {
  tier: ProductTier
  className?: string
  frameWidth?: number
}) {
  // SVG gradient ids are global; a unique id per instance stops one mark from
  // adopting another's colors. useId's colons are invalid in url(#…), so strip.
  const gradientId = `arc-mark-${useId().replace(/:/g, "")}`
  const { deep, light } = TIER_STOPS[tier]

  return (
    <svg
      viewBox="0 0 581 521"
      className={cn("shrink-0", className)}
      fill="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <radialGradient
          id={gradientId}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(359.578,-1.50014,1.50014,359.578,322.139,303.602)"
        >
          <stop offset="0" stopColor={deep} />
          <stop offset="1" stopColor={light} />
        </radialGradient>
      </defs>

      <g transform="translate(-31.841,-43.419)">
        <rect
          x="32.883"
          y="44.461"
          width="578.512"
          height="518.282"
          stroke={light}
          strokeWidth={frameWidth}
        />
        <path
          d="M32.883,339.021L32.883,44.461L611.395,44.461L611.395,339.021C553.892,238.836 445.841,171.295 322.139,171.295C198.437,171.295 90.386,238.836 32.883,339.021ZM94.501,562.743C85.685,537.727 80.889,510.822 80.889,482.806C80.889,349.941 188.758,242.072 321.623,242.072C454.487,242.072 562.357,349.941 562.357,482.806C562.357,510.822 557.56,537.727 548.745,562.743L94.501,562.743Z"
          fill={`url(#${gradientId})`}
        />
      </g>
    </svg>
  )
}

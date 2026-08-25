"use client"

import { useId } from "react"

import type { ProductTier } from "@/lib/product-tier"
import { cn } from "@/lib/utils"

const ARCH =
  "M32.883,339.021L32.883,44.461L611.395,44.461L611.395,339.021C553.892,238.836 445.841,171.295 322.139,171.295C198.437,171.295 90.386,238.836 32.883,339.021Z"
const DOME =
  "M94.501,562.743C85.685,537.727 80.889,510.822 80.889,482.806C80.889,349.941 188.758,242.072 321.623,242.072C454.487,242.072 562.357,349.941 562.357,482.806C562.357,510.822 557.56,537.727 548.745,562.743"

const TIER_LIGHT: Record<ProductTier, string> = {
  residential: "var(--tier-residential-light)",
  commercial: "var(--tier-commercial-light)",
  production: "var(--tier-production-light)",
}

/** A quiet, branded live-progress mark based on the arc-website footer sweep. */
export function ArcLoadingMark({
  tier,
  className,
}: {
  tier?: ProductTier
  className?: string
}) {
  const id = useId().replace(/:/g, "")
  const shimmerId = `arc-loading-shimmer-${id}`
  const glowId = `arc-loading-glow-${id}`
  // Explicit data wins. Without it the mark inherits the tier the authenticated
  // chrome publishes, so a fallback deep in the tree never flashes the wrong
  // product color; residential only applies before any org tier has resolved.
  const light = tier
    ? TIER_LIGHT[tier]
    : "var(--arc-loading-light, var(--tier-residential-light))"

  return (
    <svg
      viewBox="0 0 581 521"
      className={cn("shrink-0 overflow-visible", className)}
      fill="none"
      aria-hidden
      focusable="false"
      data-slot="arc-loading-mark"
    >
      <defs>
        <linearGradient
          id={shimmerId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="220"
          y2="0"
          gradientTransform="translate(-700 0)"
        >
          <stop offset="0" stopColor={light} stopOpacity="0" />
          <stop offset="0.4" stopColor={light} stopOpacity="0" />
          <stop offset="0.5" stopColor={light} stopOpacity="1" />
          <stop offset="0.6" stopColor={light} stopOpacity="0" />
          <stop offset="1" stopColor={light} stopOpacity="0" />
          <animateTransform
            className="arc-loading-sweep"
            attributeName="gradientTransform"
            type="translate"
            values="-700 0; 700 0; 700 0"
            keyTimes="0; 0.68; 1"
            dur="2.6s"
            repeatCount="indefinite"
          />
        </linearGradient>
        <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g transform="translate(-31.841 -43.419)">
        <g
          stroke={light}
          strokeOpacity="0.2"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={ARCH} />
          <path d={DOME} strokeLinecap="butt" />
        </g>
        <g
          className="arc-loading-highlight"
          stroke={`url(#${shimmerId})`}
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#${glowId})`}
        >
          <path d={ARCH} />
          <path d={DOME} strokeLinecap="butt" />
        </g>
      </g>
    </svg>
  )
}

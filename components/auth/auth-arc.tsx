"use client"

import { useEffect, useRef } from "react"

/**
 * The hairline arc behind every auth page: the logo's arc at room scale, with
 * one point of light on it. It draws in once, leans toward the cursor, and the
 * sign-in form talks to it through `signalAuthArc` — pending work runs the
 * light along the line, a wrong answer tints it, and signing in lights the
 * whole arc.
 *
 * Performance is the design here, not an afterthought. Safari re-rasterizes
 * SVG blur on every frame the blurred geometry changes, so nothing blurred is
 * ever redrawn: the light only ever travels along a circle, so each glowing
 * piece (core, bloom, tail, glint, halo) is drawn once into its own small
 * layer at the top of the circle and moved by rotating that layer around the
 * circle's center — a compositor-only transform. Breathing is opacity on those
 * layers. The fade behind the form is a static copy of the sky laid over the
 * line, feathered with a CSS mask, sized once per window size: it must never
 * follow the form's height animations, or Safari repaints a full-screen masked
 * layer on every frame of every step change.
 */
export type AuthArcSignal = { type: "busy"; on: boolean } | { type: "error" } | { type: "complete" }

const listeners = new Set<(signal: AuthArcSignal) => void>()

export function signalAuthArc(signal: AuthArcSignal) {
  for (const listener of listeners) listener(signal)
}

/** Where the light rests, as a fraction along the arc. */
const REST = 0.52
/** Angular spans, as fractions of the half circle. */
const LIGHT_SPAN = 0.12
const TAIL_SPAN = 0.22
const GLINT_SPAN = 0.05
/** Room around each segment for its glow. */
const GLOW_PAD = 44
/** The fade behind the form: a clear core plus a feathered edge, tall enough for every step. */
const VEIL_PAD = 26
const VEIL_FEATHER = 30
const VEIL_HALF_HEIGHT = 250
const HALO_SIZE = 560

type Circle = { x: number; y: number; r: number }

/**
 * Lays a rotor out at the top of the circle: a small box holding one arc
 * segment, pivoting around the circle's center. `from`/`to` are angles from
 * the top, in radians (negative is left).
 */
function placeRotor(rotor: HTMLElement, svg: SVGSVGElement, circle: Circle, from: number, to: number) {
  const reach = Math.max(Math.abs(from), Math.abs(to))
  const half = circle.r * Math.sin(reach) + GLOW_PAD
  const width = half * 2
  const height = circle.r * (1 - Math.cos(reach)) + GLOW_PAD * 2
  const pivotY = GLOW_PAD + circle.r
  const point = (angle: number) => `${half + circle.r * Math.sin(angle)} ${pivotY - circle.r * Math.cos(angle)}`

  rotor.style.left = `${circle.x - half}px`
  rotor.style.top = `${circle.y - pivotY}px`
  rotor.style.width = `${width}px`
  rotor.style.height = `${height}px`
  rotor.style.transformOrigin = `${half}px ${pivotY}px`
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  const d = `M ${point(from)} A ${circle.r} ${circle.r} 0 0 1 ${point(to)}`
  for (const path of svg.querySelectorAll("path")) path.setAttribute("d", d)
  for (const filter of svg.querySelectorAll("filter")) {
    filter.setAttribute("x", "0")
    filter.setAttribute("y", "0")
    filter.setAttribute("width", String(width))
    filter.setAttribute("height", String(height))
  }
}

export function AuthArc() {
  const rootRef = useRef<HTMLDivElement>(null)
  const linesRef = useRef<SVGSVGElement>(null)
  const baseRef = useRef<SVGPathElement>(null)
  const fullCoreRef = useRef<SVGPathElement>(null)
  const fullBloomRef = useRef<SVGSVGElement>(null)
  const haloRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const bloomRef = useRef<HTMLDivElement>(null)
  const lightRef = useRef<HTMLDivElement>(null)
  const glintRef = useRef<HTMLDivElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const lines = linesRef.current
    const base = baseRef.current
    const fullCore = fullCoreRef.current
    const fullBloom = fullBloomRef.current
    const halo = haloRef.current
    const tail = tailRef.current
    const bloom = bloomRef.current
    const light = lightRef.current
    const glint = glintRef.current
    const veil = veilRef.current
    if (!root || !lines || !base || !fullCore || !fullBloom || !halo || !tail || !bloom || !light || !glint || !veil) {
      return
    }
    const rotorSvg = (rotor: HTMLElement) => rotor.querySelector("svg")

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let alive = true
    let circle: Circle = { x: 0, y: 0, r: 0 }
    let length = 0
    let pos = 0
    let target = REST
    let raf = 0
    let prev = 0
    let tailSize = 0
    let direction = 1
    let running = false
    let complete = false
    let errorTimer = 0

    /** Fraction along the arc → rotation of a rotor, in degrees (0 is the top). */
    const turn = (fraction: number) => `rotate(${(fraction - 0.5) * 180}deg)`

    /**
     * The form's column, measured from layout that does not animate: its x-range, and the
     * vertical center of the area that centers it (which stays put while the form grows).
     */
    const column = () => {
      const panel = document.querySelector<HTMLElement>("[data-auth-panel]")
      const area = panel?.parentElement
      if (!panel || !area) return null
      const x = panel.getBoundingClientRect()
      const y = area.getBoundingClientRect()
      return { left: x.left, right: x.right, centerY: (y.top + y.bottom) / 2 }
    }

    const veilAround = () => {
      const box = column()
      if (!box) return
      veil.style.setProperty("--veil-x1", `${box.left - VEIL_PAD}px`)
      veil.style.setProperty("--veil-x2", `${box.right + VEIL_PAD}px`)
      veil.style.setProperty("--veil-y1", `${box.centerY - VEIL_HALF_HEIGHT}px`)
      veil.style.setProperty("--veil-y2", `${box.centerY + VEIL_HALF_HEIGHT}px`)
      veil.style.setProperty("--veil-feather", `${VEIL_FEATHER}px`)
    }

    /**
     * The circle, chosen so the line always passes behind the form: it runs through a point
     * inside the form's column, with its crown kept on screen at any window width.
     */
    const fitCircle = (width: number, height: number): Circle => {
      const box = column()
      if (width < 760 || !box) return { x: width * 0.5, y: height * 1.02, r: height * 0.62 }
      const y = height * 1.08
      const through = { x: box.left + (box.right - box.left) * 0.6, y: box.centerY }
      const rise = y - through.y
      const r = Math.max(height * 0.86, width * 0.42, rise + 1)
      const x = Math.min(width * 0.86, Math.max(width * 0.55, through.x + Math.sqrt(r * r - rise * rise)))
      return { x, y, r: Math.hypot(x - through.x, rise) }
    }

    const paint = () => {
      const rotation = turn(pos)
      halo.style.transform = rotation
      bloom.style.transform = rotation
      light.style.transform = rotation
      // A comet tail trails the light while it moves and fades to nothing at rest.
      const velocity = pos - prev
      prev = pos
      if (Math.abs(velocity) > 1e-5) direction = Math.sign(velocity)
      tailSize += (Math.min(1, Math.abs(velocity) * 100) - tailSize) * 0.2
      tail.style.transform = `${rotation} scaleX(${direction})`
      tail.style.opacity = String(tailSize * 0.45)
    }

    const layout = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      circle = fitCircle(width, height)
      length = Math.PI * circle.r

      const d = `M ${circle.x - circle.r} ${circle.y} A ${circle.r} ${circle.r} 0 0 1 ${circle.x + circle.r} ${circle.y}`
      for (const svg of [lines, fullBloom]) {
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
        for (const path of svg.querySelectorAll("path")) path.setAttribute("d", d)
      }
      base.style.strokeDasharray = `${length}`
      if (!complete) fullCore.style.strokeDasharray = `0 ${length * 2}`

      const lightHalf = (LIGHT_SPAN * Math.PI) / 2
      for (const rotor of [bloom, light]) {
        const svg = rotorSvg(rotor)
        if (svg) placeRotor(rotor, svg, circle, -lightHalf, lightHalf)
      }
      const tailSvg = rotorSvg(tail)
      if (tailSvg) placeRotor(tail, tailSvg, circle, -lightHalf - TAIL_SPAN * Math.PI, -lightHalf)
      const glintSvg = rotorSvg(glint)
      if (glintSvg) placeRotor(glint, glintSvg, circle, (-GLINT_SPAN * Math.PI) / 2, (GLINT_SPAN * Math.PI) / 2)

      halo.style.left = `${circle.x - HALO_SIZE / 2}px`
      halo.style.top = `${circle.y - circle.r - HALO_SIZE / 2}px`
      halo.style.transformOrigin = `${HALO_SIZE / 2}px ${HALO_SIZE / 2 + circle.r}px`

      veilAround()
      paint()
    }

    // One loop eases the light toward its target, runs it along the arc while work is pending,
    // and lets the tail fade. It stops once everything settles, so the page is still when idle.
    const tick = () => {
      if (!alive) return
      if (running) {
        pos += 0.0065
        if (pos > 1.08) {
          pos = -0.08
          prev = pos
        }
      } else {
        pos += (target - pos) * 0.06
      }
      paint()
      const settled = !running && Math.abs(target - pos) < 0.0005 && tailSize < 0.002
      if (settled) {
        pos = target
        tailSize = 0
        paint()
        raf = 0
      } else {
        raf = requestAnimationFrame(tick)
      }
    }
    const wake = () => {
      if (!raf && !complete) raf = requestAnimationFrame(tick)
    }

    // Entrance: the hairline draws left to right while the light rides its leading edge.
    const intro = () => {
      if (reduce) {
        base.style.strokeDashoffset = "0"
        pos = target = REST
        prev = pos
        paint()
        return
      }
      const started = performance.now()
      base.style.strokeDashoffset = `${length}`
      const step = (now: number) => {
        if (!alive) return
        const k = Math.min(1, (now - started) / 1700)
        const eased = 1 - Math.pow(1 - k, 4)
        base.style.strokeDashoffset = `${length * (1 - eased)}`
        pos = eased * (REST + 0.08)
        paint()
        if (k < 1) requestAnimationFrame(step)
        else wake()
      }
      requestAnimationFrame(step)
    }

    // Every so often a faint glint runs the whole length of the line.
    const shimmer = () => {
      if (reduce || running || complete || document.hidden) return
      const started = performance.now()
      const step = (now: number) => {
        if (!alive) return
        const k = Math.min(1, (now - started) / 2600)
        const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
        glint.style.transform = turn(eased * 1.1 - 0.05)
        glint.style.opacity = String(Math.sin(Math.PI * k) * 0.7)
        if (k < 1) requestAnimationFrame(step)
        else glint.style.opacity = "0"
      }
      requestAnimationFrame(step)
    }

    // Signed in: the line lights up from the light outward until the whole arc glows.
    const finish = () => {
      complete = true
      running = false
      cancelAnimationFrame(raf)
      raf = 0
      tailSize = 0
      tail.style.opacity = "0"
      root.setAttribute("data-complete", "")
      const from = pos
      const reveal = (k: number) => {
        const center = from + (0.5 - from) * k
        const span = LIGHT_SPAN + (1 - LIGHT_SPAN) * k
        fullCore.style.strokeDasharray = `${span * length} ${length * 2}`
        fullCore.style.strokeDashoffset = `${-(center - span / 2) * length}`
        pos = center
        prev = pos
        paint()
      }
      if (reduce) return reveal(1)
      const started = performance.now()
      const step = (now: number) => {
        if (!alive) return
        const k = Math.min(1, (now - started) / 1400)
        reveal(k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
        if (k < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }

    const onSignal = (signal: AuthArcSignal) => {
      if (signal.type === "complete") return finish()
      if (complete) return
      if (signal.type === "error") {
        root.setAttribute("data-error", "")
        window.clearTimeout(errorTimer)
        errorTimer = window.setTimeout(() => root.removeAttribute("data-error"), 900)
        return
      }
      if (reduce || signal.on === running) return
      running = signal.on
      if (!signal.on) {
        prev = pos
        target = REST
      }
      wake()
    }

    // The light leans toward the cursor, within the visible part of the arc.
    const onPointerMove = (event: PointerEvent) => {
      if (complete || running) return
      const angle = Math.atan2(event.clientY - circle.y, event.clientX - circle.x)
      const fraction = Math.min(1, Math.max(0, (angle + Math.PI) / Math.PI))
      target = REST + (fraction - REST) * 0.35
      wake()
    }

    layout()
    intro()
    listeners.add(onSignal)
    window.addEventListener("resize", layout)
    window.addEventListener("scroll", veilAround, { passive: true })
    if (!reduce) window.addEventListener("pointermove", onPointerMove)
    const firstShimmer = window.setTimeout(shimmer, 3200)
    const shimmerTimer = window.setInterval(shimmer, 9000)

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      listeners.delete(onSignal)
      window.removeEventListener("resize", layout)
      window.removeEventListener("scroll", veilAround)
      window.removeEventListener("pointermove", onPointerMove)
      window.clearTimeout(firstShimmer)
      window.clearTimeout(errorTimer)
      window.clearInterval(shimmerTimer)
    }
  }, [])

  return (
    <div ref={rootRef} className="auth-arc" aria-hidden>
      <div className="auth-sky" />

      <svg ref={linesRef} className="auth-arc-layer">
        <path ref={baseRef} className="auth-arc-base" />
        <path ref={fullCoreRef} className="auth-arc-light" />
      </svg>
      <svg ref={fullBloomRef} className="auth-arc-layer auth-arc-full-bloom">
        <filter id="auth-arc-full-soft" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <path className="auth-arc-bloom" filter="url(#auth-arc-full-soft)" />
      </svg>

      <div ref={haloRef} className="auth-arc-rotor auth-arc-halo" />
      <div ref={tailRef} className="auth-arc-rotor auth-arc-tail-rotor">
        <svg>
          <filter id="auth-arc-tail-soft" filterUnits="userSpaceOnUse">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <path className="auth-arc-tail" filter="url(#auth-arc-tail-soft)" />
        </svg>
      </div>
      <div ref={bloomRef} className="auth-arc-rotor auth-arc-bloom-rotor">
        <svg>
          <filter id="auth-arc-bloom-soft" filterUnits="userSpaceOnUse">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <path className="auth-arc-bloom" filter="url(#auth-arc-bloom-soft)" />
        </svg>
      </div>
      <div ref={lightRef} className="auth-arc-rotor">
        <svg>
          <path className="auth-arc-light" />
        </svg>
      </div>
      <div ref={glintRef} className="auth-arc-rotor auth-arc-glint-rotor">
        <svg>
          <path className="auth-arc-glint" />
        </svg>
      </div>

      {/* The sky again, feathered to the form's box, so the line fades out behind the form. */}
      <div ref={veilRef} className="auth-sky auth-arc-veil" />
    </div>
  )
}

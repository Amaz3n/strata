"use client"

import { useEffect, useRef } from "react"

/**
 * JaguarDither — Arc brand intro animation.
 *
 * Timeline:
 *  1. The Arc dome logo scales in at center (brand radial-blue gradient).
 *  2. The dome expands outward and fades.
 *  3. A jaguar, rendered as a dithered grid of dots, fades into place and then
 *     *runs in place* — a continuous gait cycle. The dot cloud is rigged to a
 *     tiny skeleton (four legs with hip+knee joints, a swaying tail, a body
 *     bob) so the legs actually cycle through a running stride.
 *
 * One <canvas> + requestAnimationFrame drives the whole sequence so it shares a
 * single timeline and loops cleanly. Everything is tunable via config.
 */

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/** Arc logo radial gradient stops (dark center → light edge). */
const BLUE_STOPS: { p: number; c: [number, number, number] }[] = [
  { p: 0, c: [0, 52, 160] }, // #0034A0
  { p: 0.42, c: [14, 88, 182] }, // #0E58B6
  { p: 1, c: [45, 167, 231] }, // #2DA7E7
]

function sampleBlue(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < BLUE_STOPS.length; i++) {
    const a = BLUE_STOPS[i - 1]
    const b = BLUE_STOPS[i]
    if (x <= b.p) {
      const k = (x - a.p) / (b.p - a.p || 1)
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * k),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * k),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * k),
      ]
    }
  }
  return BLUE_STOPS[BLUE_STOPS.length - 1].c
}

/** Arc dome logo (from public/arc-logo2.svg), in its raw path coord space. */
const ARC_LOGO_PATH =
  "M32.883,339.021L32.883,44.461L611.395,44.461L611.395,339.021C553.892,238.836 445.841,171.295 322.139,171.295C198.437,171.295 90.386,238.836 32.883,339.021ZM94.501,562.743C85.685,537.727 80.889,510.822 80.889,482.806C80.889,349.941 188.758,242.072 321.623,242.072C454.487,242.072 562.357,349.941 562.357,482.806C562.357,510.822 557.56,537.727 548.745,562.743L94.501,562.743Z"
const ARC_BBOX = { x: 32.883, y: 44.461, w: 578.512, h: 518.282, cx: 322.139, cy: 303.602 }

/**
 * Procedural big-cat silhouette in a near-neutral stance, traced clockwise from
 * the nose. Coordinate space SRC_W x SRC_H. Faces right; the four legs are
 * roughly vertical so the rig can swing them through a running cycle.
 */
const SRC_W = 1000
const SRC_H = 560
const JAGUAR_PATH = [
  "M 950 248",
  "C 935 205 905 188 890 196", // muzzle → ear front
  "C 884 214 872 210 862 224", // ear notch → back of skull
  "C 845 240 720 232 600 238", // upper back / spine
  "C 470 244 360 240 296 246", // spine → rump top
  "C 278 230 250 150 150 120", // tail base sweeps up-left
  "C 120 112 110 130 128 150", // tail tip curl
  "C 200 178 250 220 250 270", // inner tail back to rear
  "C 252 320 232 350 212 372", // rear haunch down
  "C 206 420 204 460 204 496", // back leg 1 (hind-near) → paw
  "C 204 508 230 508 232 496", // paw underside
  "C 234 450 240 410 268 392", // up between hind legs
  "C 286 420 290 458 292 496", // back leg 2 (hind-far) → paw
  "C 292 508 318 508 320 496", // paw underside
  "C 324 448 342 430 430 428", // belly start
  "C 540 426 624 430 690 414", // belly forward
  "C 700 450 704 470 706 500", // front leg 1 (fore-near) → paw
  "C 706 512 732 512 734 500", // paw underside
  "C 738 460 748 436 786 424", // up between fore legs
  "C 804 452 810 470 812 500", // front leg 2 (fore-far) → paw
  "C 812 512 838 512 840 500", // paw underside
  "C 842 444 826 372 824 332", // chest up to throat
  "C 830 302 882 270 920 262", // throat → chin
  "C 935 258 946 254 950 248", // back to nose
  "Z",
].join(" ")

/**
 * Skeleton legs. Each dot inside a region (x in [x0,x1] AND y >= hipY) belongs
 * to that leg and pivots about its hip; below kneeY it also pivots about the
 * knee. Phase offsets give a diagonal (trot-like) running gait: legs 0+3 move
 * together, 1+2 move together, the two pairs a half-cycle apart.
 */
const LEGS = [
  { x0: 195, x1: 245, hipX: 222, hipY: 366, kneeY: 432, offset: 0 }, // hind-near
  { x0: 255, x1: 330, hipX: 285, hipY: 388, kneeY: 442, offset: Math.PI }, // hind-far
  { x0: 685, x1: 745, hipX: 712, hipY: 410, kneeY: 470, offset: Math.PI }, // fore-near
  { x0: 760, x1: 850, hipX: 802, hipY: 420, kneeY: 472, offset: 0 }, // fore-far
]
const TAIL = { maxX: 272, maxY: 278, pivotX: 258, pivotY: 254 }
const KNEE_PHASE = Math.PI / 2

// Bone kinds
const BODY = 0
const TAIL_BONE = 1
const LEG = 2

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type JaguarDitherConfig = {
  loop: boolean
  paused: boolean
  timeScale: number
  /** Sample grid gap in source px — smaller = more, finer dots. */
  dotGap: number
  /** Dot radius as a fraction of on-screen grid spacing (0..1). */
  dotRadius: number
  /** Jaguar size as a fraction of the available viewport. */
  jaguarScale: number
  showLogoIntro: boolean
  /** Run the gait cycle once the cat has assembled. */
  running: boolean
  /** ms per full stride cycle. */
  runPeriod: number
  /** Hip swing amplitude, degrees. */
  hipSwing: number
  /** Knee flex amplitude, degrees. */
  kneeBend: number
  /** Vertical body bob, source units. */
  bodyBob: number
  /** Tail sway amplitude, degrees. */
  tailSway: number
  /** Canvas background. "transparent" clears; otherwise a CSS color. */
  background: string
  // Intro phase durations in source ms (before timeScale).
  logoIn: number
  logoHold: number
  logoOut: number
  dotsStagger: number
  dotFly: number
  /** How long the cat runs before the loop restarts. */
  holdAfter: number
}

export const DEFAULT_CONFIG: JaguarDitherConfig = {
  loop: true,
  paused: false,
  timeScale: 1,
  dotGap: 15,
  dotRadius: 0.4,
  jaguarScale: 0.66,
  showLogoIntro: true,
  running: true,
  runPeriod: 620,
  hipSwing: 24,
  kneeBend: 30,
  bodyBob: 9,
  tailSway: 11,
  background: "transparent",
  logoIn: 620,
  logoHold: 460,
  logoOut: 820,
  dotsStagger: 700,
  dotFly: 620,
  holdAfter: 4200,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInCubic = (t: number) => t * t * t
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Dot = {
  sx: number // source x (rest pose)
  sy: number // source y (rest pose)
  staticNx: number // normalized x of rest pose (for stagger ordering)
  base: [number, number, number]
  kind: number
  legIdx: number
  lower: boolean
}

export function JaguarDither({
  config,
  className,
  restartSignal,
  onCycle,
}: {
  config: JaguarDitherConfig
  className?: string
  restartSignal?: number
  onCycle?: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cfgRef = useRef(config)
  cfgRef.current = config
  const onCycleRef = useRef(onCycle)
  onCycleRef.current = onCycle

  const dotsRef = useRef<Dot[]>([])
  const boxRef = useRef({ minX: 0, minY: 0, bw: 1, bh: 1, aspect: SRC_W / SRC_H })
  const restartRef = useRef(false)

  // Build the rigged dot set whenever sampling density changes.
  useEffect(() => {
    const gap = config.dotGap
    const off = document.createElement("canvas")
    off.width = SRC_W
    off.height = SRC_H
    const o = off.getContext("2d")
    if (!o) return
    o.fillStyle = "#000"
    o.fill(new Path2D(JAGUAR_PATH))
    const data = o.getImageData(0, 0, SRC_W, SRC_H).data

    const raw: { x: number; y: number }[] = []
    for (let y = gap / 2; y < SRC_H; y += gap) {
      for (let x = gap / 2; x < SRC_W; x += gap) {
        const a = data[(Math.floor(y) * SRC_W + Math.floor(x)) * 4 + 3]
        if (a > 128) raw.push({ x, y })
      }
    }
    if (raw.length === 0) return

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const p of raw) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    const bw = maxX - minX || 1
    const bh = maxY - minY || 1
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const maxR = 0.5 * Math.hypot(bw, bh)

    dotsRef.current = raw.map((p) => {
      // Assign to a bone.
      let kind = BODY
      let legIdx = -1
      let lower = false
      for (let i = 0; i < LEGS.length; i++) {
        const L = LEGS[i]
        if (p.x >= L.x0 && p.x <= L.x1 && p.y >= L.hipY) {
          kind = LEG
          legIdx = i
          lower = p.y > L.kneeY
          break
        }
      }
      if (kind === BODY && p.x < TAIL.maxX && p.y < TAIL.maxY) kind = TAIL_BONE

      const dist = Math.hypot(p.x - cx, p.y - cy) / maxR
      return {
        sx: p.x,
        sy: p.y,
        staticNx: (p.x - minX) / bw,
        base: sampleBlue(dist),
        kind,
        legIdx,
        lower,
      }
    })
    boxRef.current = { minX, minY, bw, bh, aspect: bw / bh }
  }, [config.dotGap])

  // Reset the timeline on an external restart signal.
  useEffect(() => {
    restartRef.current = true
  }, [restartSignal])

  // Main render loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const logoPath = new Path2D(ARC_LOGO_PATH)
    let raf = 0
    let start = performance.now()
    let last = start

    const rot = (x: number, y: number, a: number) => {
      const c = Math.cos(a)
      const s = Math.sin(a)
      return { x: x * c - y * s, y: x * s + y * c }
    }

    const draw = (t: number, W: number, H: number) => {
      const cfg = cfgRef.current
      const dots = dotsRef.current
      const box = boxRef.current

      if (cfg.background === "transparent") {
        ctx.clearRect(0, 0, W, H)
      } else {
        ctx.fillStyle = cfg.background
        ctx.fillRect(0, 0, W, H)
      }

      const minVp = Math.min(W, H)
      const cx = W / 2
      const cy = H / 2

      // ---- Jaguar layout -------------------------------------------------
      const targetW = cfg.jaguarScale * Math.min(W * 0.94, H * 0.94 * box.aspect)
      const targetH = targetW / box.aspect
      const screenGap = (targetW * cfg.dotGap) / box.bw
      const baseR = Math.max(0.4, cfg.dotRadius * screenGap)

      const dotsStart = cfg.logoIn + cfg.logoHold
      const dotsEnd = dotsStart + cfg.dotsStagger + cfg.dotFly

      // ---- Gait state ----------------------------------------------------
      const run = cfg.running && t > dotsStart
      const phase = run ? (2 * Math.PI * (t - dotsStart)) / cfg.runPeriod : 0
      const hipA = (cfg.hipSwing * Math.PI) / 180
      const kneeA = (cfg.kneeBend * Math.PI) / 180
      const tailA = (cfg.tailSway * Math.PI) / 180
      const bob = run ? cfg.bodyBob * Math.sin(phase * 2) : 0

      // ---- Jaguar dots ---------------------------------------------------
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i]

        // Skeleton deform (rest pose → animated source coords).
        let gx = d.sx
        let gy = d.sy
        if (run) {
          if (d.kind === LEG) {
            const L = LEGS[d.legIdx]
            const ph = phase + L.offset
            const swing = hipA * Math.sin(ph)
            const flex = kneeA * (0.5 - 0.5 * Math.cos(ph + KNEE_PHASE))
            if (!d.lower) {
              const r = rot(gx - L.hipX, gy - L.hipY, swing)
              gx = L.hipX + r.x
              gy = L.hipY + r.y
            } else {
              const kr = rot(0, L.kneeY - L.hipY, swing)
              const kx = L.hipX + kr.x
              const ky = L.hipY + kr.y
              const dr = rot(gx - L.hipX, gy - L.kneeY, swing + flex)
              gx = kx + dr.x
              gy = ky + dr.y
            }
          } else if (d.kind === TAIL_BONE) {
            const a = tailA * Math.sin(phase + 0.6)
            const r = rot(gx - TAIL.pivotX, gy - TAIL.pivotY, a)
            gx = TAIL.pivotX + r.x
            gy = TAIL.pivotY + r.y
          }
        }
        gy += bob

        // To screen.
        const nx = (gx - box.minX) / box.bw
        const ny = (gy - box.minY) / box.bh
        const px = cx + (nx - 0.5) * targetW
        const py = cy + (ny - 0.5) * targetH

        // Assembly: staggered fade + slight rise, ordered nose→tail by x.
        const delay = (1 - d.staticNx) * cfg.dotsStagger
        const p = clamp01((t - dotsStart - delay) / cfg.dotFly)
        if (p <= 0) continue
        const e = easeOutCubic(p)
        const drawY = py - (1 - e) * targetH * 0.1
        const alpha = Math.min(1, p * 1.7)

        ctx.beginPath()
        ctx.fillStyle = `rgba(${d.base[0]},${d.base[1]},${d.base[2]},${alpha})`
        ctx.arc(px, drawY, baseR, 0, Math.PI * 2)
        ctx.fill()
      }

      // ---- Arc dome logo intro -------------------------------------------
      if (cfg.showLogoIntro) {
        const inEnd = cfg.logoIn
        const holdEnd = inEnd + cfg.logoHold
        const outEnd = holdEnd + cfg.logoOut
        if (t < outEnd) {
          let scale = 1
          let alpha = 1
          if (t < inEnd) {
            const e = easeOutCubic(t / cfg.logoIn)
            scale = 0.5 + 0.5 * e
            alpha = e
          } else if (t < holdEnd) {
            scale = 1
            alpha = 1
          } else {
            const e = easeInCubic((t - holdEnd) / cfg.logoOut)
            scale = 1 + 2.8 * e
            alpha = 1 - e
          }

          const targetLogoH = 0.18 * minVp
          const pscale = (targetLogoH / ARC_BBOX.h) * scale

          ctx.save()
          ctx.globalAlpha = alpha
          ctx.translate(cx, cy)
          ctx.scale(pscale, pscale)
          ctx.translate(-ARC_BBOX.cx, -ARC_BBOX.cy)
          const grad = ctx.createRadialGradient(ARC_BBOX.cx, ARC_BBOX.cy, 0, ARC_BBOX.cx, ARC_BBOX.cy, 360)
          grad.addColorStop(0, "rgb(0,52,160)")
          grad.addColorStop(0.42, "rgb(14,88,182)")
          grad.addColorStop(1, "rgb(45,167,231)")
          ctx.fillStyle = grad
          ctx.fill(logoPath)
          ctx.restore()
        }
      }

      void dotsEnd
    }

    const frame = (now: number) => {
      const cfg = cfgRef.current
      const dt = now - last
      last = now

      if (restartRef.current) {
        start = now
        restartRef.current = false
      }
      if (cfg.paused) start += dt // freeze t

      let t = (now - start) * cfg.timeScale
      const total = cfg.logoIn + cfg.logoHold + cfg.dotsStagger + cfg.dotFly + cfg.holdAfter
      if (t >= total) {
        if (cfg.loop) {
          start = now
          t = 0
          onCycleRef.current?.()
        } else {
          t = total
        }
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      draw(t, cw, ch)
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvasRef} className={className} style={{ width: "100%", height: "100%", display: "block" }} />
}

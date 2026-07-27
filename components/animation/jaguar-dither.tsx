"use client"

import { useEffect, useRef } from "react"

/**
 * JaguarDither — Arc brand intro animation.
 *
 * Timeline:
 *  1. The Arc dome logo scales in at center (brand radial-blue gradient).
 *  2. The dome expands outward and fades.
 *  3. A jaguar, rendered as a dithered grid of dots, assembles and runs a
 *     rotary gallop — the gait big cats actually use at speed.
 *
 * The cat is not a rigid silhouette with legs bolted on. Dots are sampled once
 * from a neutral standing pose, bound to a skeleton, and skinned every frame:
 *
 *  - The spine is a seven-joint chain deformed as a curve, so the whole trunk
 *    flexes and extends through the stride. That flexion is the single biggest
 *    reason a galloping felid reads as fast — the back does as much work as the
 *    legs, and no amount of leg swing substitutes for it.
 *  - Each limb is a three-segment chain (thigh/shank/foot, upper/fore/paw)
 *    driven by a stance-and-swing model rather than a sine wave, so the foot
 *    sweeps back while planted and folds tight on the way through.
 *  - Footfalls follow a rotary gallop — left hind, right hind, right fore, left
 *    fore — with two suspension phases per stride: gathered (limbs bunched) and
 *    extended (limbs thrown out).
 *  - The tail runs a travelling wave, and the head counter-rotates against the
 *    neck so the gaze stays level while the body pitches under it.
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

// ---------------------------------------------------------------------------
// Rest skeleton — a neutral standing jaguar, facing right
// ---------------------------------------------------------------------------

const SRC_W = 1000
const SRC_H = 560

type Pt = [number, number]

/** Pelvis → skull base. Deformed as a curve; carries the whole trunk. */
const SPINE: Pt[] = [
  [330, 250],
  [420, 244],
  [510, 240],
  [600, 238],
  [680, 240],
  [742, 246],
  [800, 252],
]

/** How much of the spine bend each segment takes — most of it in the loin. */
const SPINE_BEND_W = [0.3, 0.26, 0.19, 0.12, 0.08, 0.05]

/** Pelvis → tip. */
const TAIL: Pt[] = [
  [330, 252],
  [280, 246],
  [228, 240],
  [176, 234],
  [124, 230],
  [74, 226],
  [30, 224],
]
const TAIL_RADII = [15, 13, 11, 9, 8, 7, 5]

type Limb = {
  kind: "hind" | "fore"
  /** Spine joint the limb hangs from. */
  attach: number
  /** hip/shoulder → mid → low → toe. Three bones. */
  joints: Pt[]
  radii: number[]
  /** Footfall offset within the stride, 0..1. */
  phase: number
}

/**
 * Rotary gallop footfall order: left hind, right hind, right fore, left fore.
 * "Far" limbs are the left pair, drawn a little behind the near pair.
 */
const LIMBS: Limb[] = [
  {
    kind: "hind",
    attach: 0,
    joints: [
      [322, 296],
      [312, 368],
      [324, 436],
      [318, 514],
    ],
    radii: [42, 26, 17, 13],
    phase: 0.0,
  },
  {
    kind: "hind",
    attach: 0,
    joints: [
      [350, 296],
      [340, 368],
      [352, 436],
      [346, 514],
    ],
    radii: [42, 26, 17, 13],
    phase: 0.12,
  },
  {
    kind: "fore",
    attach: 4,
    joints: [
      [702, 300],
      [704, 372],
      [708, 444],
      [712, 514],
    ],
    radii: [38, 24, 15, 12],
    phase: 0.42,
  },
  {
    kind: "fore",
    attach: 4,
    joints: [
      [676, 300],
      [678, 372],
      [682, 444],
      [686, 514],
    ],
    radii: [38, 24, 15, 12],
    phase: 0.54,
  },
]

/** Everything forward of this belongs to the rigid skull. */
const HEAD_X = 800

/** Tapered capsule between two joints — the limb and tail geometry. */
function capsule(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): string {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  return [
    `M ${x0 + nx * r0} ${y0 + ny * r0}`,
    `L ${x1 + nx * r1} ${y1 + ny * r1}`,
    `A ${r1} ${r1} 0 0 0 ${x1 - nx * r1} ${y1 - ny * r1}`,
    `L ${x0 - nx * r0} ${y0 - ny * r0}`,
    `A ${r0} ${r0} 0 0 0 ${x0 + nx * r0} ${y0 + ny * r0}`,
    "Z",
  ].join(" ")
}

function chainCapsules(joints: Pt[], radii: number[]): string[] {
  const out: string[] = []
  for (let i = 0; i < joints.length - 1; i++) {
    out.push(capsule(joints[i][0], joints[i][1], radii[i], joints[i + 1][0], joints[i + 1][1], radii[i + 1]))
  }
  return out
}

/**
 * Rest silhouette, filled part by part so overlaps union regardless of winding.
 * Trunk, neck and skull are authored; limbs and tail come off the skeleton, so
 * the drawing and the rig can never drift apart.
 */
const REST_PARTS: string[] = [
  // Trunk: withers → back → rump → haunch → waist tuck → chest.
  [
    "M 690 236",
    "C 620 230 540 236 470 240",
    "C 420 242 370 238 336 232",
    "C 306 228 286 238 276 258",
    "C 266 284 268 314 280 340",
    "C 296 360 322 372 352 372",
    "C 392 368 428 348 456 330",
    "C 484 314 512 306 542 306",
    "C 590 312 646 330 688 348",
    "C 712 356 734 352 748 342",
    "C 764 326 768 296 762 268",
    "C 752 246 712 236 690 236",
    "Z",
  ].join(" "),
  // Neck.
  "M 738 246 C 760 234 786 228 806 230 C 814 252 814 288 806 310 C 784 312 758 322 742 336 C 730 318 728 270 738 246 Z",
  // Skull — big and blocky, the jaguar's tell.
  "M 800 240 C 820 222 858 216 884 224 C 908 232 920 250 920 272 C 920 296 906 314 882 320 C 852 328 818 320 806 304 C 794 286 792 254 800 240 Z",
  // Muzzle — short and deep.
  "M 896 250 C 920 244 942 254 946 272 C 950 292 938 306 916 310 C 902 312 894 302 892 288 C 890 270 891 254 896 250 Z",
  // Ears — small, rounded.
  "M 812 232 C 806 210 816 194 832 198 C 846 202 852 222 848 240 Z",
  "M 848 226 C 846 206 856 194 870 200 C 882 206 882 224 878 236 Z",
  ...chainCapsules(TAIL, TAIL_RADII),
  ...LIMBS.flatMap((l) => chainCapsules(l.joints, l.radii)),
]

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
  /** Hip/shoulder protraction–retraction amplitude, degrees. */
  hipSwing: number
  /** Mid-limb fold amplitude through swing, degrees. */
  kneeBend: number
  /** Peak spine flexion/extension across the whole trunk, degrees. */
  spineFlex: number
  /** Fraction of the stride each limb spends on the ground. */
  duty: number
  /** Vertical travel of the body through the two suspensions, source units. */
  bodyBob: number
  /** Trunk pitch oscillation, degrees. */
  bodyPitch: number
  /** Tail wave amplitude, degrees. */
  tailSway: number
  /** Tail carriage — how high the tail streams behind, degrees. */
  tailLift: number
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
  dotGap: 8,
  dotRadius: 0.36,
  jaguarScale: 0.72,
  showLogoIntro: true,
  running: true,
  runPeriod: 460,
  hipSwing: 32,
  kneeBend: 62,
  spineFlex: 17,
  duty: 0.32,
  bodyBob: 13,
  bodyPitch: 5,
  tailSway: 9,
  tailLift: 13,
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

const DEG = Math.PI / 180
const TAU = Math.PI * 2
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInCubic = (t: number) => t * t * t
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)
const smoothstep = (t: number) => t * t * (3 - 2 * t)

/** Squared distance from p to segment ab, plus the unclamped projection. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  const u = ((px - ax) * dx + (py - ay) * dy) / len2
  const c = u < 0 ? 0 : u > 1 ? 1 : u
  const qx = ax + dx * c
  const qy = ay + dy * c
  return { d2: (px - qx) ** 2 + (py - qy) ** 2, u }
}

/**
 * Walk a chain, applying a relative bend at each joint while preserving segment
 * lengths. Returns joint positions plus the absolute angle of each segment.
 */
function deformChain(rest: Pt[], bends: number[], rootX: number, rootY: number, rootAngle: number) {
  const pts: Pt[] = [[rootX, rootY]]
  const angs: number[] = []
  let acc = rootAngle
  for (let i = 1; i < rest.length; i++) {
    const dx = rest[i][0] - rest[i - 1][0]
    const dy = rest[i][1] - rest[i - 1][1]
    const len = Math.hypot(dx, dy)
    acc += bends[i - 1] ?? 0
    const a = Math.atan2(dy, dx) + acc
    angs.push(a)
    pts.push([pts[i - 1][0] + Math.cos(a) * len, pts[i - 1][1] + Math.sin(a) * len])
  }
  return { pts, angs }
}

/**
 * Stance-and-swing joint angles for one limb at stride phase p.
 *
 * Stance sweeps the planted foot from protracted to retracted while the limb
 * extends to push; swing throws it forward with a tight fold that peaks
 * mid-flight. Hind limbs fold harder than fore limbs, which is what makes the
 * hindquarters look like they're doing the work.
 */
function limbAngles(p: number, kind: "hind" | "fore", swing: number, fold: number, duty: number) {
  const hindward = kind === "hind"
  if (p < duty) {
    const u = p / duty
    const ext = Math.sin(Math.PI * u) // 0 → 1 → 0 across the contact
    const residual = 1 - ext
    return [
      swing * (1 - 2 * u),
      -(hindward ? 0.34 : 0.24) * fold * residual,
      (hindward ? 0.3 : 0.2) * fold * residual,
    ]
  }
  const v = (p - duty) / (1 - duty)
  const tuck = Math.sin(Math.PI * v) // peak fold at mid-swing
  return [
    -swing + 2 * swing * smoothstep(v),
    -(hindward ? 1 : 0.82) * fold * tuck,
    (hindward ? 0.86 : 0.68) * fold * tuck,
  ]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** How a dot follows the skeleton. */
const BIND_SPINE = 0
const BIND_HEAD = 1
const BIND_TAIL = 2
const BIND_LIMB = 3

type Dot = {
  bind: number
  /** Chain segment (spine/tail) or bone index (limb). */
  seg: number
  /** Limb index when bind === BIND_LIMB. */
  limb: number
  /** Local coords in the bound segment's rest frame. */
  u: number
  v: number
  /** Blend toward the next bone, for limb joints. */
  w: number
  staticNx: number
  base: [number, number, number]
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

  // Sample the rest pose and bind every dot to the skeleton.
  useEffect(() => {
    const gap = config.dotGap
    const off = document.createElement("canvas")
    off.width = SRC_W
    off.height = SRC_H
    const o = off.getContext("2d", { willReadFrequently: true })
    if (!o) return
    o.fillStyle = "#000"
    // One fill per part: overlaps union instead of cancelling on winding.
    for (const part of REST_PARTS) o.fill(new Path2D(part))
    const data = o.getImageData(0, 0, SRC_W, SRC_H).data

    const raw: Pt[] = []
    for (let y = gap / 2; y < SRC_H; y += gap) {
      for (let x = gap / 2; x < SRC_W; x += gap) {
        const a = data[(Math.floor(y) * SRC_W + Math.floor(x)) * 4 + 3]
        if (a > 128) raw.push([x, y])
      }
    }
    if (raw.length === 0) return

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of raw) {
      if (p[0] < minX) minX = p[0]
      if (p[1] < minY) minY = p[1]
      if (p[0] > maxX) maxX = p[0]
      if (p[1] > maxY) maxY = p[1]
    }
    const bw = maxX - minX || 1
    const bh = maxY - minY || 1
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const maxR = 0.5 * Math.hypot(bw, bh)

    /** Project onto a chain, returning the nearest segment and local frame. */
    const bindChain = (px: number, py: number, chain: Pt[]) => {
      let best = 0
      let bestD2 = Infinity
      let bestU = 0
      for (let i = 0; i < chain.length - 1; i++) {
        const r = segDist(px, py, chain[i][0], chain[i][1], chain[i + 1][0], chain[i + 1][1])
        if (r.d2 < bestD2) {
          bestD2 = r.d2
          best = i
          bestU = r.u
        }
      }
      const ax = chain[best][0]
      const ay = chain[best][1]
      const len = Math.hypot(chain[best + 1][0] - ax, chain[best + 1][1] - ay) || 1
      const dx = (chain[best + 1][0] - ax) / len
      const dy = (chain[best + 1][1] - ay) / len
      return {
        seg: best,
        u: bestU * len,
        v: -(px - ax) * dy + (py - ay) * dx,
        d2: bestD2,
      }
    }

    dotsRef.current = raw.map(([px, py]) => {
      const dist = Math.hypot(px - cx, py - cy) / maxR
      const base = sampleBlue(dist)
      const staticNx = (px - minX) / bw

      // Limbs claim first: a dot inside a bone's capsule rides that bone.
      let limbIdx = -1
      let boneIdx = 0
      let bestScore = 1
      for (let li = 0; li < LIMBS.length; li++) {
        const L = LIMBS[li]
        for (let b = 0; b < L.joints.length - 1; b++) {
          const r = segDist(px, py, L.joints[b][0], L.joints[b][1], L.joints[b + 1][0], L.joints[b + 1][1])
          const c = clamp01(r.u)
          const rad = L.radii[b] + (L.radii[b + 1] - L.radii[b]) * c
          const score = Math.sqrt(r.d2) / rad
          if (score < bestScore) {
            bestScore = score
            limbIdx = li
            boneIdx = b
          }
        }
      }

      if (limbIdx >= 0) {
        const L = LIMBS[limbIdx]
        const ax = L.joints[boneIdx][0]
        const ay = L.joints[boneIdx][1]
        const len = Math.hypot(L.joints[boneIdx + 1][0] - ax, L.joints[boneIdx + 1][1] - ay) || 1
        const dx = (L.joints[boneIdx + 1][0] - ax) / len
        const dy = (L.joints[boneIdx + 1][1] - ay) / len
        const u = (px - ax) * dx + (py - ay) * dy
        const v = -(px - ax) * dy + (py - ay) * dx
        // Soften the crease at the joint by blending into the next bone.
        const w = boneIdx < L.joints.length - 2 ? clamp01((u / len - 0.72) / 0.28) * 0.5 : 0
        return { bind: BIND_LIMB, seg: boneIdx, limb: limbIdx, u, v, w, staticNx, base }
      }

      if (px >= HEAD_X) {
        const anchor = SPINE[SPINE.length - 1]
        return {
          bind: BIND_HEAD,
          seg: 0,
          limb: -1,
          u: px - anchor[0],
          v: py - anchor[1],
          w: 0,
          staticNx,
          base,
        }
      }

      // The tail only claims dots that actually sit inside its capsules —
      // nearest-chain would hand it the whole rump, which then swings with it.
      let inTail = false
      for (let b = 0; b < TAIL.length - 1 && !inTail; b++) {
        const r = segDist(px, py, TAIL[b][0], TAIL[b][1], TAIL[b + 1][0], TAIL[b + 1][1])
        const c = clamp01(r.u)
        const rad = TAIL_RADII[b] + (TAIL_RADII[b + 1] - TAIL_RADII[b]) * c
        if (Math.sqrt(r.d2) < rad) inTail = true
      }
      if (inTail && px < SPINE[0][0] - 20) {
        const tail = bindChain(px, py, TAIL)
        return { bind: BIND_TAIL, seg: tail.seg, limb: -1, u: tail.u, v: tail.v, w: 0, staticNx, base }
      }
      const spine = bindChain(px, py, SPINE)
      return { bind: BIND_SPINE, seg: spine.seg, limb: -1, u: spine.u, v: spine.v, w: 0, staticNx, base }
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

      const targetW = cfg.jaguarScale * Math.min(W * 0.94, H * 0.94 * box.aspect)
      const targetH = targetW / box.aspect
      const screenGap = (targetW * cfg.dotGap) / box.bw
      const baseR = Math.max(0.35, cfg.dotRadius * screenGap)

      const dotsStart = cfg.logoIn + cfg.logoHold
      const run = cfg.running && t > dotsStart
      const stride = run ? ((t - dotsStart) / cfg.runPeriod) % 1 : 0

      // ---- Trunk ---------------------------------------------------------
      // Two suspensions per stride: the trunk flexes as the hind limbs swing
      // through under it, then extends as they drive back.
      const flex = run ? cfg.spineFlex * DEG * Math.cos(TAU * stride + 0.9) : 0
      const spineBends = SPINE_BEND_W.map((w) => flex * w)
      const pitch = run ? cfg.bodyPitch * DEG * Math.sin(TAU * stride + 0.4) : 0
      const bob = run ? cfg.bodyBob * Math.cos(2 * TAU * stride) : 0

      const spine = deformChain(SPINE, spineBends, SPINE[0][0], SPINE[0][1] + bob, pitch)

      // ---- Tail ----------------------------------------------------------
      // Carried high and running a travelling wave down its length.
      const tailBends = TAIL.slice(0, -1).map((_, k) =>
        run ? (-cfg.tailLift * DEG) / 3 + cfg.tailSway * DEG * Math.sin(TAU * stride - k * 0.7) * (0.4 + k * 0.14) : 0,
      )
      const tail = deformChain(TAIL, tailBends, spine.pts[0][0], spine.pts[0][1], pitch)

      // ---- Limbs ---------------------------------------------------------
      const swing = cfg.hipSwing * DEG
      const fold = cfg.kneeBend * DEG
      const limbs = LIMBS.map((L) => {
        const anchor = SPINE[L.attach]
        const rootAng = spine.angs[Math.min(L.attach, spine.angs.length - 1)]
        const restAng = Math.atan2(
          SPINE[Math.min(L.attach + 1, SPINE.length - 1)][1] - anchor[1],
          SPINE[Math.min(L.attach + 1, SPINE.length - 1)][0] - anchor[0],
        )
        const twist = rootAng - restAng
        const ox = L.joints[0][0] - anchor[0]
        const oy = L.joints[0][1] - anchor[1]
        const c = Math.cos(twist)
        const s = Math.sin(twist)
        const rootX = spine.pts[L.attach][0] + ox * c - oy * s
        const rootY = spine.pts[L.attach][1] + ox * s + oy * c
        const bends = run
          ? limbAngles((stride + L.phase) % 1, L.kind, swing, fold, cfg.duty)
          : [0, 0, 0]
        return deformChain(L.joints, bends, rootX, rootY, twist)
      })

      // ---- Head ----------------------------------------------------------
      // Counter-rotate against the neck so the gaze holds level.
      const neckAng = spine.angs[spine.angs.length - 1]
      const neckRest = Math.atan2(
        SPINE[SPINE.length - 1][1] - SPINE[SPINE.length - 2][1],
        SPINE[SPINE.length - 1][0] - SPINE[SPINE.length - 2][0],
      )
      const headAng = (neckAng - neckRest) * 0.35
      const headC = Math.cos(headAng)
      const headS = Math.sin(headAng)
      const headX = spine.pts[spine.pts.length - 1][0]
      const headY = spine.pts[spine.pts.length - 1][1]

      // ---- Dots ----------------------------------------------------------
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i]
        let gx: number
        let gy: number

        if (d.bind === BIND_HEAD) {
          gx = headX + d.u * headC - d.v * headS
          gy = headY + d.u * headS + d.v * headC
        } else if (d.bind === BIND_LIMB) {
          const L = limbs[d.limb]
          const a = L.angs[d.seg]
          const ca = Math.cos(a)
          const sa = Math.sin(a)
          gx = L.pts[d.seg][0] + d.u * ca - d.v * sa
          gy = L.pts[d.seg][1] + d.u * sa + d.v * ca
          if (d.w > 0) {
            const rest = LIMBS[d.limb].joints
            const len = Math.hypot(rest[d.seg + 1][0] - rest[d.seg][0], rest[d.seg + 1][1] - rest[d.seg][1])
            const nb = L.angs[d.seg + 1]
            const cb = Math.cos(nb)
            const sb = Math.sin(nb)
            const nx = L.pts[d.seg + 1][0] + (d.u - len) * cb - d.v * sb
            const ny = L.pts[d.seg + 1][1] + (d.u - len) * sb + d.v * cb
            gx += (nx - gx) * d.w
            gy += (ny - gy) * d.w
          }
        } else {
          const chain = d.bind === BIND_TAIL ? tail : spine
          const a = chain.angs[d.seg]
          const ca = Math.cos(a)
          const sa = Math.sin(a)
          gx = chain.pts[d.seg][0] + d.u * ca - d.v * sa
          gy = chain.pts[d.seg][1] + d.u * sa + d.v * ca
        }

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
        ctx.arc(px, drawY, baseR, 0, TAU)
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

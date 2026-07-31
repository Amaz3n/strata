/**
 * Pointer/wheel gesture wiring for GPU viewers.
 *
 * Behavioral contract inherited from the OpenSeadragon era (the measuring
 * tools depend on it — see drawing-viewer.tsx):
 *  - `preventDefault()` on every primary pointerdown, so the browser never
 *    synthesizes mouse events for a press over the sheet. Tools listen for
 *    POINTER events in the capture phase; React mouse handlers only ever see
 *    presses the SVG overlay swallowed.
 *  - Drag-pan stays live regardless of the click/scroll options, so a room
 *    can be traced across a sheet without disarming the tool.
 *  - Options mirror OSD's gesture settings and are toggled by the viewer
 *    chrome per active tool.
 */

export interface GestureOptions {
  clickToZoom: boolean
  dblClickToZoom: boolean
  scrollToZoom: boolean
  pinchToZoom: boolean
  /** Touch flick inertia. */
  flickEnabled: boolean
}

export interface GestureHost {
  panByScreen(dx: number, dy: number): void
  /** `animate` marks discrete zooms (double-click, click-zoom) that should
   * glide; continuous input (pinch, wheel) passes false and applies raw. */
  zoomBy(factor: number, focal: { x: number; y: number }, animate: boolean): void
}

export interface GestureController {
  setOptions(options: Partial<GestureOptions>): void
  destroy(): void
}

const CLICK_SLOP_PX = 5
const CLICK_MAX_MS = 300
const ZOOM_PER_CLICK = 2
/** Trackpad pinch (ctrl/cmd-wheel) delta → zoom factor exponent. */
const PINCH_ZOOM_RATE = 0.012
/** ~1.2x per classic 120-unit wheel notch (notched mice). */
const WHEEL_ZOOM_RATE = 1.0015
/** deltaMode LINE/PAGE arrive in lines; convert to pixel-ish units. */
const WHEEL_LINE_PX = 40
const FLICK_MIN_SPEED_PX_MS = 0.4
const FLICK_DECAY_PER_MS = 0.0045

interface TrackedPointer {
  x: number
  y: number
}

export function attachGestures(
  element: HTMLElement,
  host: GestureHost,
  initial?: Partial<GestureOptions>,
): GestureController {
  const options: GestureOptions = {
    clickToZoom: false,
    dblClickToZoom: true,
    scrollToZoom: true,
    pinchToZoom: true,
    flickEnabled: true,
    ...initial,
  }

  const pointers = new Map<number, TrackedPointer>()
  let pressStart: { x: number; y: number; time: number } | null = null
  let lastVelocity = { x: 0, y: 0 }
  let lastMoveTime = 0
  let flickFrame = 0

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = element.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const stopFlick = () => {
    if (flickFrame) cancelAnimationFrame(flickFrame)
    flickFrame = 0
  }

  const startFlick = (pointerType: string) => {
    if (!options.flickEnabled || pointerType !== "touch") return
    const speed = Math.hypot(lastVelocity.x, lastVelocity.y)
    if (speed < FLICK_MIN_SPEED_PX_MS) return
    let vx = lastVelocity.x
    let vy = lastVelocity.y
    let last = performance.now()
    const step = (now: number) => {
      const dt = now - last
      last = now
      const keep = Math.pow(1 - FLICK_DECAY_PER_MS, dt)
      vx *= keep
      vy *= keep
      host.panByScreen(vx * dt, vy * dt)
      if (Math.hypot(vx, vy) > 0.02) flickFrame = requestAnimationFrame(step)
      else flickFrame = 0
    }
    flickFrame = requestAnimationFrame(step)
  }

  const pinchState = { distance: 0, midpoint: { x: 0, y: 0 } }

  const refreshPinch = () => {
    const [a, b] = [...pointers.values()]
    pinchState.distance = Math.hypot(b.x - a.x, b.y - a.y)
    pinchState.midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    // Suppress synthesized mouse events for presses over the sheet — the
    // measuring tools' capture-phase pointer listeners rely on this.
    event.preventDefault()
    stopFlick()
    element.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, localPoint(event))
    if (pointers.size === 1) {
      pressStart = { ...localPoint(event), time: performance.now() }
      lastVelocity = { x: 0, y: 0 }
      lastMoveTime = performance.now()
    } else if (pointers.size === 2) {
      pressStart = null
      refreshPinch()
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const tracked = pointers.get(event.pointerId)
    if (!tracked) return
    const point = localPoint(event)

    if (pointers.size === 1) {
      const dx = point.x - tracked.x
      const dy = point.y - tracked.y
      const now = performance.now()
      const dt = Math.max(1, now - lastMoveTime)
      lastVelocity = { x: dx / dt, y: dy / dt }
      lastMoveTime = now
      host.panByScreen(dx, dy)
    } else if (pointers.size === 2 && options.pinchToZoom) {
      tracked.x = point.x
      tracked.y = point.y
      const previousDistance = pinchState.distance
      const previousMid = pinchState.midpoint
      refreshPinch()
      if (previousDistance > 0) {
        host.zoomBy(pinchState.distance / previousDistance, pinchState.midpoint, false)
        host.panByScreen(
          pinchState.midpoint.x - previousMid.x,
          pinchState.midpoint.y - previousMid.y,
        )
      }
      return
    }
    tracked.x = point.x
    tracked.y = point.y
  }

  const onPointerEnd = (event: PointerEvent) => {
    const wasTracked = pointers.delete(event.pointerId)
    if (!wasTracked) return
    if (pointers.size === 1) refreshPinch()
    if (pointers.size > 0) return

    const press = pressStart
    pressStart = null
    if (event.type === "pointercancel") return

    const point = localPoint(event)
    const isClick =
      press !== null &&
      performance.now() - press.time <= CLICK_MAX_MS &&
      Math.hypot(point.x - press.x, point.y - press.y) <= CLICK_SLOP_PX
    if (isClick && options.clickToZoom && event.pointerType === "mouse") {
      host.zoomBy(ZOOM_PER_CLICK, point, true)
      return
    }
    if (!isClick) startFlick(event.pointerType)
  }

  const onDoubleClick = (event: MouseEvent) => {
    if (!options.dblClickToZoom) return
    event.preventDefault()
    host.zoomBy(ZOOM_PER_CLICK, localPoint(event), true)
  }

  // Mac-native wheel semantics: two-finger scroll PANS the sheet (like every
  // maps/Figma canvas), the trackpad pinch (reported as ctrl/cmd + pixel
  // wheel) zooms at the cursor, and classic notched mouse wheels
  // (deltaMode LINE/PAGE) keep zooming since a mouse has no pinch.
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    stopFlick()
    const focal = localPoint(event)
    if (event.ctrlKey || event.metaKey) {
      host.zoomBy(Math.exp(-event.deltaY * PINCH_ZOOM_RATE), focal, false)
      return
    }
    if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
      if (!options.scrollToZoom) return
      const deltaPx = event.deltaY * WHEEL_LINE_PX
      host.zoomBy(Math.pow(WHEEL_ZOOM_RATE, -deltaPx), focal, false)
      return
    }
    host.panByScreen(-event.deltaX, -event.deltaY)
  }

  element.addEventListener("pointerdown", onPointerDown)
  element.addEventListener("pointermove", onPointerMove)
  element.addEventListener("pointerup", onPointerEnd)
  element.addEventListener("pointercancel", onPointerEnd)
  element.addEventListener("dblclick", onDoubleClick)
  element.addEventListener("wheel", onWheel, { passive: false })

  return {
    setOptions(next) {
      Object.assign(options, next)
    },
    destroy() {
      stopFlick()
      element.removeEventListener("pointerdown", onPointerDown)
      element.removeEventListener("pointermove", onPointerMove)
      element.removeEventListener("pointerup", onPointerEnd)
      element.removeEventListener("pointercancel", onPointerEnd)
      element.removeEventListener("dblclick", onDoubleClick)
      element.removeEventListener("wheel", onWheel)
    },
  }
}

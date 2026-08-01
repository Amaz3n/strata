"use client"

/**
 * The walkable model.
 *
 * Three.js, dynamically imported so none of it reaches the app shell — this
 * component is the only place in Arc that touches a 3D scene graph, and it
 * loads when somebody asks to see a house, not when they open the sidebar.
 * The 2D tile renderer in `lib/viewer` is deliberately NOT extended: a
 * walkthrough needs cameras, lighting and collision, and forcing those into a
 * tile compositor would be work spent fighting the wrong abstraction.
 *
 * Deliberately model-like, not photoreal: matte neutral surfaces, one soft sky
 * light, no textures. A buyer walking their plan should read it as an accurate
 * diagram of their house — promising a rendering the model cannot deliver is
 * how this feature would lose trust the first time somebody stood in it.
 *
 * Colours are resolved from the app's own CSS custom properties at build time,
 * so the scene follows the light/dark theme instead of hard-coding a palette.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  Box,
  Download,
  Footprints,
  Layers,
  Loader2,
  Maximize2,
  Orbit,
  Ruler,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  buildSceneGeometry,
  resolveWalkCollision,
  DOLLHOUSE_CUT_FT,
  EYE_HEIGHT_FT,
  type LevelGeometry,
  type MeshData,
  type SceneGeometry,
} from "@/lib/plans/floorplan-geometry"
import type { FloorplanModel } from "@/lib/drawings/floorplan-model"
import { cn } from "@/lib/utils"

export type ViewerMode = "orbit" | "walk"

/** Level selector value: a level id, or every level at once. */
const ALL_LEVELS = "all"

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Resolve a CSS custom property to an `0xRRGGBB` integer.
 *
 * Arc's tokens are `oklch`, which Three cannot parse. Painting one pixel with
 * the token and reading it back makes the BROWSER do the conversion, so the
 * scene is guaranteed to match the surrounding UI in either theme — and it
 * keeps this file honest about the tokens-only rule.
 */
function resolveTokenColor(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback
  const raw = readTokenString(name, "")
  if (!raw) return fallback
  try {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) return fallback
    // Assigning an unparseable colour leaves fillStyle untouched, so a sentinel
    // that survives the assignment means the token was not understood.
    context.fillStyle = "magenta"
    context.fillStyle = raw
    if (context.fillStyle === "magenta") return fallback
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return (r << 16) | (g << 8) | b
  } catch {
    return fallback
  }
}

/** The token's own CSS value, for the 2D contexts that draw room labels. */
function readTokenString(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/**
 * Material colours are FIXED, not themed.
 *
 * The first cut resolved wall/floor/ceiling from `--card`/`--secondary`, which
 * is right for UI chrome and wrong for a physical model: in dark mode the
 * house came out near-black on a near-black void and you could not read a
 * single room. Drywall is off-white whatever theme the app is in. The theme
 * drives the ENVIRONMENT — void, ground, grid, labels — and nothing else.
 */
const MATERIAL = {
  wall: 0xf4f2ee,
  wallExterior: 0xe6e2da,
  trim: 0xfcfbf8,
  glass: 0x9fc0d6,
  floor: 0xcfccc5,
  ceiling: 0xfaf9f7,
  edge: 0x5b5852,
  floorInk: 0x45423c,
} as const

interface Palette {
  background: number
  ground: number
  grid: number
  label: string
  labelBackground: string
  dark: boolean
}

function readPalette(): Palette {
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  return {
    background: resolveTokenColor("--muted", dark ? 0x1c1f26 : 0xf1f2f5),
    // The ground sits just off the void so the model reads as standing on
    // something rather than floating in it.
    ground: dark ? 0x23262d : 0xe6e7ea,
    grid: dark ? 0x343841 : 0xd2d4d9,
    label: readTokenString("--foreground", dark ? "white" : "black"),
    labelBackground: readTokenString("--card", dark ? "black" : "white"),
    dark,
  }
}

/** 12'-4" — the way a builder reads a distance. */
function formatFeetInches(feet: number): string {
  const whole = Math.floor(feet)
  const inches = Math.round((feet - whole) * 12)
  if (inches === 12) return `${whole + 1}'-0"`
  return `${whole}'-${inches}"`
}

// ---------------------------------------------------------------------------
// Scene controller
// ---------------------------------------------------------------------------

type ThreeModule = typeof import("three")

export type ViewerTool = "measure" | null

export interface WalkPose {
  levelId: string
  x: number
  z: number
  yaw: number
}

interface ControllerOptions {
  container: HTMLElement
  onReady: (stats: { buildMs: number; scene: SceneGeometry }) => void
  onModeChange: (mode: ViewerMode) => void
  onLevelChange: (levelId: string) => void
  onToolChange: (tool: ViewerTool) => void
  onMeasure: (text: string | null) => void
}

/**
 * Imperative owner of the WebGL scene.
 *
 * React drives it through setters instead of re-rendering it: a scene graph is
 * mutable state with a render loop attached, and reconciling one through JSX
 * costs frames for nothing.
 */
class FloorplanScene {
  private three: ThreeModule
  private renderer: import("three").WebGLRenderer
  private scene: import("three").Scene
  private camera: import("three").PerspectiveCamera
  private root: import("three").Group
  private container: HTMLElement
  private palette: Palette
  private frame = 0
  private disposed = false
  private options: ControllerOptions

  private geometry: SceneGeometry | null = null
  private levelGroups = new Map<string, import("three").Group>()
  private floorMeshes = new Map<string, import("three").Mesh>()
  private ceilingMeshes: Array<import("three").Mesh> = []
  private labelSprites: Array<import("three").Sprite> = []
  private floorLabels: Array<import("three").Mesh> = []
  private clippedMaterials: Array<import("three").Material> = []
  private disposables: Array<{ dispose: () => void }> = []
  private sun: import("three").DirectionalLight

  private mode: ViewerMode = "orbit"
  private visibleLevel: string = ALL_LEVELS
  private showCeilings = false
  private showLabels = true
  private dollhouse = false
  private tool: ViewerTool = null

  // Measure state — markers, line and label live in their own group so one
  // clear() wipes the whole measurement.
  private measureGroup: import("three").Group
  private measurePoints: Array<import("three").Vector3> = []
  private measureDisposables: Array<{ dispose: () => void }> = []

  // Orbit state
  private orbit = { theta: Math.PI * 0.75, phi: Math.PI * 0.32, radius: 60, target: [0, 4, 0] as [number, number, number] }
  private orbitVelocity = { theta: 0, phi: 0 }

  // Walk state
  private walk = { x: 0, z: 0, yaw: 0, pitch: 0 }
  private keys = new Set<string>()
  private joystick = { x: 0, y: 0, active: false }
  private pointer: {
    id: number
    x: number
    y: number
    downX: number
    downY: number
    mode: "look" | "orbit" | null
  } | null = null

  constructor(options: ControllerOptions, three: ThreeModule) {
    this.options = options
    this.three = three
    this.container = options.container
    this.palette = readPalette()

    this.renderer = new three.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = three.PCFSoftShadowMap
    this.renderer.localClippingEnabled = true
    this.renderer.domElement.style.display = "block"
    this.renderer.domElement.style.touchAction = "none"
    this.renderer.domElement.style.outline = "none"
    this.renderer.domElement.tabIndex = 0
    this.container.appendChild(this.renderer.domElement)

    this.scene = new three.Scene()
    this.scene.background = new three.Color(this.palette.background)
    this.scene.fog = new three.Fog(this.palette.background, 90, 400)

    this.camera = new three.PerspectiveCamera(55, this.aspect, 0.1, 2000)
    this.root = new three.Group()
    this.scene.add(this.root)
    this.measureGroup = new three.Group()
    this.scene.add(this.measureGroup)

    // Sky above, bounced light below, one key light for shape, one fill to keep
    // north-facing walls off black. Four cheap lights beat any PBR setup here.
    this.scene.add(new three.HemisphereLight(0xffffff, MATERIAL.floor, 1.2))
    this.scene.add(new three.AmbientLight(0xffffff, 0.35))
    this.sun = new three.DirectionalLight(0xffffff, 1.15)
    this.sun.position.set(60, 120, 45)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0004
    this.scene.add(this.sun)
    const fill = new three.DirectionalLight(0xffffff, 0.35)
    fill.position.set(-60, 45, -40)
    this.scene.add(fill)

    // Ground + grid: without them the model floats in a void with no sense of
    // scale, which is most of why it read as "a bunch of walls".
    const ground = new three.Mesh(
      new three.PlaneGeometry(4000, 4000),
      new three.MeshBasicMaterial({ color: this.palette.ground }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.6
    this.scene.add(ground)
    // MeshBasicMaterial cannot receive shadows, and swapping the ground to a
    // lit material would drag its colour away from the theme token. A shadow
    // catcher is a plane that renders NOTHING except the shadows cast on it.
    const shadowCatcher = new three.Mesh(
      new three.PlaneGeometry(1000, 1000),
      new three.ShadowMaterial({ opacity: this.palette.dark ? 0.28 : 0.16 }),
    )
    shadowCatcher.rotation.x = -Math.PI / 2
    shadowCatcher.position.y = -0.58
    shadowCatcher.receiveShadow = true
    this.scene.add(shadowCatcher)
    const grid = new three.GridHelper(400, 80, this.palette.grid, this.palette.grid)
    grid.position.y = -0.55
    ;(grid.material as import("three").Material).transparent = true
    ;(grid.material as import("three").Material).opacity = this.palette.dark ? 0.5 : 0.7
    this.scene.add(grid)

    this.bindInput()
    this.resizeObserver.observe(this.container)
    this.loop()
  }

  private get aspect(): number {
    const height = this.container.clientHeight || 1
    return (this.container.clientWidth || 1) / height
  }

  private resizeObserver = new ResizeObserver(() => {
    if (this.disposed) return
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return
    this.renderer.setSize(width, height)
    this.camera.aspect = this.aspect
    this.camera.updateProjectionMatrix()
  })

  // -- geometry ------------------------------------------------------------

  setModel(model: FloorplanModel): void {
    const started = performance.now()
    this.clearGeometry()
    const three = this.three
    const geometry = buildSceneGeometry(model)
    this.geometry = geometry

    const wallMaterial = new three.MeshLambertMaterial({ color: MATERIAL.wall })
    const exteriorMaterial = new three.MeshLambertMaterial({ color: MATERIAL.wallExterior })
    const trimMaterial = new three.MeshLambertMaterial({ color: MATERIAL.trim })
    const glassMaterial = new three.MeshLambertMaterial({
      color: MATERIAL.glass,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    })
    // Floors carry their room tint as vertex colours; the material stays white
    // so the tint arrives unmultiplied.
    const floorMaterial = new three.MeshLambertMaterial({ color: 0xffffff, vertexColors: true })
    const plainFloorMaterial = new three.MeshLambertMaterial({ color: MATERIAL.floor })
    const ceilingMaterial = new three.MeshLambertMaterial({
      color: MATERIAL.ceiling,
      transparent: true,
      opacity: 0.9,
    })
    // Edges are what make a matte model legible. Without them two walls meeting
    // at a corner are one continuous pale surface, and the eye cannot find the
    // room boundaries at all — which is most of what "just a bunch of walls"
    // actually describes.
    const edgeMaterial = new three.LineBasicMaterial({
      color: MATERIAL.edge,
      transparent: true,
      opacity: 0.55,
    })
    this.disposables.push(
      wallMaterial,
      exteriorMaterial,
      trimMaterial,
      glassMaterial,
      floorMaterial,
      plainFloorMaterial,
      ceilingMaterial,
      edgeMaterial,
    )
    // Everything above the dollhouse cut vanishes; floors sit below it and are
    // deliberately not clipped, so the plan stays whole while walls open up.
    this.clippedMaterials = [
      wallMaterial,
      exteriorMaterial,
      trimMaterial,
      glassMaterial,
      ceilingMaterial,
      edgeMaterial,
    ]

    for (const level of geometry.levels) {
      const group = new three.Group()
      group.name = level.levelId

      const meshes: Array<{ data: MeshData; material: import("three").Material; kind: "floor" | "wall" | "trim" | "glass" | "ceiling" }> = [
        { data: level.floor, material: level.floor.colors ? floorMaterial : plainFloorMaterial, kind: "floor" },
        { data: level.walls, material: wallMaterial, kind: "wall" },
        { data: level.exteriorWalls, material: exteriorMaterial, kind: "wall" },
        { data: level.trim, material: trimMaterial, kind: "trim" },
        { data: level.glass, material: glassMaterial, kind: "glass" },
        { data: level.ceiling, material: ceilingMaterial, kind: "ceiling" },
      ]
      for (const { data, material, kind } of meshes) {
        if (data.indices.length === 0) continue
        const buffer = new three.BufferGeometry()
        buffer.setAttribute("position", new three.BufferAttribute(data.positions, 3))
        buffer.setAttribute("normal", new three.BufferAttribute(data.normals, 3))
        if (data.colors) buffer.setAttribute("color", new three.BufferAttribute(data.colors, 3))
        buffer.setIndex(new three.BufferAttribute(data.indices, 1))
        buffer.computeBoundingSphere()
        this.disposables.push(buffer)
        const mesh = new three.Mesh(buffer, material)
        if (kind === "wall" || kind === "trim") {
          mesh.castShadow = true
          mesh.receiveShadow = true
        }
        if (kind === "floor") {
          mesh.receiveShadow = true
          this.floorMeshes.set(level.levelId, mesh)
        }
        if (kind === "ceiling") {
          mesh.visible = this.showCeilings
          this.ceilingMeshes.push(mesh)
        }
        group.add(mesh)

        // Only the walls get outlined: edging the floor fan would draw every
        // triangle of the triangulation, not the room's outline.
        if (kind === "wall") {
          const edges = new three.EdgesGeometry(buffer, 25)
          this.disposables.push(edges)
          group.add(new three.LineSegments(edges, edgeMaterial))
        }
      }

      for (const label of level.labels) {
        const sprite = this.makeLabelSprite(label.text, label.areaSqft)
        if (sprite) {
          sprite.position.set(label.x, label.y, label.z)
          this.labelSprites.push(sprite)
          group.add(sprite)
        }
        const painted = this.makeFloorLabel(label.text, label.areaSqft, label.fitFt)
        if (painted) {
          painted.position.set(label.x, label.floorY + 0.04, label.z)
          painted.rotation.z = label.angle
          this.floorLabels.push(painted)
          group.add(painted)
        }
      }

      this.levelGroups.set(level.levelId, group)
      this.root.add(group)
    }

    // Shadow frustum sized to the house, not to a guess: too big wastes every
    // shadow-map texel, too small clips the roofline shadow at the eaves.
    const extent = geometry.radiusFt * 1.7
    this.sun.position.set(geometry.radiusFt * 1.1, geometry.radiusFt * 2.2, geometry.radiusFt * 0.8)
    this.sun.shadow.camera.left = -extent
    this.sun.shadow.camera.right = extent
    this.sun.shadow.camera.top = extent
    this.sun.shadow.camera.bottom = -extent
    this.sun.shadow.camera.far = geometry.radiusFt * 6 + 50
    this.sun.shadow.camera.updateProjectionMatrix()

    this.frameCamera()
    this.applyVisibility()
    this.applyLabelVisibility()
    this.applyClipping()
    this.options.onReady({ buildMs: performance.now() - started, scene: geometry })
  }

  private makeLabelSprite(text: string, areaSqft: number): import("three").Sprite | null {
    const three = this.three
    const canvas = document.createElement("canvas")
    const scale = 2
    canvas.width = 256 * scale
    canvas.height = 80 * scale
    const context = canvas.getContext("2d")
    if (!context) return null
    context.scale(scale, scale)
    // A label plate, not a solid card: room names must not hide the geometry
    // they sit on top of.
    context.globalAlpha = 0.84
    context.fillStyle = this.palette.labelBackground
    context.fillRect(0, 0, 256, 80)
    context.globalAlpha = 1
    context.fillStyle = this.palette.label
    context.font = "600 26px ui-sans-serif, system-ui, sans-serif"
    context.textAlign = "center"
    context.textBaseline = "middle"
    context.fillText(text.toUpperCase().slice(0, 18), 128, 30)
    context.font = "400 18px ui-sans-serif, system-ui, sans-serif"
    context.globalAlpha = 0.65
    context.fillText(`${areaSqft.toLocaleString("en-US")} SF`, 128, 58)

    const texture = new three.CanvasTexture(canvas)
    texture.colorSpace = three.SRGBColorSpace
    const material = new three.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
    this.disposables.push(texture, material)
    const sprite = new three.Sprite(material)
    sprite.scale.set(8, 2.5, 1)
    return sprite
  }

  /**
   * The room's name painted onto its floor, the way the plan itself annotates
   * it — legible from orbit height, where a billboard forest is not.
   */
  private makeFloorLabel(
    text: string,
    areaSqft: number,
    fitFt: number,
  ): import("three").Mesh | null {
    const three = this.three
    const canvas = document.createElement("canvas")
    canvas.width = 512
    canvas.height = 160
    const context = canvas.getContext("2d")
    if (!context) return null
    const ink = `#${MATERIAL.floorInk.toString(16).padStart(6, "0")}`
    context.fillStyle = ink
    context.textAlign = "center"
    context.textBaseline = "middle"
    const name = text.toUpperCase().slice(0, 20)
    let size = 64
    context.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`
    while (size > 28 && context.measureText(name).width > 472) {
      size -= 4
      context.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`
    }
    context.globalAlpha = 0.82
    context.fillText(name, 256, 62)
    context.globalAlpha = 0.55
    context.font = "400 38px ui-sans-serif, system-ui, sans-serif"
    context.fillText(`${areaSqft.toLocaleString("en-US")} SF`, 256, 118)

    const texture = new three.CanvasTexture(canvas)
    texture.colorSpace = three.SRGBColorSpace
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    const material = new three.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      // Nudged toward the camera so the paint never z-fights the slab.
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
    this.disposables.push(texture, material)
    const geometry = new three.PlaneGeometry(fitFt, fitFt * (160 / 512))
    this.disposables.push(geometry)
    const mesh = new three.Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    return mesh
  }

  private clearGeometry(): void {
    for (const group of this.levelGroups.values()) this.root.remove(group)
    this.levelGroups.clear()
    this.floorMeshes.clear()
    this.ceilingMeshes = []
    this.labelSprites = []
    this.floorLabels = []
    this.clippedMaterials = []
    this.clearMeasurement()
    for (const item of this.disposables) item.dispose()
    this.disposables = []
  }

  // -- view state ----------------------------------------------------------

  setMode(mode: ViewerMode): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === "walk") {
      const level = this.activeWalkLevel()
      if (level?.spawn) {
        this.walk.x = level.spawn.x
        this.walk.z = level.spawn.z
      } else {
        this.walk.x = 0
        this.walk.z = 0
      }
      this.walk.yaw = this.orbit.theta + Math.PI
      this.walk.pitch = 0
      this.setTool(null)
      // Walking through a ceiling you cannot see under is disorienting; a walk
      // always happens on one storey.
      if (this.visibleLevel === ALL_LEVELS && this.geometry && this.geometry.levels.length > 0) {
        this.setVisibleLevel(this.geometry.levels[0].levelId)
        this.options.onLevelChange(this.visibleLevel)
      }
    } else {
      this.frameCamera()
    }
    this.applyVisibility()
    this.applyLabelVisibility()
    this.applyClipping()
    this.options.onModeChange(mode)
  }

  setVisibleLevel(levelId: string): void {
    this.visibleLevel = levelId
    if (this.mode === "walk") {
      const level = this.activeWalkLevel()
      if (level?.spawn) {
        this.walk.x = level.spawn.x
        this.walk.z = level.spawn.z
      }
    }
    this.applyVisibility()
    this.applyClipping()
  }

  setShowCeilings(show: boolean): void {
    this.showCeilings = show
    for (const mesh of this.ceilingMeshes) mesh.visible = show
  }

  setShowLabels(show: boolean): void {
    this.showLabels = show
    this.applyLabelVisibility()
  }

  setDollhouse(on: boolean): void {
    this.dollhouse = on
    this.applyClipping()
  }

  setTool(tool: ViewerTool): void {
    if (this.tool === tool) return
    this.tool = tool
    this.clearMeasurement()
    this.options.onMeasure(null)
    this.options.onToolChange(tool)
  }

  setJoystick(x: number, y: number, active: boolean): void {
    this.joystick = { x, y, active }
  }

  resetView(): void {
    if (this.mode === "walk") this.setMode("orbit")
    else this.frameCamera()
  }

  focus(): void {
    this.renderer.domElement.focus({ preventScroll: true })
  }

  /** Drop the walker at a world point — the mini-map and double-click use it. */
  teleportTo(levelId: string, x: number, z: number): void {
    if (this.visibleLevel !== levelId) {
      this.setVisibleLevel(levelId)
      this.options.onLevelChange(levelId)
    }
    this.walk.x = x
    this.walk.z = z
    if (this.mode !== "walk") this.setMode("walk")
  }

  getWalkPose(): WalkPose | null {
    if (this.mode !== "walk") return null
    const level = this.activeWalkLevel()
    if (!level) return null
    return { levelId: level.levelId, x: this.walk.x, z: this.walk.z, yaw: this.walk.yaw }
  }

  async exportGlb(fileName: string): Promise<void> {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js")
    const exporter = new GLTFExporter()
    const result = await exporter.parseAsync(this.root, { binary: true })
    if (!(result instanceof ArrayBuffer)) return
    const blob = new Blob([result], { type: "model/gltf-binary" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${fileName}.glb`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  private activeWalkLevel(): LevelGeometry | null {
    if (!this.geometry || this.geometry.levels.length === 0) return null
    if (this.visibleLevel === ALL_LEVELS) return this.geometry.levels[0]
    return this.geometry.levels.find((level) => level.levelId === this.visibleLevel) ?? this.geometry.levels[0]
  }

  private applyVisibility(): void {
    if (!this.geometry) return
    for (const level of this.geometry.levels) {
      const group = this.levelGroups.get(level.levelId)
      if (!group) continue
      group.visible = this.visibleLevel === ALL_LEVELS || this.visibleLevel === level.levelId
    }
  }

  /**
   * Orbit reads labels off the floor, walking reads them off billboards: a
   * floor label under your feet is invisible, a billboard forest from above is
   * noise. One toggle, two presentations.
   */
  private applyLabelVisibility(): void {
    for (const sprite of this.labelSprites) sprite.visible = this.showLabels && this.mode === "walk"
    for (const mesh of this.floorLabels) mesh.visible = this.showLabels && this.mode === "orbit"
  }

  /**
   * The dollhouse cut: one clipping plane at chest height above the topmost
   * visible storey. Lower storeys sit entirely below the plane, so "all
   * levels" cuts only the roofline storey — exactly what a dollhouse means.
   */
  private applyClipping(): void {
    const three = this.three
    let planes: Array<import("three").Plane> | null = null
    if (this.dollhouse && this.mode === "orbit" && this.geometry) {
      const top =
        this.visibleLevel === ALL_LEVELS
          ? this.geometry.levels.at(-1)
          : this.geometry.levels.find((level) => level.levelId === this.visibleLevel)
      if (top) {
        planes = [new three.Plane(new three.Vector3(0, -1, 0), top.baseY + DOLLHOUSE_CUT_FT)]
      }
    }
    for (const material of this.clippedMaterials) {
      material.clippingPlanes = planes
      material.needsUpdate = true
    }
  }

  private frameCamera(): void {
    if (!this.geometry) return
    // Frame the whole footprint with a little air, from a three-quarter view —
    // the angle a plan is easiest to read from.
    this.orbit.radius = Math.max(24, this.geometry.radiusFt * 2.6)
    this.orbit.theta = Math.PI * 0.75
    this.orbit.phi = Math.PI * 0.32
    const top = this.geometry.levels.at(-1)
    this.orbit.target = [0, top ? (top.baseY + top.ceilingHeightFt) / 2 : 5, 0]
  }

  // -- measuring -----------------------------------------------------------

  private clearMeasurement(): void {
    this.measureGroup.clear()
    for (const item of this.measureDisposables) item.dispose()
    this.measureDisposables = []
    this.measurePoints = []
  }

  private addMeasurePoint(point: import("three").Vector3): void {
    const three = this.three
    if (this.measurePoints.length >= 2) this.clearMeasurement()
    this.measurePoints.push(point)

    const markerGeometry = new three.SphereGeometry(0.22, 12, 12)
    const markerMaterial = new three.MeshBasicMaterial({ color: MATERIAL.edge, depthTest: false })
    this.measureDisposables.push(markerGeometry, markerMaterial)
    const marker = new three.Mesh(markerGeometry, markerMaterial)
    marker.position.copy(point)
    marker.renderOrder = 10
    this.measureGroup.add(marker)

    if (this.measurePoints.length === 2) {
      const [a, b] = this.measurePoints
      const lineGeometry = new three.BufferGeometry().setFromPoints([a, b])
      const lineMaterial = new three.LineBasicMaterial({ color: MATERIAL.edge, depthTest: false })
      this.measureDisposables.push(lineGeometry, lineMaterial)
      const line = new three.Line(lineGeometry, lineMaterial)
      line.renderOrder = 10
      this.measureGroup.add(line)
      this.options.onMeasure(formatFeetInches(a.distanceTo(b)))
    } else {
      this.options.onMeasure(null)
    }
  }

  /** Raycast a pointer event into the model. `floorsOnly` for teleporting. */
  private pick(
    event: { clientX: number; clientY: number },
    floorsOnly: boolean,
  ): { levelId: string; point: import("three").Vector3 } | null {
    if (!this.geometry) return null
    const three = this.three
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new three.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new three.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    const targets: Array<import("three").Object3D> = []
    for (const [levelId, mesh] of this.floorMeshes) {
      const group = this.levelGroups.get(levelId)
      if (group?.visible) targets.push(mesh)
    }
    if (!floorsOnly) {
      for (const group of this.levelGroups.values()) {
        if (!group.visible) continue
        for (const child of group.children) {
          if ((child as import("three").Mesh).isMesh) targets.push(child)
        }
      }
    }
    const hits = raycaster.intersectObjects(targets, false)
    const hit = hits[0]
    if (!hit) return null
    let node: import("three").Object3D | null = hit.object
    while (node && !this.levelGroups.has(node.name)) node = node.parent
    if (!node) return null
    return { levelId: node.name, point: hit.point }
  }

  // -- input ---------------------------------------------------------------

  private bindInput(): void {
    const element = this.renderer.domElement
    element.addEventListener("pointerdown", this.onPointerDown)
    element.addEventListener("pointermove", this.onPointerMove)
    element.addEventListener("pointerup", this.onPointerUp)
    element.addEventListener("pointercancel", this.onPointerUp)
    element.addEventListener("dblclick", this.onDoubleClick)
    element.addEventListener("wheel", this.onWheel, { passive: false })
    element.addEventListener("keydown", this.onKeyDown)
    element.addEventListener("keyup", this.onKeyUp)
    element.addEventListener("blur", this.onBlur)
  }

  private unbindInput(): void {
    const element = this.renderer.domElement
    element.removeEventListener("pointerdown", this.onPointerDown)
    element.removeEventListener("pointermove", this.onPointerMove)
    element.removeEventListener("pointerup", this.onPointerUp)
    element.removeEventListener("pointercancel", this.onPointerUp)
    element.removeEventListener("dblclick", this.onDoubleClick)
    element.removeEventListener("wheel", this.onWheel)
    element.removeEventListener("keydown", this.onKeyDown)
    element.removeEventListener("keyup", this.onKeyUp)
    element.removeEventListener("blur", this.onBlur)
  }

  private onPointerDown = (event: PointerEvent) => {
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.renderer.domElement.focus({ preventScroll: true })
    this.pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      downX: event.clientX,
      downY: event.clientY,
      mode: this.mode === "walk" ? "look" : "orbit",
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.pointer || this.pointer.id !== event.pointerId) return
    const dx = event.clientX - this.pointer.x
    const dy = event.clientY - this.pointer.y
    this.pointer.x = event.clientX
    this.pointer.y = event.clientY

    if (this.pointer.mode === "look") {
      this.walk.yaw -= dx * 0.005
      this.walk.pitch = clamp(this.walk.pitch - dy * 0.005, -1.2, 1.2)
      return
    }
    this.orbitVelocity.theta -= dx * 0.006
    this.orbitVelocity.phi -= dy * 0.005
  }

  private onPointerUp = (event: PointerEvent) => {
    const pointer = this.pointer
    if (pointer?.id === event.pointerId) {
      this.pointer = null
      // A click, not a drag: the measure tool takes it.
      const travelled = Math.hypot(event.clientX - pointer.downX, event.clientY - pointer.downY)
      if (this.tool === "measure" && this.mode === "orbit" && travelled < 6) {
        const hit = this.pick(event, false)
        if (hit) this.addMeasurePoint(hit.point)
      }
    }
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId)
    }
  }

  /** Double-click (or double-tap) a floor: walk there. */
  private onDoubleClick = (event: MouseEvent) => {
    if (this.tool === "measure") return
    const hit = this.pick(event, true)
    if (!hit) return
    this.teleportTo(hit.levelId, hit.point.x, hit.point.z)
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault()
    if (this.mode === "walk") return
    const factor = Math.exp(event.deltaY * 0.0015)
    const limit = this.geometry ? this.geometry.radiusFt * 6 : 400
    this.orbit.radius = clamp(this.orbit.radius * factor, 6, limit)
  }

  private onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase()
    if (WALK_KEYS.has(key) || key === "arrowup" || key === "arrowdown" || key === "arrowleft" || key === "arrowright") {
      event.preventDefault()
    }
    if (key === "escape" && this.tool) this.setTool(null)
    this.keys.add(key)
  }

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.key.toLowerCase())
  }

  private onBlur = () => {
    this.keys.clear()
  }

  // -- render loop ---------------------------------------------------------

  private lastFrameAt = 0

  private loop = () => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.loop)
    const now = performance.now()
    const delta = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 0.016
    this.lastFrameAt = now

    if (this.mode === "walk") this.stepWalk(delta)
    else this.stepOrbit(delta)

    this.renderer.render(this.scene, this.camera)
  }

  private stepOrbit(delta: number): void {
    this.orbit.theta += this.orbitVelocity.theta
    this.orbit.phi = clamp(this.orbit.phi + this.orbitVelocity.phi, 0.08, Math.PI / 2 - 0.02)
    // Inertia: the drag keeps gliding for a beat and settles, which is what
    // makes a turntable feel like an object rather than a slider.
    const damping = Math.pow(0.0025, delta)
    this.orbitVelocity.theta *= damping
    this.orbitVelocity.phi *= damping
    if (Math.abs(this.orbitVelocity.theta) < 1e-5) this.orbitVelocity.theta = 0
    if (Math.abs(this.orbitVelocity.phi) < 1e-5) this.orbitVelocity.phi = 0

    const [tx, ty, tz] = this.orbit.target
    const radius = this.orbit.radius
    this.camera.position.set(
      tx + radius * Math.sin(this.orbit.phi) * Math.cos(this.orbit.theta),
      ty + radius * Math.cos(this.orbit.phi),
      tz + radius * Math.sin(this.orbit.phi) * Math.sin(this.orbit.theta),
    )
    this.camera.lookAt(tx, ty, tz)
  }

  private stepWalk(delta: number): void {
    const level = this.activeWalkLevel()
    let forward = 0
    let strafe = 0
    if (this.keys.has("w") || this.keys.has("arrowup")) forward += 1
    if (this.keys.has("s") || this.keys.has("arrowdown")) forward -= 1
    if (this.keys.has("a") || this.keys.has("arrowleft")) strafe -= 1
    if (this.keys.has("d") || this.keys.has("arrowright")) strafe += 1
    if (this.joystick.active) {
      forward -= this.joystick.y
      strafe += this.joystick.x
    }

    const magnitude = Math.hypot(forward, strafe)
    if (magnitude > 0 && level) {
      const speed = (this.keys.has("shift") ? 12 : 6) * delta
      const nx = forward / magnitude
      const nz = strafe / magnitude
      const sin = Math.sin(this.walk.yaw)
      const cos = Math.cos(this.walk.yaw)
      const target = {
        x: this.walk.x + (-sin * nx + cos * nz) * speed,
        z: this.walk.z + (-cos * nx - sin * nz) * speed,
      }
      const resolved = resolveWalkCollision({ x: this.walk.x, z: this.walk.z }, target, level.collision)
      this.walk.x = resolved.x
      this.walk.z = resolved.z
    }

    const baseY = level?.baseY ?? 0
    this.camera.position.set(this.walk.x, baseY + EYE_HEIGHT_FT, this.walk.z)
    const cosPitch = Math.cos(this.walk.pitch)
    this.camera.lookAt(
      this.walk.x - Math.sin(this.walk.yaw) * cosPitch,
      baseY + EYE_HEIGHT_FT + Math.sin(this.walk.pitch),
      this.walk.z - Math.cos(this.walk.yaw) * cosPitch,
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.unbindInput()
    this.clearGeometry()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

const WALK_KEYS = new Set(["w", "a", "s", "d"])

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// Mini-map
// ---------------------------------------------------------------------------

interface MiniMapProps {
  level: LevelGeometry
  getPose: () => WalkPose | null
  onTeleport: (x: number, z: number) => void
}

/**
 * A little plan inset for walk mode: the wall footprints, you as a heading
 * wedge, and tap-anywhere teleport. Drawn from the collision segments, which
 * are exactly the walls a walker can feel.
 */
function MiniMap({ level, getPose, onTeleport }: MiniMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const frame = useMemo(() => {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const segment of level.collision) {
      minX = Math.min(minX, segment.x0, segment.x1)
      maxX = Math.max(maxX, segment.x0, segment.x1)
      minZ = Math.min(minZ, segment.z0, segment.z1)
      maxZ = Math.max(maxZ, segment.z0, segment.z1)
    }
    if (!Number.isFinite(minX)) {
      minX = -10
      maxX = 10
      minZ = -10
      maxZ = 10
    }
    const size = 144
    const padding = 10
    const scale = Math.min(
      (size - padding * 2) / Math.max(1, maxX - minX),
      (size - padding * 2) / Math.max(1, maxZ - minZ),
    )
    const offsetX = (size - (maxX - minX) * scale) / 2 - minX * scale
    const offsetZ = (size - (maxZ - minZ) * scale) / 2 - minZ * scale
    return { size, scale, offsetX, offsetZ }
  }, [level])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const context = canvas?.getContext("2d")
      if (!canvas || !context) return
      const ratio = window.devicePixelRatio || 1
      if (canvas.width !== frame.size * ratio) {
        canvas.width = frame.size * ratio
        canvas.height = frame.size * ratio
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, frame.size, frame.size)
      const wallStyle = getComputedStyle(canvas).getPropertyValue("color") || "#666"
      context.strokeStyle = wallStyle
      context.lineCap = "round"
      for (const segment of level.collision) {
        context.lineWidth = Math.max(1.5, segment.halfThickness * 2 * frame.scale)
        context.beginPath()
        context.moveTo(segment.x0 * frame.scale + frame.offsetX, segment.z0 * frame.scale + frame.offsetZ)
        context.lineTo(segment.x1 * frame.scale + frame.offsetX, segment.z1 * frame.scale + frame.offsetZ)
        context.stroke()
      }
      const pose = getPose()
      if (pose && pose.levelId === level.levelId) {
        const px = pose.x * frame.scale + frame.offsetX
        const pz = pose.z * frame.scale + frame.offsetZ
        // Walk yaw 0 faces world −Z; canvas +y is world +Z.
        const heading = Math.atan2(-Math.cos(pose.yaw), -Math.sin(pose.yaw))
        context.fillStyle = wallStyle
        context.globalAlpha = 0.25
        context.beginPath()
        context.moveTo(px, pz)
        context.arc(px, pz, 14, heading - 0.5, heading + 0.5)
        context.closePath()
        context.fill()
        context.globalAlpha = 1
        context.beginPath()
        context.arc(px, pz, 3.5, 0, Math.PI * 2)
        context.fill()
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [frame, getPose, level])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-auto border border-border bg-card/80 text-foreground backdrop-blur-sm"
      style={{ width: frame.size, height: frame.size }}
      aria-label="Floor plan mini-map — tap to teleport"
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const x = (event.clientX - rect.left - frame.offsetX) / frame.scale
        const z = (event.clientY - rect.top - frame.offsetZ) / frame.scale
        onTeleport(x, z)
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface Plan3dViewerProps {
  model: FloorplanModel
  /** Shown in the corner — the plan's name, or the builder's, on a portal. */
  caption?: string | null
  className?: string
  /** Portals hide the desk-only tools: measure, export, keyboard hints. */
  compact?: boolean
}

export function Plan3dViewer({ model, caption, className, compact = false }: Plan3dViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<FloorplanScene | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [mode, setMode] = useState<ViewerMode>("orbit")
  const [visibleLevel, setVisibleLevel] = useState<string>(ALL_LEVELS)
  const [showCeilings, setShowCeilings] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [dollhouse, setDollhouse] = useState(false)
  const [tool, setTool] = useState<ViewerTool>(null)
  const [measurement, setMeasurement] = useState<string | null>(null)
  const [stats, setStats] = useState<{ buildMs: number; scene: SceneGeometry } | null>(null)

  const levels = useMemo(
    () => [...model.levels].sort((a, b) => a.order - b.order),
    [model.levels],
  )

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return

    import("three")
      .then((three) => {
        if (cancelled || !containerRef.current) return
        const scene = new FloorplanScene(
          {
            container,
            onReady: (ready) => {
              setStats(ready)
              setStatus("ready")
            },
            onModeChange: setMode,
            onLevelChange: setVisibleLevel,
            onToolChange: setTool,
            onMeasure: setMeasurement,
          },
          three,
        )
        sceneRef.current = scene
        scene.setModel(model)
      })
      .catch(() => {
        if (!cancelled) setStatus("error")
      })

    return () => {
      cancelled = true
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
    // The scene is created once; model changes go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (status !== "ready") return
    sceneRef.current?.setModel(model)
  }, [model, status])

  useEffect(() => {
    sceneRef.current?.setVisibleLevel(visibleLevel)
  }, [visibleLevel])

  useEffect(() => {
    sceneRef.current?.setShowCeilings(showCeilings)
  }, [showCeilings])

  useEffect(() => {
    sceneRef.current?.setShowLabels(showLabels)
  }, [showLabels])

  useEffect(() => {
    sceneRef.current?.setDollhouse(dollhouse)
  }, [dollhouse])

  useEffect(() => {
    sceneRef.current?.setTool(tool)
  }, [tool])

  const toggleMode = useCallback(() => {
    const next: ViewerMode = mode === "orbit" ? "walk" : "orbit"
    sceneRef.current?.setMode(next)
    sceneRef.current?.focus()
    if (next === "walk" && visibleLevel === ALL_LEVELS && levels.length > 0) {
      setVisibleLevel(levels[0].id)
    }
    if (next === "walk") setTool(null)
  }, [levels, mode, visibleLevel])

  const joystickRef = useRef<HTMLDivElement>(null)
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null)

  const onJoystickMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = joystickRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const radius = rect.width / 2
    const dx = clamp((event.clientX - rect.left - radius) / radius, -1, 1)
    const dy = clamp((event.clientY - rect.top - radius) / radius, -1, 1)
    setKnob({ x: dx, y: dy })
    sceneRef.current?.setJoystick(dx, dy, true)
  }, [])

  const onJoystickEnd = useCallback(() => {
    setKnob(null)
    sceneRef.current?.setJoystick(0, 0, false)
  }, [])

  const getPose = useCallback(() => sceneRef.current?.getWalkPose() ?? null, [])

  const activeLevelName =
    visibleLevel === ALL_LEVELS
      ? "All levels"
      : (levels.find((level) => level.id === visibleLevel)?.name ?? "Level")

  const walkLevelGeometry =
    mode === "walk" && stats
      ? (stats.scene.levels.find((level) => level.levelId === visibleLevel) ?? stats.scene.levels[0] ?? null)
      : null

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-muted", className)}>
      <div ref={containerRef} className="absolute inset-0" />

      {status === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Building the model…
        </div>
      ) : null}

      {status === "error" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm font-medium">The 3D viewer could not start</p>
          <p className="text-xs text-muted-foreground">
            This browser may not support WebGL. The plan sheets are still available in the drawings viewer.
          </p>
        </div>
      ) : null}

      {status === "ready" ? (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
            <div className="pointer-events-auto flex items-center gap-1">
              <Button
                size="sm"
                variant={mode === "orbit" ? "default" : "secondary"}
                onClick={toggleMode}
                className="gap-1.5"
              >
                {mode === "orbit" ? <Footprints className="h-3.5 w-3.5" /> : <Orbit className="h-3.5 w-3.5" />}
                {mode === "orbit" ? "Walk through" : "Orbit"}
              </Button>
              {levels.length > 1 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1.5"
                  onClick={() => {
                    const order = [ALL_LEVELS, ...levels.map((level) => level.id)]
                    const index = order.indexOf(visibleLevel)
                    const next = order[(index + 1) % order.length]
                    // Walk mode is always one storey; skip "all" while walking.
                    setVisibleLevel(mode === "walk" && next === ALL_LEVELS ? order[1] : next)
                  }}
                >
                  <Layers className="h-3.5 w-3.5" />
                  {activeLevelName}
                </Button>
              ) : null}
            </div>

            <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1">
              {mode === "orbit" ? (
                <Button
                  size="sm"
                  variant={dollhouse ? "default" : "secondary"}
                  onClick={() => setDollhouse((value) => !value)}
                >
                  Dollhouse
                </Button>
              ) : null}
              {mode === "orbit" && !compact ? (
                <Button
                  size="sm"
                  variant={tool === "measure" ? "default" : "secondary"}
                  className="gap-1.5"
                  onClick={() => setTool((value) => (value === "measure" ? null : "measure"))}
                  aria-label="Measure"
                >
                  <Ruler className="h-3.5 w-3.5" />
                  {measurement ?? "Measure"}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => setShowLabels((value) => !value)}>
                {showLabels ? "Hide labels" : "Show labels"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setShowCeilings((value) => !value)}>
                {showCeilings ? "Open top" : "Ceilings"}
              </Button>
              {!compact ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void sceneRef.current?.exportGlb(caption?.trim() || "plan-model")}
                  aria-label="Export GLB"
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => sceneRef.current?.resetView()}
                aria-label="Reset view"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3">
            <div className="space-y-0.5 text-xs text-muted-foreground">
              {caption ? <p className="font-medium text-foreground">{caption}</p> : null}
              {stats ? (
                <p className="tabular-nums">
                  {stats.scene.totalFloorAreaSqft.toLocaleString("en-US")} SF ·{" "}
                  {levels.length} {levels.length === 1 ? "level" : "levels"} ·{" "}
                  {stats.scene.levels.reduce((total, level) => total + level.roomCount, 0)} rooms
                </p>
              ) : null}
              {tool === "measure" ? (
                <p>Click two points to measure. Esc to stop.</p>
              ) : mode === "walk" && !compact ? (
                <p>WASD or arrows to move, shift to jog, drag to look, double-click to teleport.</p>
              ) : mode === "orbit" ? (
                <p>Double-{compact ? "tap" : "click"} a room to walk there.</p>
              ) : null}
            </div>

            {mode === "walk" ? (
              <div className="pointer-events-none flex items-end gap-3">
                {walkLevelGeometry ? (
                  <MiniMap
                    level={walkLevelGeometry}
                    getPose={getPose}
                    onTeleport={(x, z) => sceneRef.current?.teleportTo(walkLevelGeometry.levelId, x, z)}
                  />
                ) : null}
                <div
                  ref={joystickRef}
                  className="pointer-events-auto relative h-24 w-24 rounded-full border border-border bg-card/70 backdrop-blur-sm"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    onJoystickMove(event)
                  }}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) onJoystickMove(event)
                  }}
                  onPointerUp={onJoystickEnd}
                  onPointerCancel={onJoystickEnd}
                  aria-label="Movement joystick"
                >
                  <div
                    className="pointer-events-none absolute h-9 w-9 rounded-full bg-primary/80"
                    style={{
                      left: `calc(50% + ${(knob?.x ?? 0) * 30}px - 1.125rem)`,
                      top: `calc(50% + ${(knob?.y ?? 0) * 30}px - 1.125rem)`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Box className="h-3.5 w-3.5" />
                Interpreted from the plan sheets
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

export default Plan3dViewer

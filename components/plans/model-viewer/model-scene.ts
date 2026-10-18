/**
 * The 3D building scene.
 *
 * One class owns the WebGL context, the camera rig and every mesh; React only
 * tells it what to show (`setModel`, `setLook`, `setFocus`...) and listens for
 * what the person did (hover, select, place, move, measure). It renders ON
 * DEMAND: a frame is drawn only while the camera is settling or something
 * changed, so a model left open on a second monitor costs nothing.
 *
 * Geometry comes from `lib/plans/floorplan-geometry.ts` (pure, tested). This
 * file only turns those meshes into lit, pickable objects. Every wall, room,
 * object and roof is its own mesh so it can be hovered, selected and coloured
 * by the takeoff; the joinery, glass and slab edges are merged per level.
 *
 * - Rendering: ambient occlusion, outlines on hover and selection, a little
 *   bloom, SMAA and tone mapping through one composer ("high"); a plain
 *   forward render on phones ("fast"). A real sun from the site's latitude
 *   and north at a chosen hour. "Photo" hands the frame to a path tracer
 *   that refines while nothing moves.
 * - Cutting: the dollhouse cut, a section box and a section through any wall
 *   are ONE set of global clipping planes, so every pass (AO included) sees
 *   the same cut building. The path tracer cannot clip, so a photo is traced
 *   from a copy of the model whose cut walls are built to the cut height.
 * - Furniture with a catalogue id is drawn from its real model
 *   (`model-furniture.ts`); its box stays as the invisible pick target.
 *
 * Three.js is passed in (`model-runtime.ts`), never imported at runtime, so
 * none of it reaches a bundle until someone opens a model.
 */

import type * as ThreeTypes from "three"
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js"
import type { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js"
import type { WebGLPathTracer } from "three-gpu-pathtracer"

import {
  buildLevelGeometry,
  buildSceneGeometry,
  isWalkable,
  placeLevel,
  resolveWalkCollision,
  wallIsExterior,
  worldToLevelPoint,
  DOLLHOUSE_CUT_FT,
  EYE_HEIGHT_FT,
  type LevelGeometry,
  type MeshData,
  type SceneGeometry,
} from "@/lib/plans/floorplan-geometry"
import { dayOfYear, sunPosition, DEFAULT_SITE } from "@/lib/plans/sun-position"
import { shouldRecord, tourDurationSec, tourPose, TOUR_SAMPLE_SEC, MAX_TOUR_POINTS, type TourSample } from "@/lib/plans/camera-tour"
import {
  MODEL_MATERIAL_COLORS,
  type SavedModelView,
  type SurfaceFinish,
} from "@/lib/drawings/architectural-model"
import { furnitureModel } from "@/lib/drawings/furniture-catalog"
import type { FloorplanModel, Level, Wall } from "@/lib/drawings/floorplan-model"
import { formatFeetInches } from "@/lib/validation/drawings"

import { FurnitureLibrary } from "./model-furniture"
import type { ModelRuntime } from "./model-runtime"

export type ModelLook = "real" | "takeoff" | "xray"
export type ModelMode = "orbit" | "walk"
export type ModelCameraPreset = "iso" | "top" | "front"
export type ModelQuality = "high" | "fast"
export type ModelTool = "select" | "measure"
export type SurfaceKind = "wall" | "room" | "object" | "roof"

export interface ModelPick {
  kind: SurfaceKind
  id: string
  levelId: string
}

export interface ScreenPoint {
  x: number
  y: number
}

/** An issue or photo pinned to a spot on a floor. */
export interface ModelPin {
  id: string
  levelId: string
  xFt: number
  yFt: number
  /** Status, mapped onto the theme's state colours. */
  tone: "accent" | "warning" | "danger" | "success"
  /** One character drawn on the marker. */
  glyph: string
}

/** What changed since the previous revision of a floor, ready to draw. */
export interface ModelSceneDiff {
  levelId: string
  addedWallIds: string[]
  removedWalls: Wall[]
  rooms: Array<{ roomId: string; status: "added" | "changed" }>
  removedRooms: Array<Array<[number, number]>>
}

export interface ModelMeasurement {
  id: string
  lengthFt: number
  /** Plan distance and rise, when the line is not level or not plumb. */
  runFt: number
  riseFt: number
}

export interface ModelSceneCallbacks {
  onHover: (pick: ModelPick | null, at: ScreenPoint | null) => void
  onSelect: (pick: ModelPick | null, at: ScreenPoint | null) => void
  onPlace: (point: { levelId: string; xFt: number; yFt: number }) => void
  onObjectMove: (change: { levelId: string; objectId: string; xFt: number; yFt: number }) => void
  onModeChange: (mode: ModelMode) => void
  onPinSelect: (pinId: string, at: ScreenPoint) => void
  onMeasure: (measurements: ModelMeasurement[]) => void
  /** Photo refinement, 0..1; null when photo mode ends. */
  onPhoto: (progress: number | null) => void
  /** A tour finished playing, or was interrupted. */
  onTourEnd: () => void
  /** Fires after each drawn frame so anchored HTML can follow the camera. */
  onFrame: () => void
}

export interface ModelSceneTheme {
  /** Ink for floor-painted room labels. */
  ink: string
  /** Opaque backdrop behind the building (post-processing needs one). */
  background: number
  /** Faint site disc under the building. */
  ground: number
  /** Hover / selection tint. */
  accent: number
  /** Revision diff: added, changed, removed. */
  added: number
  changed: number
  removed: number
}

/** Fixed physical colours — drywall is off-white whatever the app theme is. */
const SURFACE = {
  wall: 0xf3f1ec,
  wallExterior: 0xe4e0d8,
  trim: 0xfbfaf7,
  glass: 0xa8c4d6,
  slab: 0xd6d3cc,
  poche: 0x45484f,
  untakenWall: 0xd5d8de,
  untakenRoom: 0xe6e7eb,
  xrayWall: 0x9db2de,
  edge: 0x3b3f47,
  measure: 0x111318,
  sunHigh: 0xfff4e6,
  sunLow: 0xffc68a,
  skyTop: 0xdfe9f7,
  skyGround: 0x8a8070,
} as const

const ORBIT_MIN_R = 8
const WALK_SPEED_FT = 7
const PICK_SLOP_PX = 4
const SNAP_VERTEX_PX = 10
const SNAP_EDGE_PX = 7
const PHOTO_SAMPLES = 320
const FEET_TO_METERS = 0.3048
/** Past this distance (× the framing radius) finish carpentry is sub-pixel and is dropped. */
const DETAIL_LOD_K = 1.25

interface SurfaceNode {
  mesh: ThreeTypes.Mesh
  kind: SurfaceKind
  /** The real furniture drawn in place of the box, when there is one. */
  display: ThreeTypes.Object3D | null
}

interface LevelNode {
  levelId: string
  order: number
  baseY: number
  ceilingHeightFt: number
  group: ThreeTypes.Group
  ceiling: ThreeTypes.Mesh | null
  detail: ThreeTypes.Mesh | null
  surfaces: Map<string, SurfaceNode>
  labels: ThreeTypes.Mesh[]
  geometry: LevelGeometry
}

interface OrbitState {
  theta: number
  phi: number
  r: number
  target: [number, number, number]
}

interface Drag {
  kind: "orbit" | "pan" | "object" | "place" | "pinch" | "section"
  startX: number
  startY: number
  lastX: number
  lastY: number
  moved: boolean
  object?: { levelId: string; id: string; mesh: ThreeTypes.Mesh; startWorld: [number, number]; hitStart: [number, number]; baseY: number }
  pinch?: { distance: number; r: number; midX: number; midY: number }
  section?: { face: SectionFace; start: number; origin: number }
}

type SectionFace = "minX" | "maxX" | "minY" | "maxY" | "minZ" | "maxZ"

interface SnapPoint {
  point: ThreeTypes.Vector3
  kind: "vertex" | "edge" | "face"
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const ease = (t: number) => 1 - Math.pow(1 - t, 3)
const nearestAngle = (from: number, to: number) => to + 2 * Math.PI * Math.round((from - to) / (2 * Math.PI))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export class ModelScene {
  private readonly runtime: ModelRuntime
  private readonly three: ModelRuntime["three"]
  private readonly container: HTMLElement
  private readonly callbacks: ModelSceneCallbacks
  private readonly renderer: ThreeTypes.WebGLRenderer
  private readonly scene: ThreeTypes.Scene
  /** Tools drawn over the building and never cut: section handles, measurements. */
  private readonly toolScene: ThreeTypes.Scene
  private readonly camera: ThreeTypes.PerspectiveCamera
  private readonly raycaster: ThreeTypes.Raycaster
  private readonly sun: ThreeTypes.DirectionalLight
  private readonly hemisphere: ThreeTypes.HemisphereLight
  private readonly environment: ThreeTypes.Texture
  private readonly ground: ThreeTypes.Mesh
  private readonly site: ThreeTypes.Mesh
  private readonly building: ThreeTypes.Group
  private readonly overlays: ThreeTypes.Group
  private readonly pinGroup: ThreeTypes.Group
  private readonly diffGroup: ThreeTypes.Group
  private readonly measureGroup: ThreeTypes.Group
  private readonly sectionGroup: ThreeTypes.Group
  private readonly furniture: FurnitureLibrary
  private readonly disposables: Array<{ dispose: () => void }> = []
  private buildDisposables: Array<{ dispose: () => void }> = []
  private overlayDisposables: Array<{ dispose: () => void }> = []
  private pinDisposables: Array<{ dispose: () => void }> = []
  private diffDisposables: Array<{ dispose: () => void }> = []
  private measureDisposables: Array<{ dispose: () => void }> = []
  private sectionDisposables: Array<{ dispose: () => void }> = []
  private readonly textures = new Map<string, ThreeTypes.Texture>()
  private resizeObserver: ResizeObserver | null = null
  private lastTime = 0
  private dirty = true
  private disposed = false

  private composer: EffectComposer | null = null
  private outline: OutlinePass | null = null
  private quality: ModelQuality

  private model: FloorplanModel | null = null
  private placed: Level[] = []
  private geometry: SceneGeometry | null = null
  private levels: LevelNode[] = []
  private exteriorWalls = new Set<string>()
  private detailVisible = true

  private look: ModelLook = "real"
  private focus: string = "all"
  private cutaway = true
  private labelsOn = true
  private takeoffColors: Record<string, string> = {}
  private highlight = new Set<string>()
  private selected: string | null = null
  private hovered: string | null = null
  private theme: ModelSceneTheme
  private placing: { widthFt: number; depthFt: number; heightFt: number } | null = null
  private ghost: ThreeTypes.Mesh | null = null
  private sunHour = 15
  private sunDay = dayOfYear(new Date())

  private tool: ModelTool = "select"
  private measurePoints: ThreeTypes.Vector3[] = []
  private measurements: Array<ModelMeasurement & { a: ThreeTypes.Vector3; b: ThreeTypes.Vector3 }> = []
  private measureHover: SnapPoint | null = null

  private pins: ModelPin[] = []
  private diff: ModelSceneDiff[] = []

  private sectionBox: ThreeTypes.Box3 | null = null
  private sectionPlane: ThreeTypes.Plane | null = null
  private sectionHandles: Array<{ face: SectionFace; mesh: ThreeTypes.Mesh }> = []

  private photo: { tracer: WebGLPathTracer | null; sky: ThreeTypes.Texture | null; samples: number; cancelled: boolean } | null = null
  private recording: { samples: TourSample[]; clock: number; still: number } | null = null
  private tour: { samples: TourSample[]; t: number } | null = null
  private xr: { session: XRSession; scale: number } | null = null

  private mode: ModelMode = "orbit"
  private readonly current: OrbitState = { theta: 0.75, phi: 0.9, r: 80, target: [0, 2, 0] }
  private readonly goal: OrbitState = { theta: 0.75, phi: 0.9, r: 80, target: [0, 2, 0] }
  private readonly walk = { x: 0, z: 0, yaw: 0, pitch: -0.05, goalYaw: 0, goalPitch: -0.05, glide: null as [number, number] | null }
  private readonly keys = new Set<string>()
  private blend: { k: number; position: [number, number, number]; look: [number, number, number] } | null = null
  private lastLook: [number, number, number] = [0, 2, 0]
  private userZoomed = false

  private drag: Drag | null = null
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private pointer: ScreenPoint | null = null
  private pointerMoved = false

  constructor(runtime: ModelRuntime, container: HTMLElement, callbacks: ModelSceneCallbacks, theme: ModelSceneTheme, quality: ModelQuality) {
    const three = runtime.three
    this.runtime = runtime
    this.three = three
    this.container = container
    this.callbacks = callbacks
    this.theme = theme
    this.quality = quality

    const renderer = new three.WebGLRenderer({ antialias: quality === "fast", powerPreference: "high-performance", preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === "fast" ? 1.5 : 2))
    renderer.toneMapping = three.NeutralToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = three.PCFSoftShadowMap
    renderer.setClearColor(theme.background, 1)
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    renderer.domElement.style.outline = "none"
    renderer.domElement.style.touchAction = "none"
    renderer.domElement.tabIndex = 0
    container.appendChild(renderer.domElement)
    this.renderer = renderer

    this.scene = new three.Scene()
    this.scene.background = new three.Color(theme.background)
    this.camera = new three.PerspectiveCamera(38, 1, 0.3, 4000)
    this.raycaster = new three.Raycaster()

    const pmrem = new three.PMREMGenerator(renderer)
    this.environment = pmrem.fromScene(this.environmentRoom(), 0.04).texture
    pmrem.dispose()
    this.scene.environment = this.environment
    this.scene.environmentIntensity = 0.55
    this.disposables.push(this.environment)

    this.hemisphere = new three.HemisphereLight(0xe8eefc, 0x9a8c76, 0.9)
    this.scene.add(this.hemisphere)
    this.sun = new three.DirectionalLight(SURFACE.sunHigh, 2.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.03
    this.scene.add(this.sun, this.sun.target)

    this.ground = new three.Mesh(new three.PlaneGeometry(4000, 4000), new three.ShadowMaterial({ opacity: 0.2 }))
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.04
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
    this.site = new three.Mesh(new three.CircleGeometry(1, 72), new three.MeshStandardMaterial({ color: theme.ground, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false }))
    this.site.rotation.x = -Math.PI / 2
    this.site.position.y = -0.03
    this.site.receiveShadow = true
    this.scene.add(this.site)
    this.disposables.push(this.ground.geometry, this.ground.material as ThreeTypes.Material, this.site.geometry, this.site.material as ThreeTypes.Material)

    this.building = new three.Group()
    this.overlays = new three.Group()
    this.pinGroup = new three.Group()
    this.diffGroup = new three.Group()
    this.measureGroup = new three.Group()
    this.sectionGroup = new three.Group()
    this.scene.add(this.building, this.overlays, this.pinGroup, this.diffGroup)
    this.toolScene = new three.Scene()
    this.toolScene.add(this.measureGroup, this.sectionGroup)

    this.furniture = new FurnitureLibrary(three, () => this.rebuild())

    if (quality === "high") this.setupComposer()
    this.bindInput()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    renderer.setAnimationLoop(this.tick)
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setModel(model: FloorplanModel): void {
    const first = !this.model
    this.model = model
    this.placed = model.levels.map(placeLevel)
    this.exteriorWalls = new Set(this.placed.flatMap((level) => level.walls.filter((wall) => wallIsExterior(wall, level.rooms)).map((wall) => wall.id)))
    this.geometry = buildSceneGeometry(model)
    const radius = this.geometry.radiusFt
    const extent = radius * 1.8
    Object.assign(this.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: radius * 7 + 60 })
    this.sun.shadow.camera.updateProjectionMatrix()
    this.site.scale.setScalar(radius * 2.4)
    this.applySun()
    this.rebuild()
    if (first) this.preset("iso", true)
  }

  setLook(look: ModelLook): void {
    if (look === this.look) return
    this.look = look
    this.rebuild()
  }

  setTakeoffColors(colors: Record<string, string>): void {
    this.takeoffColors = colors
    if (this.look === "takeoff") this.rebuild()
  }

  setFocus(levelId: string): void {
    if (levelId === this.focus) return
    this.focus = levelId
    this.rebuild()
    if (this.mode === "orbit") {
      this.goal.target = [this.goal.target[0], this.focusBaseY() + 2, this.goal.target[2]]
    } else {
      const level = this.walkLevel()
      if (level) this.enterWalkAt(level)
    }
    this.dirty = true
  }

  setCutaway(on: boolean): void {
    if (on === this.cutaway) return
    this.cutaway = on
    this.rebuild()
  }

  setLabels(on: boolean): void {
    this.labelsOn = on
    for (const level of this.levels) for (const label of level.labels) label.visible = on && this.mode === "orbit"
    this.dirty = true
  }

  setTheme(theme: ModelSceneTheme): void {
    this.theme = theme
    ;(this.site.material as ThreeTypes.MeshStandardMaterial).color.setHex(theme.ground)
    this.renderer.setClearColor(theme.background, 1)
    this.scene.background = new this.three.Color(theme.background)
    if (this.outline) {
      this.outline.visibleEdgeColor.setHex(theme.accent)
      this.outline.hiddenEdgeColor.setHex(theme.accent)
    }
    this.rebuild()
    this.refreshPins()
    this.refreshMeasure()
  }

  setQuality(quality: ModelQuality): void {
    if (quality === this.quality) return
    this.quality = quality
    if (quality === "high") this.setupComposer()
    else this.teardownComposer()
    this.refreshOverlays()
  }

  /** Hour of the day (local solar time) and optionally the day of the year. */
  setSun(hour: number, day?: number): void {
    this.sunHour = hour
    if (day !== undefined) this.sunDay = day
    this.applySun()
    this.restartPhoto()
  }

  /** Surfaces lit up from outside — a hovered ledger row, a hovered sheet room. */
  setHighlight(ids: Iterable<string>): void {
    const next = new Set(ids)
    if (next.size === this.highlight.size && [...next].every((id) => this.highlight.has(id))) return
    this.highlight = next
    this.refreshOverlays()
  }

  setSelected(id: string | null): void {
    if (id === this.selected) return
    this.selected = id
    this.refreshOverlays()
  }

  setPlacing(size: { widthFt: number; depthFt: number; heightFt: number } | null): void {
    this.placing = size
    if (this.ghost) {
      this.overlays.remove(this.ghost)
      this.ghost.geometry.dispose()
      ;(this.ghost.material as ThreeTypes.Material).dispose()
      this.ghost = null
    }
    if (size) {
      const three = this.three
      this.ghost = new three.Mesh(
        new three.BoxGeometry(size.widthFt, size.heightFt, size.depthFt),
        new three.MeshStandardMaterial({ color: this.theme.accent, transparent: true, opacity: 0.4, depthWrite: false }),
      )
      this.ghost.visible = false
      this.overlays.add(this.ghost)
    }
    this.updateCursor()
    this.dirty = true
  }

  setMode(mode: ModelMode): void {
    if (mode === this.mode) return
    this.stopPhoto()
    if (mode === "walk") {
      const level = this.walkLevel()
      if (!level) return
      this.startBlend()
      this.mode = "walk"
      this.enterWalkAt(level)
    } else {
      this.startBlend()
      this.mode = "orbit"
      this.keys.clear()
    }
    this.rebuild()
    this.updateCursor()
    this.callbacks.onModeChange(this.mode)
  }

  setTool(tool: ModelTool): void {
    if (tool === this.tool) return
    this.tool = tool
    if (tool !== "measure") this.clearMeasurements()
    this.updateCursor()
  }

  clearMeasurements(): void {
    this.measurePoints = []
    this.measurements = []
    this.measureHover = null
    this.refreshMeasure()
    this.callbacks.onMeasure([])
  }

  setPins(pins: ModelPin[]): void {
    this.pins = pins
    this.refreshPins()
  }

  setDiff(diff: ModelSceneDiff[]): void {
    this.diff = diff
    this.refreshDiff()
    this.refreshOverlays()
  }

  /** A box around the building whose six faces can be dragged in. */
  setSectionBox(on: boolean): void {
    if (on === (this.sectionBox !== null)) return
    this.sectionPlane = null
    if (!on) this.sectionBox = null
    else if (this.geometry) {
      const box = new this.three.Box3().setFromObject(this.building)
      box.min.y = -0.5
      box.expandByVector(new this.three.Vector3(1, 0, 1))
      box.max.y += 1
      this.sectionBox = box
    }
    this.refreshSection()
  }

  /** A vertical cut along a wall, keeping what lies beyond it from where the camera stands. */
  sectionThrough(levelId: string, wallId: string): void {
    const node = this.levels.find((level) => level.levelId === levelId)?.surfaces.get(wallId)
    const level = this.placed.find((candidate) => candidate.id === levelId)
    const wall = level?.walls.find((candidate) => candidate.id === wallId)
    if (!node || !wall || !this.geometry) return
    const three = this.three
    const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0) || 1
    const normal = new three.Vector3(-(wall.y1 - wall.y0) / length, 0, (wall.x1 - wall.x0) / length)
    const center = new three.Vector3((wall.x0 + wall.x1) / 2 - this.geometry.centerX, 0, (wall.y0 + wall.y1) / 2 - this.geometry.centerY)
    // Keep the side away from the camera; the cut passes just in front of the wall's face.
    const toCamera = this.camera.position.clone().sub(center)
    if (toCamera.dot(normal) > 0) normal.negate()
    const offset = wall.thicknessFt / 2 + 0.05
    const plane = new three.Plane().setFromNormalAndCoplanarPoint(normal, center.clone().addScaledVector(normal, -offset))
    this.sectionBox = null
    this.sectionPlane = plane
    this.refreshSection()
    // Look straight at the cut.
    if (this.mode === "walk") this.setMode("orbit")
    this.goal.theta = nearestAngle(this.current.theta, Math.atan2(-normal.x, -normal.z))
    this.goal.phi = 1.25
    this.goal.target = [center.x, this.focusBaseY() + 4, center.z]
    this.userZoomed = true
    this.dirty = true
  }

  clearSection(): void {
    this.sectionBox = null
    this.sectionPlane = null
    this.refreshSection()
  }

  flipSection(): void {
    if (!this.sectionPlane) return
    this.sectionPlane.negate()
    this.refreshSection()
  }

  get hasSection(): boolean {
    return this.sectionBox !== null || this.sectionPlane !== null
  }

  preset(name: ModelCameraPreset, instant = false): void {
    if (this.mode === "walk") this.setMode("orbit")
    const presets: Record<ModelCameraPreset, { theta: number; phi: number; k: number }> = {
      iso: { theta: 0.75, phi: 0.9, k: 1 },
      top: { theta: 0, phi: 0.02, k: 0.95 },
      front: { theta: 0, phi: 1.36, k: 0.95 },
    }
    const next = presets[name]
    this.userZoomed = false
    this.goal.theta = nearestAngle(this.current.theta, next.theta)
    this.goal.phi = next.phi
    this.goal.r = this.fitRadius() * next.k
    this.goal.target = [0, this.focusBaseY() + 2, 0]
    if (instant) Object.assign(this.current, { ...this.goal, target: [...this.goal.target] })
    this.dirty = true
  }

  /** Fly to a room, wall or object and frame it. */
  frameSurface(levelId: string, id: string): void {
    const node = this.levels.find((level) => level.levelId === levelId)?.surfaces.get(id)
    if (!node) return
    if (this.mode === "walk") this.setMode("orbit")
    const box = new this.three.Box3().setFromObject(node.mesh)
    const center = box.getCenter(new this.three.Vector3())
    const size = box.getSize(new this.three.Vector3())
    this.goal.target = [center.x, center.y, center.z]
    this.goal.r = clamp(Math.max(size.x, size.z) * 2.6, 24, this.fitRadius())
    this.userZoomed = true
    this.dirty = true
  }

  /** Where a surface sits on screen, for anchoring a card to it. */
  projectSurface(levelId: string, id: string): ScreenPoint | null {
    const node = this.levels.find((level) => level.levelId === levelId)?.surfaces.get(id)
    if (!node || !node.mesh.parent?.visible) return null
    const box = new this.three.Box3().setFromObject(node.mesh)
    const center = box.getCenter(new this.three.Vector3())
    center.y = Math.min(box.max.y, center.y + 0.5)
    return this.toScreen(center)
  }

  captureView(name: string): SavedModelView {
    const direction = new this.three.Vector3()
    this.camera.getWorldDirection(direction)
    const target = this.mode === "orbit" ? this.current.target : this.camera.position.clone().add(direction).toArray()
    return {
      id: crypto.randomUUID(),
      name,
      levelId: this.focus,
      mode: this.mode,
      position: this.camera.position.toArray() as [number, number, number],
      target: [target[0], target[1], target[2]],
    }
  }

  restoreView(view: SavedModelView): void {
    this.setFocus(view.levelId)
    if (view.mode === "walk") {
      this.setMode("walk")
      const level = this.walkLevel()
      if (!level || !isWalkable(level, view.position[0], view.position[2])) return
      this.walk.x = view.position[0]
      this.walk.z = view.position[2]
      const dx = view.target[0] - view.position[0]
      const dy = view.target[1] - view.position[1]
      const dz = view.target[2] - view.position[2]
      this.walk.yaw = this.walk.goalYaw = Math.atan2(-dx, -dz)
      this.walk.pitch = this.walk.goalPitch = Math.atan2(dy, Math.hypot(dx, dz))
    } else {
      this.setMode("orbit")
      const [px, py, pz] = view.position
      const [tx, ty, tz] = view.target
      const dx = px - tx
      const dy = py - ty
      const dz = pz - tz
      const r = Math.hypot(dx, dy, dz)
      this.goal.r = r
      this.goal.phi = Math.acos(clamp(dy / r, -1, 1))
      this.goal.theta = Math.atan2(dx, dz)
      this.goal.target = [tx, ty, tz]
      this.userZoomed = true
    }
    this.dirty = true
  }

  // --- Walkthroughs --------------------------------------------------------

  startRecording(): void {
    this.stopTour()
    this.recording = { samples: [], clock: 0, still: 0 }
  }

  /** The recorded path, or null if nothing worth keeping was recorded. */
  stopRecording(): TourSample[] | null {
    const samples = this.recording?.samples ?? []
    this.recording = null
    return samples.length >= 4 ? samples : null
  }

  get isRecording(): boolean {
    return this.recording !== null
  }

  playTour(samples: TourSample[]): void {
    if (samples.length < 2) return
    this.stopPhoto()
    this.recording = null
    if (this.mode === "walk") {
      this.mode = "orbit"
      this.keys.clear()
      this.callbacks.onModeChange("orbit")
    }
    this.tour = { samples, t: 0 }
    this.rebuild()
    this.dirty = true
  }

  stopTour(): void {
    if (!this.tour) return
    this.tour = null
    // Hand the camera back to the orbit rig where the tour left it.
    const look = this.lastLook
    const position = this.camera.position
    const dx = position.x - look[0]
    const dy = position.y - look[1]
    const dz = position.z - look[2]
    const r = Math.max(ORBIT_MIN_R, Math.hypot(dx, dy, dz))
    Object.assign(this.goal, { r, phi: Math.acos(clamp(dy / r, -1, 1)), theta: Math.atan2(dx, dz), target: [...look] })
    Object.assign(this.current, { ...this.goal, target: [...look] })
    this.userZoomed = true
    this.callbacks.onTourEnd()
    this.dirty = true
  }

  // --- Photo ---------------------------------------------------------------

  /** Path-trace the current view; refines until `PHOTO_SAMPLES` or until anything moves. */
  async startPhoto(): Promise<void> {
    if (this.photo || !this.geometry || this.xr) return
    this.photo = { tracer: null, sky: null, samples: 0, cancelled: false }
    const photo = this.photo
    this.callbacks.onPhoto(0)
    this.rebuild()
    const { WebGLPathTracer, GradientEquirectTexture } = await import("three-gpu-pathtracer")
    if (photo.cancelled || this.disposed) return
    const sky = new GradientEquirectTexture(256)
    sky.topColor.setHex(SURFACE.skyTop)
    sky.bottomColor.setHex(SURFACE.skyGround)
    sky.exponent = 1.6
    sky.update()
    this.scene.environment = sky
    this.scene.environmentIntensity = 0.9
    const tracer = new WebGLPathTracer(this.renderer)
    tracer.bounces = 5
    tracer.filterGlossyFactor = 0.5
    tracer.minSamples = 1
    tracer.dynamicLowRes = true
    tracer.fadeDuration = 300
    tracer.tiles.set(1, 1)
    // A house is a few hundred thousand triangles: building its BVH on the main thread takes a beat, not a worker.
    tracer.setScene(this.scene, this.camera)
    photo.tracer = tracer
    photo.sky = sky
    this.dirty = true
  }

  stopPhoto(): void {
    const photo = this.photo
    if (!photo) return
    photo.cancelled = true
    photo.tracer?.dispose()
    photo.sky?.dispose()
    this.photo = null
    this.scene.environment = this.environment
    this.applySun()
    this.callbacks.onPhoto(null)
    this.rebuild()
  }

  get isPhoto(): boolean {
    return this.photo !== null
  }

  private restartPhoto(): void {
    if (!this.photo?.tracer) return
    this.photo.samples = 0
    this.photo.tracer.updateLights()
    this.photo.tracer.reset()
  }

  // --- WebXR ---------------------------------------------------------------

  static async xrSupported(): Promise<boolean> {
    const xr = typeof navigator === "undefined" ? undefined : navigator.xr
    if (!xr) return false
    return xr.isSessionSupported("immersive-vr").catch(() => false)
  }

  /** Stand in the model at the walk position, at real scale. */
  async enterXR(): Promise<void> {
    const xr = navigator.xr
    if (!xr || this.xr) return
    this.stopPhoto()
    this.stopTour()
    if (this.mode === "orbit") this.setMode("walk")
    const session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] })
    const level = this.walkLevel()
    this.renderer.xr.enabled = true
    this.renderer.xr.setReferenceSpaceType("local-floor")
    await this.renderer.xr.setSession(session)
    this.scene.scale.setScalar(FEET_TO_METERS)
    const base = this.renderer.xr.getReferenceSpace()
    if (base) {
      const offset = new XRRigidTransform({
        x: -this.walk.x * FEET_TO_METERS,
        y: -(level?.baseY ?? 0) * FEET_TO_METERS,
        z: -this.walk.z * FEET_TO_METERS,
        w: 1,
      })
      this.renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(offset))
    }
    this.xr = { session, scale: FEET_TO_METERS }
    session.addEventListener("end", () => {
      this.xr = null
      this.scene.scale.setScalar(1)
      this.renderer.xr.enabled = false
      this.resize()
      this.dirty = true
    })
  }

  // --- Export --------------------------------------------------------------

  exportImage(fileName: string): void {
    if (!this.photo) this.draw()
    const anchor = document.createElement("a")
    anchor.href = this.renderer.domElement.toDataURL("image/png")
    anchor.download = `${fileName}.png`
    anchor.click()
  }

  /** The whole building, every level, uncut — whatever is on screen. */
  async exportGlb(fileName: string): Promise<void> {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js")
    const saved = { focus: this.focus, cutaway: this.cutaway }
    this.focus = "all"
    this.cutaway = false
    this.rebuild()
    const copy = new this.three.Group()
    for (const level of this.levels) {
      const clone = level.group.clone(true)
      clone.visible = true
      clone.traverse((child) => {
        if (child.name.startsWith("label:") || (child as ThreeTypes.LineSegments).isLineSegments) child.visible = false
      })
      copy.add(clone)
    }
    this.focus = saved.focus
    this.cutaway = saved.cutaway
    this.rebuild()
    const result = await new GLTFExporter().parseAsync(copy, { binary: true, onlyVisible: true })
    if (!(result instanceof ArrayBuffer)) return
    const url = URL.createObjectURL(new Blob([result], { type: "model/gltf-binary" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${fileName}.glb`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  resize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width < 2 || height < 2 || this.xr) return
    this.renderer.setSize(width, height, false)
    this.composer?.setPixelRatio(this.renderer.getPixelRatio())
    this.composer?.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (!this.userZoomed && this.geometry && this.mode === "orbit") this.goal.r = this.fitRadius()
    this.restartPhoto()
    this.dirty = true
  }

  /** Keys reach the scene only while it has focus or the pointer is over it. */
  handleKey(event: KeyboardEvent, down: boolean): boolean {
    const key = event.key.toLowerCase()
    if (down && key === "escape") {
      if (this.tour) {
        this.stopTour()
        return true
      }
      if (this.tool === "measure" && (this.measurePoints.length > 0 || this.measurements.length > 0)) {
        if (this.measurePoints.length > 0) {
          this.measurePoints = []
          this.refreshMeasure()
        } else this.clearMeasurements()
        return true
      }
      return false
    }
    const movement = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"]
    if (this.mode !== "walk" || !movement.includes(key)) return false
    if (down) this.keys.add(key)
    else this.keys.delete(key)
    this.walk.glide = null
    if (down) this.stopPhoto()
    this.dirty = true
    return true
  }

  dispose(): void {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    void this.xr?.session.end()
    this.stopPhoto()
    this.resizeObserver?.disconnect()
    this.unbindInput()
    this.clearBuilding()
    for (const list of [this.overlayDisposables, this.pinDisposables, this.diffDisposables, this.measureDisposables, this.sectionDisposables]) {
      for (const item of list) item.dispose()
    }
    this.setPlacing(null)
    this.teardownComposer()
    this.furniture.dispose()
    for (const item of this.disposables) item.dispose()
    for (const texture of this.textures.values()) texture.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // -------------------------------------------------------------------------
  // Post-processing and light
  // -------------------------------------------------------------------------

  private setupComposer(): void {
    if (this.composer) return
    const three = this.three
    const { EffectComposer, RenderPass, GTAOPass, OutlinePass, UnrealBloomPass, SMAAPass, OutputPass } = this.runtime.post
    const width = Math.max(2, this.container.clientWidth)
    const height = Math.max(2, this.container.clientHeight)
    const ratio = this.renderer.getPixelRatio()
    const target = new three.WebGLRenderTarget(width * ratio, height * ratio, { type: three.HalfFloatType })
    const composer = new EffectComposer(this.renderer, target)
    composer.setPixelRatio(ratio)
    composer.setSize(width, height)
    composer.addPass(new RenderPass(this.scene, this.camera))

    const ao = new GTAOPass(this.scene, this.camera, width, height)
    ao.output = GTAOPass.OUTPUT.Default
    ao.blendIntensity = 0.85
    // Feet, not metres: a two-foot reach darkens corners and under furniture.
    ao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.4, thickness: 2.5, scale: 1.1, distanceFallOff: 1, samples: 16 })
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 })
    composer.addPass(ao)

    const outline = new OutlinePass(new three.Vector2(width, height), this.scene, this.camera)
    outline.edgeStrength = 3.4
    outline.edgeGlow = 0
    outline.edgeThickness = 1
    outline.visibleEdgeColor.setHex(this.theme.accent)
    outline.hiddenEdgeColor.setHex(this.theme.accent)
    composer.addPass(outline)
    // Only true highlights bloom: glass and polished floors catching the sun.
    composer.addPass(new UnrealBloomPass(new three.Vector2(width, height), 0.12, 0.4, 1.6))
    composer.addPass(new SMAAPass())
    composer.addPass(new OutputPass())
    this.composer = composer
    this.outline = outline
    this.dirty = true
  }

  private teardownComposer(): void {
    if (!this.composer) return
    for (const pass of this.composer.passes) pass.dispose()
    this.composer.dispose()
    this.composer = null
    this.outline = null
    this.dirty = true
  }

  /** The sun where it really is for this site at this hour; dusk dims and warms it. */
  private applySun(): void {
    const three = this.three
    const site = this.model?.site ?? DEFAULT_SITE
    const sun = sunPosition(site, this.sunDay, this.sunHour)
    const radius = this.geometry?.radiusFt ?? 40
    const altitude = Math.max(sun.altitudeDeg, 1)
    const up = Math.sin((altitude * Math.PI) / 180)
    const flat = Math.hypot(sun.direction[0], sun.direction[2]) || 1
    const direction = new three.Vector3((sun.direction[0] / flat) * Math.cos((altitude * Math.PI) / 180), up, (sun.direction[2] / flat) * Math.cos((altitude * Math.PI) / 180))
    this.sun.position.copy(direction.multiplyScalar(radius * 3 + 30))
    this.sun.target.position.set(0, 0, 0)
    const day = smoothstep(-4, 14, sun.altitudeDeg)
    this.sun.intensity = 2.8 * day
    this.sun.color.setHex(SURFACE.sunLow).lerp(new three.Color(SURFACE.sunHigh), smoothstep(4, 30, sun.altitudeDeg))
    this.hemisphere.intensity = 0.45 + 0.5 * day
    if (!this.photo) this.scene.environmentIntensity = 0.3 + 0.28 * day
    this.dirty = true
  }

  // -------------------------------------------------------------------------
  // Building the meshes
  // -------------------------------------------------------------------------

  private clearBuilding(): void {
    this.building.clear()
    this.overlays.children.filter((child) => child !== this.ghost).forEach((child) => this.overlays.remove(child))
    for (const item of this.buildDisposables) item.dispose()
    this.buildDisposables = []
    this.levels = []
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.buildDisposables.push(item)
    return item
  }

  private bufferGeometry(data: MeshData, owner: Array<{ dispose: () => void }> = this.buildDisposables): ThreeTypes.BufferGeometry {
    const three = this.three
    const geometry = new three.BufferGeometry()
    geometry.setAttribute("position", new three.BufferAttribute(data.positions, 3))
    geometry.setAttribute("normal", new three.BufferAttribute(data.normals, 3))
    if (data.uvs) geometry.setAttribute("uv", new three.BufferAttribute(data.uvs, 2))
    if (data.colors) geometry.setAttribute("color", new three.BufferAttribute(data.colors, 3))
    geometry.setIndex(new three.BufferAttribute(data.indices, 1))
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()
    if (data.indices.length > 0) geometry.computeBoundsTree()
    owner.push({
      dispose: () => {
        geometry.disposeBoundsTree()
        geometry.dispose()
      },
    })
    return geometry
  }

  private visibleOrders(): { top: number; cutLevel: string | null } {
    const sorted = [...(this.geometry?.levels ?? [])].sort((a, b) => a.order - b.order)
    const focusLevel = sorted.find((level) => level.levelId === this.focus)
    const top = focusLevel ? focusLevel.order : (sorted.at(-1)?.order ?? 0)
    const topId = focusLevel ? focusLevel.levelId : (sorted.at(-1)?.levelId ?? null)
    const cutLevel = this.mode === "walk" || this.tour || !this.cutaway ? null : topId
    return { top, cutLevel }
  }

  /** The model a photo is traced from: the cut level's walls built only to the cut. */
  private photoGeometry(cutLevel: string | null): SceneGeometry | null {
    if (!this.model) return null
    if (!cutLevel) return this.geometry
    return buildSceneGeometry({
      ...this.model,
      levels: this.model.levels.map((level) =>
        level.id === cutLevel ? { ...level, roof: undefined, walls: level.walls.map((wall) => ({ ...wall, heightFt: Math.min(wall.heightFt ?? level.ceilingHeightFt, DOLLHOUSE_CUT_FT) })) } : level,
      ),
    })
  }

  private rebuild(): void {
    if (!this.geometry || this.disposed) return
    this.clearBuilding()
    const three = this.three
    const { top, cutLevel } = this.visibleOrders()
    const photo = this.photo !== null
    const source = photo ? this.photoGeometry(cutLevel) : this.geometry
    if (!source) return
    const showRoof = this.focus === "all" && !this.cutaway && this.mode === "orbit" && this.look !== "takeoff"
    const cutting = !photo && (cutLevel !== null || this.hasSection)

    for (const geometry of source.levels) {
      // Levels above the one in focus are never built, not merely hidden.
      if (geometry.order > top) continue
      const group = new three.Group()
      const placedLevel = this.placed.find((level) => level.id === geometry.levelId)
      const node: LevelNode = {
        levelId: geometry.levelId,
        order: geometry.order,
        baseY: geometry.baseY,
        ceilingHeightFt: geometry.ceilingHeightFt,
        group,
        ceiling: null,
        detail: null,
        surfaces: new Map(),
        labels: [],
        geometry,
      }

      for (const surface of geometry.surfaces) {
        if (surface.kind === "roof" && !showRoof) continue
        if (surface.kind === "object" && this.look === "takeoff") continue
        const mesh = new three.Mesh(this.bufferGeometry(surface.mesh), this.surfaceMaterial(surface.kind, surface.id, surface.finish, surface.color))
        mesh.castShadow = surface.kind !== "room"
        mesh.receiveShadow = true
        mesh.userData = { pick: { kind: surface.kind, id: surface.id, levelId: geometry.levelId } satisfies ModelPick }
        let display: ThreeTypes.Object3D | null = null
        if (surface.kind === "wall" && !photo) {
          const edges = new three.LineSegments(this.track(new three.EdgesGeometry(mesh.geometry, 30)), this.edgeMaterial())
          mesh.add(edges)
          if (cutting) {
            const poche = new three.Mesh(mesh.geometry, this.pocheMaterial())
            poche.renderOrder = 1
            mesh.add(poche)
          }
        }
        if (surface.kind === "object") {
          const object = placedLevel?.objects?.find((candidate) => candidate.id === surface.id)
          const piece = furnitureModel(object?.modelId)
          const real = object && piece ? this.furniture.instance(piece, object) : null
          if (object && real) {
            real.position.set(object.xFt - source.centerX, geometry.baseY + object.elevationFt, object.yFt - source.centerY)
            real.rotation.y = (-object.rotationDeg * Math.PI) / 180
            real.userData.home = real.position.clone()
            // The box stays as the pick target; the path tracer traces every mesh it is given, so a photo gets no box at all.
            ;(mesh.material as ThreeTypes.Material).visible = false
            mesh.castShadow = false
            group.add(real)
            display = real
          }
        }
        if (!(photo && display)) group.add(mesh)
        node.surfaces.set(surface.id, { mesh, kind: surface.kind, display })
      }

      if (this.look !== "takeoff") {
        const trim = new three.Mesh(this.bufferGeometry(geometry.trim), this.flat(SURFACE.trim, 0.55))
        trim.castShadow = true
        group.add(trim)
        const detail = new three.Mesh(this.bufferGeometry(geometry.detail), this.flat(SURFACE.trim, 0.5))
        detail.castShadow = true
        detail.visible = photo || this.detailVisible
        group.add(detail)
        node.detail = detail
        const glass = new three.Mesh(
          this.bufferGeometry(geometry.glass),
          this.track(new three.MeshPhysicalMaterial({ color: SURFACE.glass, transparent: true, opacity: this.look === "xray" ? 0.12 : 0.32, roughness: 0.05, metalness: 0, transmission: photo ? 0.9 : 0, ior: 1.5, envMapIntensity: 1.4, depthWrite: false })),
        )
        group.add(glass)
      }
      const slab = new three.Mesh(this.bufferGeometry(geometry.floor), this.track(new three.MeshStandardMaterial({ color: SURFACE.slab, roughness: 0.9, vertexColors: true })))
      slab.receiveShadow = true
      group.add(slab)

      if (!photo) {
        const ceiling = new three.Mesh(this.bufferGeometry(geometry.ceiling), this.flat(SURFACE.trim, 0.95))
        ceiling.visible = (this.mode === "walk" || this.xr !== null) && this.walkLevel()?.levelId === geometry.levelId
        ceiling.material.side = three.DoubleSide
        group.add(ceiling)
        node.ceiling = ceiling
      }

      if (geometry.order === top && !photo) {
        for (const anchor of geometry.labels) {
          const label = this.floorLabel(anchor.text, anchor.areaSqft, anchor.fitFt)
          if (!label) continue
          label.position.set(anchor.x, anchor.floorY + 0.06, anchor.z)
          label.rotation.set(-Math.PI / 2, 0, anchor.angle)
          label.visible = this.labelsOn && this.mode === "orbit" && !this.tour
          label.renderOrder = 2
          group.add(label)
          node.labels.push(label)
        }
      }

      this.building.add(group)
      this.levels.push(node)
    }
    this.ground.material = photo ? this.track(new this.three.MeshStandardMaterial({ color: this.theme.ground, roughness: 1 })) : (this.disposables[1] as ThreeTypes.Material)
    this.site.visible = !photo
    this.applyClipping(cutLevel)
    this.refreshOverlays()
    this.refreshDiff()
    this.refreshPins()
    this.dirty = true
  }

  /** One set of planes for every cut — dollhouse, section box, section plane. */
  private applyClipping(cutLevel: string | null): void {
    const planes: ThreeTypes.Plane[] = []
    if (!this.photo) {
      const level = this.geometry?.levels.find((candidate) => candidate.levelId === cutLevel)
      if (level) planes.push(new this.three.Plane(new this.three.Vector3(0, -1, 0), level.baseY + DOLLHOUSE_CUT_FT))
      if (this.sectionPlane) planes.push(this.sectionPlane)
      if (this.sectionBox) {
        const { min, max } = this.sectionBox
        const V = this.three.Vector3
        planes.push(
          new this.three.Plane(new V(1, 0, 0), -min.x),
          new this.three.Plane(new V(-1, 0, 0), max.x),
          new this.three.Plane(new V(0, 1, 0), -min.y),
          new this.three.Plane(new V(0, -1, 0), max.y),
          new this.three.Plane(new V(0, 0, 1), -min.z),
          new this.three.Plane(new V(0, 0, -1), max.z),
        )
      }
    }
    this.renderer.clippingPlanes = planes
    this.dirty = true
  }

  private flat(color: number, roughness: number): ThreeTypes.MeshStandardMaterial {
    return this.track(new this.three.MeshStandardMaterial({ color, roughness }))
  }

  private edgeMaterial(): ThreeTypes.LineBasicMaterial {
    const xray = this.look === "xray"
    return this.track(new this.three.LineBasicMaterial({ color: SURFACE.edge, transparent: true, opacity: xray ? 0.55 : this.look === "takeoff" ? 0.08 : 0.13 }))
  }

  private pocheMaterial(): ThreeTypes.MeshBasicMaterial {
    return this.track(new this.three.MeshBasicMaterial({ color: SURFACE.poche, side: this.three.BackSide }))
  }

  private surfaceMaterial(kind: SurfaceKind, id: string, finish: SurfaceFinish | undefined, color: string | undefined): ThreeTypes.Material {
    const three = this.three
    if (this.look === "takeoff" && (kind === "wall" || kind === "room")) {
      const hex = this.takeoffColors[id]
      return this.track(new three.MeshStandardMaterial({ color: hex ?? (kind === "wall" ? SURFACE.untakenWall : SURFACE.untakenRoom), roughness: 0.85 }))
    }
    if (this.look === "xray" && kind === "wall") {
      return this.track(new three.MeshStandardMaterial({ color: SURFACE.xrayWall, transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.6 }))
    }
    if (kind === "wall") {
      if (finish) return this.finishMaterial(finish)
      return this.flat(this.exteriorWalls.has(id) ? SURFACE.wallExterior : SURFACE.wall, 0.92)
    }
    if (kind === "room") {
      if (finish) return this.finishMaterial(finish)
      return this.track(new three.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8 }))
    }
    if (kind === "roof") return this.track(new three.MeshStandardMaterial({ color: color ?? MODEL_MATERIAL_COLORS.roof, roughness: 0.85, side: three.DoubleSide }))
    return this.track(new three.MeshStandardMaterial({ color: color ?? MODEL_MATERIAL_COLORS.furniture, roughness: 0.8 }))
  }

  /**
   * Finishes as physical materials: the pattern tile is both the colour map
   * and a bump map, so boards, grout and stone read in raking light; polished
   * surfaces get a clear coat.
   */
  private finishMaterial(finish: SurfaceFinish): ThreeTypes.MeshStandardMaterial {
    const three = this.three
    const material = new three.MeshPhysicalMaterial({
      color: finish.color,
      roughness: finish.roughness,
      metalness: 0,
      clearcoat: finish.roughness < 0.5 ? 0.35 : 0,
      clearcoatRoughness: 0.25,
    })
    this.track(material)
    if (finish.pattern === "solid") return material
    let texture = this.textures.get(finish.pattern)
    if (!texture) {
      texture = this.patternTexture(finish.pattern)
      this.textures.set(finish.pattern, texture)
    }
    const instance = texture.clone()
    instance.needsUpdate = true
    instance.repeat.set(1 / finish.scaleFt, 1 / finish.scaleFt)
    instance.rotation = ((finish.rotationDeg ?? 0) * Math.PI) / 180
    this.track(instance)
    material.map = instance
    material.bumpMap = instance
    material.bumpScale = finish.pattern === "tile" ? 1.6 : 0.8
    return material
  }

  /**
   * Procedural pattern tiles, drawn white so the finish colour multiplies
   * through. One canvas per pattern, cloned per finish so each can carry its
   * own scale and rotation.
   */
  private patternTexture(pattern: SurfaceFinish["pattern"]): ThreeTypes.Texture {
    const three = this.three
    const size = 512
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext("2d")
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    if (context) {
      context.fillStyle = MODEL_MATERIAL_COLORS.textureBase
      context.fillRect(0, 0, size, size)
      if (pattern === "wood") {
        const rows = 8
        const height = size / rows
        for (let row = 0; row < rows; row++) {
          let x = -random() * size * 0.6
          while (x < size) {
            const length = size * (0.4 + random() * 0.55)
            const shade = 0.82 + random() * 0.18
            context.fillStyle = `rgba(${Math.round(255 * shade)},${Math.round(250 * shade)},${Math.round(242 * shade)},1)`
            context.fillRect(x, row * height, length, height)
            context.strokeStyle = "rgba(60,40,15,0.08)"
            for (let grain = 0; grain < 7; grain++) {
              const y = row * height + random() * height
              context.beginPath()
              context.moveTo(x, y)
              context.bezierCurveTo(x + length * 0.3, y + (random() - 0.5) * 7, x + length * 0.6, y + (random() - 0.5) * 7, x + length, y + (random() - 0.5) * 5)
              context.stroke()
            }
            context.fillStyle = "rgba(40,25,10,0.22)"
            context.fillRect(x, row * height, 1.5, height)
            x += length
          }
          context.fillStyle = "rgba(40,25,10,0.2)"
          context.fillRect(0, row * height, size, 1.5)
        }
      } else if (pattern === "tile") {
        context.fillStyle = MODEL_MATERIAL_COLORS.grout
        context.fillRect(0, 0, size, size)
        context.fillStyle = MODEL_MATERIAL_COLORS.textureBase
        context.fillRect(4, 4, size - 8, size - 8)
        for (let i = 0; i < 2500; i++) {
          context.fillStyle = `rgba(${random() < 0.5 ? "0,0,0" : "255,255,255"},${random() * 0.05})`
          context.fillRect(random() * size, random() * size, 2, 2)
        }
      } else {
        for (let i = 0; i < 22000; i++) {
          context.fillStyle = `rgba(${random() < 0.5 ? "70,55,40" : "255,250,240"},${random() * 0.1})`
          context.fillRect(random() * size, random() * size, 1.6, 1.6)
        }
      }
    }
    const texture = new three.CanvasTexture(canvas)
    texture.wrapS = three.RepeatWrapping
    texture.wrapT = three.RepeatWrapping
    texture.colorSpace = three.SRGBColorSpace
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    return texture
  }

  private floorLabel(text: string, areaSqft: number, fitFt: number): ThreeTypes.Mesh | null {
    const three = this.three
    const canvas = document.createElement("canvas")
    canvas.width = 512
    canvas.height = 160
    const context = canvas.getContext("2d")
    if (!context) return null
    context.fillStyle = this.theme.ink
    context.textAlign = "center"
    context.textBaseline = "middle"
    context.font = "600 64px ui-sans-serif, system-ui, sans-serif"
    context.fillText(text.toUpperCase(), 256, 62, 500)
    context.globalAlpha = 0.6
    context.font = "500 40px ui-monospace, SFMono-Regular, Menlo, monospace"
    context.fillText(`${Math.round(areaSqft).toLocaleString("en-US")} SF`, 256, 122, 500)
    const texture = this.track(new three.CanvasTexture(canvas))
    texture.colorSpace = three.SRGBColorSpace
    const width = Math.min(fitFt, 12)
    const material = this.track(new three.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.85 }))
    const mesh = new three.Mesh(this.track(new three.PlaneGeometry(width, (width * 160) / 512)), material)
    mesh.name = `label:${text}`
    return mesh
  }

  /** A small chip of text that always faces the camera at a fixed screen size. */
  private chip(text: string, background: number, owner: Array<{ dispose: () => void }>): ThreeTypes.Sprite {
    const three = this.three
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    const font = "600 34px ui-sans-serif, system-ui, sans-serif"
    if (context) context.font = font
    const width = Math.ceil((context?.measureText(text).width ?? 120) + 36)
    canvas.width = width
    canvas.height = 56
    if (context) {
      context.fillStyle = `#${background.toString(16).padStart(6, "0")}`
      context.fillRect(0, 0, width, 56)
      context.font = font
      context.fillStyle = "white"
      context.textBaseline = "middle"
      context.fillText(text, 18, 29)
    }
    const texture = new three.CanvasTexture(canvas)
    texture.colorSpace = three.SRGBColorSpace
    const material = new three.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false, toneMapped: false })
    owner.push(texture, material)
    const sprite = new three.Sprite(material)
    sprite.scale.set((0.032 * width) / 56, 0.032, 1)
    sprite.renderOrder = 10
    return sprite
  }

  private environmentRoom(): ThreeTypes.Scene {
    const three = this.three
    const room = new three.Scene()
    room.add(new three.Mesh(new three.BoxGeometry(60, 30, 60), new three.MeshStandardMaterial({ color: 0x7c818b, side: three.BackSide, roughness: 1 })))
    for (const [x, y, z, w, h, d, intensity] of [
      [0, 14.8, 0, 36, 0.2, 36, 6],
      [-29.6, 8, 0, 0.2, 10, 30, 3],
      [29.6, 10, 8, 0.2, 8, 20, 2.2],
      [0, 8, -29.6, 24, 8, 0.2, 1.6],
    ] as const) {
      const material = new three.MeshBasicMaterial({ color: 0xffffff })
      material.color.setScalar(intensity)
      const panel = new three.Mesh(new three.BoxGeometry(w, h, d), material)
      panel.position.set(x, y, z)
      room.add(panel)
    }
    room.add(new three.AmbientLight(0xffffff, 1))
    return room
  }

  // -------------------------------------------------------------------------
  // Overlays: hover, highlight, selection, diff, pins, measure, section
  // -------------------------------------------------------------------------

  private refreshOverlays(): void {
    const three = this.three
    this.overlays.children.filter((child) => child !== this.ghost).forEach((child) => this.overlays.remove(child))
    for (const item of this.overlayDisposables) item.dispose()
    this.overlayDisposables = []
    const own = <T extends { dispose: () => void }>(item: T): T => {
      this.overlayDisposables.push(item)
      return item
    }
    const outlined: ThreeTypes.Object3D[] = []
    const tint = (id: string, color: number, strength: number, edges = false) => {
      for (const level of this.levels) {
        const node = level.surfaces.get(id)
        if (!node) continue
        const material = own(
          new three.MeshBasicMaterial({ color, transparent: true, opacity: strength, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        )
        const overlay = new three.Mesh(node.mesh.geometry, material)
        overlay.renderOrder = 3
        this.overlays.add(overlay)
        if (edges && !this.outline) {
          const lines = new three.LineSegments(own(new three.EdgesGeometry(node.mesh.geometry, 30)), own(new three.LineBasicMaterial({ color })))
          lines.renderOrder = 4
          this.overlays.add(lines)
        }
      }
    }
    const outlineOf = (id: string) => {
      for (const level of this.levels) {
        const node = level.surfaces.get(id)
        if (node) outlined.push(node.display ?? node.mesh)
      }
    }
    for (const level of this.diff) {
      for (const id of level.addedWallIds) tint(id, this.theme.added, 0.45)
      for (const room of level.rooms) tint(room.roomId, room.status === "added" ? this.theme.added : this.theme.changed, 0.35)
    }
    for (const id of this.highlight) tint(id, this.theme.accent, 0.28)
    if (this.hovered && this.hovered !== this.selected) {
      if (this.outline) outlineOf(this.hovered)
      else tint(this.hovered, this.theme.accent, 0.22)
    }
    if (this.selected) {
      tint(this.selected, this.theme.accent, this.outline ? 0.18 : 0.34, true)
      outlineOf(this.selected)
    }
    if (this.outline) this.outline.selectedObjects = outlined
    this.dirty = true
  }

  private refreshDiff(): void {
    this.diffGroup.clear()
    for (const item of this.diffDisposables) item.dispose()
    this.diffDisposables = []
    if (!this.geometry || this.diff.length === 0) return
    const three = this.three
    const centerX = this.geometry.centerX
    const centerY = this.geometry.centerY
    const removed = new three.MeshBasicMaterial({ color: this.theme.removed, transparent: true, opacity: 0.35, depthWrite: false })
    const outline = new three.LineDashedMaterial({ color: this.theme.removed, dashSize: 0.8, gapSize: 0.5 })
    this.diffDisposables.push(removed, outline)
    for (const diff of this.diff) {
      const level = this.model?.levels.find((candidate) => candidate.id === diff.levelId)
      const node = this.levels.find((candidate) => candidate.levelId === diff.levelId)
      if (!level || !node) continue
      if (diff.removedWalls.length > 0) {
        const ghost = buildLevelGeometry(placeLevel({ ...level, walls: diff.removedWalls, openings: [], rooms: [], objects: [], roof: undefined }), { centerX, centerY, baseY: node.baseY })
        for (const data of [ghost.walls, ghost.exteriorWalls]) {
          if (data.indices.length === 0) continue
          const mesh = new three.Mesh(this.bufferGeometry(data, this.diffDisposables), removed)
          mesh.renderOrder = 5
          this.diffGroup.add(mesh)
        }
      }
      if (diff.removedRooms.length > 0) {
        const placedRooms = placeLevel({ ...level, rooms: diff.removedRooms.map((polygon, index) => ({ id: `removed-${index}`, polygon, label: null, areaSqft: 0, confidence: 1 })) }).rooms
        const points: number[] = []
        for (const room of placedRooms) {
          const ring = room.polygon
          for (let i = 0; i < ring.length; i++) {
            const [x0, y0] = ring[i]
            const [x1, y1] = ring[(i + 1) % ring.length]
            points.push(x0 - centerX, node.baseY + 0.08, y0 - centerY, x1 - centerX, node.baseY + 0.08, y1 - centerY)
          }
        }
        const geometry = new three.BufferGeometry()
        geometry.setAttribute("position", new three.Float32BufferAttribute(points, 3))
        this.diffDisposables.push(geometry)
        const lines = new three.LineSegments(geometry, outline)
        lines.computeLineDistances()
        this.diffGroup.add(lines)
      }
    }
    this.dirty = true
  }

  private refreshPins(): void {
    this.pinGroup.clear()
    for (const item of this.pinDisposables) item.dispose()
    this.pinDisposables = []
    if (!this.geometry || this.photo) return
    const three = this.three
    for (const pin of this.pins) {
      const node = this.levels.find((level) => level.levelId === pin.levelId)
      const level = this.model?.levels.find((candidate) => candidate.id === pin.levelId)
      if (!node || !level) continue
      const [placed] = placeLevel({ ...level, objects: [{ id: pin.id, kind: "column", name: "", xFt: pin.xFt, yFt: pin.yFt, widthFt: 0, depthFt: 0, heightFt: 0, elevationFt: 0, rotationDeg: 0, color: "" }] }).objects ?? []
      if (!placed) continue
      const x = placed.xFt - this.geometry.centerX
      const z = placed.yFt - this.geometry.centerY
      const height = Math.min(node.ceilingHeightFt, DOLLHOUSE_CUT_FT) - 0.4
      const tones = { accent: this.theme.accent, warning: this.theme.changed, danger: this.theme.removed, success: this.theme.added }
      const color = new three.Color(tones[pin.tone])
      const stem = new three.BufferGeometry().setFromPoints([new three.Vector3(x, node.baseY, z), new three.Vector3(x, node.baseY + height, z)])
      const stemMaterial = new three.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
      const head = this.chip(pin.glyph, color.getHex(), this.pinDisposables)
      head.scale.set(0.034, 0.034, 1)
      head.position.set(x, node.baseY + height, z)
      head.userData = { pin: pin.id }
      this.pinDisposables.push(stem, stemMaterial)
      this.pinGroup.add(new three.LineSegments(stem, stemMaterial), head)
    }
    this.dirty = true
  }

  private refreshMeasure(): void {
    this.measureGroup.clear()
    for (const item of this.measureDisposables) item.dispose()
    this.measureDisposables = []
    const three = this.three
    const own = this.measureDisposables
    const segment = (a: ThreeTypes.Vector3, b: ThreeTypes.Vector3, faint: boolean) => {
      const geometry = new three.BufferGeometry().setFromPoints([a, b])
      const material = new three.LineBasicMaterial({ color: SURFACE.measure, depthTest: false, transparent: true, opacity: faint ? 0.55 : 1, toneMapped: false })
      own.push(geometry, material)
      const line = new three.Line(geometry, material)
      line.renderOrder = 9
      this.measureGroup.add(line)
    }
    const dot = (point: ThreeTypes.Vector3, kind: SnapPoint["kind"]) => {
      const geometry = new three.SphereGeometry(kind === "face" ? 0.08 : 0.13, 12, 8)
      const material = new three.MeshBasicMaterial({ color: kind === "face" ? SURFACE.measure : this.theme.accent, depthTest: false, toneMapped: false })
      own.push(geometry, material)
      const mesh = new three.Mesh(geometry, material)
      mesh.position.copy(point)
      mesh.renderOrder = 10
      this.measureGroup.add(mesh)
    }
    const label = (a: ThreeTypes.Vector3, b: ThreeTypes.Vector3) => {
      const length = a.distanceTo(b)
      const rise = Math.abs(b.y - a.y)
      const run = Math.hypot(b.x - a.x, b.z - a.z)
      const parts = [formatFeetInches(length)]
      if (rise > 0.1 && run > 0.1) parts.push(`run ${formatFeetInches(run)} · rise ${formatFeetInches(rise)}`)
      const sprite = this.chip(parts.join("   "), SURFACE.measure, own)
      sprite.position.copy(a).add(b).multiplyScalar(0.5)
      this.measureGroup.add(sprite)
    }
    for (const measurement of this.measurements) {
      segment(measurement.a, measurement.b, false)
      dot(measurement.a, "vertex")
      dot(measurement.b, "vertex")
      label(measurement.a, measurement.b)
    }
    const [start] = this.measurePoints
    if (start) dot(start, "vertex")
    if (this.measureHover) {
      dot(this.measureHover.point, this.measureHover.kind)
      if (start) {
        segment(start, this.measureHover.point, true)
        label(start, this.measureHover.point)
      }
    }
    this.dirty = true
  }

  private refreshSection(): void {
    this.sectionGroup.clear()
    for (const item of this.sectionDisposables) item.dispose()
    this.sectionDisposables = []
    this.sectionHandles = []
    const three = this.three
    const box = this.sectionBox
    if (box) {
      const inner = box.clone().expandByScalar(-0.03)
      const helper = new three.Box3Helper(inner, this.theme.accent)
      ;(helper.material as ThreeTypes.LineBasicMaterial).transparent = true
      ;(helper.material as ThreeTypes.LineBasicMaterial).opacity = 0.6
      this.sectionDisposables.push(helper.geometry, helper.material as ThreeTypes.Material)
      this.sectionGroup.add(helper)
      const center = box.getCenter(new three.Vector3())
      const faces: Array<[SectionFace, ThreeTypes.Vector3]> = [
        ["minX", new three.Vector3(box.min.x + 0.3, center.y, center.z)],
        ["maxX", new three.Vector3(box.max.x - 0.3, center.y, center.z)],
        ["minY", new three.Vector3(center.x, box.min.y + 0.3, center.z)],
        ["maxY", new three.Vector3(center.x, box.max.y - 0.3, center.z)],
        ["minZ", new three.Vector3(center.x, center.y, box.min.z + 0.3)],
        ["maxZ", new three.Vector3(center.x, center.y, box.max.z - 0.3)],
      ]
      const geometry = new three.SphereGeometry(0.55, 20, 14)
      const material = new three.MeshBasicMaterial({ color: this.theme.accent, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false })
      this.sectionDisposables.push(geometry, material)
      for (const [face, position] of faces) {
        const mesh = new three.Mesh(geometry, material)
        mesh.position.copy(position)
        mesh.renderOrder = 11
        this.sectionGroup.add(mesh)
        this.sectionHandles.push({ face, mesh })
      }
    }
    const { cutLevel } = this.visibleOrders()
    this.rebuild()
    this.applyClipping(cutLevel)
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  private fitRadius(): number {
    const radius = this.geometry?.radiusFt ?? 30
    const vertical = (this.camera.fov * Math.PI) / 360
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect)
    return clamp((radius * 1.05) / Math.sin(Math.min(vertical, horizontal)), 30, 900)
  }

  private focusBaseY(): number {
    const level = this.geometry?.levels.find((candidate) => candidate.levelId === this.focus)
    return level?.baseY ?? 0
  }

  private walkLevel(): LevelGeometry | null {
    const levels = this.geometry?.levels ?? []
    if (levels.length === 0) return null
    return levels.find((level) => level.levelId === this.focus) ?? [...levels].sort((a, b) => a.order - b.order)[0]
  }

  private enterWalkAt(level: LevelGeometry): void {
    const spawn = level.spawn ?? { x: 0, z: 0 }
    this.walk.x = spawn.x
    this.walk.z = spawn.z
    this.walk.glide = null
    this.dirty = true
  }

  private startBlend(): void {
    this.blend = { k: 0, position: this.camera.position.toArray() as [number, number, number], look: [...this.lastLook] }
  }

  private orbitPose(): { position: [number, number, number]; look: [number, number, number] } {
    const { theta, phi, r, target } = this.current
    const s = Math.sin(phi)
    return { position: [target[0] + r * s * Math.sin(theta), target[1] + r * Math.cos(phi), target[2] + r * s * Math.cos(theta)], look: [...target] }
  }

  private walkPose(): { position: [number, number, number]; look: [number, number, number] } {
    const level = this.walkLevel()
    const y = (level?.baseY ?? 0) + EYE_HEIGHT_FT
    const c = Math.cos(this.walk.pitch)
    return {
      position: [this.walk.x, y, this.walk.z],
      look: [this.walk.x - Math.sin(this.walk.yaw) * c, y + Math.sin(this.walk.pitch), this.walk.z - Math.cos(this.walk.yaw) * c],
    }
  }

  private moveWalk(dx: number, dz: number): void {
    const level = this.walkLevel()
    if (!level) return
    const next = resolveWalkCollision({ x: this.walk.x, z: this.walk.z }, { x: this.walk.x + dx, z: this.walk.z + dz }, level.collision)
    this.walk.x = next.x
    this.walk.z = next.z
  }

  private toScreen(point: ThreeTypes.Vector3): ScreenPoint | null {
    const projected = point.clone().project(this.camera)
    if (projected.z > 1) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    return { x: ((projected.x + 1) / 2) * rect.width, y: ((1 - projected.y) / 2) * rect.height }
  }

  private draw(): void {
    if (this.composer && !this.xr) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
    if (this.measureGroup.children.length === 0 && this.sectionGroup.children.length === 0) return
    // Tools sit on top, outside every cut: a handle on a section face must not be cut by it.
    const planes = this.renderer.clippingPlanes
    const autoClear = this.renderer.autoClear
    this.renderer.clippingPlanes = []
    this.renderer.autoClear = false
    this.renderer.render(this.toolScene, this.camera)
    this.renderer.autoClear = autoClear
    this.renderer.clippingPlanes = planes
  }

  private readonly tick = (time: number) => {
    if (this.disposed) return
    const raw = Math.min(0.25, (time - this.lastTime) / 1000 || 0.016)
    const dt = Math.min(0.05, raw)
    this.lastTime = time
    const k = 1 - Math.exp(-dt * 10)
    let moving = false

    if (this.xr) {
      this.renderer.render(this.scene, this.camera)
      return
    }

    if (this.tour) {
      this.tour.t += raw
      const pose = tourPose(this.tour.samples, this.tour.t)
      if (pose) {
        this.camera.position.set(pose[0], pose[1], pose[2])
        this.camera.lookAt(pose[3], pose[4], pose[5])
        this.lastLook = [pose[3], pose[4], pose[5]]
      }
      if (this.camera.fov !== 50) {
        this.camera.fov = 50
        this.camera.updateProjectionMatrix()
      }
      this.draw()
      this.callbacks.onFrame()
      if (this.tour.t >= tourDurationSec(this.tour.samples)) this.stopTour()
      return
    }

    if (this.mode === "orbit") {
      const c = this.current
      const g = this.goal
      const delta = Math.abs(g.theta - c.theta) + Math.abs(g.phi - c.phi) + Math.abs(g.r - c.r) / 50 + g.target.reduce((sum, v, i) => sum + Math.abs(v - c.target[i]), 0) / 50
      if (delta > 1e-5) {
        c.theta += (g.theta - c.theta) * k
        c.phi += (g.phi - c.phi) * k
        c.r += (g.r - c.r) * k
        c.target = c.target.map((v, i) => v + (g.target[i] - v) * k) as [number, number, number]
        moving = true
      }
    } else {
      const has = (...names: string[]) => names.some((name) => this.keys.has(name))
      const forward = (has("w", "arrowup") ? 1 : 0) - (has("s", "arrowdown") ? 1 : 0)
      const strafe = (has("d", "arrowright") ? 1 : 0) - (has("a", "arrowleft") ? 1 : 0)
      const speed = (has("shift") ? 2 : 1) * WALK_SPEED_FT * dt
      if (forward || strafe) {
        const fx = -Math.sin(this.walk.yaw)
        const fz = -Math.cos(this.walk.yaw)
        const rx = Math.cos(this.walk.yaw)
        const rz = -Math.sin(this.walk.yaw)
        this.moveWalk((fx * forward + rx * strafe) * speed, (fz * forward + rz * strafe) * speed)
        moving = true
      }
      if (this.walk.glide) {
        const dx = this.walk.glide[0] - this.walk.x
        const dz = this.walk.glide[1] - this.walk.z
        const distance = Math.hypot(dx, dz)
        if (distance < 0.15) this.walk.glide = null
        else {
          const step = Math.min(distance, 12 * dt)
          this.moveWalk((dx / distance) * step, (dz / distance) * step)
          moving = true
        }
      }
      const turn = Math.abs(this.walk.goalYaw - this.walk.yaw) + Math.abs(this.walk.goalPitch - this.walk.pitch)
      if (turn > 1e-4) {
        const kk = Math.min(1, k * 1.6)
        this.walk.yaw += (this.walk.goalYaw - this.walk.yaw) * kk
        this.walk.pitch += (this.walk.goalPitch - this.walk.pitch) * kk
        moving = true
      }
    }

    let pose = this.mode === "walk" ? this.walkPose() : this.orbitPose()
    if (this.blend) {
      this.blend.k = Math.min(1, this.blend.k + raw / 0.75)
      const e = ease(this.blend.k)
      const mix = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] - v) * e) as [number, number, number]
      pose = { position: mix(this.blend.position, pose.position), look: mix(this.blend.look, pose.look) }
      if (this.blend.k >= 1) this.blend = null
      moving = true
    }
    this.camera.position.set(...pose.position)
    this.camera.lookAt(...pose.look)
    this.lastLook = pose.look
    const fov = this.mode === "walk" ? 64 : 38
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * k
      this.camera.updateProjectionMatrix()
      moving = true
    }

    if (this.recording) {
      this.recording.clock += raw
      if (this.recording.clock >= TOUR_SAMPLE_SEC) {
        this.recording.clock -= TOUR_SAMPLE_SEC
        const sample: TourSample = [...pose.position, ...pose.look]
        const samples = this.recording.samples
        if (shouldRecord(samples.at(-1), sample, this.recording.still)) {
          samples.push(sample)
          if (samples.length >= MAX_TOUR_POINTS) this.recording.clock = -Infinity
        }
        this.recording.still = moving ? 0 : this.recording.still + 1
      }
    }

    // Finish carpentry drops out past framing distance, where it is sub-pixel.
    const near = this.mode === "walk" || this.current.r < this.fitRadius() * DETAIL_LOD_K
    if (near !== this.detailVisible) {
      this.detailVisible = near
      for (const level of this.levels) if (level.detail) level.detail.visible = near || this.photo !== null
      this.dirty = true
    }

    if (this.pointerMoved && !this.drag) {
      this.pointerMoved = false
      this.hoverPick()
    }

    if (moving && this.photo) this.stopPhoto()
    const photo = this.photo
    if (photo?.tracer) {
      if (photo.samples < PHOTO_SAMPLES) {
        photo.tracer.renderSample()
        photo.samples = photo.tracer.samples
        this.callbacks.onPhoto(Math.min(1, photo.samples / PHOTO_SAMPLES))
        this.callbacks.onFrame()
      }
      return
    }
    if (photo) return

    if (moving || this.dirty) {
      this.dirty = false
      this.draw()
      this.callbacks.onFrame()
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private local(event: { clientX: number; clientY: number }): ScreenPoint {
    const rect = this.renderer.domElement.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private setRay(point: ScreenPoint): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.raycaster.setFromCamera(new this.three.Vector2((point.x / rect.width) * 2 - 1, -(point.y / rect.height) * 2 + 1), this.camera)
  }

  private clipped(point: ThreeTypes.Vector3): boolean {
    return this.renderer.clippingPlanes.some((plane) => plane.distanceToPoint(point) < 0)
  }

  /** Nearest visible surface, ignoring anything sliced off by a cut. */
  private pick(point: ScreenPoint): { pick: ModelPick; point: ThreeTypes.Vector3; mesh: ThreeTypes.Mesh; face: ThreeTypes.Face | null } | null {
    this.setRay(point)
    const meshes: ThreeTypes.Mesh[] = []
    for (const level of this.levels) for (const node of level.surfaces.values()) meshes.push(node.mesh)
    const hits = this.raycaster.intersectObjects(meshes, false)
    for (const hit of hits) {
      if (this.clipped(hit.point)) continue
      const mesh = hit.object as ThreeTypes.Mesh
      const pick = mesh.userData.pick as ModelPick | undefined
      if (pick) return { pick, point: hit.point, mesh, face: hit.face ?? null }
    }
    return null
  }

  private pickPin(point: ScreenPoint): string | null {
    if (this.pinGroup.children.length === 0) return null
    this.setRay(point)
    const hit = this.raycaster.intersectObjects(this.pinGroup.children.filter((child) => (child as ThreeTypes.Sprite).isSprite), false)[0]
    return (hit?.object.userData.pin as string | undefined) ?? null
  }

  private pickHandle(point: ScreenPoint): SectionFace | null {
    if (this.sectionHandles.length === 0) return null
    this.setRay(point)
    const hit = this.raycaster.intersectObjects(this.sectionHandles.map((handle) => handle.mesh), false)[0]
    return this.sectionHandles.find((handle) => handle.mesh === hit?.object)?.face ?? null
  }

  /**
   * Where a measure click lands: the nearest corner of the face under the
   * cursor if one is close on screen, else the nearest edge, else the face.
   */
  private snap(point: ScreenPoint): SnapPoint | null {
    const hit = this.pick(point)
    if (!hit || !hit.face) return null
    const three = this.three
    const position = hit.mesh.geometry.getAttribute("position")
    const corners = [hit.face.a, hit.face.b, hit.face.c].map((index) => new three.Vector3().fromBufferAttribute(position, index).applyMatrix4(hit.mesh.matrixWorld))
    let best: SnapPoint | null = null
    let bestDistance = SNAP_VERTEX_PX
    for (const corner of corners) {
      const screen = this.toScreen(corner)
      const distance = screen ? Math.hypot(screen.x - point.x, screen.y - point.y) : Infinity
      if (distance < bestDistance) {
        bestDistance = distance
        best = { point: corner, kind: "vertex" }
      }
    }
    if (best) return best
    bestDistance = SNAP_EDGE_PX
    for (let i = 0; i < 3; i++) {
      const line = new three.Line3(corners[i], corners[(i + 1) % 3])
      const closest = line.closestPointToPoint(hit.point, true, new three.Vector3())
      const screen = this.toScreen(closest)
      const distance = screen ? Math.hypot(screen.x - point.x, screen.y - point.y) : Infinity
      if (distance < bestDistance) {
        bestDistance = distance
        best = { point: closest, kind: "edge" }
      }
    }
    return best ?? { point: hit.point.clone(), kind: "face" }
  }

  private floorPoint(point: ScreenPoint, y: number): ThreeTypes.Vector3 | null {
    this.setRay(point)
    return this.raycaster.ray.intersectPlane(new this.three.Plane(new this.three.Vector3(0, 1, 0), -y), new this.three.Vector3())
  }

  private hoverPick(): void {
    const point = this.pointer
    if (!point) return
    if (this.placing && this.ghost) {
      const level = this.walkLevel()
      const hit = level ? this.floorPoint(point, level.baseY + 0.1) : null
      if (hit) {
        this.ghost.visible = true
        this.ghost.position.set(Math.round(hit.x * 4) / 4, hit.y + this.placing.heightFt / 2, Math.round(hit.z * 4) / 4)
        this.dirty = true
      }
      return
    }
    if (this.tool === "measure") {
      this.measureHover = this.snap(point)
      this.refreshMeasure()
      this.updateCursor()
      return
    }
    const overHandle = this.pickHandle(point) !== null
    const overPin = !overHandle && this.pickPin(point) !== null
    const hit = overHandle || overPin ? null : this.pick(point)
    const id = hit?.pick.id ?? null
    if (id !== this.hovered) {
      this.hovered = id
      this.refreshOverlays()
    }
    this.callbacks.onHover(hit?.pick ?? null, hit ? point : null)
    this.renderer.domElement.style.cursor = overHandle ? "ns-resize" : overPin ? "pointer" : ""
    if (!overHandle && !overPin) this.updateCursor(hit?.pick.kind)
  }

  private updateCursor(kind?: SurfaceKind): void {
    const element = this.renderer.domElement
    element.style.cursor = this.placing
      ? "copy"
      : this.tool === "measure"
        ? "crosshair"
        : this.mode === "walk"
          ? "crosshair"
          : this.drag?.moved
            ? "grabbing"
            : kind === "object"
              ? "move"
              : kind
                ? "pointer"
                : "grab"
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.renderer.domElement.focus({ preventScroll: true })
    this.renderer.domElement.setPointerCapture(event.pointerId)
    if (this.tour) this.stopTour()
    const point = this.local(event)
    this.pointers.set(event.pointerId, point)
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.drag = { kind: "pinch", startX: 0, startY: 0, lastX: 0, lastY: 0, moved: true, pinch: { distance: Math.hypot(a.x - b.x, a.y - b.y), r: this.goal.r, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 } }
      return
    }
    const base: Drag = { kind: "orbit", startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, moved: false }
    if (this.placing && event.button === 0) {
      this.drag = { ...base, kind: "place" }
      return
    }
    if (event.button === 2 || event.button === 1 || event.shiftKey) {
      this.drag = { ...base, kind: "pan" }
      return
    }
    if (this.mode === "orbit" && event.button === 0) {
      const face = this.pickHandle(point)
      if (face && this.sectionBox) {
        const axis = face.endsWith("X") ? "x" : face.endsWith("Y") ? "y" : "z"
        const bound = face.startsWith("min") ? this.sectionBox.min : this.sectionBox.max
        this.drag = { ...base, kind: "section", section: { face, start: this.axisParameter(point, face) ?? 0, origin: bound[axis] } }
        return
      }
      const hit = this.tool === "select" ? this.pick(point) : null
      if (hit && hit.pick.kind === "object") {
        const level = this.levels.find((candidate) => candidate.levelId === hit.pick.levelId)
        const floor = level ? this.floorPoint(point, level.baseY) : null
        if (level && floor) {
          this.drag = { ...base, kind: "object", object: { levelId: level.levelId, id: hit.pick.id, mesh: hit.mesh, startWorld: [hit.mesh.position.x, hit.mesh.position.z], hitStart: [floor.x, floor.z], baseY: level.baseY } }
          return
        }
      }
    }
    this.drag = base
  }

  /** Where along a section handle's axis the cursor ray passes closest. */
  private axisParameter(point: ScreenPoint, face: SectionFace): number | null {
    const handle = this.sectionHandles.find((candidate) => candidate.face === face)
    if (!handle) return null
    const three = this.three
    const axis = face.endsWith("X") ? new three.Vector3(1, 0, 0) : face.endsWith("Y") ? new three.Vector3(0, 1, 0) : new three.Vector3(0, 0, 1)
    this.setRay(point)
    const ray = this.raycaster.ray
    const w0 = handle.mesh.position.clone().sub(ray.origin)
    const b = axis.dot(ray.direction)
    const denominator = 1 - b * b
    if (denominator < 1e-4) return null
    const d = axis.dot(w0)
    const e = ray.direction.dot(w0)
    return (b * e - d) / denominator
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const point = this.local(event)
    this.pointer = point
    this.pointerMoved = true
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, point)
    const drag = this.drag
    if (!drag) return
    if (drag.kind === "pinch" && drag.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      this.goal.r = clamp((drag.pinch.r * drag.pinch.distance) / Math.max(1, distance), ORBIT_MIN_R, this.fitRadius() * 3)
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      this.panBy(midX - drag.pinch.midX, midY - drag.pinch.midY)
      drag.pinch.midX = midX
      drag.pinch.midY = midY
      this.userZoomed = true
      this.dirty = true
      return
    }
    const dx = point.x - drag.lastX
    const dy = point.y - drag.lastY
    drag.lastX = point.x
    drag.lastY = point.y
    if (!drag.moved && Math.hypot(point.x - drag.startX, point.y - drag.startY) > PICK_SLOP_PX) {
      drag.moved = true
      this.callbacks.onHover(null, null)
      this.updateCursor()
    }
    if (!drag.moved) return
    if (drag.kind === "orbit") {
      if (this.mode === "walk") {
        this.walk.goalYaw -= dx * 0.0042
        this.walk.goalPitch = clamp(this.walk.goalPitch - dy * 0.0042, -1.2, 1.2)
      } else {
        this.goal.theta -= dx * 0.0072
        this.goal.phi = clamp(this.goal.phi - dy * 0.006, 0.02, 1.52)
      }
      this.dirty = true
    } else if (drag.kind === "pan") {
      if (this.mode === "orbit") this.panBy(dx, dy)
    } else if (drag.kind === "section" && drag.section && this.sectionBox) {
      const at = this.axisParameter(point, drag.section.face)
      if (at !== null) {
        const { face, start, origin } = drag.section
        const axis = face.endsWith("X") ? "x" : face.endsWith("Y") ? "y" : "z"
        const box = this.sectionBox
        const value = origin + at - start
        if (face.startsWith("min")) box.min[axis] = Math.min(value, box.max[axis] - 1)
        else box.max[axis] = Math.max(value, box.min[axis] + 1)
        drag.section.start = this.axisParameter(point, face) ?? at
        drag.section.origin = face.startsWith("min") ? box.min[axis] : box.max[axis]
        this.refreshSection()
      }
    } else if (drag.kind === "object" && drag.object) {
      const floor = this.floorPoint(point, drag.object.baseY)
      if (floor) {
        const snap = (value: number) => Math.round(value * 4) / 4
        drag.object.mesh.position.x = snap(floor.x - drag.object.hitStart[0])
        drag.object.mesh.position.z = snap(floor.z - drag.object.hitStart[1])
        const display = this.levels.find((level) => level.levelId === drag.object?.levelId)?.surfaces.get(drag.object.id)?.display
        const home = display?.userData.home as ThreeTypes.Vector3 | undefined
        if (display && home) display.position.set(home.x + drag.object.mesh.position.x, home.y, home.z + drag.object.mesh.position.z)
        this.dirty = true
      }
    }
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId)
    const drag = this.drag
    if (this.pointers.size === 0) this.drag = null
    if (!drag || drag.kind === "pinch") return
    const point = this.local(event)
    if (drag.kind === "object" && drag.object && drag.moved) {
      this.commitObjectMove(drag.object)
    } else if (!drag.moved) {
      this.click(point)
    }
    this.updateCursor()
  }

  private commitObjectMove(object: NonNullable<Drag["object"]>): void {
    if (!this.geometry || !this.model) return
    const level = this.model.levels.find((candidate) => candidate.id === object.levelId)
    const placedLevel = this.placed.find((candidate) => candidate.id === object.levelId)
    const placedObject = placedLevel?.objects?.find((candidate) => candidate.id === object.id)
    if (!level || !placedObject) return
    const worldX = placedObject.xFt - this.geometry.centerX + object.mesh.position.x
    const worldZ = placedObject.yFt - this.geometry.centerY + object.mesh.position.z
    const [xFt, yFt] = worldToLevelPoint(level, this.geometry, worldX, worldZ)
    this.callbacks.onObjectMove({ levelId: object.levelId, objectId: object.id, xFt, yFt })
  }

  private click(point: ScreenPoint): void {
    if (this.placing) {
      const level = this.walkLevel()
      const modelLevel = this.model?.levels.find((candidate) => candidate.id === level?.levelId)
      const hit = level ? this.floorPoint(point, level.baseY + 0.1) : null
      if (!hit || !modelLevel || !this.geometry) return
      const [xFt, yFt] = worldToLevelPoint(modelLevel, this.geometry, Math.round(hit.x * 4) / 4, Math.round(hit.z * 4) / 4)
      this.callbacks.onPlace({ levelId: modelLevel.id, xFt, yFt })
      return
    }
    if (this.tool === "measure") {
      const snapped = this.snap(point)
      if (!snapped) return
      const [start] = this.measurePoints
      if (!start) this.measurePoints = [snapped.point.clone()]
      else {
        const b = snapped.point.clone()
        this.measurements.push({
          id: crypto.randomUUID(),
          a: start,
          b,
          lengthFt: start.distanceTo(b),
          runFt: Math.hypot(b.x - start.x, b.z - start.z),
          riseFt: Math.abs(b.y - start.y),
        })
        this.measurePoints = []
        this.callbacks.onMeasure(this.measurements.map(({ id, lengthFt, runFt, riseFt }) => ({ id, lengthFt, runFt, riseFt })))
      }
      this.refreshMeasure()
      return
    }
    const pin = this.pickPin(point)
    if (pin) {
      this.callbacks.onPinSelect(pin, point)
      return
    }
    const hit = this.pick(point)
    if (this.mode === "walk") {
      if (hit && hit.pick.kind === "room") this.walk.glide = [hit.point.x, hit.point.z]
      return
    }
    this.callbacks.onSelect(hit?.pick ?? null, hit ? point : null)
  }

  private panBy(dx: number, dy: number): void {
    const scale = this.current.r * 0.0016
    const c = Math.cos(this.current.theta)
    const s = Math.sin(this.current.theta)
    this.goal.target = [
      this.goal.target[0] - c * dx * scale - s * dy * scale,
      this.goal.target[1],
      this.goal.target[2] + s * dx * scale - c * dy * scale,
    ]
    this.userZoomed = true
    this.dirty = true
  }

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault()
    if (this.tour) this.stopTour()
    if (this.mode === "walk") {
      this.walk.glide = null
      const step = -event.deltaY * 0.02
      this.moveWalk(-Math.sin(this.walk.yaw) * step, -Math.cos(this.walk.yaw) * step)
      this.dirty = true
      return
    }
    const next = clamp(this.goal.r * Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.0011)), ORBIT_MIN_R, this.fitRadius() * 3)
    const hit = this.pick(this.local(event))
    if (hit && next < this.goal.r) {
      const k = 1 - next / this.goal.r
      this.goal.target = this.goal.target.map((v, i) => v + ([hit.point.x, hit.point.y, hit.point.z][i] - v) * k) as [number, number, number]
    }
    this.goal.r = next
    this.userZoomed = true
    this.dirty = true
  }

  private readonly onDoubleClick = (event: MouseEvent) => {
    if (this.mode === "walk" || this.placing || this.tool === "measure") return
    const hit = this.pick(this.local(event))
    if (!hit) return
    this.goal.target = [hit.point.x, hit.point.y, hit.point.z]
    this.goal.r = Math.max(16, this.goal.r * 0.5)
    this.userZoomed = true
    this.dirty = true
  }

  private readonly onLeave = () => {
    this.pointer = null
    if (this.drag) return
    if (this.hovered) {
      this.hovered = null
      this.refreshOverlays()
    }
    if (this.measureHover) {
      this.measureHover = null
      this.refreshMeasure()
    }
    if (this.ghost) this.ghost.visible = false
    this.callbacks.onHover(null, null)
    this.dirty = true
  }

  private readonly onContextMenu = (event: Event) => event.preventDefault()
  private readonly onBlur = () => this.keys.clear()

  private bindInput(): void {
    const element = this.renderer.domElement
    element.addEventListener("pointerdown", this.onPointerDown)
    element.addEventListener("pointermove", this.onPointerMove)
    element.addEventListener("pointerup", this.onPointerUp)
    element.addEventListener("pointercancel", this.onPointerUp)
    element.addEventListener("pointerleave", this.onLeave)
    element.addEventListener("wheel", this.onWheel, { passive: false })
    element.addEventListener("dblclick", this.onDoubleClick)
    element.addEventListener("contextmenu", this.onContextMenu)
    window.addEventListener("blur", this.onBlur)
  }

  private unbindInput(): void {
    const element = this.renderer.domElement
    element.removeEventListener("pointerdown", this.onPointerDown)
    element.removeEventListener("pointermove", this.onPointerMove)
    element.removeEventListener("pointerup", this.onPointerUp)
    element.removeEventListener("pointercancel", this.onPointerUp)
    element.removeEventListener("pointerleave", this.onLeave)
    element.removeEventListener("wheel", this.onWheel)
    element.removeEventListener("dblclick", this.onDoubleClick)
    element.removeEventListener("contextmenu", this.onContextMenu)
    window.removeEventListener("blur", this.onBlur)
  }
}

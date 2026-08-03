import {
  INK_ADDED_TINT,
  INK_COMMON_TINT,
  INK_LUMA,
  INK_REMOVED_TINT,
  vec3Literal,
} from "./ink-diff"
import type {
  DrawQuad,
  FrameSpec,
  ImageToScreenMatrix,
  SceneRenderer,
  Size,
  TileTexture,
} from "./types"

/**
 * WebGPU backend. One pipeline draws textured tile quads (premultiplied
 * blending); the difference mode rasterizes base and overlay revisions into
 * two offscreen targets with the same projection, then combines them with an
 * ink-diff pass — unchanged linework gray, removed red, added blue. The diff
 * constants are interpolated from ink-diff.ts, the single source of truth
 * shared with webgl2-renderer.ts.
 *
 * Per-draw data (transform, quad rect, opacity) lives in 256-byte slots of a
 * single dynamic-offset uniform buffer, rewritten each frame. Each uploaded
 * tile carries its own texture bind group, created once at upload.
 */

const UNIFORM_SLOT_BYTES = 256
const UNIFORM_PAYLOAD_BYTES = 80 // 3×vec4 matrix columns + rect + misc
const UNIFORM_PAYLOAD_FLOATS = UNIFORM_PAYLOAD_BYTES / 4

const SHARED_WGSL = `
struct DrawUniforms {
  col0: vec4<f32>,
  col1: vec4<f32>,
  col2: vec4<f32>,
  rect: vec4<f32>,
  misc: vec4<f32>, // x: opacity, yz: device viewport, w: unused
}
@group(0) @binding(0) var<uniform> U: DrawUniforms;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0),
  );
  let unit = corners[vi];
  let imagePos = U.rect.xy + unit * U.rect.zw;
  let m = mat3x3<f32>(U.col0.xyz, U.col1.xyz, U.col2.xyz);
  let clip = m * vec3<f32>(imagePos, 1.0);
  var out: VSOut;
  out.pos = vec4<f32>(clip.xy, 0.0, 1.0);
  out.uv = unit;
  return out;
}
`

const TILE_WGSL = `${SHARED_WGSL}
@group(1) @binding(0) var tileTexture: texture_2d<f32>;
@group(1) @binding(1) var tileSampler: sampler;

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // Tiles upload premultiplied; opacity scales the whole vector.
  return textureSample(tileTexture, tileSampler, in.uv) * U.misc.x;
}
`

/** Exported for the shader-sync test only. */
export const DIFF_WGSL = `${SHARED_WGSL}
@group(1) @binding(0) var baseTexture: texture_2d<f32>;
@group(1) @binding(1) var overlayTexture: texture_2d<f32>;
@group(1) @binding(2) var diffSampler: sampler;

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let screenUv = in.pos.xy / U.misc.yz;
  let a = textureSample(baseTexture, diffSampler, screenUv).rgb;
  let b = textureSample(overlayTexture, diffSampler, screenUv).rgb;
  let luma = ${vec3Literal("wgsl", INK_LUMA)};
  let inkBase = 1.0 - dot(a, luma);
  let inkOverlay = 1.0 - dot(b, luma);
  let commonInk = min(inkBase, inkOverlay);
  let removed = clamp(inkBase - commonInk, 0.0, 1.0);
  let added = clamp(inkOverlay - commonInk, 0.0, 1.0);
  let color = vec3<f32>(1.0)
    - commonInk * ${vec3Literal("wgsl", INK_COMMON_TINT)}
    - removed * ${vec3Literal("wgsl", INK_REMOVED_TINT)}
    - added * ${vec3Literal("wgsl", INK_ADDED_TINT)};
  return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`

class GpuTileTexture implements TileTexture {
  constructor(
    readonly texture: GPUTexture,
    readonly bindGroup: GPUBindGroup,
    readonly width: number,
    readonly height: number,
  ) {}
}

function slotData(
  matrix: ImageToScreenMatrix,
  viewport: Size,
  dpr: number,
  rect: { x: number; y: number; width: number; height: number },
  opacity: number,
): number[] {
  // Image px → clip, composed from the CSS-px affine matrix. Identical for
  // screen and offscreen passes so window coordinates stay aligned.
  const sx = 2 / Math.max(1, viewport.width)
  const sy = -2 / Math.max(1, viewport.height)
  return [
    // Column-major mat3 as three padded vec4 columns.
    matrix.a * sx, matrix.b * sy, 0, 0,
    matrix.c * sx, matrix.d * sy, 0, 0,
    matrix.e * sx - 1, matrix.f * sy + 1, 0, 0,
    rect.x, rect.y, rect.width, rect.height,
    opacity, viewport.width * dpr, viewport.height * dpr, 0,
  ]
}

export class WebGPURenderer implements SceneRenderer {
  readonly backend = "webgpu" as const
  onDeviceLost: ((reason: string) => void) | null = null

  private destroyed = false
  private readonly context: GPUCanvasContext
  private readonly format: GPUTextureFormat
  private readonly sampler: GPUSampler
  private readonly uniformLayout: GPUBindGroupLayout
  private readonly tileTextureLayout: GPUBindGroupLayout
  private readonly diffTextureLayout: GPUBindGroupLayout
  private readonly tilePipeline: GPURenderPipeline
  private readonly diffPipeline: GPURenderPipeline
  private uniformBuffer: GPUBuffer
  private uniformBindGroup: GPUBindGroup
  private uniformCapacitySlots: number
  private offscreenBase: GPUTexture | null = null
  private offscreenOverlay: GPUTexture | null = null
  private diffBindGroup: GPUBindGroup | null = null
  private deviceWidth = 0
  private deviceHeight = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
    context: GPUCanvasContext,
  ) {
    this.context = context
    this.format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format: this.format, alphaMode: "premultiplied" })

    // Validation failures are async and otherwise silent — make them loud.
    device.addEventListener("uncapturederror", this.handleUncapturedError)

    // A resolved `lost` promise with any reason but "destroyed" means the
    // device died under us (driver reset, GPU process crash) and every
    // resource on it is gone.
    void device.lost.then((info) => {
      if (this.destroyed || info.reason === "destroyed") return
      this.onDeviceLost?.(info.message)
    })

    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })

    this.uniformLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: UNIFORM_PAYLOAD_BYTES,
          },
        },
      ],
    })
    this.tileTextureLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    this.diffTextureLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })

    const premultipliedBlend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    }
    const tileModule = device.createShaderModule({ code: TILE_WGSL })
    this.tilePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.uniformLayout, this.tileTextureLayout],
      }),
      vertex: { module: tileModule, entryPoint: "vs" },
      fragment: {
        module: tileModule,
        entryPoint: "fs",
        targets: [{ format: this.format, blend: premultipliedBlend }],
      },
      primitive: { topology: "triangle-strip" },
    })
    const diffModule = device.createShaderModule({ code: DIFF_WGSL })
    this.diffPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.uniformLayout, this.diffTextureLayout],
      }),
      vertex: { module: diffModule, entryPoint: "vs" },
      fragment: {
        module: diffModule,
        entryPoint: "fs",
        targets: [{ format: this.format, blend: premultipliedBlend }],
      },
      primitive: { topology: "triangle-strip" },
    })

    this.uniformCapacitySlots = 256
    this.uniformBuffer = this.createUniformBuffer(this.uniformCapacitySlots)
    this.uniformBindGroup = this.createUniformBindGroup()
  }

  private readonly handleUncapturedError = (event: GPUUncapturedErrorEvent): void => {
    console.error("[WebGPURenderer] Uncaptured GPU error:", event.error.message)
  }

  private createUniformBuffer(slots: number): GPUBuffer {
    return this.device.createBuffer({
      size: slots * UNIFORM_SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  private createUniformBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.uniformLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer, size: UNIFORM_PAYLOAD_BYTES },
        },
      ],
    })
  }

  uploadTile(bitmap: ImageBitmap): TileTexture {
    const texture = this.device.createTexture({
      size: { width: bitmap.width, height: bitmap.height },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture, premultipliedAlpha: true },
      { width: bitmap.width, height: bitmap.height },
    )
    const bindGroup = this.device.createBindGroup({
      layout: this.tileTextureLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
      ],
    })
    return new GpuTileTexture(texture, bindGroup, bitmap.width, bitmap.height)
  }

  destroyTile(texture: TileTexture): void {
    if (texture instanceof GpuTileTexture) texture.texture.destroy()
  }

  resize(viewport: Size, dpr: number): void {
    const width = Math.max(1, Math.round(viewport.width * dpr))
    const height = Math.max(1, Math.round(viewport.height * dpr))
    if (width === this.deviceWidth && height === this.deviceHeight) return
    this.deviceWidth = width
    this.deviceHeight = height
    this.canvas.width = width
    this.canvas.height = height
    this.disposeOffscreen()
  }

  render(frame: FrameSpec): void {
    if (this.deviceWidth === 0) this.resize(frame.viewport, frame.dpr)
    const difference = frame.mode === "difference" && frame.overlay.length > 0

    // Slot 0..n-1: base quads; then overlay quads; last slot: diff combine.
    const drawCount = frame.base.length + frame.overlay.length + (difference ? 1 : 0)
    if (drawCount === 0) {
      this.clearScreen()
      return
    }
    this.ensureUniformCapacity(drawCount)
    const data = new Float32Array(drawCount * (UNIFORM_SLOT_BYTES / 4))
    let slot = 0
    const writeSlot = (
      rect: { x: number; y: number; width: number; height: number },
      opacity: number,
    ): number => {
      data.set(
        slotData(frame.matrix, frame.viewport, frame.dpr, rect, opacity).slice(
          0,
          UNIFORM_PAYLOAD_FLOATS,
        ),
        slot * (UNIFORM_SLOT_BYTES / 4),
      )
      return slot++
    }
    const baseSlots = frame.base.map((q) => writeSlot(q.rect, 1))
    const overlaySlots = frame.overlay.map((q) =>
      writeSlot(q.rect, difference ? 1 : frame.overlayOpacity),
    )
    const diffSlot = difference ? writeSlot(frame.imageRect, 1) : -1
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)

    const encoder = this.device.createCommandEncoder()
    if (difference) {
      const base = this.ensureOffscreen("base")
      const overlay = this.ensureOffscreen("overlay")
      this.encodeQuadPass(encoder, base.createView(), { r: 1, g: 1, b: 1, a: 1 }, frame.base, baseSlots)
      this.encodeQuadPass(encoder, overlay.createView(), { r: 1, g: 1, b: 1, a: 1 }, frame.overlay, overlaySlots)

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      })
      pass.setPipeline(this.diffPipeline)
      pass.setBindGroup(0, this.uniformBindGroup, [diffSlot * UNIFORM_SLOT_BYTES])
      pass.setBindGroup(1, this.ensureDiffBindGroup())
      pass.draw(4)
      pass.end()
    } else {
      this.encodeQuadPass(
        encoder,
        this.context.getCurrentTexture().createView(),
        { r: 0, g: 0, b: 0, a: 0 },
        [...frame.base, ...frame.overlay],
        [...baseSlots, ...overlaySlots],
      )
    }
    this.device.queue.submit([encoder.finish()])
  }

  private clearScreen(): void {
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    })
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  private encodeQuadPass(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    clearValue: GPUColor,
    quads: DrawQuad[],
    slots: number[],
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue, loadOp: "clear", storeOp: "store" }],
    })
    pass.setPipeline(this.tilePipeline)
    quads.forEach((quad, i) => {
      if (!(quad.texture instanceof GpuTileTexture)) return
      pass.setBindGroup(0, this.uniformBindGroup, [slots[i] * UNIFORM_SLOT_BYTES])
      pass.setBindGroup(1, quad.texture.bindGroup)
      pass.draw(4)
    })
    pass.end()
  }

  private ensureUniformCapacity(slots: number): void {
    if (slots <= this.uniformCapacitySlots) return
    this.uniformBuffer.destroy()
    this.uniformCapacitySlots = Math.ceil(slots / 256) * 256
    this.uniformBuffer = this.createUniformBuffer(this.uniformCapacitySlots)
    this.uniformBindGroup = this.createUniformBindGroup()
  }

  private ensureOffscreen(which: "base" | "overlay"): GPUTexture {
    const existing = which === "base" ? this.offscreenBase : this.offscreenOverlay
    if (existing) return existing
    const texture = this.device.createTexture({
      size: { width: this.deviceWidth, height: this.deviceHeight },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    if (which === "base") this.offscreenBase = texture
    else this.offscreenOverlay = texture
    this.diffBindGroup = null
    return texture
  }

  private ensureDiffBindGroup(): GPUBindGroup {
    if (this.diffBindGroup) return this.diffBindGroup
    const base = this.ensureOffscreen("base")
    const overlay = this.ensureOffscreen("overlay")
    this.diffBindGroup = this.device.createBindGroup({
      layout: this.diffTextureLayout,
      entries: [
        { binding: 0, resource: base.createView() },
        { binding: 1, resource: overlay.createView() },
        { binding: 2, resource: this.sampler },
      ],
    })
    return this.diffBindGroup
  }

  private disposeOffscreen(): void {
    this.offscreenBase?.destroy()
    this.offscreenOverlay?.destroy()
    this.offscreenBase = null
    this.offscreenOverlay = null
    this.diffBindGroup = null
  }

  destroy(): void {
    this.destroyed = true
    this.disposeOffscreen()
    this.uniformBuffer.destroy()
    this.device.removeEventListener("uncapturederror", this.handleUncapturedError)
    this.context.unconfigure()
    // Frees every remaining device resource (tile textures included) and
    // resolves `lost` with reason "destroyed", which the handler ignores.
    this.device.destroy()
  }
}

/**
 * Acquire the best available backend for a canvas: WebGPU when the browser
 * grants a device, WebGL2 otherwise (older iPad Safari). The WebGPU context
 * is only claimed after a device exists, so a fallback canvas is still free
 * to become a WebGL2 canvas.
 */
export async function createSceneRenderer(
  canvas: HTMLCanvasElement,
): Promise<SceneRenderer> {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      const device = await adapter?.requestDevice()
      if (device) {
        const context = canvas.getContext("webgpu")
        if (context) return new WebGPURenderer(canvas, device, context)
      }
    } catch (error) {
      console.warn("[viewer] WebGPU unavailable, falling back to WebGL2:", error)
    }
  }
  const { WebGL2Renderer } = await import("./webgl2-renderer")
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
  })
  if (!gl) throw new Error("Neither WebGPU nor WebGL2 is available in this browser")
  return new WebGL2Renderer(canvas, gl)
}

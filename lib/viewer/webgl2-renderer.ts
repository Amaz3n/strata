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
 * WebGL2 backend — the fallback path, and the primary one on browsers without
 * WebGPU (older iPad Safari being the field reality). Mirrors the WebGPU
 * renderer's frame contract exactly; the difference-shader constants are
 * interpolated from ink-diff.ts, the single source of truth shared with
 * webgpu-renderer.ts.
 *
 * Blending is premultiplied-alpha throughout (the canvas is configured to
 * match), so an overlay at opacity o outputs rgb·o / a·o with ONE,
 * ONE_MINUS_SRC_ALPHA.
 */

const QUAD_VERT = `#version 300 es
layout(location = 0) in vec2 aUnit;
uniform vec4 uRect;      // image px: x, y, w, h
uniform mat3 uImageToClip;
out vec2 vUv;
void main() {
  vec2 imagePos = uRect.xy + aUnit * uRect.zw;
  vec3 clip = uImageToClip * vec3(imagePos, 1.0);
  vUv = aUnit;
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`

const TILE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uTexture;
uniform float uOpacity;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 c = texture(uTexture, vUv);
  outColor = vec4(c.rgb * c.a, c.a) * uOpacity;
}`

// Ink difference: treat darkness as ink, split it into common / removed /
// added, and recolor — unchanged gray, removed (base only) red, added
// (overlay only) blue. Sampling by window coordinate keeps the two offscreen
// rasters texel-aligned with the composite pass.
/** Exported for the shader-sync test only. */
export const DIFF_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uTexBase;
uniform sampler2D uTexOverlay;
uniform vec2 uViewportDevice;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 screenUv = gl_FragCoord.xy / uViewportDevice;
  vec3 a = texture(uTexBase, screenUv).rgb;
  vec3 b = texture(uTexOverlay, screenUv).rgb;
  vec3 luma = ${vec3Literal("glsl", INK_LUMA)};
  float inkBase = 1.0 - dot(a, luma);
  float inkOverlay = 1.0 - dot(b, luma);
  float commonInk = min(inkBase, inkOverlay);
  float removed = clamp(inkBase - commonInk, 0.0, 1.0);
  float added = clamp(inkOverlay - commonInk, 0.0, 1.0);
  vec3 color = vec3(1.0)
    - commonInk * ${vec3Literal("glsl", INK_COMMON_TINT)}
    - removed * ${vec3Literal("glsl", INK_REMOVED_TINT)}
    - added * ${vec3Literal("glsl", INK_ADDED_TINT)};
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`

class GLTileTexture implements TileTexture {
  constructor(
    readonly texture: WebGLTexture,
    readonly width: number,
    readonly height: number,
  ) {}
}

interface OffscreenTarget {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error("WebGL2: createShader failed")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`WebGL2 shader compile failed: ${log ?? "unknown"}`)
  }
  return shader
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error("WebGL2: createProgram failed")
  const vs = compile(gl, gl.VERTEX_SHADER, vert)
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`WebGL2 program link failed: ${log ?? "unknown"}`)
  }
  return program
}

/**
 * Column-major mat3 mapping image px → clip space, composed from the CSS-px
 * affine matrix and the viewport (identical between screen and offscreen
 * passes, so window coordinates line up).
 */
function imageToClip(matrix: ImageToScreenMatrix, viewport: Size): Float32Array {
  const sx = 2 / Math.max(1, viewport.width)
  const sy = -2 / Math.max(1, viewport.height)
  return new Float32Array([
    matrix.a * sx,
    matrix.b * sy,
    0,
    matrix.c * sx,
    matrix.d * sy,
    0,
    matrix.e * sx - 1,
    matrix.f * sy + 1,
    0,
  ])
}

export class WebGL2Renderer implements SceneRenderer {
  readonly backend = "webgl2" as const
  onDeviceLost: ((reason: string) => void) | null = null

  private contextLost = false
  private readonly gl: WebGL2RenderingContext
  private readonly tileProgram: WebGLProgram
  private readonly diffProgram: WebGLProgram
  private readonly quadVao: WebGLVertexArrayObject
  private readonly quadVbo: WebGLBuffer
  private readonly tileUniforms: {
    rect: WebGLUniformLocation | null
    matrix: WebGLUniformLocation | null
    texture: WebGLUniformLocation | null
    opacity: WebGLUniformLocation | null
  }
  private readonly diffUniforms: {
    rect: WebGLUniformLocation | null
    matrix: WebGLUniformLocation | null
    texBase: WebGLUniformLocation | null
    texOverlay: WebGLUniformLocation | null
    viewportDevice: WebGLUniformLocation | null
  }
  private offscreenBase: OffscreenTarget | null = null
  private offscreenOverlay: OffscreenTarget | null = null
  private deviceWidth = 0
  private deviceHeight = 0

  constructor(private readonly canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl
    this.tileProgram = link(gl, QUAD_VERT, TILE_FRAG)
    this.diffProgram = link(gl, QUAD_VERT, DIFF_FRAG)
    this.tileUniforms = {
      rect: gl.getUniformLocation(this.tileProgram, "uRect"),
      matrix: gl.getUniformLocation(this.tileProgram, "uImageToClip"),
      texture: gl.getUniformLocation(this.tileProgram, "uTexture"),
      opacity: gl.getUniformLocation(this.tileProgram, "uOpacity"),
    }
    this.diffUniforms = {
      rect: gl.getUniformLocation(this.diffProgram, "uRect"),
      matrix: gl.getUniformLocation(this.diffProgram, "uImageToClip"),
      texBase: gl.getUniformLocation(this.diffProgram, "uTexBase"),
      texOverlay: gl.getUniformLocation(this.diffProgram, "uTexOverlay"),
      viewportDevice: gl.getUniformLocation(this.diffProgram, "uViewportDevice"),
    }

    const vao = gl.createVertexArray()
    if (!vao) throw new Error("WebGL2: createVertexArray failed")
    this.quadVao = vao
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error("WebGL2: createBuffer failed")
    this.quadVbo = buffer
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

    canvas.addEventListener("webglcontextlost", this.handleContextLost)
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored)
  }

  private readonly handleContextLost = (event: Event): void => {
    // preventDefault tells the browser we manage recovery, which also allows
    // it to restore the context later. Every GL resource is gone either way —
    // the owner (gpu-viewer.ts) tears this renderer down and re-negotiates.
    event.preventDefault()
    this.contextLost = true
    this.onDeviceLost?.("webgl2 context lost")
  }

  private readonly handleContextRestored = (): void => {
    // The owner rebuilds by replacing this renderer; clearing the flag only
    // stops render() from touching a lost context in the teardown gap.
    this.contextLost = false
  }

  uploadTile(bitmap: ImageBitmap): TileTexture {
    const gl = this.gl
    const texture = gl.createTexture()
    if (!texture) throw new Error("WebGL2: createTexture failed")
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    return new GLTileTexture(texture, bitmap.width, bitmap.height)
  }

  destroyTile(texture: TileTexture): void {
    if (texture instanceof GLTileTexture) this.gl.deleteTexture(texture.texture)
  }

  resize(viewport: Size, dpr: number): void {
    const width = Math.max(1, Math.round(viewport.width * dpr))
    const height = Math.max(1, Math.round(viewport.height * dpr))
    if (width === this.deviceWidth && height === this.deviceHeight) return
    this.deviceWidth = width
    this.deviceHeight = height
    this.canvas.width = width
    this.canvas.height = height
    // Offscreen targets track the drawing buffer size; rebuild lazily.
    this.disposeOffscreen()
  }

  render(frame: FrameSpec): void {
    if (this.contextLost) return
    const gl = this.gl
    if (this.deviceWidth === 0) this.resize(frame.viewport, frame.dpr)
    const clipMatrix = imageToClip(frame.matrix, frame.viewport)

    if (frame.mode === "difference" && frame.overlay.length > 0) {
      this.renderDifference(frame, clipMatrix)
      return
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.deviceWidth, this.deviceHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.drawQuads(frame.base, clipMatrix, 1)
    if (frame.overlay.length > 0) {
      this.drawQuads(frame.overlay, clipMatrix, frame.overlayOpacity)
    }
  }

  private renderDifference(frame: FrameSpec, clipMatrix: Float32Array): void {
    const gl = this.gl
    const base = this.ensureOffscreen("base")
    const overlay = this.ensureOffscreen("overlay")

    // Pass 1 + 2: rasterize each revision onto white "paper".
    for (const [target, quads] of [
      [base, frame.base],
      [overlay, frame.overlay],
    ] satisfies Array<[OffscreenTarget, DrawQuad[]]>) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
      gl.viewport(0, 0, this.deviceWidth, this.deviceHeight)
      gl.clearColor(1, 1, 1, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.drawQuads(quads, clipMatrix, 1)
    }

    // Pass 3: combine over the sheet quad only; outside stays transparent.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.deviceWidth, this.deviceHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.diffProgram)
    gl.bindVertexArray(this.quadVao)
    gl.uniformMatrix3fv(this.diffUniforms.matrix, false, clipMatrix)
    gl.uniform4f(
      this.diffUniforms.rect,
      frame.imageRect.x,
      frame.imageRect.y,
      frame.imageRect.width,
      frame.imageRect.height,
    )
    gl.uniform2f(this.diffUniforms.viewportDevice, this.deviceWidth, this.deviceHeight)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, base.texture)
    gl.uniform1i(this.diffUniforms.texBase, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, overlay.texture)
    gl.uniform1i(this.diffUniforms.texOverlay, 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  private drawQuads(quads: DrawQuad[], clipMatrix: Float32Array, opacity: number): void {
    if (quads.length === 0) return
    const gl = this.gl
    gl.useProgram(this.tileProgram)
    gl.bindVertexArray(this.quadVao)
    gl.uniformMatrix3fv(this.tileUniforms.matrix, false, clipMatrix)
    gl.uniform1f(this.tileUniforms.opacity, opacity)
    gl.uniform1i(this.tileUniforms.texture, 0)
    gl.activeTexture(gl.TEXTURE0)
    for (const quad of quads) {
      if (!(quad.texture instanceof GLTileTexture)) continue
      gl.bindTexture(gl.TEXTURE_2D, quad.texture.texture)
      gl.uniform4f(
        this.tileUniforms.rect,
        quad.rect.x,
        quad.rect.y,
        quad.rect.width,
        quad.rect.height,
      )
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.bindVertexArray(null)
  }

  private ensureOffscreen(which: "base" | "overlay"): OffscreenTarget {
    const existing = which === "base" ? this.offscreenBase : this.offscreenOverlay
    if (existing) return existing
    const gl = this.gl
    const texture = gl.createTexture()
    const framebuffer = gl.createFramebuffer()
    if (!texture || !framebuffer) throw new Error("WebGL2: offscreen target alloc failed")
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.deviceWidth,
      this.deviceHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    )
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const target = { framebuffer, texture }
    if (which === "base") this.offscreenBase = target
    else this.offscreenOverlay = target
    return target
  }

  private disposeOffscreen(): void {
    for (const target of [this.offscreenBase, this.offscreenOverlay]) {
      if (!target) continue
      this.gl.deleteFramebuffer(target.framebuffer)
      this.gl.deleteTexture(target.texture)
    }
    this.offscreenBase = null
    this.offscreenOverlay = null
  }

  destroy(): void {
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost)
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored)
    this.disposeOffscreen()
    this.gl.deleteProgram(this.tileProgram)
    this.gl.deleteProgram(this.diffProgram)
    this.gl.deleteVertexArray(this.quadVao)
    this.gl.deleteBuffer(this.quadVbo)
    // Release the context itself; without this the GPU keeps it alive until
    // the canvas is garbage-collected.
    this.gl.getExtension("WEBGL_lose_context")?.loseContext()
  }
}

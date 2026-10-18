/**
 * Everything the 3D scene needs from three.js, loaded together and only when
 * a model is first opened. The path tracer is heavier and loads on its own the
 * first time someone renders a photo.
 */

import type * as BVH from "three-mesh-bvh"

export interface ModelRuntime {
  three: typeof import("three")
  post: {
    EffectComposer: typeof import("three/examples/jsm/postprocessing/EffectComposer.js").EffectComposer
    RenderPass: typeof import("three/examples/jsm/postprocessing/RenderPass.js").RenderPass
    GTAOPass: typeof import("three/examples/jsm/postprocessing/GTAOPass.js").GTAOPass
    OutlinePass: typeof import("three/examples/jsm/postprocessing/OutlinePass.js").OutlinePass
    UnrealBloomPass: typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass
    SMAAPass: typeof import("three/examples/jsm/postprocessing/SMAAPass.js").SMAAPass
    OutputPass: typeof import("three/examples/jsm/postprocessing/OutputPass.js").OutputPass
  }
}

let patched = false

/** Picking runs against a bounding-volume tree instead of every triangle. */
function installBvh(three: ModelRuntime["three"], bvh: typeof BVH): void {
  if (patched) return
  patched = true
  three.BufferGeometry.prototype.computeBoundsTree = bvh.computeBoundsTree
  three.BufferGeometry.prototype.disposeBoundsTree = bvh.disposeBoundsTree
  three.Mesh.prototype.raycast = bvh.acceleratedRaycast
}

export async function loadModelRuntime(): Promise<ModelRuntime> {
  const [three, composer, render, gtao, outline, bloom, smaa, output, bvh] = await Promise.all([
    import("three"),
    import("three/examples/jsm/postprocessing/EffectComposer.js"),
    import("three/examples/jsm/postprocessing/RenderPass.js"),
    import("three/examples/jsm/postprocessing/GTAOPass.js"),
    import("three/examples/jsm/postprocessing/OutlinePass.js"),
    import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
    import("three/examples/jsm/postprocessing/SMAAPass.js"),
    import("three/examples/jsm/postprocessing/OutputPass.js"),
    import("three-mesh-bvh"),
  ])
  installBvh(three, bvh)
  return {
    three,
    post: {
      EffectComposer: composer.EffectComposer,
      RenderPass: render.RenderPass,
      GTAOPass: gtao.GTAOPass,
      OutlinePass: outline.OutlinePass,
      UnrealBloomPass: bloom.UnrealBloomPass,
      SMAAPass: smaa.SMAAPass,
      OutputPass: output.OutputPass,
    },
  }
}

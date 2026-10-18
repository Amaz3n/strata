/**
 * Real furniture for the scene: loads each catalogue model once, then hands
 * out clones that share its geometry, materials and textures — twelve dining
 * chairs are one set of GPU buffers.
 *
 * A clone comes back normalised to the object's box: centred on its footprint,
 * standing on y = 0, turned so its back faces local +z, and scaled so it fills
 * exactly the width × depth × height the object says. The caller only places
 * and rotates it.
 */

import type * as ThreeTypes from "three"
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"

import { furnitureModelUrl, type FurnitureModel } from "@/lib/drawings/furniture-catalog"

type Three = typeof import("three")

interface Template {
  scene: ThreeTypes.Group
  /** Offset that centres the rotated model on its footprint with its base at 0. */
  offset: ThreeTypes.Vector3
  size: ThreeTypes.Vector3
  yaw: number
}

export class FurnitureLibrary {
  private readonly three: Three
  private readonly onLoaded: () => void
  private loader: Promise<GLTFLoader> | null = null
  private readonly templates = new Map<string, Template>()
  private readonly pending = new Set<string>()
  private readonly failed = new Set<string>()
  private disposed = false

  constructor(three: Three, onLoaded: () => void) {
    this.three = three
    this.onLoaded = onLoaded
  }

  /** A ready-to-place clone, or null while it loads (the caller draws its box meanwhile). */
  instance(model: FurnitureModel, target: { widthFt: number; depthFt: number; heightFt: number }): ThreeTypes.Group | null {
    const template = this.templates.get(model.id)
    if (!template) {
      this.load(model)
      return null
    }
    const three = this.three
    const inner = template.scene.clone(true)
    inner.rotation.y = template.yaw
    inner.position.copy(template.offset)
    const holder = new three.Group()
    holder.add(inner)
    holder.scale.set(target.widthFt / template.size.x, target.heightFt / template.size.y, target.depthFt / template.size.z)
    return holder
  }

  /** Every model this library loaded is fetched from the catalogue, never from model data. */
  private load(model: FurnitureModel): void {
    if (this.pending.has(model.id) || this.failed.has(model.id)) return
    this.pending.add(model.id)
    this.loader ??= import("three/examples/jsm/loaders/GLTFLoader.js").then(({ GLTFLoader }) => new GLTFLoader())
    this.loader
      .then((loader) => loader.loadAsync(furnitureModelUrl(model)))
      .then((gltf) => {
        if (this.disposed) return
        const three = this.three
        const scene = gltf.scene
        scene.traverse((child) => {
          const mesh = child as ThreeTypes.Mesh
          if (!mesh.isMesh) return
          mesh.castShadow = true
          mesh.receiveShadow = true
        })
        const yaw = Math.PI + ((model.yawOffsetDeg ?? 0) * Math.PI) / 180
        const probe = new three.Group()
        const turned = scene.clone(true)
        turned.rotation.y = yaw
        probe.add(turned)
        const box = new three.Box3().setFromObject(probe)
        const size = box.getSize(new three.Vector3())
        const center = box.getCenter(new three.Vector3())
        this.templates.set(model.id, {
          scene,
          yaw,
          size: new three.Vector3(Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3)),
          offset: new three.Vector3(-center.x, -box.min.y, -center.z),
        })
        this.pending.delete(model.id)
        this.onLoaded()
      })
      .catch(() => {
        // A model that cannot load keeps its procedural box; nothing else depends on it.
        this.pending.delete(model.id)
        this.failed.add(model.id)
      })
  }

  /** Frees every loaded model's buffers, materials and textures. */
  dispose(): void {
    this.disposed = true
    for (const template of this.templates.values()) {
      template.scene.traverse((child) => {
        const mesh = child as ThreeTypes.Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of materials) {
          for (const value of Object.values(material)) {
            if (value && typeof value === "object" && "isTexture" in value) (value as ThreeTypes.Texture).dispose()
          }
          material.dispose()
        }
      })
    }
    this.templates.clear()
  }
}

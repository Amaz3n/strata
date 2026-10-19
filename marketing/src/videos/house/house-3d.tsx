import { useFrame, useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { cancelRender, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { track, type Key } from "../../kit/motion";
import { BLOCKS, CATALOG, FURNITURE, HOUSE, ROOMS, WALLS, EXTERIOR_T, INTERIOR_T, wallPieces, type Block, type Wall } from "./plan";
import { BLUEPRINT_MARGIN, blueprintTexture, oakTexture, siteFade, tileTexture } from "./textures";

// Arc's model palette (components/plans/model-viewer/model-scene.ts SURFACE).
const SURFACE = {
  wall: 0xf3f1ec,
  wallExterior: 0xe4e0d8,
  glass: 0xa8c4d6,
  slab: 0xd6d3cc,
  poche: 0x45484f,
  sunHigh: 0xfff4e6,
  sunLow: 0xffc68a,
};

// Plan feet → scene: the house is centred on the origin, plan y runs along +z.
const X = (x: number) => x - HOUSE.width / 2;
const Z = (y: number) => y - HOUSE.depth / 2;

// ---------------------------------------------------------------- furniture

type Template = { scene: THREE.Group };
let furniturePromise: Promise<Map<string, Template>> | null = null;

function loadFurniture() {
  if (furniturePromise) return furniturePromise;
  const loader = new GLTFLoader();
  const ids = [...new Set(FURNITURE.map((f) => f.id))];
  furniturePromise = Promise.all(
    ids.map(async (id) => {
      const gltf = await loader.loadAsync(staticFile(`models/furniture/${id}/${id}.gltf`));
      const scene = gltf.scene;
      const size = CATALOG[id];
      // Normalise to the catalogue box: centred on its footprint, base on 0,
      // scaled to its real size in feet.
      const box = new THREE.Box3().setFromObject(scene);
      const dims = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const inner = new THREE.Group();
      inner.add(scene);
      scene.position.set(-centre.x, -box.min.y, -centre.z);
      const outer = new THREE.Group();
      outer.add(inner);
      inner.scale.set(size.w / dims.x, size.h / dims.y, size.d / dims.z);
      outer.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return [id, { scene: outer }] as const;
    }),
  ).then((entries) => new Map(entries));
  return furniturePromise;
}

// The canvas only draws when the frame changes, so a model that arrives later
// has to draw the frame itself before Remotion may take the picture.
function useFurniture() {
  const [map, setMap] = useState<Map<string, Template> | null>(null);
  const [handle] = useState(() => delayRender("Loading furniture"));
  const { advance } = useThree();
  useLayoutEffect(() => {
    loadFurniture()
      .then(setMap)
      .catch((error: unknown) => cancelRender(error));
  }, []);
  useLayoutEffect(() => {
    if (!map) return;
    advance(performance.now());
    continueRender(handle);
  }, [map, advance, handle]);
  return map;
}

// ---------------------------------------------------------------- materials

function useMaterials() {
  return useMemo(() => {
    const flat = (color: number, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness });
    const wall = flat(SURFACE.wall);
    const exterior = flat(SURFACE.wallExterior);
    const poche = flat(SURFACE.poche, 0.9);
    const glass = new THREE.MeshPhysicalMaterial({ color: SURFACE.glass, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0, envMapIntensity: 1.4, depthWrite: false });
    const finish = (kind: "oak" | "tile", w: number, h: number) => {
      const map = (kind === "oak" ? oakTexture() : tileTexture()).clone();
      map.needsUpdate = true;
      map.repeat.set(w / 8, h / 8);
      return new THREE.MeshStandardMaterial({ map, roughness: kind === "oak" ? 0.62 : 0.55, transparent: true });
    };
    return {
      wall,
      exterior,
      poche,
      glass,
      finish,
      slab: flat(SURFACE.slab, 0.95),
      linen: flat(0xf4f1ea, 0.95),
      duvet: flat(0xd9d2c4, 0.95),
      wood: flat(0x9b7653, 0.6),
      counter: flat(0xf6f5f2, 0.3),
      cabinet: flat(0x5b6470, 0.55),
      porcelain: flat(0xfbfbfa, 0.15),
      appliance: flat(0xe9eaec, 0.35),
      rug: flat(0xcfc6b6, 1),
    };
  }, []);
}

type Materials = ReturnType<typeof useMaterials>;

// ---------------------------------------------------------------- the house

function WallMesh({ wall, rise, m }: { wall: Wall; rise: number; m: Materials }) {
  const t = wall.exterior ? EXTERIOR_T : INTERIOR_T;
  const horizontal = wall.y1 === wall.y2;
  const start = horizontal ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2);
  const len = horizontal ? Math.abs(wall.x2 - wall.x1) : Math.abs(wall.y2 - wall.y1);
  // Six faces: +x, -x, +y (the cut top: Arc's dark poche), -y, +z, -z.
  const side = wall.exterior ? m.exterior : m.wall;
  const faces = useMemo(() => [side, side, m.poche, side, side, side], [side, m.poche]);
  if (rise <= 0.001) return null;
  return (
    <group scale={[1, rise, 1]}>
      {wallPieces(wall).map((p, i) => {
        // Exterior runs reach past their corners so the corners close.
        const a = p.a === 0 && wall.exterior ? -t / 2 : p.a;
        const b = p.b === len && wall.exterior ? len + t / 2 : p.b;
        const runLen = b - a;
        const mid = start + (a + b) / 2;
        const h = p.z1 - p.z0;
        const pos: [number, number, number] = horizontal ? [X(mid), p.z0 + h / 2, Z(wall.y1)] : [X(wall.x1), p.z0 + h / 2, Z(mid)];
        const size: [number, number, number] = horizontal ? [runLen, h, p.glass ? 0.08 : t] : [p.glass ? 0.08 : t, h, runLen];
        return (
          <mesh key={i} position={pos} castShadow={!p.glass} receiveShadow material={p.glass ? m.glass : faces}>
            <boxGeometry args={size} />
          </mesh>
        );
      })}
    </group>
  );
}

function BlockMesh({ block, m }: { block: Block; m: Materials }) {
  const cx = X(block.x + block.w / 2);
  const cz = Z(block.y + block.d / 2);
  const box = (w: number, h: number, d: number, y: number, mat: THREE.Material, dx = 0, dz = 0) => (
    <mesh position={[cx + dx, y + h / 2, cz + dz]} material={mat} castShadow receiveShadow>
      <boxGeometry args={[w, h, d]} />
    </mesh>
  );
  switch (block.kind) {
    case "bed": {
      // Headboard against the wall at the block's low-x edge.
      return (
        <group>
          {box(block.w, 1.1, block.d, 0, m.wood)}
          {box(block.w - 0.3, 0.75, block.d - 0.3, 1.1, m.linen)}
          {box(block.w * 0.62, 0.22, block.d - 0.1, 1.85, m.duvet, block.w * 0.19)}
          {box(1.2, 0.45, block.d * 0.42, 1.85, m.linen, -block.w / 2 + 1, -block.d * 0.24)}
          {box(1.2, 0.45, block.d * 0.42, 1.85, m.linen, -block.w / 2 + 1, block.d * 0.24)}
          {box(0.35, 3.6, block.d + 0.4, 0, m.wood, -block.w / 2 - 0.1)}
        </group>
      );
    }
    case "counter":
    case "island":
      return (
        <group>
          {box(block.w, block.h - 0.15, block.d, 0, m.cabinet)}
          {box(block.w + 0.15, 0.15, block.d + 0.15, block.h - 0.15, m.counter)}
        </group>
      );
    case "tub":
      return box(block.w, block.h, block.d, 0, m.porcelain);
    case "vanity":
      return (
        <group>
          {box(block.w, block.h - 0.12, block.d, 0, m.wood)}
          {box(block.w + 0.1, 0.12, block.d + 0.1, block.h - 0.12, m.counter)}
        </group>
      );
    case "appliance":
      return box(block.w, block.h, block.d, 0, m.appliance);
    case "rug":
      return (
        <mesh position={[cx, 0.03, cz]} rotation={[-Math.PI / 2, 0, 0]} material={m.rug} receiveShadow>
          <planeGeometry args={[block.w, block.d]} />
        </mesh>
      );
  }
}

export type HouseState = {
  /** 0 → 1: the beam sweeps the plan and the walls rise behind it. */
  rise: number;
  /** 0 → 1: the blueprint gives way to finished floors. */
  finish: number;
  /** 0 → 1: furniture drops into place, piece by piece. */
  furnish: number;
  /** Time of day, 5–21. */
  hour: number;
};

// The beam's position across the plan for a given `rise`: it enters above the
// top edge and leaves past the bottom.
const beamY = (rise: number) => -4 + rise * (HOUSE.depth + 14);

function House({ state }: { state: HouseState }) {
  const m = useMaterials();
  const furniture = useFurniture();
  const by = beamY(state.rise);
  const floors = useMemo(() => ROOMS.map((r) => ({ r, mat: m.finish(r.finish, r.w, r.h) })), [m]);
  const blueprint = useMemo(() => new THREE.MeshBasicMaterial({ map: blueprintTexture(), transparent: true, toneMapped: false }), []);
  blueprint.opacity = 1 - state.finish;
  for (const f of floors) f.mat.opacity = state.finish;

  return (
    <group>
      {/* Slab */}
      <mesh position={[0, -0.3, 0]} material={m.slab} receiveShadow castShadow>
        <boxGeometry args={[HOUSE.width + 1, 0.6, HOUSE.depth + 1]} />
      </mesh>
      {blueprint.opacity > 0.001 ? (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} material={blueprint}>
          <planeGeometry args={[HOUSE.width + BLUEPRINT_MARGIN * 2, HOUSE.depth + BLUEPRINT_MARGIN * 2]} />
        </mesh>
      ) : null}
      {state.finish > 0.001
        ? floors.map(({ r, mat }) => (
            <mesh key={r.name} position={[X(r.x + r.w / 2), 0.015, Z(r.y + r.h / 2)]} rotation={[-Math.PI / 2, 0, 0]} material={mat} receiveShadow>
              <planeGeometry args={[r.w, r.h]} />
            </mesh>
          ))
        : null}
      {WALLS.map((w) => {
        const minY = Math.min(w.y1, w.y2);
        const local = THREE.MathUtils.clamp((by - minY) / 9, 0, 1);
        return <WallMesh key={w.id} wall={w} rise={THREE.MathUtils.smootherstep(local, 0, 1)} m={m} />;
      })}
      {state.furnish > 0
        ? BLOCKS.map((b, i) => {
            const k = THREE.MathUtils.clamp(state.furnish * 1.6 - i * 0.04, 0, 1);
            if (k <= 0) return null;
            const e = THREE.MathUtils.smootherstep(k, 0, 1);
            return (
              <group key={i} position={[0, (1 - e) * 4, 0]} scale={[1, Math.max(e, 0.001), 1]}>
                <BlockMesh block={b} m={m} />
              </group>
            );
          })
        : null}
      {furniture && state.furnish > 0
        ? FURNITURE.map((f, i) => {
            const k = THREE.MathUtils.clamp(state.furnish * 1.5 - i * 0.025, 0, 1);
            const template = furniture.get(f.id);
            if (k <= 0 || !template) return null;
            const e = THREE.MathUtils.smootherstep(k, 0, 1);
            return <Piece key={i} template={template} x={X(f.x)} z={Z(f.y)} y={(f.z ?? 0) + (1 - e) * 5} rot={f.rot} scale={0.6 + e * 0.4} />;
          })
        : null}
      <Beam y={by} visible={state.rise > 0 && state.rise < 1} />
    </group>
  );
}

function Piece({ template, x, y, z, rot, scale }: { template: Template; x: number; y: number; z: number; rot: number; scale: number }) {
  const object = useMemo(() => template.scene.clone(true), [template]);
  return <primitive object={object} position={[x, y, z]} rotation={[0, THREE.MathUtils.degToRad(rot), 0]} scale={scale} />;
}

// The scan beam: a sheet of light crossing the plan, as in the scan overlay.
function Beam({ y, visible }: { y: number; visible: boolean }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { color: { value: new THREE.Color(0x6d8cff) } },
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader:
          "uniform vec3 color; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 2.2) * 0.55; gl_FragColor = vec4(color * a, a); }",
      }),
    [],
  );
  const line = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xbfd0ff, toneMapped: false }), []);
  if (!visible) return null;
  const width = HOUSE.width + BLUEPRINT_MARGIN * 2;
  return (
    <group position={[0, 0, Z(y)]}>
      <mesh position={[0, HOUSE.wallHeight * 0.75, 0]} material={mat}>
        <planeGeometry args={[width, HOUSE.wallHeight * 1.5]} />
      </mesh>
      <mesh position={[0, 0.06, 0]} material={line}>
        <boxGeometry args={[width, 0.05, 0.12]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- stage

function Environment() {
  const { gl, scene } = useThree();
  useLayoutEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.3;
    gl.toneMapping = THREE.NeutralToneMapping;
    gl.toneMappingExposure = 1.05;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.shadowMap.needsUpdate = true;
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

// The sun by time of day: it travels across the back of the house as seen
// from the camera's usual side, so shadows fall toward the viewer; low and
// warm early and late, high and white at noon.
function Sun({ hour }: { hour: number }) {
  const t = (hour - 5) / 16;
  const az = THREE.MathUtils.lerp(-1.6, 1.6, t) + Math.PI;
  const el = Math.max(0.16, Math.sin(t * Math.PI) * 0.95);
  const r = 90;
  const pos: [number, number, number] = [Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, Math.cos(az) * Math.cos(el) * r];
  const color = new THREE.Color(SURFACE.sunLow).lerp(new THREE.Color(SURFACE.sunHigh), Math.min(1, el / 0.7));
  // Built by hand: the shadow camera's frustum only takes effect after
  // updateProjectionMatrix(), which declarative props never call.
  const light = useMemo(() => {
    const l = new THREE.DirectionalLight(0xffffff, 2.6);
    l.castShadow = true;
    l.shadow.mapSize.set(4096, 4096);
    const cam = l.shadow.camera;
    cam.left = -44;
    cam.right = 44;
    cam.top = 44;
    cam.bottom = -44;
    cam.near = 1;
    cam.far = 220;
    cam.updateProjectionMatrix();
    l.shadow.bias = -0.0003;
    l.shadow.normalBias = 0.04;
    l.shadow.radius = 3;
    return l;
  }, []);
  light.position.set(...pos);
  light.color.copy(color);
  return <primitive object={light} />;
}

export type CamKey = Key<{ az: number; el: number; dist: number; tx: number; ty: number; tz: number; fov: number }>;

function Rig({ keys }: { keys: CamKey[] }) {
  const frame = useCurrentFrame();
  const { camera } = useThree();
  const c = track(frame, keys);
  useLayoutEffect(() => {
    const el = THREE.MathUtils.degToRad(c.el);
    const az = THREE.MathUtils.degToRad(c.az);
    camera.position.set(c.tx + Math.sin(az) * Math.cos(el) * c.dist, c.ty + Math.sin(el) * c.dist, c.tz + Math.cos(az) * Math.cos(el) * c.dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(c.tx, c.ty, c.tz);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = c.fov;
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

// Ground-contact shading (GTAO), as the app's own viewer does; it is what makes
// corners, furniture feet and door reveals read as solid.
function Post() {
  const { gl, scene, camera, size } = useThree();
  const composer = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(size.width, size.height, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(gl, target);
    c.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, size.width, size.height);
    ao.updateGtaoMaterial({ radius: 2.4, distanceExponent: 1.4, thickness: 2, scale: 1.1, samples: 16 });
    ao.blendIntensity = 0.85;
    c.addPass(ao);
    c.addPass(new OutputPass());
    return c;
  }, [gl, scene, camera, size.width, size.height]);
  useFrame(() => composer.render(), 1);
  return null;
}

function Site() {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0xc9c7c1, roughness: 1, alphaMap: siteFade(), transparent: true }), []);
  return (
    <mesh position={[0, -0.6, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mat} receiveShadow>
      <circleGeometry args={[60, 96]} />
    </mesh>
  );
}

export function HouseScene({ width, height, camera, state, children }: {
  width: number;
  height: number;
  camera: CamKey[];
  state: HouseState;
  children?: ReactNode;
}) {
  return (
    <ThreeCanvas width={width} height={height} shadows gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }} camera={{ fov: 35, near: 0.5, far: 600 }} dpr={1}>
      <Environment />
      <Rig keys={camera} />
      <hemisphereLight args={[0xe8eefc, 0x9a8c76, 0.6]} />
      <Sun hour={state.hour} />
      <Site />
      <House state={state} />
      {children}
      <Post />
    </ThreeCanvas>
  );
}

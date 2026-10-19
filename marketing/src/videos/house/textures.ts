import * as THREE from "three";
import { HOUSE, ROOMS, WALLS, wallPieces, along, roomArea } from "./plan";

// Surfaces painted on a canvas, so the video needs no image assets. Each is
// made once per tab and shared.

const cache = new Map<string, THREE.Texture>();

function once(key: string, make: () => THREE.Texture) {
  const hit = cache.get(key);
  if (hit) return hit;
  const made = make();
  cache.set(key, made);
  return made;
}

// Seeded so every frame of every render paints the same planks.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// White oak planks, 8 ft long, 7" wide: one tile covers 8 × 8 ft.
export function oakTexture() {
  return once("oak", () => {
    const size = 1024;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    if (!g) throw new Error("2d canvas unavailable");
    const rand = rng(7);
    const rows = 14;
    const rowH = size / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rand() * size * 0.6;
      while (x < size) {
        const len = size * (0.55 + rand() * 0.45);
        const tone = 0.9 + rand() * 0.12;
        g.fillStyle = `rgb(${Math.round(196 * tone)}, ${Math.round(168 * tone)}, ${Math.round(128 * tone)})`;
        g.fillRect(x, r * rowH, len, rowH);
        // Grain.
        for (let k = 0; k < 9; k++) {
          g.strokeStyle = `rgba(120, 88, 52, ${0.05 + rand() * 0.07})`;
          g.lineWidth = 1 + rand() * 1.5;
          const y = r * rowH + rand() * rowH;
          g.beginPath();
          g.moveTo(x, y);
          g.bezierCurveTo(x + len * 0.3, y + (rand() - 0.5) * 6, x + len * 0.7, y + (rand() - 0.5) * 6, x + len, y);
          g.stroke();
        }
        g.fillStyle = "rgba(90, 64, 40, 0.35)";
        g.fillRect(x, r * rowH, 2, rowH);
        x += len;
      }
      g.fillStyle = "rgba(90, 64, 40, 0.28)";
      g.fillRect(0, r * rowH, size, 1.5);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
}

// 2 ft porcelain tiles with a light grout line: one tile covers 8 × 8 ft.
export function tileTexture() {
  return once("tile", () => {
    const size = 1024;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    if (!g) throw new Error("2d canvas unavailable");
    const rand = rng(11);
    const n = 4;
    const cell = size / n;
    g.fillStyle = "rgb(160, 157, 150)";
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const tone = 0.96 + rand() * 0.05;
        g.fillStyle = `rgb(${Math.round(206 * tone)}, ${Math.round(203 * tone)}, ${Math.round(196 * tone)})`;
        g.fillRect(i * cell + 3, j * cell + 3, cell - 6, cell - 6);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
}

// A disc that fades to nothing at its rim, so the site melts into the canvas.
export function siteFade() {
  return once("site", () => {
    const size = 512;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    if (!g) throw new Error("2d canvas unavailable");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "white");
    grad.addColorStop(0.62, "white");
    grad.addColorStop(1, "black");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(c);
  });
}

// The plan as a blueprint: white linework on Arc blue, the look of the scan
// bays in components/drawings/workspace/scan-overlay.tsx.
export const BLUEPRINT_MARGIN = 6;
export function blueprintTexture() {
  return once("blueprint", () => {
    const ppf = 36;
    const W = HOUSE.width + BLUEPRINT_MARGIN * 2;
    const D = HOUSE.depth + BLUEPRINT_MARGIN * 2;
    const c = document.createElement("canvas");
    c.width = W * ppf;
    c.height = D * ppf;
    const g = c.getContext("2d");
    if (!g) throw new Error("2d canvas unavailable");
    g.fillStyle = "rgb(40, 72, 205)";
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "rgba(255,255,255,0.13)";
    g.lineWidth = 1;
    for (let x = 0; x <= W; x += 2) {
      g.beginPath();
      g.moveTo(x * ppf, 0);
      g.lineTo(x * ppf, c.height);
      g.stroke();
    }
    for (let y = 0; y <= D; y += 2) {
      g.beginPath();
      g.moveTo(0, y * ppf);
      g.lineTo(c.width, y * ppf);
      g.stroke();
    }
    const px = (v: number) => (v + BLUEPRINT_MARGIN) * ppf;
    g.strokeStyle = "rgba(255,255,255,0.95)";
    g.lineCap = "square";
    for (const w of WALLS) {
      g.lineWidth = (w.exterior ? 0.75 : 0.42) * ppf;
      for (const p of wallPieces(w)) {
        if (p.z0 !== 0 || p.glass) continue;
        const a = along(w, p.a);
        const b = along(w, p.b);
        g.beginPath();
        g.moveTo(px(a.x), px(a.y));
        g.lineTo(px(b.x), px(b.y));
        g.stroke();
      }
      g.lineWidth = 3;
      for (const o of w.openings) {
        if (o.kind === "door") continue;
        const a = along(w, o.from);
        const b = along(w, o.to);
        g.beginPath();
        g.moveTo(px(a.x), px(a.y));
        g.lineTo(px(b.x), px(b.y));
        g.stroke();
      }
    }
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.textAlign = "center";
    for (const r of ROOMS) {
      g.font = `600 ${0.9 * ppf}px "DM Mono", monospace`;
      g.fillText(r.name.toUpperCase(), px(r.x + r.w / 2), px(r.y + r.h / 2));
      g.font = `400 ${0.7 * ppf}px "DM Mono", monospace`;
      g.fillText(`${roomArea(r)} SF`, px(r.x + r.w / 2), px(r.y + r.h / 2) + ppf * 1.1);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

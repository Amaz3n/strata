import { Easing, interpolate, spring } from "remotion";
import { FPS } from "./brand";

export type Key<T> = { at: number } & T;

const ease = Easing.bezier(0.65, 0, 0.35, 1);

// Interpolates every numeric field of a keyframe list at `frame`, with an
// ease-in-out between neighbours. The camera, the cursor and anything else
// that travels along a path share this one function.
export function track<T extends Record<string, number>>(frame: number, keys: Key<T>[]): T {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (frame <= first.at) return strip(first);
  if (frame >= last.at) return strip(last);
  const i = keys.findIndex((k) => k.at > frame);
  const from = keys[i - 1];
  const to = keys[i];
  const t = ease((frame - from.at) / (to.at - from.at));
  const out: Record<string, number> = {};
  for (const name of Object.keys(from)) {
    if (name === "at") continue;
    out[name] = from[name] + (to[name] - from[name]) * t;
  }
  return out as T;
}

function strip<T extends Record<string, number>>(key: Key<T>): T {
  const { at: _at, ...rest } = key;
  return rest as unknown as T;
}

// A soft, slightly springy 0→1 entrance that starts at `delay`.
export const pop = (frame: number, delay = 0, stiffness = 140) =>
  spring({ frame: frame - delay, fps: FPS, config: { damping: 16, stiffness, mass: 0.8 } });

export const fade = (frame: number, start: number, length = 10) =>
  interpolate(frame, [start, start + length], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

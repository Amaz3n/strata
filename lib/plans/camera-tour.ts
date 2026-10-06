/**
 * Walkthroughs: a camera path recorded as someone walks or orbits the model,
 * played back smoothly for a buyer or a meeting.
 *
 * A tour is a list of samples (position then look-at target, world feet),
 * recorded every `TOUR_SAMPLE_SEC`. Playback runs a centripetal-style
 * Catmull-Rom through the samples at the recorded pace, so a pause while
 * recording is a pause on playback. Pure and tested.
 */

export type TourSample = [number, number, number, number, number, number];

export const TOUR_SAMPLE_SEC = 0.25;
/** Two and a half minutes of walking. */
export const MAX_TOUR_POINTS = 600;

export function tourDurationSec(samples: readonly TourSample[]): number {
  return Math.max(0, samples.length - 1) * TOUR_SAMPLE_SEC;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** The camera at `seconds` into the tour, clamped to its ends. */
export function tourPose(samples: readonly TourSample[], seconds: number): TourSample | null {
  if (samples.length === 0) return null;
  if (samples.length === 1) return [...samples[0]];
  const u = Math.max(0, Math.min(samples.length - 1, seconds / TOUR_SAMPLE_SEC));
  const i = Math.min(samples.length - 2, Math.floor(u));
  const t = u - i;
  const at = (k: number) => samples[Math.max(0, Math.min(samples.length - 1, k))];
  const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
  return b.map((_, axis) => catmull(a[axis], b[axis], c[axis], d[axis], t)) as TourSample;
}

/**
 * Whether a new sample is worth keeping: the camera moved or turned. Long
 * pauses still record (so playback keeps the pace) but only up to a second.
 */
export function shouldRecord(previous: TourSample | undefined, next: TourSample, stillSamples: number): boolean {
  if (!previous) return true;
  const moved = Math.hypot(next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]);
  const turned = Math.hypot(next[3] - previous[3], next[4] - previous[4], next[5] - previous[5]);
  return moved > 0.05 || turned > 0.05 || stillSamples < 1 / TOUR_SAMPLE_SEC;
}

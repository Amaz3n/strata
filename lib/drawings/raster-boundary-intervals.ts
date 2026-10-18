/** Retain individually qualified intervals of an already continuous ink run.
 * A dense non-boundary crossing splits support; it never licenses interpolation
 * or a lower boundary fraction. The caller keeps the original samples and fit. */
export function rasterBoundaryIntervals(
  boundaries: readonly boolean[],
  minimumSamples: number,
  work: () => boolean,
): { ranges: Array<[number, number]>; limited: boolean } {
  const result = { ranges: [] as Array<[number, number]>, limited: false };
  const prefix = [0];
  const gaps: Array<[number, number]> = [];
  let gap = -1;
  for (let i = 0; i <= boundaries.length; i++) {
    if (!work()) return { ...result, limited: true };
    if (i < boundaries.length) prefix.push(prefix[i] + Number(boundaries[i]));
    if (i < boundaries.length && !boundaries[i]) {
      if (gap < 0) gap = i;
    } else if (gap >= 0) {
      gaps.push([gap, i]);
      gap = -1;
    }
  }
  const pending: Array<[number, number]> = [[0, boundaries.length]];
  while (pending.length) {
    if (!work()) return { ...result, limited: true };
    const [start, end] = pending.pop()!;
    if (end - start < minimumSamples) continue;
    if ((prefix[end] - prefix[start]) / (end - start) >= 0.9) {
      result.ranges.push([start, end]);
      continue;
    }
    let split: [number, number] | undefined;
    for (const candidate of gaps) {
      if (!work()) return { ...result, limited: true };
      if (candidate[0] < start || candidate[1] > end) continue;
      const length = candidate[1] - candidate[0];
      if (
        !split ||
        length > split[1] - split[0] ||
        (length === split[1] - split[0] &&
          Math.abs(candidate[0] + candidate[1] - start - end) <
            Math.abs(split[0] + split[1] - start - end))
      )
        split = candidate;
    }
    if (split) pending.push([start, split[0]], [split[1], end]);
  }
  result.ranges.sort((a, b) => a[0] - b[0]);
  return result;
}

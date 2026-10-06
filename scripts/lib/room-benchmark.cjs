const { ShapeUtils, Vector2 } = require('three')

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
function signedArea(p) {
  return p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]; return sum + a[0] * b[1] - b[0] * a[1] }, 0) / 2
}
const area = p => Math.abs(signedArea(p))
function validateRooms(rooms) {
  if (!Array.isArray(rooms)) throw new Error('rooms must be an array')
  const ids = new Set()
  for (const room of rooms) {
    if (typeof room.id !== 'string' || !room.id || ids.has(room.id)) throw new Error('Room IDs must be unique nonempty strings')
    ids.add(room.id)
    if (room.holes?.length) throw new Error(`${room.id}: holes are not supported; exclude this case explicitly from the pilot`)
    const p = room.polygon
    if (!Array.isArray(p) || p.length < 3 || p.length > 1000 || p.some(v => !Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite))) throw new Error(`${room.id}: invalid polygon`)
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length]
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-8) throw new Error(`${room.id}: duplicate consecutive vertex`)
      for (let j = i + 1; j < p.length; j++) {
        if (j === i + 1 || (i === 0 && j === p.length - 1)) continue
        const c = p[j], d = p[(j + 1) % p.length]
        const overlaps = Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))
        if (overlaps && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) throw new Error(`${room.id}: self-intersecting polygon`)
      }
    }
    if (area(p) < 1e-8) throw new Error(`${room.id}: zero area`)
  }
}
function triangles(p) {
  return ShapeUtils.triangulateShape(p.map(([x, y]) => new Vector2(x, y)), []).map(indices => {
    const t = indices.map(i => p[i]); return signedArea(t) < 0 ? t.reverse() : t
  })
}
function clippedArea(subject, clip) {
  let out = subject
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], input = out
    out = []
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length]
      const dp = cross(a, b, p), dq = cross(a, b, q)
      if (dp >= 0) out.push(p)
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq)
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
      }
    }
  }
  return area(out)
}
function iou(a, b) {
  let intersection = 0
  const ta = triangles(a), tb = triangles(b)
  for (const x of ta) for (const y of tb) intersection += clippedArea(x, y)
  return Math.max(0, Math.min(1, intersection / (area(a) + area(b) - intersection)))
}
function distanceToBoundary(p, ring) {
  return Math.min(...ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }))
}
function boundaryP95(a, b) {
  const distances = []
  for (const [from, to] of [[a, b], [b, a]]) for (let i = 0; i < from.length; i++) {
    const p = from[i], q = from[(i + 1) % from.length]
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.1))
    if (n > 100000) throw new Error('Boundary exceeds benchmark size limit; check feet units')
    for (let j = 0; j < n; j++) distances.push(distanceToBoundary([p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n], to))
  }
  distances.sort((x, y) => x - y)
  return distances[Math.ceil(distances.length * 0.95) - 1]
}
function scoreRooms(truth, predicted, threshold = 0.5) {
  validateRooms(truth); validateRooms(predicted)
  if (!(threshold > 0 && threshold <= 1)) throw new Error('IoU threshold must be in (0, 1]')
  const overlaps = truth.map(t => predicted.map(p => iou(t.polygon, p.polygon)))
  const candidates = overlaps.map(row => row.map((value, index) => ({ value, index })).filter(x => x.value >= threshold).sort((a, b) => b.value - a.value))
  // Maximum-cardinality one-to-one assignment; descending IoU traversal is a
  // deterministic tie preference, not a maximum-total-IoU claim.
  const owners = new Map()
  function assign(t, seen) {
    for (const { index: p } of candidates[t]) {
      if (seen.has(p)) continue
      seen.add(p)
      if (!owners.has(p) || assign(owners.get(p), seen)) { owners.set(p, t); return true }
    }
    return false
  }
  truth.forEach((_, t) => assign(t, new Set()))
  const matches = [...owners].map(([p, t]) => ({
    truthId: truth[t].id, predictionId: predicted[p].id, iou: overlaps[t][p],
    areaErrorPercent: 100 * (area(predicted[p].polygon) - area(truth[t].polygon)) / area(truth[t].polygon),
    boundaryP95Ft: boundaryP95(truth[t].polygon, predicted[p].polygon),
  }))
  return {
    truthCount: truth.length, predictionCount: predicted.length, matchedCount: matches.length,
    recall: truth.length ? matches.length / truth.length : null,
    precision: predicted.length ? matches.length / predicted.length : null,
    missed: truth.filter(t => !matches.some(m => m.truthId === t.id)).map(t => t.id),
    extra: predicted.filter(p => !matches.some(m => m.predictionId === p.id)).map(p => p.id),
    matches,
  }
}
module.exports = { area, iou, scoreRooms, validateRooms }

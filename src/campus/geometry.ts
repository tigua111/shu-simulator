import { AREAS, BUILDINGS, NEIGHBORS, PATHS, type Box, type Vec2 } from './data'

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
  return { x: a.x + t * dx, z: a.z + t * dz }
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const c = closestOnSegment(p, a, b)
  return Math.hypot(p.x - c.x, p.z - c.z)
}

export function distToPolyline(p: Vec2, line: Vec2[]): number {
  let d = Infinity
  for (let i = 0; i < line.length - 1; i++) d = Math.min(d, distToSegment(p, line[i], line[i + 1]))
  return d
}

export function distToPolygonEdge(p: Vec2, poly: Vec2[]): number {
  let d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSegment(p, poly[j], poly[i]))
  return d
}

export function boxOf(pts: Vec2[]): Box {
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const p of pts) {
    x0 = Math.min(x0, p.x)
    x1 = Math.max(x1, p.x)
    z0 = Math.min(z0, p.z)
    z1 = Math.max(z1, p.z)
  }
  return { x0, x1, z0, z1 }
}

function nearBox(p: Vec2, b: Box, pad: number): boolean {
  return p.x > b.x0 - pad && p.x < b.x1 + pad && p.z > b.z0 - pad && p.z < b.z1 + pad
}

function centroidOf(poly: Vec2[]): Vec2 {
  return { x: poly.reduce((s, q) => s + q.x, 0) / poly.length, z: poly.reduce((s, q) => s + q.z, 0) / poly.length }
}

/** 將半徑 r 的圓推出多邊形；未接觸則原樣回傳 */
export function pushOutOfPolygon(p: Vec2, poly: Vec2[], r: number): Vec2 {
  let best: Vec2 | null = null
  let bestD = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const c = closestOnSegment(p, poly[j], poly[i])
    const d = Math.hypot(p.x - c.x, p.z - c.z)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  if (!best) return p
  const inside = pointInPolygon(p, poly)
  if (!inside && bestD >= r) return p
  let nx = p.x - best.x
  let nz = p.z - best.z
  let len = Math.hypot(nx, nz)
  let s = inside ? -1 : 1
  if (len < 1e-6) {
    const c = centroidOf(poly)
    nx = p.x - c.x
    nz = p.z - c.z
    len = Math.hypot(nx, nz) || 1
    s = 1
  }
  return { x: best.x + ((s * nx) / len) * (r + 0.001), z: best.z + ((s * nz) / len) * (r + 0.001) }
}

export interface Obstacle {
  x: number
  z: number
  r: number
}

interface Solid {
  pts: Vec2[]
  box: Box
}
/** 所有地面層實體（校舍地面層多邊形 + 校外建物） */
export const SOLIDS: Solid[] = [
  ...BUILDINGS.flatMap(b => b.ground.map(g => ({ pts: g, box: boxOf(g) }))),
  ...NEIGHBORS.map(n => ({ pts: n.pts, box: n.box })),
]

const AREA_BOXES = AREAS.filter(a => !a.noWalk).map(a => ({ a, box: boxOf(a.pts) }))
const PATH_BOXES = PATHS.map(p => ({ p, box: boxOf(p.pts) }))

/** 位於鋪面區域或步道範圍內（不考慮建物） */
export function onPaved(p: Vec2): boolean {
  for (const { p: path, box } of PATH_BOXES) {
    const half = path.w / 2
    if (!nearBox(p, box, half)) continue
    if (distToPolyline(p, path.pts) <= half) return true
  }
  for (const { a, box } of AREA_BOXES) {
    if (nearBox(p, box, 0) && pointInPolygon(p, a.pts)) return true
  }
  return false
}

/** 位於哪一條步道（取最近者）；不在任何步道上回傳 null */
export function pathAt(p: Vec2): (typeof PATHS)[number] | null {
  let best: (typeof PATHS)[number] | null = null
  let bestD = Infinity
  for (const { p: path, box } of PATH_BOXES) {
    const half = path.w / 2
    if (!nearBox(p, box, half)) continue
    const d = distToPolyline(p, path.pts)
    if (d <= half && d < bestD) {
      bestD = d
      best = path
    }
  }
  return best
}

export function insideSolid(p: Vec2, pad = 0): boolean {
  for (const s of SOLIDS) {
    if (!nearBox(p, s.box, pad)) continue
    if (pointInPolygon(p, s.pts)) return true
    if (pad > 0 && distToPolygonEdge(p, s.pts) < pad) return true
  }
  return false
}

/** 可以站立：位於鋪面且不在建物內 */
export function isWalkable(p: Vec2, radius = 0.4): boolean {
  return onPaved(p) && !insideSolid(p, radius)
}

/**
 * 嘗試把玩家由 from 移到 to：先推出建物／障礙，若離開可步行範圍則改沿單軸滑動，
 * 都不行就留在原地。
 */
export function resolveMove(from: Vec2, to: Vec2, radius = 0.4, extra: Obstacle[] = []): Vec2 {
  const solve = (p: Vec2): Vec2 | null => {
    let q = p
    for (let iter = 0; iter < 3; iter++) {
      for (const s of SOLIDS) if (nearBox(q, s.box, radius + 0.5)) q = pushOutOfPolygon(q, s.pts, radius)
      for (const o of extra) {
        const dx = q.x - o.x
        const dz = q.z - o.z
        const d = Math.hypot(dx, dz)
        const min = o.r + radius
        if (d < min && d > 1e-6) q = { x: o.x + (dx / d) * min, z: o.z + (dz / d) * min }
      }
    }
    if (Math.hypot(q.x - p.x, q.z - p.z) > 2.5) return null
    return onPaved(q) && !insideSolid(q) ? q : null
  }
  return solve(to) ?? solve({ x: to.x, z: from.z }) ?? solve({ x: from.x, z: to.z }) ?? from
}

export function routeLength(route: Vec2[]): number {
  let n = 0
  for (let i = 0; i < route.length - 1; i++) n += Math.hypot(route[i + 1].x - route[i].x, route[i + 1].z - route[i].z)
  return n
}

/** 沿路線距離 s 處的位置與切線方向 */
export function samplePath(route: Vec2[], s: number): { p: Vec2; dir: Vec2; index: number } {
  let rest = Math.max(0, s)
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]
    const b = route[i + 1]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (rest <= len || i === route.length - 2) {
      const t = len === 0 ? 0 : Math.min(1, rest / len)
      return { p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, dir: { x: (b.x - a.x) / (len || 1), z: (b.z - a.z) / (len || 1) }, index: i }
    }
    rest -= len
  }
  const last = route[route.length - 1]
  return { p: last, dir: { x: 0, z: -1 }, index: route.length - 2 }
}

/** 等距取樣折線 */
export function resample(line: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = []
  const total = routeLength(line)
  const n = Math.max(1, Math.ceil(total / step))
  for (let i = 0; i <= n; i++) out.push(samplePath(line, (total * i) / n).p)
  return out
}

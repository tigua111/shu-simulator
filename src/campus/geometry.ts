import { BUILDINGS, CAMPUS_POLYGON, type Building, type Vec2 } from './data'

export function pointInPolygon(p: Vec2, poly: Vec2[] = CAMPUS_POLYGON): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz))
}

export function distToPolyline(p: Vec2, line: Vec2[]): number {
  let d = Infinity
  for (let i = 0; i < line.length - 1; i++) d = Math.min(d, distToSegment(p, line[i], line[i + 1]))
  return d
}

/** 到多邊形邊界的距離 */
export function distToPolygonEdge(p: Vec2, poly: Vec2[] = CAMPUS_POLYGON): number {
  let d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSegment(p, poly[j], poly[i]))
  return d
}

/** 轉到建築本地座標 */
function toLocal(p: Vec2, b: Building): Vec2 {
  const dx = p.x - b.x
  const dz = p.z - b.z
  const c = Math.cos(b.rot)
  const s = Math.sin(b.rot)
  // three.js 繞 y 旋轉：world = R * local，其中 x' = x c + z s, z' = -x s + z c
  return { x: dx * c - dz * s, z: dx * s + dz * c }
}

function toWorld(l: Vec2, b: Building): Vec2 {
  const c = Math.cos(b.rot)
  const s = Math.sin(b.rot)
  return { x: b.x + l.x * c + l.z * s, z: b.z - l.x * s + l.z * c }
}

export function insideBuilding(p: Vec2, b: Building, pad = 0): boolean {
  const l = toLocal(p, b)
  return Math.abs(l.x) < b.w / 2 + pad && Math.abs(l.z) < b.d / 2 + pad
}

export function buildingCorners(b: Building): Vec2[] {
  return [
    { x: -b.w / 2, z: -b.d / 2 },
    { x: b.w / 2, z: -b.d / 2 },
    { x: b.w / 2, z: b.d / 2 },
    { x: -b.w / 2, z: b.d / 2 },
  ].map(l => toWorld(l, b))
}

/** 將圓形（玩家）推出建築的矩形範圍 */
export function pushOutOfBuilding(p: Vec2, b: Building, r: number): Vec2 {
  const l = toLocal(p, b)
  const hx = b.w / 2
  const hz = b.d / 2
  const cx = Math.max(-hx, Math.min(hx, l.x))
  const cz = Math.max(-hz, Math.min(hz, l.z))
  const dx = l.x - cx
  const dz = l.z - cz
  const d = Math.hypot(dx, dz)
  if (d >= r) return p
  let nl: Vec2
  if (d > 1e-6) {
    nl = { x: cx + (dx / d) * r, z: cz + (dz / d) * r }
  } else {
    // 中心落在矩形內：從最近的邊推出
    const px = hx - Math.abs(l.x)
    const pz = hz - Math.abs(l.z)
    nl = px < pz ? { x: Math.sign(l.x || 1) * (hx + r), z: l.z } : { x: l.x, z: Math.sign(l.z || 1) * (hz + r) }
  }
  return toWorld(nl, b)
}

export interface Obstacle {
  x: number
  z: number
  r: number
}

/**
 * 嘗試把玩家由 from 移到 to：先推出建築／障礙，若離開校園範圍則改沿單軸滑動，
 * 都不行就留在原地。回傳最終位置。
 */
export function resolveMove(from: Vec2, to: Vec2, radius = 0.4, extra: Obstacle[] = [], buildings: Building[] = BUILDINGS): Vec2 {
  const solve = (p: Vec2): Vec2 | null => {
    let q = p
    for (let iter = 0; iter < 2; iter++) {
      for (const b of buildings) q = pushOutOfBuilding(q, b, radius)
      for (const o of extra) {
        const dx = q.x - o.x
        const dz = q.z - o.z
        const d = Math.hypot(dx, dz)
        const min = o.r + radius
        if (d < min && d > 1e-6) q = { x: o.x + (dx / d) * min, z: o.z + (dz / d) * min }
      }
    }
    return pointInPolygon(q) ? q : null
  }
  return solve(to) ?? solve({ x: to.x, z: from.z }) ?? solve({ x: from.x, z: to.z }) ?? from
}

export function isWalkable(p: Vec2, radius = 0.4): boolean {
  if (!pointInPolygon(p)) return false
  return !BUILDINGS.some(b => insideBuilding(p, b, radius))
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

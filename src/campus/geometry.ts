import { AREAS, BOUNDS, BUILDINGS, NEIGHBORS, PATHS, bankWeight, groundHeight, inStairZone, stairPartAt, terrainBaseHeight, type Box, type Vec2 } from './data'

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
/** 所有地面層實體（校舍地面層多邊形 + 校外建物 + 世界建構時加入的圍牆／花台等） */
export const SOLIDS: Solid[] = [
  ...BUILDINGS.flatMap(b => b.ground.map(g => ({ pts: g, box: boxOf(g) }))),
  ...NEIGHBORS.map(n => ({ pts: n.pts, box: n.box })),
]
// ─── 實體空間索引（8 m 方格），避免每次判定都掃過全部實體 ─────────────
const CELL = 8
let SOLID_GRID: Map<number, number[]> | null = null
const cellKey = (i: number, j: number) => (i + 2048) * 4096 + (j + 2048)
function solidGrid(): Map<number, number[]> {
  if (SOLID_GRID) return SOLID_GRID
  const g = new Map<number, number[]>()
  SOLIDS.forEach((sd, k) => {
    for (let i = Math.floor(sd.box.x0 / CELL); i <= Math.floor(sd.box.x1 / CELL); i++)
      for (let j = Math.floor(sd.box.z0 / CELL); j <= Math.floor(sd.box.z1 / CELL); j++) {
        const key = cellKey(i, j)
        const a = g.get(key)
        if (a) a.push(k)
        else g.set(key, [k])
      }
  })
  SOLID_GRID = g
  return g
}
/** p 周圍 pad 範圍內可能接觸的實體 */
function solidsNear(p: Vec2, pad: number): Solid[] {
  const g = solidGrid()
  const out: Solid[] = []
  const seen = new Set<number>()
  for (let i = Math.floor((p.x - pad) / CELL); i <= Math.floor((p.x + pad) / CELL); i++)
    for (let j = Math.floor((p.z - pad) / CELL); j <= Math.floor((p.z + pad) / CELL); j++) {
      const a = g.get(cellKey(i, j))
      if (!a) continue
      for (const k of a) {
        if (seen.has(k)) continue
        seen.add(k)
        if (nearBox(p, SOLIDS[k].box, pad)) out.push(SOLIDS[k])
      }
    }
  return out
}
/** 加入一個不可穿越的地面實體（圍牆、擋土牆、花台、矮牆等；多邊形 x 東、z 南） */
export function addSolid(pts: Vec2[]): void {
  SOLIDS.push({ pts, box: boxOf(pts) })
  SOLID_GRID = null
}

const AREA_BOXES = AREAS.filter(a => !a.noWalk).map(a => ({ a, box: boxOf(a.pts) }))
const NOWALK_BOXES = AREAS.filter(a => a.noWalk).map(a => ({ a, box: boxOf(a.pts) }))
const PATH_BOXES = PATHS.map(p => ({ p, box: boxOf(p.pts) }))

/** 位於鋪面區域或步道範圍內（不考慮建物） */
export function onPaved(p: Vec2): boolean {
  // 大禮堂樓梯、2F 平台與天橋（高度由 walkHeight 處理）
  if (inStairZone(p.x, p.z) && stairPartAt(p.x, p.z)) return true
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

// ─── 開放地面（2026-10-10「很多隱形牆，但那些路看起來都可以走」） ─────────────
// 草地、空地、校外巷弄等「看起來平的地」一律可走：視覺山坡高度 ≈ 0、坡度不陡、
// 一樓地形與步行地面同高（不在二樓平台／圓環階梯範圍）、不在宿舍坡地與不可步行空地內。
// 山坡高度場由 world.ts 建好後註冊（單元測試未註冊時只認鋪面）。
let HILL: ((x: number, z: number) => number) | null = null
export function setHillField(f: ((x: number, z: number) => number) | null): void {
  HILL = f
}
const OPEN_SLOPE = 0.42
const EDGE_INSET = 6
export function onOpenGround(p: Vec2): boolean {
  const hill = HILL
  if (!hill) return false
  if (p.x < BOUNDS.minX + EDGE_INSET || p.x > BOUNDS.maxX - EDGE_INSET || p.z < BOUNDS.minZ + EDGE_INSET || p.z > BOUNDS.maxZ - EDGE_INSET) return false
  if (hill(p.x, p.z) > 0.15) return false
  const d = 1
  if (hill(p.x + d, p.z) > 0.35 || hill(p.x - d, p.z) > 0.35 || hill(p.x, p.z + d) > 0.35 || hill(p.x, p.z - d) > 0.35) return false
  if (bankWeight(p.x, p.z) > 0.02) return false
  const h0 = terrainBaseHeight(p.x, p.z)
  if (Math.abs(groundHeight(p.x, p.z) - h0) > 0.15) return false
  const sx = Math.abs(terrainBaseHeight(p.x + d, p.z) - terrainBaseHeight(p.x - d, p.z)) / (2 * d)
  const sz = Math.abs(terrainBaseHeight(p.x, p.z + d) - terrainBaseHeight(p.x, p.z - d)) / (2 * d)
  if (sx > OPEN_SLOPE || sz > OPEN_SLOPE) return false
  for (const { a, box } of NOWALK_BOXES) if (nearBox(p, box, 0) && pointInPolygon(p, a.pts)) return false
  return true
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
  for (const s of solidsNear(p, pad)) {
    if (pointInPolygon(p, s.pts)) return true
    if (pad > 0 && distToPolygonEdge(p, s.pts) < pad) return true
  }
  return false
}

/** 可以站立：位於鋪面或開放地面，且不在建物／圍牆內 */
export function isWalkable(p: Vec2, radius = 0.4): boolean {
  return (onPaved(p) || onOpenGround(p)) && !insideSolid(p, radius)
}

/**
 * 嘗試把玩家由 from 移到 to：先推出建物／障礙，若離開可步行範圍則改沿單軸滑動，
 * 都不行就留在原地。
 */
export function resolveMove(from: Vec2, to: Vec2, radius = 0.4, extra: Obstacle[] = []): Vec2 {
  // 障礙點（樹幹、燈柱、欄杆…）數量上千：先篩出目的地附近的，再反覆推擠
  const near: Obstacle[] = []
  for (const o of extra) {
    const lim = o.r + radius + 3
    if (Math.abs(to.x - o.x) < lim && Math.abs(to.z - o.z) < lim) near.push(o)
  }
  const solve = (p: Vec2): Vec2 | null => {
    let q = p
    for (let iter = 0; iter < 3; iter++) {
      for (const s of solidsNear(q, radius + 0.5)) q = pushOutOfPolygon(q, s.pts, radius)
      for (const o of near) {
        const dx = q.x - o.x
        const dz = q.z - o.z
        if (Math.abs(dx) > o.r + radius || Math.abs(dz) > o.r + radius) continue
        const d = Math.hypot(dx, dz)
        const min = o.r + radius
        if (d < min && d > 1e-6) q = { x: o.x + (dx / d) * min, z: o.z + (dz / d) * min }
      }
    }
    if (Math.hypot(q.x - p.x, q.z - p.z) > 2.5) return null
    return (onPaved(q) || onOpenGround(q)) && !insideSolid(q) ? q : null
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

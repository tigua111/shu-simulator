/**
 * 世新大學校園配置資料（真實座標版）。
 * 座標單位公尺：x 向東、z 向南（三維場景 -z 為北），原點約在舍我樓東南角。
 * 建築輪廓與步道取自 OpenStreetMap（© OpenStreetMap 貢獻者，ODbL），並以國土測繪中心正射影像核對；
 * 樓層數取自世新大學官網「大樓樓層資訊」。高程為依電子地圖等高線估計的近似值。
 */
import { SITE } from './site'
import type { AreaKind, BuildingStyle, P2, PathKind, SiteBuilding } from './siteTypes'
import { APPEARANCE, type RoofKind } from './appearance'

export type { BuildingStyle, PathKind, AreaKind, RoofKind }
export type Vec2 = { x: number; z: number }

const v = (p: P2): Vec2 => ({ x: p[0], z: p[1] })

export interface Box {
  x0: number
  x1: number
  z0: number
  z1: number
}
export interface Building extends Omit<SiteBuilding, 'poly' | 'ground'> {
  pts: Vec2[]
  /** 地面層碰撞用多邊形（無穿越通道時等於 pts） */
  ground: Vec2[][]
  c: Vec2
  box: Box
  roof: RoofKind
}
export interface Neighbor {
  osm: number
  h: number
  pts: Vec2[]
  box: Box
}
export interface PathLine {
  id: string
  kind: PathKind
  w: number
  pts: Vec2[]
}
export interface Area {
  id: string
  kind: AreaKind
  pts: Vec2[]
}

export function polyBox(pts: Vec2[]): Box {
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

/** 多邊形面積加權質心 */
export function centroid(pts: Vec2[]): Vec2 {
  let a = 0
  let cx = 0
  let cz = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j].x * pts[i].z - pts[i].x * pts[j].z
    a += f
    cx += (pts[j].x + pts[i].x) * f
    cz += (pts[j].z + pts[i].z) * f
  }
  if (Math.abs(a) < 1e-6) return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, z: pts.reduce((s, p) => s + p.z, 0) / pts.length }
  return { x: cx / (3 * a), z: cz / (3 * a) }
}

export const BUILDINGS: Building[] = SITE.buildings.map(b => {
  const pts = b.poly.map(v)
  const ap = APPEARANCE[b.id]
  return {
    ...b,
    style: ap?.style ?? b.style,
    h: ap?.h ?? b.h,
    roof: ap?.roof ?? 'flat',
    pts,
    ground: b.ground ? b.ground.map(g => g.map(v)) : [pts],
    c: centroid(pts),
    box: polyBox(pts),
  }
})
export const NEIGHBORS: Neighbor[] = SITE.neighbors.map(n => {
  const pts = n.poly.map(v)
  return { osm: n.osm, h: n.h, pts, box: polyBox(pts) }
})
export const PATHS: PathLine[] = SITE.paths.map(p => ({ id: p.id, kind: p.kind, w: p.w, pts: p.pts.map(v) }))
export const AREAS: Area[] = SITE.areas.map(a => ({ id: a.id, kind: a.kind, pts: a.poly.map(v) }))
export const FOREST: Vec2[][] = SITE.forest.map(f => f.map(v))
export const BOUNDS = SITE.bounds
export const ORIGIN = SITE.origin

export const TUNNEL = PATHS.find(p => p.kind === 'tunnel')!
export const TRACK = { x: SITE.track.center[0], z: SITE.track.center[1], rot: SITE.track.rot, len: SITE.track.len, w: SITE.track.w, lane: SITE.track.lane }
export const STAGE = { x: SITE.stage.center[0], z: SITE.stage.center[1], r: SITE.stage.r }
export const BACK_GATE = { x: SITE.backGate.center[0], z: SITE.backGate.center[1], dir: v(SITE.backGate.dir) }
export const FRONT_GATE = { x: SITE.frontGate.center[0], z: SITE.frontGate.center[1], dir: v(SITE.frontGate.dir) }

/** 主動線：前校門 → 隧道 → 八方廣場 → 舍我樓 → 學校廣場 → 大禮堂北側 → 操場 → 傳播大廈 C 棟 */
export const ROUTE: Vec2[] = SITE.route.map(v)
export const START: { pos: Vec2; yaw: number } = (() => {
  const p = ROUTE[0]
  const q = ROUTE[2]
  return { pos: { ...p }, yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)) }
})()
/** 傳播大廈東側入口（終點判定） */
export const DESTINATION: Vec2 = { ...ROUTE[ROUTE.length - 1] }

export function buildingById(id: string): Building {
  const b = BUILDINGS.find(x => x.id === id)
  if (!b) throw new Error(`unknown building ${id}`)
  return b
}

// ─── 地面高程 ─────────────────────────────────────────
const ELEV = SITE.elev
/** 依控制點反距離加權插值的原始高程 */
function rawHeight(x: number, z: number): number {
  let ws = 0
  let hs = 0
  for (let i = 0; i < ELEV.length; i++) {
    const e = ELEV[i]
    const dx = x - e[0]
    const dz = z - e[1]
    const d2 = dx * dx + dz * dz
    if (d2 < 0.01) return e[2]
    const w = 1 / Math.pow(d2 + 4, 1.4)
    ws += w
    hs += w * e[2]
  }
  return hs / ws
}

/** 點到多邊形邊界的距離（內部回傳 0） */
function polyDist(x: number, z: number, pts: Vec2[]): number {
  let inside = false
  let best = Infinity
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]
    const b = pts[i]
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
    const dx = b.x - a.x
    const dz = b.z - a.z
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)))
    best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t))
  }
  return inside ? 0 : best
}

/** 操場（跑道＋網球場）為平整場地：範圍內固定高程，外圍 10 公尺平順銜接 */
const SPORTS = AREAS.find(a => a.kind === 'sports')
const SPORTS_BOX = SPORTS ? polyBox(SPORTS.pts) : null
const SPORTS_Y = rawHeight(SITE.track.center[0], SITE.track.center[1])
const FLAT_MARGIN = 10

/** 步行地面高程（公尺，海拔） */
export function groundHeight(x: number, z: number): number {
  const h = rawHeight(x, z)
  if (!SPORTS || !SPORTS_BOX) return h
  if (x < SPORTS_BOX.x0 - FLAT_MARGIN || x > SPORTS_BOX.x1 + FLAT_MARGIN || z < SPORTS_BOX.z0 - FLAT_MARGIN || z > SPORTS_BOX.z1 + FLAT_MARGIN) return h
  const d = polyDist(x, z, SPORTS.pts)
  if (d >= FLAT_MARGIN) return h
  const t = smoothstep(0, FLAT_MARGIN, d)
  return SPORTS_Y * (1 - t) + h * t
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

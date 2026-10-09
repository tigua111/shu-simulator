/**
 * 世新大學校園配置資料（真實座標版）。
 * 座標單位公尺：x 向東、z 向南（三維場景 -z 為北），原點約在舍我樓東南角。
 * 建築輪廓與步道取自 OpenStreetMap（© OpenStreetMap 貢獻者，ODbL），並以國土測繪中心正射影像核對；
 * 樓層數取自世新大學官網「大樓樓層資訊」。高程為依電子地圖等高線估計的近似值。
 */
import { SITE } from './site'
import type { AreaKind, BuildingStyle, P2, PathKind, SiteBuilding } from './siteTypes'
import { APPEARANCE, type RoofKind } from './appearance'
import { LOADED_EDITS, transformPoint } from './edits'
import { SURVEY_HOUSES } from './plazaSurvey'

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
  /** 可移動物件 id（nb:o<osm> 或 nb:s<實測編號>） */
  id: string
  osm: number
  /** 實測補上的民宅編號（OSM 鄰房為空） */
  sid?: string
  roof?: number
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
  const raw = b.poly.map(v)
  // 編輯模式保存的調整：繞原始質心旋轉後平移
  const e = LOADED_EDITS[b.id]
  const c0 = centroid(raw)
  const tf = (p: Vec2): Vec2 => (e ? transformPoint(p, c0, e) : p)
  const pts = raw.map(tf)
  const ap = APPEARANCE[b.id]
  return {
    ...b,
    style: ap?.style ?? b.style,
    h: ap?.h ?? b.h,
    roof: ap?.roof ?? 'flat',
    pts,
    ground: b.ground ? b.ground.map(g => g.map(v).map(tf)) : [pts],
    c: centroid(pts),
    box: polyBox(pts),
  }
})
const inPoly = (p: Vec2, poly: Vec2[]): boolean => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) c = !c
  }
  return c
}
const RAW_PATHS = SITE.paths.map(p => ({ w: p.w, pts: p.pts.map(v) }))
/** 離道路／步道中心線小於半寬＋0.8 m 視為壓到路面 */
const onRoad = (p: Vec2): boolean =>
  RAW_PATHS.some(pa => {
    for (let i = 1; i < pa.pts.length; i++) {
      const q = pa.pts[i - 1]
      const r = pa.pts[i]
      const vx = r.x - q.x
      const vz = r.z - q.z
      const l2 = vx * vx + vz * vz || 1
      const t = Math.max(0, Math.min(1, ((p.x - q.x) * vx + (p.z - q.z) * vz) / l2))
      if (Math.hypot(p.x - q.x - t * vx, p.z - q.z - t * vz) < pa.w / 2 + 0.8) return true
    }
    return false
  })
/**
 * 學校廣場周邊依 0052 空拍描出的民宅（plazaSurvey.ts）。
 * 空拍屋頂有透視位移，壓到 OSM 道路的角點往質心內收；仍有六成以上落在路面的房子略過。
 */
/** Sutherland–Hodgman：保留 n·(p − o) ≥ 0 的一側 */
function clipHalf(poly: Vec2[], o: Vec2, n: Vec2): Vec2[] {
  const f = (p: Vec2) => n.x * (p.x - o.x) + n.z * (p.z - o.z)
  const out: Vec2[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const fa = f(a)
    const fb = f(b)
    if (fa >= 0) out.push(a)
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb)
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  return out
}
const SURVEYED: Neighbor[] = SURVEY_HOUSES.flatMap(h => {
  let pts = h.poly.map(v)
  // 與道路相交者，沿路緣切開，保留原質心那一側
  for (const pa of RAW_PATHS) {
    for (let i = 1; i < pa.pts.length; i++) {
      if (pts.length < 3) break
      const q = pa.pts[i - 1]
      const r = pa.pts[i]
      const l = Math.hypot(r.x - q.x, r.z - q.z) || 1
      const d = { x: (r.x - q.x) / l, z: (r.z - q.z) / l }
      let n = { x: -d.z, z: d.x }
      const half = pa.w / 2 + 0.8
      // 只處理在此路段範圍內有交疊的情形
      const along = pts.map(p => (p.x - q.x) * d.x + (p.z - q.z) * d.z)
      if (Math.max(...along) < -half || Math.min(...along) > l + half) continue
      const side = pts.map(p => (p.x - q.x) * n.x + (p.z - q.z) * n.z)
      if (Math.min(...side) > half || Math.max(...side) < -half) continue
      const c = centroid(pts)
      if ((c.x - q.x) * n.x + (c.z - q.z) * n.z < 0) n = { x: -n.x, z: -n.z }
      pts = clipHalf(pts, { x: q.x + n.x * half, z: q.z + n.z * half }, n)
    }
  }
  if (pts.length < 3) return []
  const box = polyBox(pts)
  let tot = 0
  let bad = 0
  for (let x = box.x0; x <= box.x1; x += 1)
    for (let z = box.z0; z <= box.z1; z += 1) {
      const q = { x, z }
      if (!inPoly(q, pts)) continue
      tot++
      if (onRoad(q)) bad++
    }
  if (!tot || bad / tot > 0.6) return []
  return [{ id: `nb:s${h.id}`, osm: 0, sid: h.id, roof: h.roof, h: h.h, pts, box }]
})
/** 鄰房原始輪廓（未套用編輯），供匯出 */
export const ORIGINAL_NEIGHBOR_POLYS: Record<string, Vec2[]> = {}
export const NEIGHBORS: Neighbor[] = [
  // OSM 鄰房中與實測民宅重疊者以實測為準
  ...SITE.neighbors
    .map((n, i) => {
      const pts = n.poly.map(v)
      return { id: `nb:o${n.osm || 'i' + i}`, osm: n.osm, h: n.h, pts, box: polyBox(pts) }
    })
    .filter(n => !SURVEYED.some(s => inPoly(centroid(n.pts), s.pts) || n.pts.some(p => inPoly(p, s.pts)) || s.pts.some(p => inPoly(p, n.pts)))),
  ...SURVEYED,
].map(n => {
  ORIGINAL_NEIGHBOR_POLYS[n.id] = n.pts
  // 編輯模式保存的調整：與建築相同，繞原始質心旋轉後平移，碰撞與地形依新位置重建
  const e = LOADED_EDITS[n.id]
  if (!e) return n
  const c0 = centroid(n.pts)
  const pts = n.pts.map(p => transformPoint(p, c0, e))
  return { ...n, pts, box: polyBox(pts) }
})
export const PATHS: PathLine[] = SITE.paths.map(p => ({ id: p.id, kind: p.kind, w: p.w, pts: p.pts.map(v) }))
export const AREAS: Area[] = SITE.areas.map(a => ({ id: a.id, kind: a.kind, pts: a.poly.map(v) }))
export const FOREST: Vec2[][] = SITE.forest.map(f => f.map(v))
export const BOUNDS = SITE.bounds
export const ORIGIN = SITE.origin
/** 原始（未調整）建築輪廓，供編輯器匯出差異 */
export const ORIGINAL_POLYS: Record<string, Vec2[]> = Object.fromEntries(SITE.buildings.map(b => [b.id, b.poly.map(v)]))

export const TUNNEL = PATHS.find(p => p.kind === 'tunnel')!
/**
 * 前校門立面法線（指向門內）：立面平行最近的木柵路路段。
 * 隧道原為斜交校門 36° 的直線；改為先垂直校門直行 12 m，再以平順曲線轉向原出口，讓拱門開口正對隧道。
 */
export const GATE_NORMAL: Vec2 = (() => {
  const a = TUNNEL.pts[0]
  const b = TUNNEL.pts[TUNNEL.pts.length - 1]
  let best = Infinity
  let tan = { x: 1, z: 0 }
  for (const p of PATHS) {
    if (p.kind !== 'road') continue
    for (let i = 1; i < p.pts.length; i++) {
      const q = p.pts[i - 1]
      const r = p.pts[i]
      const vx = r.x - q.x
      const vz = r.z - q.z
      const l2 = vx * vx + vz * vz || 1
      const t = Math.max(0, Math.min(1, ((a.x - q.x) * vx + (a.z - q.z) * vz) / l2))
      const d = Math.hypot(a.x - q.x - t * vx, a.z - q.z - t * vz)
      if (d < best) {
        best = d
        const l = Math.sqrt(l2)
        tan = { x: vx / l, z: vz / l }
      }
    }
  }
  let n = { x: -tan.z, z: tan.x }
  if (n.x * (b.x - a.x) + n.z * (b.z - a.z) < 0) n = { x: -n.x, z: -n.z }
  return n
})()
export const TUNNEL_STRAIGHT = 12
{
  const a = TUNNEL.pts[0]
  const b = TUNNEL.pts[TUNNEL.pts.length - 1]
  const n = GATE_NORMAL
  const p1 = { x: a.x + n.x * TUNNEL_STRAIGHT, z: a.z + n.z * TUNNEL_STRAIGHT }
  // 二次貝茲：起點切線沿校門法線，終點落在原出口
  const ctrl = { x: p1.x + n.x * 22, z: p1.z + n.z * 22 }
  const pts: Vec2[] = [{ ...a }, p1]
  const N = 14
  for (let i = 1; i <= N; i++) {
    const t = i / N
    const u = 1 - t
    pts.push({ x: u * u * p1.x + 2 * u * t * ctrl.x + t * t * b.x, z: u * u * p1.z + 2 * u * t * ctrl.z + t * t * b.z })
  }
  TUNNEL.pts.splice(0, TUNNEL.pts.length, ...pts)
}
export const TRACK = { x: SITE.track.center[0], z: SITE.track.center[1], rot: SITE.track.rot, len: SITE.track.len, w: SITE.track.w, lane: SITE.track.lane }
export const STAGE = { x: SITE.stage.center[0], z: SITE.stage.center[1], r: SITE.stage.r }
export const BACK_GATE = { x: SITE.backGate.center[0], z: SITE.backGate.center[1], dir: v(SITE.backGate.dir) }
export const FRONT_GATE = { x: SITE.frontGate.center[0], z: SITE.frontGate.center[1], dir: v(SITE.frontGate.dir) }

/** 主動線：前校門 → 隧道 → 八方廣場 → 舍我樓 → 學校廣場 → 大禮堂北側 → 操場 → 傳播大廈 C 棟 */
export const ROUTE: Vec2[] = (() => {
  const raw = SITE.route.map(v)
  const a = TUNNEL.pts[0]
  const b = TUNNEL.pts[TUNNEL.pts.length - 1]
  // 原路線：街口 → 斜向進門 → 隧道直線 → 出口；改為在木柵路上正對校門，沿隧道折線前進
  const iExit = raw.findIndex(p => Math.hypot(p.x - b.x, p.z - b.z) < 1)
  const n = GATE_NORMAL
  const head = [
    { x: a.x - n.x * 13, z: a.z - n.z * 13 },
    { x: a.x - n.x * 6, z: a.z - n.z * 6 },
  ]
  return [...head, ...TUNNEL.pts.map(p => ({ ...p })), ...raw.slice(iExit + 1)]
})()
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

// ─── 隧道出口 → 行政大樓：上下兩層（Google 街景 2026-10-05 使用者截圖）─────────
// 下層：沿 ramp-1 的粉紅磚步道，北側為行政大樓下層的商店街（店面牆即分界線）；
// 上層：分界線以北、行政大樓東南面前的灰色格紋磚坡道（ramp-2），由隧道口較陡地升上行政大樓入口。
// 以 ramp-1 中心線為基準：s＝沿線距離，o＝往北（行政大樓側）的偏移。
const SPLIT_LINE: Vec2[] = (SITE.paths.find(p => p.id === 'ramp-1')?.pts ?? []).map(v)
export const SPLIT_EDGE = 2.8
const SPLIT_SEG = SPLIT_LINE.slice(1).map((b, i) => {
  const a = SPLIT_LINE[i]
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
  return { a, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len, len }
})
export const SPLIT_LEN = SPLIT_SEG.reduce((t, g) => t + g.len, 0)
const SPLIT_BOX = SPLIT_LINE.length
  ? {
      x0: Math.min(...SPLIT_LINE.map(p => p.x)) - 26,
      x1: Math.max(...SPLIT_LINE.map(p => p.x)) + 26,
      z0: Math.min(...SPLIT_LINE.map(p => p.z)) - 26,
      z1: Math.max(...SPLIT_LINE.map(p => p.z)) + 26,
    }
  : null
const LOWER_PROFILE: [number, number][] = [
  [0, 16],
  [45, 18.2],
  [SPLIT_LEN, 22.3],
]
const UPPER_PROFILE: [number, number][] = [
  [0, 16],
  [10, 16.6],
  [30, 21.0],
  [45, 22.6],
  [SPLIT_LEN, 24.0],
]
function profileAt(pr: [number, number][], s: number): number {
  if (s <= pr[0][0]) return pr[0][1]
  for (let i = 1; i < pr.length; i++)
    if (s <= pr[i][0]) {
      const t = (s - pr[i - 1][0]) / (pr[i][0] - pr[i - 1][0] || 1)
      return pr[i - 1][1] + (pr[i][1] - pr[i - 1][1]) * t
    }
  return pr[pr.length - 1][1]
}
/** 上下兩層高差（公尺）：分界線上的擋土牆／店面高度 */
export function splitDelta(s: number): number {
  return profileAt(UPPER_PROFILE, s) - profileAt(LOWER_PROFILE, s)
}
/** 把點投影到 ramp-1 中心線：s 沿線距離、o 往北（左側）偏移 */
export function splitProject(x: number, z: number): { s: number; o: number; d: number } {
  let best = { s: 0, o: 0, d: Infinity }
  let acc = 0
  for (const g of SPLIT_SEG) {
    const rx = x - g.a.x
    const rz = z - g.a.z
    const t = Math.max(0, Math.min(g.len, rx * g.dx + rz * g.dz))
    const px = g.a.x + g.dx * t
    const pz = g.a.z + g.dz * t
    const d = Math.hypot(x - px, z - pz)
    if (d < best.d) {
      // 行進方向（dx,dz）的左側為北（z 向南、x 向東時，左法向 = (dz, -dx)）
      const o = rx * g.dz - rz * g.dx
      best = { s: acc + rx * g.dx + rz * g.dz, o, d }
    }
    acc += g.len
  }
  return best
}
/** 分界線上一點（s, 偏移 o）的平面座標 */
export function splitPoint(s: number, o: number): Vec2 {
  let acc = 0
  for (const g of SPLIT_SEG) {
    if (s <= acc + g.len || g === SPLIT_SEG[SPLIT_SEG.length - 1]) {
      const t = s - acc
      return { x: g.a.x + g.dx * t + g.dz * o, z: g.a.z + g.dz * t - g.dx * o }
    }
    acc += g.len
  }
  return { x: 0, z: 0 }
}
function lerpTable(tb: [number, number][], s: number): number {
  return profileAt(tb, s)
}
/**
 * 下層紅磚坡道南緣（o，負值＝往女一舍側）。DJI_0043 俯拍（2026-10-09）：隧道口端紅磚鋪滿谷底約 9–10 m、
 * 中段約 7.5 m、女一舍電梯塔處讓出塔位約 6 m，往言論廣場端呈扇形放寬。
 */
const LOWER_SOUTH: [number, number][] = [
  [0, -4.6],
  [4, -5.6],
  [30, -5.0],
  [40, -3.3],
  [52, -3.2],
  [64, -7.5],
  [SPLIT_LEN, -10],
]
export function lowerSouth(s: number): number {
  return lerpTable(LOWER_SOUTH, s)
}
/** 上層灰磚平台起點（s）：之前紅磚鋪滿至分界牆以北 */
export const UPPER_START = 9
/** 上層平台未開始處，下層紅磚往北延伸到的偏移 */
export const LOWER_NORTH_OPEN = SPLIT_EDGE + 3.5
/** 上層灰磚平台北緣（o）：約 6 m → 電梯塔對面最窄約 5 m → 行政大樓段放寬至大樓東南面 */
const UPPER_NORTH: [number, number][] = [
  [UPPER_START, SPLIT_EDGE + 5.5],
  [30, SPLIT_EDGE + 5.5],
  [40, SPLIT_EDGE + 5.0],
  [50, SPLIT_EDGE + 9.5],
  [56, SPLIT_EDGE + 12.7],
  [SPLIT_LEN, SPLIT_EDGE + 12.7],
]
export function upperNorth(s: number): number {
  return lerpTable(UPPER_NORTH, s)
}
function splitHeight(x: number, z: number, h: number): number {
  if (!SPLIT_BOX || x < SPLIT_BOX.x0 || x > SPLIT_BOX.x1 || z < SPLIT_BOX.z0 || z > SPLIT_BOX.z1) return h
  const { s, o } = splitProject(x, z)
  if (s < -4 || s > SPLIT_LEN + 12) return h
  // 沿線兩端淡出：隧道口前 4 m、廣場端後 12 m
  const ws = s < 0 ? 1 + s / 4 : s > SPLIT_LEN ? 1 - (s - SPLIT_LEN) / 12 : 1
  let target: number
  let wo: number
  if (o >= SPLIT_EDGE) {
    target = profileAt(UPPER_PROFILE, s)
    wo = o <= SPLIT_EDGE + 13 ? 1 : 1 - smoothstep(SPLIT_EDGE + 13, SPLIT_EDGE + 22, o)
  } else {
    target = profileAt(LOWER_PROFILE, s)
    const so = Math.min(-7, lowerSouth(Math.max(0, Math.min(SPLIT_LEN, s))) - 1.5)
    wo = o >= so ? 1 : 1 - smoothstep(-so, -so + 8, -o)
  }
  const w = Math.max(0, Math.min(1, ws * wo))
  return h * (1 - w) + target * w
}

// 上層坡道（ramp-2）南緣不可跨過分界線，否則鋪面會垂掛到下層
for (const p of PATHS) {
  if (p.id !== 'ramp-2') continue
  const need = SPLIT_EDGE + p.w / 2 + 0.3
  // DJI_0043：隧道口前全為紅磚，灰磚平台自 UPPER_START 才開始 → 坡道起點之前的頂點捨去
  const kept = p.pts.filter(q => splitProject(q.x, q.z).s >= UPPER_START + 1)
  p.pts = [splitPoint(UPPER_START + 0.4, need), ...kept].map(q => {
    const { s, o } = splitProject(q.x, q.z)
    if (s > SPLIT_LEN || o >= need) return q
    return splitPoint(s, need)
  })
}

// 上下兩層整片鋪面：列入可步行區域（也讓樹木避開、小地圖顯示）
if (SPLIT_LINE.length) {
  const lower: Vec2[] = []
  const back: Vec2[] = []
  for (let s = 0.3; s <= SPLIT_LEN + 1e-6; s += 1) {
    lower.push(splitPoint(s, lowerSouth(s)))
    back.push(splitPoint(s, s < UPPER_START ? LOWER_NORTH_OPEN : SPLIT_EDGE - 0.05))
  }
  lower.push(splitPoint(SPLIT_LEN, lowerSouth(SPLIT_LEN)))
  back.push(splitPoint(SPLIT_LEN, SPLIT_EDGE - 0.05))
  // 上層起點的轉角
  const k = back.findIndex((_, i) => 0.3 + i >= UPPER_START)
  if (k > 0) back.splice(k, 0, splitPoint(UPPER_START, LOWER_NORTH_OPEN), splitPoint(UPPER_START, SPLIT_EDGE - 0.05))
  AREAS.push({ id: 'tx-lower', kind: 'plaza', pts: [...lower, ...back.reverse()] })
  const up: Vec2[] = []
  const upBack: Vec2[] = []
  for (let s = UPPER_START; s <= SPLIT_LEN + 1e-6; s += 1) {
    up.push(splitPoint(s, SPLIT_EDGE + 0.05))
    upBack.push(splitPoint(s, upperNorth(s)))
  }
  up.push(splitPoint(SPLIT_LEN, SPLIT_EDGE + 0.05))
  upBack.push(splitPoint(SPLIT_LEN, upperNorth(SPLIT_LEN)))
  AREAS.push({ id: 'tx-upper', kind: 'plaza', pts: [...up, ...upBack.reverse()] })
}

/** 步行地面高程（公尺，海拔） */
export function groundHeight(x: number, z: number): number {
  const h = splitHeight(x, z, rawHeight(x, z))
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

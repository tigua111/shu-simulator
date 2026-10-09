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
  /** 僅供著色／樹木避讓，不列入可步行範圍（例如坡頂平台上的宿舍空地） */
  noWalk?: boolean
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

/**
 * 原始輪廓的局部修正：女一舍 OSM 輪廓北角朝坡道的凸出處即面向步道的電梯塔
 * （另以 obj:D2-lift 建模、立於下層紅磚高程），自宿舍量體移除，宿舍本體留在坡頂平台。
 */
const D2_LIFT = { x: -133.8, z: 20.2 }
/**
 * 隧道口谷道加寬（使用者 2026-10-10「進入山洞口的路太窄，把宿舍往旁邊移動一點」）：
 * 翠谷餐廳 D1、女一舍 D2（含其電梯塔、綠色頂棚鋼梯、坡頂空地）沿分界線法向往南東整體平移 7.5 m（第二次放寬：隧道口段紅磚由約 8 m 再加寬到約 10.5 m）。
 */
export const DORM_SHIFT: Vec2 = { x: 0.573 * 7.5, z: 0.821 * 7.5 }
const DORM_IDS = new Set(['D1', 'D2', 'apron-D1', 'apron-D2'])
export const shiftDorm = (p: Vec2): Vec2 => ({ x: p.x + DORM_SHIFT.x, z: p.z + DORM_SHIFT.z })
function rawPoly(b: (typeof SITE.buildings)[number]): Vec2[] {
  let raw = b.poly.map(v)
  if (b.id === 'D2') raw = raw.filter(p => Math.hypot(p.x - D2_LIFT.x, p.z - D2_LIFT.z) > 3)
  if (DORM_IDS.has(b.id)) raw = raw.map(shiftDorm)
  // 2026-10-10 地面影片＋w059 空拍：大禮堂西牆其實是一直線；OSM 輪廓在 x 98–105、z −26…−4 的外凸
  // 是 2F 高的入口平台（門廊、雨遮，見 AUD_TERRACE），主體量改沿 x = 105 西牆
  if (b.id === 'A') {
    const i = raw.findIndex(p => p.x < 100)
    if (i > 0) {
      raw = raw.filter(p => p.x >= 100)
      raw.splice(i, 0, { x: 104.5, z: -4.0 })
    }
  }
  return raw
}
export const BUILDINGS: Building[] = SITE.buildings.map(b => {
  const raw = rawPoly(b)
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
    ground: b.ground ? b.ground.map(g => g.map(v).map(p => (DORM_IDS.has(b.id) ? shiftDorm(p) : p)).map(tf)) : [pts],
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
/** 八風舞台淨空：OSM shelter 中心，民宅輪廓離中心至少 STAGE_CLEAR m（舞台橢圓頂半長軸 6.3 m＋簷外 0.7 m） */
const STAGE_C = v(SITE.stage.center)
const STAGE_CLEAR = 7
const SURVEYED: Neighbor[] = SURVEY_HOUSES.flatMap(h => {
  let pts = h.poly.map(v)
  {
    // 實測民宅為無人機透視對位，相對 OSM 舞台偏約 (−3.5, −6.5) m，SE2 北緣因此切進舞台：沿舞台→民宅方向切掉淨空內的部分
    const c = centroid(pts)
    const l = Math.hypot(c.x - STAGE_C.x, c.z - STAGE_C.z) || 1
    const n = { x: (c.x - STAGE_C.x) / l, z: (c.z - STAGE_C.z) / l }
    if (pts.some(p => (p.x - STAGE_C.x) * n.x + (p.z - STAGE_C.z) * n.z < STAGE_CLEAR) && l < 30)
      pts = clipHalf(pts, { x: STAGE_C.x + n.x * STAGE_CLEAR, z: STAGE_C.z + n.z * STAGE_CLEAR }, n)
  }
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
    .filter(n => !SURVEYED.some(s => inPoly(centroid(n.pts), s.pts) || n.pts.some(p => inPoly(p, s.pts)) || s.pts.some(p => inPoly(p, n.pts))))
    // 國土測繪電子地圖把八風舞台本身登記成建物（−113，6.4 m 方塊），會與舞台模型重疊：剔除舞台淨空內的鄰房
    .filter(n => Math.hypot(centroid(n.pts).x - STAGE_C.x, centroid(n.pts).z - STAGE_C.z) > STAGE_CLEAR),
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
export const AREAS: Area[] = SITE.areas.map(a => ({ id: a.id, kind: a.kind, pts: DORM_IDS.has(a.id) ? a.poly.map(v).map(shiftDorm) : a.poly.map(v) }))
// 大禮堂西牆前（截水溝以東）：花台、SHU 字、樓梯腳與側樓梯下穿越通道的紅灰磚鋪面
AREAS.push({ id: 'aud-front', kind: 'plaza', pts: [{ x: 96.6, z: -50 }, { x: 104.6, z: -50 }, { x: 104.6, z: -4 }, { x: 96.6, z: -4 }] })
/** OSM 世新大學校地範圍（relation 4054406，多塊：主谷地、前校門 J/W、管院 M/OM） */
export const CAMPUS: Vec2[][] = (SITE.campus ?? []).map(c => c.map(v))
export const FOREST: Vec2[][] = SITE.forest.map(f => f.map(v))
export const BOUNDS = SITE.bounds
export const ORIGIN = SITE.origin
/** 原始（未調整）建築輪廓，供編輯器匯出差異 */
export const ORIGINAL_POLYS: Record<string, Vec2[]> = Object.fromEntries(SITE.buildings.map(b => [b.id, rawPoly(b)]))

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
  const out = [...head, ...TUNNEL.pts.map(p => ({ ...p })), ...raw.slice(iExit + 1)]
  // 2026-10-10：學校廣場 → 大禮堂北側改走側樓梯平台南緣，再沿西牆穿過天橋下的通道（原本斜穿樓梯位置）
  const iAud = out.findIndex(p => Math.abs(p.x - 103) < 1.5 && Math.abs(p.z + 51.5) < 1.5)
  if (iAud > 0) out.splice(iAud, 0, { x: 96.5, z: -40.6 }, { x: 102.3, z: -40.6 }, { x: 102.3, z: -48.6 })
  return out
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
/** 二樓平台高程（海拔）：使用者 2026-10-09 指正「斜坡上去後會到二樓」 */
export const DECK_H = 25.9
const UPPER_PROFILE: [number, number][] = [
  [0, 16],
  [10, 16.6],
  [30, 21.0],
  [45, 22.6],
  [60, 24.4],
  [SPLIT_LEN, DECK_H],
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
  // 2026-10-10 加寬：宿舍南移 5 m 後，隧道口段由 4.6–5.6 m 放寬到 6.5–8 m、電梯塔處（塔北面 o≈-8.3）由 3.3 m 放寬到 8.3 m
  // 2026-10-10 第二次加寬（宿舍南移 7.5 m）：隧道口段 10.5 m、電梯塔北面 o≈-10.8
  [0, -8.0],
  [4, -10.5],
  [24, -10.5],
  [30, -11.7], // 女一舍綠色鋼梯梯腳（s≈29、o≈-13）落在紅磚邊
  [40, -10.9],
  [52, -10.8],
  [64, -10.5],
  [SPLIT_LEN, -10.5],
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
    if (s > SPLIT_LEN) {
      // 上層坡道終點以外：二樓平台另由 DECK_2F 覆寫，平台前方即一樓廣場（與下層終點同高）
      target = profileAt(LOWER_PROFILE, SPLIT_LEN)
    } else target = profileAt(UPPER_PROFILE, s)
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

// ─── 二樓平台（使用者 2026-10-09 藍框 DJI_0037_108＋NLSC 正射 deck_raw.jpg）─────────
// 行政大樓前灰磚坡道（上層）爬上去是二樓平台：行政大樓東段前 → 橘褐色電梯塔 → 粉紅磚一層小樓（屋頂即平台）
// → 通識大樓前 → 圓環。平台前緣下方為商店／小樓店面，一樓紅磚言論廣場在其前方；圓環南側扇形階梯下到一樓。
/** 行政大樓東南面（A0 → 東端 A1）座標系：t 沿牆、off 往東南 */
const ADM_A0: Vec2 = { x: -138.7, z: 4.1 }
const ADM_A1: Vec2 = { x: -106.2, z: -18.7 }
const ADM_LEN = Math.hypot(ADM_A1.x - ADM_A0.x, ADM_A1.z - ADM_A0.z)
export const ADM_DIR: Vec2 = { x: (ADM_A1.x - ADM_A0.x) / ADM_LEN, z: (ADM_A1.z - ADM_A0.z) / ADM_LEN }
export function admFace(t: number, off: number): Vec2 {
  return { x: ADM_A0.x + ADM_DIR.x * t - ADM_DIR.z * off, z: ADM_A0.z + ADM_DIR.z * t + ADM_DIR.x * off }
}
/** 圓環：圓心（正射灰色半環雨棚），lx 沿通識大樓東南面、lz 朝東南；r0 平台半徑、r1 扇形階梯外緣 */
export const ROTUNDA = { x: -84, z: -32, yaw: Math.atan2(0.492, 0.87), r0: 7.2, r1: 13.2 }
export function rotundaWorld(lx: number, lz: number): Vec2 {
  const c = Math.cos(ROTUNDA.yaw)
  const s = Math.sin(ROTUNDA.yaw)
  return { x: ROTUNDA.x + lx * c + lz * s, z: ROTUNDA.z - lx * s + lz * c }
}
export function rotundaLocal(x: number, z: number): { lx: number; lz: number } {
  const c = Math.cos(ROTUNDA.yaw)
  const s = Math.sin(ROTUNDA.yaw)
  const dx = x - ROTUNDA.x
  const dz = z - ROTUNDA.z
  return { lx: dx * c - dz * s, lz: dx * s + dz * c }
}
/** 電梯塔（紅色角錐屋頂、四層）：塔身一半在平台前緣內，一樓門朝廣場、二樓門朝平台 */
export const DECK_LIFT = { ...admFace(40.4, 8.05), w: 4 }
/** 平台前緣（由上層坡道終點往東）：商店街 → 電梯塔 → 粉紅磚小樓 → 圓環西端 */
export const DECK_FRONT: Vec2[] = SPLIT_LINE.length
  ? [
      splitPoint(SPLIT_LEN, SPLIT_EDGE),
      admFace(38.4, 10.05),
      admFace(42.4, 10.05),
      admFace(42.4, 8.6),
      admFace(50.2, 8.6),
      admFace(50.2, 0.35),
      rotundaWorld(-ROTUNDA.r1, 0),
    ]
  : []
/** 圓環東端到通識大樓外牆的擋土牆 */
export const DECK_EAST: Vec2[] = [rotundaWorld(ROTUNDA.r1, 0), rotundaWorld(ROTUNDA.r1, -7.7)]
const G_SW: Vec2 = { x: -103.2, z: -28.9 }
const ADM_TIP: Vec2 = { x: -106.3, z: -18.7 }
export const DECK_2F: Vec2[] = SPLIT_LINE.length
  ? [...DECK_FRONT, ...DECK_EAST, G_SW, ADM_TIP, splitPoint(SPLIT_LEN, upperNorth(SPLIT_LEN))]
  : []
const DECK_BOX = boxOfPts(DECK_2F)
function boxOfPts(pts: Vec2[]) {
  return pts.length
    ? { x0: Math.min(...pts.map(p => p.x)), x1: Math.max(...pts.map(p => p.x)), z0: Math.min(...pts.map(p => p.z)), z1: Math.max(...pts.map(p => p.z)) }
    : { x0: 0, x1: -1, z0: 0, z1: -1 }
}
function inPolyXZ(x: number, z: number, pts: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]
    const b = pts[i]
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}
export function insideDeck(x: number, z: number): boolean {
  if (x < DECK_BOX.x0 || x > DECK_BOX.x1 || z < DECK_BOX.z0 || z > DECK_BOX.z1) return false
  return inPolyXZ(x, z, DECK_2F)
}
/** 二樓平台／圓環覆寫後的步行高程（b＝一樓地形高程） */
function deckHeight(x: number, z: number, b: number): number {
  if (insideDeck(x, z)) return DECK_H
  const { lx, lz } = rotundaLocal(x, z)
  if (lz < 0 || Math.abs(lx) > ROTUNDA.r1 || lz > ROTUNDA.r1) return b
  const r = Math.hypot(lx, lz)
  if (r <= ROTUNDA.r0) return DECK_H
  if (r >= ROTUNDA.r1 || b >= DECK_H) return b
  // 扇形階梯：步行以斜面近似（畫面上為 17 階）
  return DECK_H + (b - DECK_H) * ((r - ROTUNDA.r0) / (ROTUNDA.r1 - ROTUNDA.r0))
}
/** 平台後方：行政大樓東北面與通識大樓西面之間往圖書館的樓梯（自平台高程起，不低於平台） */
const DECK_REAR: Vec2[] = [ADM_TIP, { x: -117.7, z: -34.6 }, { x: -109.3, z: -39.6 }, G_SW]
function deckRearHeight(x: number, z: number, h: number): number {
  if (h >= DECK_H || x < -119 || x > -102 || z < -41 || z > -17) return h
  if (!inPolyXZ(x, z, DECK_REAR)) return h
  const dx = G_SW.x - ADM_TIP.x
  const dz = G_SW.z - ADM_TIP.z
  const L2 = dx * dx + dz * dz
  const u = Math.max(0, Math.min(1, ((x - ADM_TIP.x) * dx + (z - ADM_TIP.z) * dz) / L2))
  const d = Math.hypot(x - ADM_TIP.x - dx * u, z - ADM_TIP.z - dz * u)
  const w = 1 - smoothstep(8, 13, d)
  return h + (DECK_H - h) * w
}
if (DECK_2F.length) {
  AREAS.push({ id: 'deck-2f', kind: 'plaza', pts: DECK_2F })
  const fan: Vec2[] = []
  for (let i = 0; i <= 24; i++) {
    const a = (Math.PI * i) / 24
    fan.push(rotundaWorld(-ROTUNDA.r1 * Math.cos(a), ROTUNDA.r1 * Math.sin(a)))
  }
  AREAS.push({ id: 'rotunda-fan', kind: 'plaza', pts: fan })
}

// ─── 宿舍山坡（使用者 2026-10-09「宿舍往後走那片山沒做好」；DJI_0043_000–012 空拍）──────
// 紅磚坡道南緣外即是陡峭林坡：坡腳灰色矮牆＋綠籬，往南數公尺內陡升約 10 m 到坡頂平台；
// 女一舍 D2、男二舍 D3 與玻璃頂走廊蓋在平台上。坡腳過坡道終點後沿八方廣場南緣到扇形廣場東端，
// 平台東端在施工中的 B 西側以擋土牆切坡收邊（照片左下鷹架所在的凹地維持廣場高程）。
// 平台不開放步行（實景由宿舍樓梯／電梯塔上下），避免玩家一步登上 10 m 高的平台。
/** 坡腳離紅磚南緣的距離（矮牆＋綠籬） */
export const BANK_TOE_GAP = 1.4
/** 東端切坡（B 西牆前擋土牆）的 x 範圍 */
export const BANK_CUT_X0 = -74.8
export const BANK_CUT_X1 = -72.6
/** 擋土牆南端（再往南切坡逐漸放緩） */
export const BANK_CUT_Z = 34
export const BANK_TOE: Vec2[] = []
if (SPLIT_LINE.length) {
  for (let s = 0; s < SPLIT_LEN; s += 2) BANK_TOE.push(splitPoint(s, lowerSouth(s) - BANK_TOE_GAP))
  BANK_TOE.push(splitPoint(SPLIT_LEN, lowerSouth(SPLIT_LEN) - BANK_TOE_GAP))
  // 八方廣場南緣（扇形廣場東端花台前止）
  BANK_TOE.push({ x: -97.1, z: 2.0 }, { x: -84.4, z: 1.9 }, { x: -76.2, z: 1.4 })
}
const BANK_SEG = BANK_TOE.slice(1).map((b, i) => {
  const a = BANK_TOE[i]
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
  return { a, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len, len }
})
const BANK_ACC: number[] = []
BANK_SEG.reduce((t, g) => (BANK_ACC.push(t), t + g.len), 0)
export const BANK_LEN = BANK_SEG.reduce((t, g) => t + g.len, 0)
/** 坡頂平台高程（海拔，沿坡腳弧長）：約高出紅磚坡道 10 m，男二舍一帶再高約 1 m */
const BANK_TOP: [number, number][] = [
  [0, 22],
  [10, 25],
  [25, 27.5],
  [45, 28.6],
  [62, 30.6],
  [78, 32.4],
  [95, 33],
  [200, 33],
]
/** 坡面水平寬度：電梯塔一帶最陡（擋土牆＋植栽），往兩端放緩 */
const BANK_WIDTH: [number, number][] = [
  [0, 6.5],
  [30, 7],
  [42, 5.5],
  [58, 5.5],
  [72, 7.5],
  [200, 8],
]
const BANK_BOX = { x0: -195, x1: -60, z0: -15, z1: 125 }
/** 點相對坡腳：t 沿坡腳弧長、d 往坡內（南側）距離（負值＝坡道側）、u0 起點前的距離（負值） */
export function bankProject(x: number, z: number): { t: number; d: number; u0: number } {
  let best = { t: 0, d: -Infinity, u0: 0 }
  let bd = Infinity
  for (let i = 0; i < BANK_SEG.length; i++) {
    const g = BANK_SEG[i]
    const rx = x - g.a.x
    const rz = z - g.a.z
    const u = rx * g.dx + rz * g.dz
    const tc = Math.max(0, Math.min(g.len, u))
    const dist = Math.hypot(rx - g.dx * tc, rz - g.dz * tc)
    if (dist < bd) {
      bd = dist
      const o = rx * g.dz - rz * g.dx // 正值＝北（坡道側）
      best = { t: BANK_ACC[i] + tc, d: o <= 0 ? dist : -dist, u0: i === 0 ? Math.min(0, u) : 0 }
    }
  }
  return best
}
/** 坡頂平台高程（不含坡面漸變） */
export function bankTop(t: number): number {
  return profileAt(BANK_TOP, t)
}
/** 坡面權重 0（坡腳以外）→ 1（平台） */
export function bankWeight(x: number, z: number): number {
  if (!BANK_SEG.length || x < BANK_BOX.x0 || x > BANK_BOX.x1 || z < BANK_BOX.z0 || z > BANK_BOX.z1) return 0
  const { t, d, u0 } = bankProject(x, z)
  if (d <= 0) return 0
  let w = smoothstep(0, profileAt(BANK_WIDTH, t), d) * (1 - smoothstep(45, 80, d))
  // 東端：男二舍以北為 B 西牆前的垂直擋土牆；男二舍以南改為往東下降的自然坡（不在廣電大樓西側形成高牆）
  w *= 1 - smoothstep(BANK_CUT_X0 - Math.max(0, z - BANK_CUT_Z) * 1.2, BANK_CUT_X1, x)
  if (u0 < 0) w *= smoothstep(-6, 0, u0)
  return w
}
function bankHeight(x: number, z: number, h: number): number {
  const w = bankWeight(x, z)
  if (w <= 0) return h
  const P = bankTop(bankProject(x, z).t)
  return P > h ? h + (P - h) * w : h
}
for (const a of AREAS) {
  // 坡頂宿舍空地：著色與樹木避讓仍用，但不可步行
  if (a.id === 'apron-D1' || a.id === 'apron-D2' || a.id === 'apron-D3') a.noWalk = true
  // B 空地西緣退到切坡擋土牆外，凹地留在廣場高程
  if (a.id === 'apron-B') a.pts = a.pts.map(p => (p.x < BANK_CUT_X1 + 0.1 ? { x: BANK_CUT_X1 + 0.1, z: p.z } : p))
}

/** 一樓地形高程（不含二樓平台與圓環階梯；地形網格用） */
export function terrainBaseHeight(x: number, z: number): number {
  const h = deckRearHeight(x, z, bankHeight(x, z, splitHeight(x, z, rawHeight(x, z))))
  if (!SPORTS || !SPORTS_BOX) return h
  if (x < SPORTS_BOX.x0 - FLAT_MARGIN || x > SPORTS_BOX.x1 + FLAT_MARGIN || z < SPORTS_BOX.z0 - FLAT_MARGIN || z > SPORTS_BOX.z1 + FLAT_MARGIN) return h
  const d = polyDist(x, z, SPORTS.pts)
  if (d >= FLAT_MARGIN) return h
  const t = smoothstep(0, FLAT_MARGIN, d)
  return SPORTS_Y * (1 - t) + h * t
}
/** 步行地面高程（公尺，海拔）：一樓地形＋二樓平台／圓環階梯 */
export function groundHeight(x: number, z: number): number {
  return deckHeight(x, z, terrainBaseHeight(x, z))
}

// ─── 大禮堂西側樓梯、2F 入口平台與側門天橋（2026-10-10 地面影片 VID_20261005_115341_000–004）──────
// 軸向對齊的矩形，高度（相對 AUD_BASE）沿 axis 由 h0（x0 或 z0 端）線性變到 h1（x1 或 z1 端）；
// 畫面上是 0.16 m 的踏階，步行以斜面近似。over＝跨在通道上的天橋：下方另有可走地面，依目前所在高度決定上下層。
export interface StairPart {
  id: string
  x0: number
  x1: number
  z0: number
  z1: number
  axis: 'x' | 'z'
  h0: number
  h1: number
  over?: boolean
  /** 起點高度改取此點地面（相對 AUD_BASE），避免樓梯腳埋進較高的地面 */
  foot?: Vec2
}
/** 大禮堂 2F 入口層高度（相對廣場） */
export const AUD_2F = 4.2
/** 大禮堂西牆線（OSM 北段 x ≈ 104.6） */
export const AUD_WALL_X = 104.6
export const STAIR_PARTS: StairPart[] = [
  // 正面大樓梯：沿西牆由北往南爬升，兩跑＋中間平台，到 2F 入口平台北緣
  { id: 'main-1', x0: 98.7, x1: 104.3, z0: -34.6, z1: -31.0, axis: 'z', h0: 0, h1: AUD_2F / 2 },
  { id: 'main-mid', x0: 98.7, x1: 104.3, z0: -31.0, z1: -29.6, axis: 'z', h0: AUD_2F / 2, h1: AUD_2F / 2 },
  { id: 'main-2', x0: 98.7, x1: 104.3, z0: -29.6, z1: -26.0, axis: 'z', h0: AUD_2F / 2, h1: AUD_2F },
  // 2F 入口平台（門廊、方柱、雨遮）
  { id: 'terrace', x0: 98.3, x1: AUD_WALL_X, z0: -26.0, z1: -4.1, axis: 'z', h0: AUD_2F, h1: AUD_2F },
  // 西北角側樓梯：由西往東爬升 → 平台 → 跨過沿西牆北行通道的天橋 → 2F 側門
  { id: 'side-flight', x0: 88.4, x1: 95.9, z0: -49.4, z1: -45.6, axis: 'x', h0: 0, h1: AUD_2F, foot: { x: 88.4, z: -47.5 } },
  { id: 'side-landing', x0: 95.9, x1: 100.0, z0: -49.4, z1: -41.8, axis: 'x', h0: AUD_2F, h1: AUD_2F },
  { id: 'side-bridge', x0: 100.0, x1: AUD_WALL_X, z0: -44.5, z1: -41.8, axis: 'x', h0: AUD_2F, h1: AUD_2F, over: true },
]
export const STAIR_ZONE = (() => {
  const pad = 1.6
  return {
    x0: Math.min(...STAIR_PARTS.map(s => s.x0)) - pad,
    x1: Math.max(...STAIR_PARTS.map(s => s.x1)) + pad,
    z0: Math.min(...STAIR_PARTS.map(s => s.z0)) - pad,
    z1: Math.max(...STAIR_PARTS.map(s => s.z1)) + pad,
  }
})()
let AUD_BASE_CACHE: number | null = null
/** 樓梯起算的廣場高程（正面大樓梯腳） */
export function audBase(): number {
  if (AUD_BASE_CACHE === null) AUD_BASE_CACHE = groundHeight(101.5, -35.5)
  return AUD_BASE_CACHE
}
export function inStairZone(x: number, z: number): boolean {
  return x >= STAIR_ZONE.x0 && x <= STAIR_ZONE.x1 && z >= STAIR_ZONE.z0 && z <= STAIR_ZONE.z1
}
export function stairPartAt(x: number, z: number): StairPart | null {
  for (const s of STAIR_PARTS) if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1 && !s.over) return s
  for (const s of STAIR_PARTS) if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return s
  return null
}
/** 樓梯段起點高度（相對 AUD_BASE） */
export function stairH0(s: StairPart): number {
  return s.foot ? Math.max(0, Math.min(s.h1 - 1, groundHeight(s.foot.x, s.foot.z) - audBase())) : s.h0
}
function partHeight(s: StairPart, x: number, z: number): number {
  const t = s.axis === 'x' ? (x - s.x0) / (s.x1 - s.x0) : (z - s.z0) / (s.z1 - s.z0)
  const h0 = stairH0(s)
  return audBase() + h0 + (s.h1 - h0) * Math.max(0, Math.min(1, t))
}
/**
 * 玩家站立高度：一般等於 groundHeight；大禮堂樓梯／平台上為踏面高度。
 * 天橋下的通道有上下兩層，cur（目前站立高度）較接近哪一層就站在哪一層；未給 cur 時取地面層。
 */
export function walkHeight(x: number, z: number, cur?: number): number {
  const g = groundHeight(x, z)
  if (!inStairZone(x, z)) return g
  const s = stairPartAt(x, z)
  if (!s) return g
  const h = partHeight(s, x, z)
  if (!s.over) return h
  if (cur === undefined) return g
  return Math.abs(h - cur) < Math.abs(g - cur) ? h : g
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

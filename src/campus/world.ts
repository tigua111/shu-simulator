import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js'
import {
  AREAS,
  BACK_GATE,
  BOUNDS,
  BUILDINGS,
  DESTINATION,
  FOREST,
  NEIGHBORS,
  PATHS,
  ROUTE,
  STAGE,
  START,
  TRACK,
  TUNNEL,
  GATE_NORMAL,
  buildingById,
  centroid,
  groundHeight,
  splitDelta,
  splitPoint, lowerSouth, upperNorth, UPPER_START, LOWER_NORTH_OPEN,
  BANK_TOE, BANK_LEN, BANK_CUT_X1, BANK_CUT_Z, bankProject, bankTop, bankWeight,
  SPLIT_EDGE,
  SPLIT_LEN,
  terrainBaseHeight, DECK_2F, DECK_FRONT, DECK_EAST, DECK_H, DECK_LIFT, ROTUNDA, rotundaWorld, insideDeck, admFace, ADM_DIR,
  type AreaKind,
  type Building,
  type BuildingStyle,
  type PathKind,
  type Vec2,
} from './data'
import { LANDMARKS, type Landmark } from './landmarks'
import { CANOPY } from './canopy'
import { LOADED_EDITS, transformPoint, type Edit } from './edits'
import { MovableRegistry, bindObstacles, type Movable } from './movables'
import { PLAZA_SURVEY } from './plazaSurvey'
import { distToPolyline, insideSolid, isWalkable, onPaved, pointInPolygon, resample, routeLength, samplePath, type Obstacle } from './geometry'
import { STYLE_ROOF, arrowTexture, courtTexture, facadeTexture, fieldTexture, signTexture, solarTexture, stoneTexture } from './textures'

/** 可重現的亂數 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FLOOR_H = 3.8
const SINK = FLOOR_H * 2
const GRID = 1.6

// ─── 地形高度場（山坡 = 森林區內離步行區越遠越高） ─────────────
interface Field {
  nx: number
  nz: number
  hill: Float32Array
  paved: Uint8Array
}
let FIELD: Field | null = null

// ─── 樹冠遮罩（正射影像判讀） ───────────────────────────────
const CANOPY_BITS = (() => {
  const raw = atob(CANOPY.bits)
  const a = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i)
  return a
})()
/**
 * 航照判讀時被陰影濾掉、但空拍確認為連續樹林的區塊（場景座標 x 東、z 南）。
 * 0042_030：舍我樓主塔西側、南翼拱廊北面中庭以北一整片為濃密樹林，
 * 正射上因主塔與南翼陰影呈暗色而被樹冠遮罩排除，模型因此出現一片空地。
 */
const CANOPY_PATCHES: Vec2[][] = [
  [
    { x: -46, z: -45 },
    { x: 1.5, z: -45 },
    { x: 1.5, z: -63 },
    { x: -4, z: -78 },
    { x: -46, z: -78 },
  ],
]
/** 該點在航照上是否為樹冠 */
export function canopyAt(x: number, z: number): boolean {
  if (CANOPY_PATCHES.some(poly => pointInPolygon({ x, z }, poly))) return true
  const i = Math.round((x - CANOPY.minX) / CANOPY.step)
  const j = Math.round((z - CANOPY.minZ) / CANOPY.step)
  if (i < 0 || j < 0 || i >= CANOPY.nx || j >= CANOPY.nz) return false
  const k = j * CANOPY.nx + i
  return ((CANOPY_BITS[k >> 3] >> (7 - (k & 7))) & 1) === 1
}

// ─── 前校門座向：正面平行木柵路，隧道由門口垂直進入（data.ts 已把隧道改成折線） ───────────────
export const GATE_FRAME = (() => {
  const a = TUNNEL.pts[0]
  const nIn = GATE_NORMAL
  // 隧道開頭與立面垂直，開口只需隧道半寬加一點餘裕
  const halfOpen = TUNNEL.w / 2 + 0.5
  return { a, dir: nIn, nIn, tan: { x: nIn.z, z: -nIn.x }, cos: 1, halfOpen }
})()
/** 點相對前校門立面的深度（正值＝門內、負值＝木柵路側） */
function gateDepth(p: Vec2): number {
  return (p.x - GATE_FRAME.a.x) * GATE_FRAME.nIn.x + (p.z - GATE_FRAME.a.z) * GATE_FRAME.nIn.z
}
const GATE_CLEAR_R = 30

function smooth01(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}
const TUNNEL_LEN = (() => {
  let l = 0
  for (let i = 1; i < TUNNEL.pts.length; i++) l += Math.hypot(TUNNEL.pts[i].x - TUNNEL.pts[i - 1].x, TUNNEL.pts[i].z - TUNNEL.pts[i - 1].z)
  return l
})()
/** d：到隧道中心折線的距離；t：沿折線的弧長比例（門口 0、出口 1，可超出範圍） */
function tunnelParam(p: Vec2): { d: number; t: number } {
  const P = TUNNEL.pts
  let best = Infinity
  let bestS = 0
  let acc = 0
  for (let i = 1; i < P.length; i++) {
    const q = P[i - 1]
    const r = P[i]
    const vx = r.x - q.x
    const vz = r.z - q.z
    const l = Math.hypot(vx, vz) || 1
    let u = ((p.x - q.x) * vx + (p.z - q.z) * vz) / (l * l)
    // 兩端延伸，讓門外／出口外也有對應的 t
    if (i > 1) u = Math.max(0, u)
    if (i < P.length - 1) u = Math.min(1, u)
    const d = Math.hypot(p.x - q.x - u * vx, p.z - q.z - u * vz)
    if (d < best) {
      best = d
      bestS = acc + u * l
    }
    acc += l
  }
  return { d: best, t: bestS / TUNNEL_LEN }
}
function buildField(): Field {
  const nx = Math.floor((BOUNDS.maxX - BOUNDS.minX) / GRID) + 1
  const nz = Math.floor((BOUNDS.maxZ - BOUNDS.minZ) / GRID) + 1
  const dist = new Float32Array(nx * nz)
  const paved = new Uint8Array(nx * nz)
  const INF = 1e9
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const p = { x: BOUNDS.minX + i * GRID, z: BOUNDS.minZ + j * GRID }
      const k = j * nx + i
      const inForest = FOREST.some(f => pointInPolygon(p, f))
      const pv = onPaved(p)
      paved[k] = pv ? 1 : 0
      const tp = tunnelParam(p)
      const inTunnel = tp.d < TUNNEL.w / 2 + 6 && tp.t > 0.02 && tp.t < 0.98
      // 宿舍坡頂平台（data.ts 的 bankHeight 已抬升）視為起算點：平台平坦、往後山才再升起
      const seed = !inForest || (pv && !inTunnel) || insideSolid(p, 2) || bankWeight(p.x, p.z) > 0.5
      dist[k] = seed ? 0 : INF
    }
  }
  // 兩趟倒角距離轉換
  const a = GRID
  const b = GRID * Math.SQRT2
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      let d = dist[k]
      if (i > 0) d = Math.min(d, dist[k - 1] + a)
      if (j > 0) {
        d = Math.min(d, dist[k - nx] + a)
        if (i > 0) d = Math.min(d, dist[k - nx - 1] + b)
        if (i < nx - 1) d = Math.min(d, dist[k - nx + 1] + b)
      }
      dist[k] = d
    }
  for (let j = nz - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i
      let d = dist[k]
      if (i < nx - 1) d = Math.min(d, dist[k + 1] + a)
      if (j < nz - 1) {
        d = Math.min(d, dist[k + nx] + a)
        if (i < nx - 1) d = Math.min(d, dist[k + nx + 1] + b)
        if (i > 0) d = Math.min(d, dist[k + nx - 1] + b)
      }
      dist[k] = d
    }
  const hill = new Float32Array(nx * nz)
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      let h = 34 * (1 - Math.exp(-dist[k] / 48))
      const p = { x: BOUNDS.minX + i * GRID, z: BOUNDS.minZ + j * GRID }
      const tp = tunnelParam(p)
      const sd = gateDepth(p)
      // 校門前（木柵路側）清空：不長山坡與樹；門後山坡平順升起，清空區外緣平順銜接
      const rg = Math.hypot(p.x - GATE_FRAME.a.x, p.z - GATE_FRAME.a.z)
      if (rg < GATE_CLEAR_R) {
        const keep = smooth01((rg - (GATE_CLEAR_R - 10)) / 10)
        const sdF = sd < 0.5 ? 0 : smooth01((sd - 0.5) / 6)
        h *= keep + (1 - keep) * sdF
      }
      if (tp.d < TUNNEL.w / 2 + 4 && sd > 1 && tp.t > -0.3 && tp.t < 0.985) h = Math.max(h, 10)
      hill[k] = h
    }
  return { nx, nz, hill, paved }
}

function field(): Field {
  if (!FIELD) FIELD = buildField()
  return FIELD
}

/** 山坡高度（相對步行地面），雙線性內插 */
export function hillAt(x: number, z: number): number {
  const f = field()
  const fx = Math.max(0, Math.min(f.nx - 1.001, (x - BOUNDS.minX) / GRID))
  const fz = Math.max(0, Math.min(f.nz - 1.001, (z - BOUNDS.minZ) / GRID))
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  const u = fx - i
  const w = fz - j
  const k = j * f.nx + i
  const h = f.hill
  return (h[k] * (1 - u) + h[k + 1] * u) * (1 - w) + (h[k + f.nx] * (1 - u) + h[k + f.nx + 1] * u) * w
}

/** 地形表面高度（含山坡） */
export function terrainHeight(x: number, z: number): number {
  return groundHeight(x, z) + hillAt(x, z)
}

// ─── 擠出多邊形工具 ─────────────────────────────────────
function shapeOf(pts: Vec2[]): THREE.Shape {
  const s = new THREE.Shape()
  pts.forEach((p, i) => (i === 0 ? s.moveTo(p.x, -p.z) : s.lineTo(p.x, -p.z)))
  s.closePath()
  return s
}

/** 由 y0 擠出到 y1 的多邊形量體；回傳 [屋頂/底面, 側牆] 兩組幾何 */
function prism(pts: Vec2[], y0: number, y1: number): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const geo = new THREE.ExtrudeGeometry(shapeOf(pts), { depth: y1 - y0, bevelEnabled: false })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, y0, 0)
  return splitGroups(geo)
}

function splitGroups(geo: THREE.BufferGeometry): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const out: THREE.BufferGeometry[] = []
  for (const g of geo.groups.slice(0, 2)) {
    const part = new THREE.BufferGeometry()
    for (const name of ['position', 'normal', 'uv']) {
      const attr = geo.getAttribute(name) as THREE.BufferAttribute
      const size = attr.itemSize
      part.setAttribute(name, new THREE.BufferAttribute((attr.array as Float32Array).slice(g.start * size, (g.start + g.count) * size), size))
    }
    out.push(part)
  }
  geo.dispose()
  return [out[0], out[1]]
}

const facadeMats = new Map<string, THREE.MeshLambertMaterial>()
function facadeMat(style: BuildingStyle, floorH: number, sink: number): THREE.MeshLambertMaterial {
  const key = `${style}:${floorH}:${sink}`
  const hit = facadeMats.get(key)
  if (hit) return hit
  const t = facadeTexture(style).clone()
  t.needsUpdate = true
  const bay = style === 'auditorium' ? 6 : style === 'city' ? 5 : 4
  t.repeat.set(1 / bay, -1 / floorH)
  t.offset.set(0, (1 + sink) / floorH)
  const m =
    style === 'scaffold'
      ? new THREE.MeshLambertMaterial({ map: t, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, depthWrite: false })
      : new THREE.MeshLambertMaterial({ map: t })
  facadeMats.set(key, m)
  return m
}

/** 多邊形中面向 target 的最長邊 */
/** 橘褐色框＋藍綠玻璃的電梯塔（通識大樓前、女一舍前；街景） */
/** 女一舍面向紅磚坡道的電梯塔（坡腳）與沿女一舍北面往隧道口下降的綠色頂棚鋼梯 */
const D2_LIFT_AT = { x: -133.8, z: 20.2 }
const D2_STAIR_DIR = { x: -0.821, z: 0.573 }
const D2_STAIR_A = { x: D2_LIFT_AT.x + D2_STAIR_DIR.x * 2.6, z: D2_LIFT_AT.z + D2_STAIR_DIR.z * 2.6 }
const D2_STAIR_B = { x: D2_LIFT_AT.x + D2_STAIR_DIR.x * 19.6, z: D2_LIFT_AT.z + D2_STAIR_DIR.z * 19.6 }
const BANK_ACC: number[] = (() => {
  const a = [0]
  for (let i = 1; i < BANK_TOE.length; i++) a.push(a[i - 1] + Math.hypot(BANK_TOE[i].x - BANK_TOE[i - 1].x, BANK_TOE[i].z - BANK_TOE[i - 1].z))
  return a
})()
/** 宿舍山坡坡腳取樣：弧長 t 處的坡腳點與前進方向（坡面在法向 (-dir.z, dir.x) 一側＝南側） */
function toeSample(t: number): { p: Vec2; dir: Vec2 } {
  const toe = BANK_TOE
  let i = 1
  while (i < toe.length - 1 && BANK_ACC[i] < t) i++
  const a = toe[i - 1]
  const b = toe[i]
  const len = BANK_ACC[i] - BANK_ACC[i - 1] || 1
  const u = Math.max(0, Math.min(1, (t - BANK_ACC[i - 1]) / len))
  return { p: { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }, dir: { x: (b.x - a.x) / len, z: (b.z - a.z) / len } }
}
/** 坡頂平台高程（坡腳弧長取點） */
const plateauAt = (x: number, z: number): number => bankTop(bankProject(x, z).t)
function liftTower(g: THREE.Group, w: number, h: number): void {
  const glass = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, h, w - 0.3), new THREE.MeshLambertMaterial({ color: 0x3e6f6d }))
  glass.position.y = h / 2
  const fr = new THREE.MeshLambertMaterial({ color: 0xa5532f })
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.5, h + 0.4, 0.5), fr)
      c.position.set((sx * w) / 2, (h + 0.4) / 2, (sz * w) / 2)
      g.add(c)
    }
  for (let y = 3.4; y < h; y += 3.4) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.35, w + 0.1), fr)
    band.position.y = y
    g.add(band)
  }
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.6, w + 0.4), fr)
  cap.position.y = h + 0.3
  const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.55, 2.4, w + 0.2), new THREE.MeshLambertMaterial({ color: 0x8d8f91 }))
  door.position.y = 1.2
  g.add(glass, cap, door)
}

/** 雙球黃色路燈（隧道出口坡道、行政大樓前；街景） */
function globeLamp(): THREE.Group {
  const g = new THREE.Group()
  const dark = new THREE.MeshLambertMaterial({ color: 0x2f3236 })
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 4.2, 8), dark)
  pole.position.y = 2.1
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.08), dark)
  arm.position.y = 4.1
  g.add(pole, arm)
  const gm = new THREE.MeshBasicMaterial({ color: 0xf1e2a6 })
  for (const sx of [-0.5, 0.5]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), gm)
    b.position.set(sx, 4.4, 0)
    g.add(b)
  }
  return g
}

function shopTexture(): THREE.CanvasTexture {
  // 一張貼圖＝12 m 長、4.5 m 高的商店街立面
  const c = document.createElement('canvas')
  c.width = 768
  c.height = 288
  const x = c.getContext('2d')!
  const py = (m: number) => 288 - (m / 4.5) * 288
  x.fillStyle = '#34373b'
  x.fillRect(0, 0, 768, 288)
  const bays = 4
  const bw = 768 / bays
  const signs = ['#c8202b', '#2f8a3a', '#d8d1c4', '#c8202b']
  const label = ['輕食', '便利商店', '書局', '餐飲']
  for (let i = 0; i < bays; i++) {
    const x0 = i * bw
    // 店內暖光玻璃
    const grd = x.createLinearGradient(0, py(2.8), 0, py(0))
    grd.addColorStop(0, '#e0c58f')
    grd.addColorStop(1, '#8a6f4a')
    x.fillStyle = grd
    x.fillRect(x0 + 10, py(2.8), bw - 20, py(0) - py(2.8))
    x.fillStyle = 'rgba(30,30,30,0.55)'
    for (let k = 1; k < 4; k++) x.fillRect(x0 + 10 + (k * (bw - 20)) / 4 - 2, py(2.8), 4, py(0) - py(2.8))
    // 招牌帶
    x.fillStyle = '#1f2124'
    x.fillRect(x0 + 6, py(3.5), bw - 12, py(2.9) - py(3.5))
    x.fillStyle = signs[i]
    x.fillRect(x0 + 18, py(3.42), bw * 0.55, py(2.98) - py(3.42))
    x.fillStyle = signs[i] === '#d8d1c4' ? '#333' : '#fff'
    x.font = 'bold 26px sans-serif'
    x.textBaseline = 'middle'
    x.fillText(label[i], x0 + 26, (py(3.42) + py(2.98)) / 2)
  }
  // 柱
  x.fillStyle = '#17181a'
  for (let i = 0; i <= bays; i++) x.fillRect(i * bw - 7, 0, 14, 288)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  return t
}

/** 粉紅磚牆（8 m 長、4.5 m 高）；windows＝粉紅磚一層小樓店面（門、窗、黃色招牌帶） */
/** 舍我樓紅褐面磚（2 m × 2 m 一張；每塊磚色略有深淺） */
function sheBrickTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const x = c.getContext('2d')!
  x.fillStyle = '#7d4a3c'
  x.fillRect(0, 0, 256, 256)
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let y = 0, row = 0; y < 256; y += 10, row++) {
    for (let k = row % 2 ? -15 : 0; k < 256; k += 30) {
      const v = Math.floor(rnd() * 26) - 13
      x.fillStyle = `rgb(${172 + v},${Math.round(104 + v * 0.7)},${Math.round(82 + v * 0.5)})`
      x.fillRect(k + 1, y + 1, 28, 8)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}
/** 讓 BoxGeometry 各面的 UV 依實際尺寸（每 tile 公尺一張貼圖）重複 */
function scaleBoxUV(g: THREE.BoxGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = g.getAttribute('uv')
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
  for (let f = 0; f < 6; f++) {
    const [a, b] = dims[f]
    for (let k = f * 4; k < f * 4 + 4; k++) uv.setXY(k, (uv.getX(k) * a) / tile, (uv.getY(k) * b) / tile)
  }
}
function pinkBrickTexture(windows: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 288
  const x = c.getContext('2d')!
  x.fillStyle = '#c98a7d'
  x.fillRect(0, 0, 512, 288)
  x.fillStyle = 'rgba(120,60,50,0.28)'
  for (let y = 0; y < 288; y += 8) x.fillRect(0, y, 512, 1.4)
  for (let y = 0; y < 288; y += 16) for (let k = (y / 16) % 2 ? 0 : 16; k < 512; k += 32) x.fillRect(k, y, 1.4, 8)
  const py = (m: number) => 288 - (m / 4.5) * 288
  if (windows) {
    x.fillStyle = '#e8c35a'
    x.fillRect(0, py(3.35), 512, py(2.85) - py(3.35))
    x.fillStyle = '#7a3b2e'
    x.font = 'bold 24px sans-serif'
    x.textBaseline = 'middle'
    x.fillText('世新 校園服務', 24, (py(3.35) + py(2.85)) / 2)
    const glass = x.createLinearGradient(0, py(2.5), 0, py(0))
    glass.addColorStop(0, '#5f7f86')
    glass.addColorStop(1, '#2f474c')
    x.fillStyle = glass
    x.fillRect(40, py(2.5), 120, py(0) - py(2.5))
    x.fillRect(300, py(2.3), 80, py(1.0) - py(2.3))
    x.fillRect(410, py(2.3), 80, py(1.0) - py(2.3))
    x.fillStyle = '#e8e2d6'
    x.fillRect(96, py(2.5), 6, py(0) - py(2.5))
    for (const x0 of [300, 410]) x.fillRect(x0 - 4, py(1.0), 88, 6)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  return t
}
function brickBoardTexture(): THREE.CanvasTexture {
  // 8 m 長、4.5 m 高：紅磚牆＋公告欄
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 288
  const x = c.getContext('2d')!
  x.fillStyle = '#9a4b38'
  x.fillRect(0, 0, 512, 288)
  x.fillStyle = 'rgba(60,25,18,0.35)'
  for (let y = 0; y < 288; y += 9) x.fillRect(0, y, 512, 1.5)
  const py = (m: number) => 288 - (m / 4.5) * 288
  for (const x0 of [40, 290]) {
    x.fillStyle = '#5b3024'
    x.fillRect(x0 - 6, py(2.1), 192, py(0.7) - py(2.1))
    x.fillStyle = '#e9e3d6'
    x.fillRect(x0, py(2.0), 180, py(0.8) - py(2.0))
    x.fillStyle = '#4b7fb8'
    x.fillRect(x0 + 12, py(1.85), 60, 26)
    x.fillStyle = '#d9a23a'
    x.fillRect(x0 + 96, py(1.75), 64, 34)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  return t
}

function faceToward(pts: Vec2[], target: Vec2): { mid: Vec2; n: Vec2; len: number; yaw: number } {
  const c = centroid(pts)
  let best = { mid: pts[0], n: { x: 0, z: 1 }, len: 0, yaw: 0 }
  let bestScore = -Infinity
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < 2) continue
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
    let n = { x: (b.z - a.z) / len, z: -(b.x - a.x) / len }
    if (n.x * (mid.x - c.x) + n.z * (mid.z - c.z) < 0) n = { x: -n.x, z: -n.z }
    const tx = target.x - mid.x
    const tz = target.z - mid.z
    const tl = Math.hypot(tx, tz) || 1
    const facing = (n.x * tx + n.z * tz) / tl
    const score = facing * Math.min(len, 30)
    if (score > bestScore) {
      bestScore = score
      best = { mid, n, len, yaw: Math.atan2(n.x, n.z) }
    }
  }
  return best
}

/** 多邊形朝質心縮放（屋頂設備、核心用） */
function inset(pts: Vec2[], k: number): Vec2[] {
  const c = centroid(pts)
  return pts.map(p => ({ x: c.x + (p.x - c.x) * k, z: c.z + (p.z - c.z) * k }))
}

/** 全媒體大樓東面巨幅海報（程序化重繪：藍綠漸層、電路紋、標題、QR 樣式方塊；非照片貼圖） */
function omBannerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 384
  c.height = 960
  const x = c.getContext('2d')!
  const gr = x.createLinearGradient(0, 0, 0, 960)
  gr.addColorStop(0, '#3dbccb')
  gr.addColorStop(0.45, '#1c6c90')
  gr.addColorStop(1, '#0e2c55')
  x.fillStyle = gr
  x.fillRect(0, 0, 384, 960)
  let seed = 11
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  x.lineWidth = 3
  for (let i = 0; i < 30; i++) {
    let px = rnd() * 384
    let py = 260 + rnd() * 700
    x.strokeStyle = 'rgba(110,232,255,0.55)'
    x.beginPath()
    x.moveTo(px, py)
    for (let k = 0; k < 4; k++) {
      if (k % 2 === 0) py -= 40 + rnd() * 120
      else px += (rnd() - 0.5) * 110
      x.lineTo(px, py)
    }
    x.stroke()
    x.fillStyle = 'rgba(170,246,255,0.95)'
    x.beginPath()
    x.arc(px, py, 5, 0, Math.PI * 2)
    x.fill()
  }
  const F = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif'
  x.fillStyle = '#ffffff'
  x.textAlign = 'center'
  x.font = `700 28px ${F}`
  x.fillText('世新大學', 192, 66)
  x.font = `900 96px ${F}`
  x.fillText('全媒體', 192, 178)
  x.font = `700 36px ${F}`
  x.fillText('開創世新新世代', 192, 234)
  x.font = `600 24px ${F}`
  x.fillText('O M N I   M E D I A', 192, 276)
  const q = 150
  const qx = 192 - q / 2
  const qy = 318
  x.fillStyle = '#ffffff'
  x.fillRect(qx - 12, qy - 12, q + 24, q + 24)
  const n = 21
  const cell = q / n
  x.fillStyle = '#111111'
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (rnd() < 0.5) x.fillRect(qx + i * cell, qy + j * cell, cell, cell)
  for (const [fx, fy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ]) {
    x.fillStyle = '#111111'
    x.fillRect(qx + fx * cell, qy + fy * cell, 7 * cell, 7 * cell)
    x.fillStyle = '#ffffff'
    x.fillRect(qx + (fx + 1) * cell, qy + (fy + 1) * cell, 5 * cell, 5 * cell)
    x.fillStyle = '#111111'
    x.fillRect(qx + (fx + 2) * cell, qy + (fy + 2) * cell, 3 * cell, 3 * cell)
  }
  x.fillStyle = '#ffffff'
  x.font = `700 30px ${F}`
  x.fillText('CNN 在台第一所夥伴大學', 192, 560)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** 淺灰拋光磁磚（約 0.6 m 一塊；uv 以 1.2 m 為一單位） */
function paleTileTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')!
  const tones = ['#dadbd6', '#d3d4cf', '#dfe0db', '#d6d7d2']
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    x.fillStyle = tones[i * 2 + j]
    x.fillRect(i * 64, j * 64, 64, 64)
  }
  x.strokeStyle = '#b4b5b0'
  x.lineWidth = 2
  x.strokeRect(1, 1, 126, 126)
  x.beginPath()
  x.moveTo(64, 0)
  x.lineTo(64, 128)
  x.moveTo(0, 64)
  x.lineTo(128, 64)
  x.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/** 噴水池放射狀磁磚圓盤（同心圓＋放射縫；uv 為圓盤平面座標） */
function radialPavingTexture(): THREE.CanvasTexture {
  const S = 1024
  const c = document.createElement('canvas')
  c.width = c.height = S
  const x = c.getContext('2d')!
  x.fillStyle = '#dcdcd7'
  x.fillRect(0, 0, S, S)
  const R = S / 2
  x.strokeStyle = '#a9aaa5'
  x.lineWidth = 2
  const rings = 18
  for (let k = 1; k <= rings; k++) {
    const r = (R * k) / rings
    x.beginPath()
    x.arc(R, R, r, 0, Math.PI * 2)
    x.stroke()
    const r0 = (R * (k - 1)) / rings
    const seg = Math.max(6, Math.round((2 * Math.PI * r) / 34))
    x.beginPath()
    for (let i = 0; i < seg; i++) {
      const a = (Math.PI * 2 * (i + (k % 2) * 0.5)) / seg
      x.moveTo(R + r0 * Math.cos(a), R + r0 * Math.sin(a))
      x.lineTo(R + r * Math.cos(a), R + r * Math.sin(a))
    }
    x.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** 洗石子牆面（灰褐細碎石） */
function pebbleTexture(rx: number, ry: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')!
  x.fillStyle = '#8e877c'
  x.fillRect(0, 0, 128, 128)
  let seed = 5
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 900; i++) {
    const v = rnd()
    x.fillStyle = v < 0.4 ? '#6e685f' : v < 0.75 ? '#a8a194' : '#c1bbae'
    x.fillRect(rnd() * 128, rnd() * 128, 2, 2)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(rx, ry)
  return t
}

function baseOf(pts: Vec2[]): number {
  return Math.min(...pts.map(p => groundHeight(p.x, p.z)))
}

export interface LabelEntry {
  obj: CSS2DObject
  landmark: Landmark
  pos: THREE.Vector3
}

export class CampusWorld {
  readonly scene = new THREE.Scene()
  readonly labels: LabelEntry[] = []
  /** 建築 id → 以質心為原點的樞紐群組 */
  readonly buildingPivots = new Map<string, THREE.Group>()
  readonly obstacles: Obstacle[] = []
  /** 用來判斷標籤是否被建築遮住的網格 */
  readonly occluders: THREE.Object3D[] = []
  readonly tunnelPts = TUNNEL.pts
  /** 編輯模式可移動的所有物件 */
  readonly movables = new MovableRegistry()
  readonly sun: THREE.DirectionalLight
  private beacon!: THREE.Group

  constructor() {
    const scene = this.scene
    scene.fog = new THREE.Fog(0xdfe8ec, 320, 1700)
    this.addSky()
    scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x5d7a45, 1.7))
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0005
    this.sun.shadow.normalBias = 0.4
    scene.add(this.sun, this.sun.target)
    this.setShadowFocus(START.pos.x, START.pos.z, false)

    this.addGround()
    this.addPaths()
    this.addSportsGround()
    for (const b of BUILDINGS) {
      // 以質心為樞紐包一層，編輯模式可直接平移／旋轉
      const pivot = new THREE.Group()
      pivot.position.set(b.c.x, 0, b.c.z)
      const g = this.makeBuilding(b)
      g.position.set(-b.c.x, 0, -b.c.z)
      pivot.add(g)
      pivot.userData.bid = b.id
      scene.add(pivot)
      this.buildingPivots.set(b.id, pivot)
      // 建築調整寫回資料（啟動時已套用 base），樞紐只承載本次工作階段的增量
      const base: Edit = LOADED_EDITS[b.id] ?? { dx: 0, dz: 0, rot: 0 }
      const start = pivot.position.clone()
      const mv: Movable = {
        id: b.id,
        kind: 'building',
        label: b.name,
        num: b.num,
        home: { x: b.c.x - base.dx, z: b.c.z - base.dz },
        edit: { ...base },
        dataLevel: true,
        apply: e => {
          mv.edit = { ...e }
          pivot.position.set(start.x + e.dx - base.dx, 0, start.z + e.dz - base.dz)
          pivot.rotation.y = e.rot - base.rot
          pivot.updateMatrixWorld(true)
        },
        bounds: t => t.setFromObject(pivot),
      }
      this.movables.add(mv, pivot)
    }
    this.addNeighbors()
    this.addGateAndTunnel()
    this.capture('obj:stage', '八風舞台', '', 'ground', () => this.addStage())
    this.addCampusDetails()
    this.addSheWoHall()
    this.addPlazaFurniture()
    this.addCourtSurroundings()
    this.addYanlun()
    this.addDeck2F()
    this.addTunnelExitTerrace()
    this.addDormBank()
    this.addMgmtPlaza()
    this.capture('obj:back-gate', '後校門', '16', 'ground', () => this.addBackGate())
    this.addFences()
    this.addStreetDressing()
    this.addTrees()
    this.addLamps()
    this.addRouteArrows()
    this.addBeacon()
    this.addLabels()
    this.applySavedEdits()
  }

  /**
   * 把 build 期間加入場景的物件收進一個以外框中心為樞紐的群組，登錄為可移動物件。
   * build 期間加入的碰撞點也跟著移動；follow 決定移動後是否貼齊新位置的地面高度。
   */
  private capture(id: string, label: string, num: string, follow: 'ground' | 'terrain' | 'none', build: () => void): THREE.Group | null {
    const g = new THREE.Group()
    const scene = this.scene as unknown as { add: (...o: THREE.Object3D[]) => unknown }
    const o0 = this.obstacles.length
    scene.add = (...objs: THREE.Object3D[]) => {
      g.add(...objs)
      return this.scene
    }
    try {
      build()
    } finally {
      delete (scene as { add?: unknown }).add
    }
    if (!g.children.length) return null
    const box = new THREE.Box3().setFromObject(g)
    const c = { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 }
    for (const ch of g.children) {
      ch.position.x -= c.x
      ch.position.z -= c.z
    }
    g.position.set(c.x, 0, c.z)
    this.scene.add(g)
    const moveObs = bindObstacles(this.obstacles.slice(o0), c)
    const yAt = (x: number, z: number) => (follow === 'none' ? 0 : follow === 'terrain' ? terrainHeight(x, z) : groundHeight(x, z))
    const h0 = yAt(c.x, c.z)
    const mv: Movable = {
      id,
      kind: 'object',
      label,
      num: num || undefined,
      home: c,
      edit: { dx: 0, dz: 0, rot: 0 },
      dataLevel: false,
      apply: e => {
        mv.edit = { ...e }
        const nx = c.x + e.dx
        const nz = c.z + e.dz
        g.position.set(nx, yAt(nx, nz) - h0, nz)
        g.rotation.y = e.rot
        g.updateMatrixWorld(true)
        moveObs(e)
      },
      bounds: t => t.setFromObject(g),
    }
    this.movables.add(mv, g)
    return g
  }

  /** 啟動時套用保存的非資料層調整（樹、路燈、構造物…） */
  private applySavedEdits(): void {
    for (const m of this.movables.items.values()) {
      if (m.dataLevel) continue
      const e = LOADED_EDITS[m.id]
      if (e) m.apply(e)
    }
  }

  /** 陰影相機跟著玩家，總覽時涵蓋全區 */
  setShadowFocus(x: number, z: number, wide: boolean): void {
    const s = this.sun.shadow.camera
    const size = wide ? 380 : 110
    s.left = -size
    s.right = size
    s.top = size
    s.bottom = -size
    s.near = 1
    s.far = 900
    s.updateProjectionMatrix()
    const y = groundHeight(x, z)
    this.sun.target.position.set(x, y, z)
    this.sun.position.set(x - 140, y + 260, z + 110)
  }

  update(time: number): void {
    if (this.beacon) {
      const s = 1 + Math.sin(time * 2.2) * 0.08
      this.beacon.scale.set(s, 1, s)
      ;(this.beacon.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity = 0.28 + Math.sin(time * 2.2) * 0.08
    }
  }

  // ─── 天空 ───────────────────────────────────────────
  private addSky(): void {
    // 天空球跟著相機移動，半徑小於相機遠裁切面，任何視角都不會被裁出黑塊
    const geo = new THREE.SphereGeometry(1100, 32, 16)
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(0x7fb4e3) }, horizon: { value: new THREE.Color(0xe6eef0) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 horizon; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 1.6, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, h), 1.0); }',
    })
    const sky = new THREE.Mesh(geo, mat)
    sky.renderOrder = -10
    sky.frustumCulled = false
    sky.onBeforeRender = (_r, _s, cam) => {
      sky.position.copy(cam.position)
      sky.updateMatrixWorld()
      sky.modelViewMatrix.multiplyMatrices(cam.matrixWorldInverse, sky.matrixWorld)
    }
    this.scene.add(sky)
    // 遠方山稜（木柵、景美一帶）：連續環帶，高低起伏；南、東南側（指南山、二格山方向）較高
    const r = rng(7)
    const seg = 160
    const rings = [700, 820, 960, 1100]
    const phase = [r() * 6, r() * 6, r() * 6, r() * 6]
    const height = (a: number, k: number) => {
      const south = 0.65 + 0.35 * Math.max(0, Math.sin(a + 0.4))
      const n =
        0.55 +
        0.25 * Math.sin(a * 3 + phase[0]) +
        0.12 * Math.sin(a * 7 + phase[1]) +
        0.08 * Math.sin(a * 13 + phase[2]) +
        0.05 * Math.sin(a * 23 + phase[3])
      return [0, 70, 150, 120][k] * south * Math.max(0.15, n) * (k === 0 ? 0 : 1)
    }
    const pos: number[] = []
    const col: number[] = []
    const idx: number[] = []
    const near = new THREE.Color(0x3f5e3a)
    const far = new THREE.Color(0x7d9488)
    const cc = new THREE.Color()
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2
      rings.forEach((rad, k) => {
        const jitter = k === 0 ? 0 : (r() - 0.5) * 30
        pos.push(20 + Math.cos(a) * (rad + jitter), -2 + height(a, k), 65 + Math.sin(a) * (rad + jitter))
        cc.copy(near).lerp(far, k / (rings.length - 1))
        col.push(cc.r, cc.g, cc.b)
      })
    }
    const nr = rings.length
    for (let i = 0; i < seg; i++) {
      for (let k = 0; k < nr - 1; k++) {
        const a = i * nr + k
        const b = (i + 1) * nr + k
        idx.push(a, b, a + 1, b, b + 1, a + 1)
      }
    }
    const rg = new THREE.BufferGeometry()
    rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    rg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    rg.setIndex(idx)
    rg.computeVertexNormals()
    const ridge = new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))
    ridge.name = 'ridges'
    this.scene.add(ridge)
  }

  // ─── 地形 ─────────────────────────────────────────
  private addGround(): void {
    const f = field()
    const w = (f.nx - 1) * GRID
    const d = (f.nz - 1) * GRID
    const geo = new THREE.PlaneGeometry(w, d, f.nx - 1, f.nz - 1)
    geo.rotateX(-Math.PI / 2)
    geo.translate(BOUNDS.minX + w / 2, 0, BOUNDS.minZ + d / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const r = rng(11)
    // 空拍：山坡為連續濃密闊葉林（林下陰暗），市區地面多為灰色柏油與水泥
    const forest = new THREE.Color(0x2f4d2a)
    const understory = new THREE.Color(0x3c5a31)
    const urban = new THREE.Color(0x9e9c98)
    const areaColor: Record<AreaKind, THREE.Color> = {
      plaza: new THREE.Color(0xcf9f8a),
      sports: new THREE.Color(0xb5473a),
      court: new THREE.Color(0x3d6fa8),
      field: new THREE.Color(0x4f9e4a),
      grounds: new THREE.Color(0xcdbfb0),
      apron: new THREE.Color(0xc8bdb0),
    }
    const areaOrder: AreaKind[] = ['plaza', 'sports', 'grounds', 'apron']
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k)
      const z = pos.getZ(k)
      const hill = hillAt(x, z)
      pos.setY(k, terrainBaseHeight(x, z) + hill)
      const jitter = (r() - 0.5) * 0.06
      const p = { x, z }
      let set = false
      const tree = canopyAt(x, z) && !onPaved(p)
      const bw = bankWeight(x, z)
      if (bw > 0.03 && bw < 0.97 && !onPaved(p)) {
        // 宿舍山坡坡面：林下陰暗（DJI_0043_000–007）
        c.copy(forest).offsetHSL(jitter * 0.5, 0, jitter)
        set = true
      } else if (tree) {
        c.copy(forest).offsetHSL(jitter * 0.5, 0, jitter)
        set = true
      } else if (hill > 0.5) {
        c.copy(understory).offsetHSL(jitter * 0.4, 0, jitter)
        set = true
      } else {
        for (const kind of areaOrder) {
          const a = AREAS.find(ar => ar.kind === kind && pointInPolygon(p, ar.pts))
          if (a) {
            c.copy(areaColor[a.kind])
            set = true
            break
          }
        }
      }
      if (!set) {
        const inForest = FOREST.some(fp => pointInPolygon(p, fp))
        if (inForest) c.copy(understory).offsetHSL(jitter * 0.4, 0, jitter)
        else c.copy(urban).offsetHSL(0, 0, jitter * 0.6)
      }
      colors[k * 3] = c.r
      colors[k * 3 + 1] = c.g
      colors[k * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    // 隧道兩端：地形由 0 升到隧道上方山坡的過渡三角面會穿進拱門開口，挖掉
    {
      const idx = geo.index!
      const keep: number[] = []
      const half = TUNNEL.w / 2
      for (let t = 0; t < idx.count; t += 3) {
        const i0 = idx.getX(t)
        const i1 = idx.getX(t + 1)
        const i2 = idx.getX(t + 2)
        const cx = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3
        const cz = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3
        const tp = tunnelParam({ x: cx, z: cz })
        const sd = gateDepth({ x: cx, z: cz })
        const front = tp.d < GATE_FRAME.halfOpen + 1.2 && sd > -0.2 && sd < 5
        const back = tp.d < half + 1.5 && tp.t > 0.94 && tp.t < 1.04
        if (front || back) continue
        keep.push(i0, i1, i2)
      }
      geo.setIndex(keep)
    }
    geo.computeVertexNormals()
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }))
    ground.receiveShadow = true
    ground.name = 'terrain'
    this.scene.add(ground)
  }

  // ─── 道路與步道鋪面 ───────────────────────────────────
  private addPaths(): void {
    const style: Record<PathKind, { color: number; lift: number }> = {
      road: { color: 0x55565b, lift: 0.08 },
      lane: { color: 0xa86b5b, lift: 0.1 },
      footway: { color: 0xc49a83, lift: 0.12 },
      steps: { color: 0xd5cdc2, lift: 0.14 },
      covered: { color: 0xc49a83, lift: 0.12 },
      tunnel: { color: 0x5d5e62, lift: 0.08 },
      concrete: { color: 0xb3b0a8, lift: 0.11 },
    }
    const groups = new Map<PathKind, THREE.BufferGeometry[]>()
    for (const p of PATHS) {
      // 行政大樓前上層坡道為灰色斜格紋磚（街景），以水泥灰呈現
      const kind: PathKind = p.id === 'ramp-2' ? 'concrete' : p.kind
      const g = this.ribbon(p.pts, p.w, style[kind].lift)
      if (!groups.has(kind)) groups.set(kind, [])
      groups.get(kind)!.push(g)
    }
    for (const [kind, geos] of groups) {
      const mat = new THREE.MeshLambertMaterial({ color: style[kind].color, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })
      const m = new THREE.Mesh(mergeGeometries(geos), mat)
      m.receiveShadow = true
      this.scene.add(m)
    }
    // 階梯：每 0.8 公尺一道踏面線
    const stripe = new THREE.MeshBasicMaterial({ color: 0x9d958a })
    for (const p of PATHS.filter(x => x.kind === 'steps')) {
      const len = routeLength(p.pts)
      for (let s = 0.4; s < len; s += 0.8) {
        const { p: q, dir } = samplePath(p.pts, s)
        const m = new THREE.Mesh(new THREE.PlaneGeometry(p.w, 0.12), stripe)
        m.rotation.order = 'YXZ'
        m.rotation.set(-Math.PI / 2, Math.atan2(dir.x, dir.z), 0)
        m.position.set(q.x, groundHeight(q.x, q.z) + 0.16, q.z)
        this.scene.add(m)
      }
    }
    // 有頂步道（舍我樓北側、穿越 S 棟騎樓以外的部分）
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x8c5444 })
    for (const p of PATHS.filter(x => x.kind === 'covered')) {
      for (const q of resample(p.pts, 3)) {
        if (insideSolid(q)) continue
        const y = groundHeight(q.x, q.z)
        const slab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.3, 3.2), roofMat)
        slab.position.set(q.x, y + 3.6, q.z)
        slab.castShadow = true
        this.scene.add(slab)
      }
    }
    // 馬路中線
    const dash = new THREE.MeshBasicMaterial({ color: 0xf2d16b })
    for (const p of PATHS.filter(x => x.kind === 'road' && x.w >= 10)) {
      const len = routeLength(p.pts)
      for (let s = 4; s < len; s += 9) {
        const { p: q, dir } = samplePath(p.pts, s)
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 4), dash)
        m.rotation.order = 'YXZ'
        m.rotation.set(-Math.PI / 2, Math.atan2(dir.x, dir.z), 0)
        m.position.set(q.x, groundHeight(q.x, q.z) + 0.12, q.z)
        this.scene.add(m)
      }
    }
  }

  /** 沿折線、貼地的帶狀鋪面 */
  private ribbon(line: Vec2[], w: number, lift: number): THREE.BufferGeometry {
    const pts = resample(line, 1.5)
    const pos: number[] = []
    const idx: number[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(pts.length - 1, i + 1)]
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
      const nx = -(b.z - a.z) / len
      const nz = (b.x - a.x) / len
      for (const s of [-1, 1]) {
        const x = pts[i].x + nx * s * (w / 2)
        const z = pts[i].z + nz * s * (w / 2)
        pos.push(x, groundHeight(x, z) + lift, z)
      }
      if (i > 0) {
        const k = i * 2
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    // 確保法線朝上
    const n = g.attributes.normal as THREE.BufferAttribute
    for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
    g.deleteAttribute('uv')
    return g
  }

  private flatPoly(pts: Vec2[], y: number, mat: THREE.Material): THREE.Mesh {
    const geo = new THREE.ShapeGeometry(shapeOf(pts))
    geo.rotateX(-Math.PI / 2)
    const m = new THREE.Mesh(geo, mat)
    m.position.y = y
    m.receiveShadow = true
    return m
  }

  // ─── 操場、網球場 ───────────────────────────────────
  private addSportsGround(): void {
    const y = groundHeight(TRACK.x, TRACK.z) + 0.16
    const g = new THREE.Group()
    const r = TRACK.w / 2
    const straight = TRACK.len - TRACK.w
    const stadium = (p: THREE.Path, half: number) => {
      p.moveTo(-straight / 2, -half)
      p.lineTo(straight / 2, -half)
      p.absarc(straight / 2, 0, half, -Math.PI / 2, Math.PI / 2, false)
      p.lineTo(-straight / 2, half)
      p.absarc(-straight / 2, 0, half, Math.PI / 2, (Math.PI * 3) / 2, false)
      return p
    }
    const ring = (outer: number, inner: number, color: number, lift: number) => {
      const s = stadium(new THREE.Shape(), outer) as THREE.Shape
      s.holes.push(stadium(new THREE.Path(), inner))
      const m = new THREE.Mesh(new THREE.ShapeGeometry(s, 24), new THREE.MeshLambertMaterial({ color }))
      m.rotation.x = -Math.PI / 2
      m.position.y = lift
      m.receiveShadow = true
      g.add(m)
    }
    const inner = r - TRACK.lane
    ring(r, inner, 0xb5473a, 0)
    for (let k = 1; k < 5; k++) {
      const rr = inner + (TRACK.lane / 5) * k
      ring(rr + 0.06, rr - 0.06, 0xf4efe8, 0.01)
    }
    const fieldShape = stadium(new THREE.Shape(), inner) as THREE.Shape
    const ftex = fieldTexture(TRACK.len - TRACK.lane * 2, TRACK.w - TRACK.lane * 2)
    ftex.repeat.set(1 / (TRACK.len - TRACK.lane * 2), 1 / (TRACK.w - TRACK.lane * 2))
    ftex.offset.set(0.5, 0.5)
    const fm = new THREE.Mesh(new THREE.ShapeGeometry(fieldShape, 24), new THREE.MeshLambertMaterial({ map: ftex }))
    fm.rotation.x = -Math.PI / 2
    fm.position.y = 0.005
    fm.receiveShadow = true
    g.add(fm)
    g.position.set(TRACK.x, y, TRACK.z)
    g.rotation.y = TRACK.rot
    this.capture('obj:track', '操場跑道', '18', 'ground', () => this.scene.add(g))
    // OSM 球場（綠色場地、網球場、東側小球場）
    const court = new THREE.MeshLambertMaterial({ map: courtTexture() })
    for (const a of AREAS) {
      // 內場改由跑道內的球場貼圖呈現（0037、0045 空拍：綠底多個藍色球場）
      if (a.kind !== 'court') continue
      const yy = groundHeight(centroid(a.pts).x, centroid(a.pts).z) + 0.17
      const m = this.flatPoly(a.pts, yy, a.kind === 'court' ? court : new THREE.MeshLambertMaterial({ color: 0x5aa850 }))
      if (a.kind === 'court') {
        const uv = m.geometry.attributes.uv as THREE.BufferAttribute
        const xs = a.pts.map(p => p.x)
        const zs = a.pts.map(p => -p.z)
        const x0 = Math.min(...xs)
        const z0 = Math.min(...zs)
        const sx = Math.max(...xs) - x0
        const sz = Math.max(...zs) - z0
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - x0) / sx, (uv.getY(i) - z0) / sz)
      }
      this.capture(`obj:court-${a.id}`, '球場', '', 'ground', () => this.scene.add(m))
    }
    // 球場籃架（綠色場地兩端）
    const fieldArea = AREAS.find(a => a.id === 'field')
    if (fieldArea) {
      const c = centroid(fieldArea.pts)
      const ax = { x: Math.cos(TRACK.rot), z: -Math.sin(TRACK.rot) }
      const pole = new THREE.MeshLambertMaterial({ color: 0x2f6fb0 })
      const board = new THREE.MeshLambertMaterial({ color: 0xffffff })
      for (const s of [-1, 1]) this.capture(`obj:hoop-${s}`, '籃球架', '', 'ground', () => {
        const x = c.x + ax.x * s * 21
        const z = c.z + ax.z * s * 21
        const yy = groundHeight(x, z)
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.6), pole)
        p.position.set(x, yy + 1.8, z)
        p.castShadow = true
        this.scene.add(p)
        const bd = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 0.1), board)
        bd.position.set(x - ax.x * s * 0.5, yy + 3.3, z - ax.z * s * 0.5)
        bd.rotation.y = TRACK.rot + Math.PI / 2
        this.scene.add(bd)
        this.obstacles.push({ x, z, r: 0.3 })
      })
    }
  }

  // ─── 建築 ─────────────────────────────────────────
  private makeBuilding(b: Building): THREE.Group {
    const g = new THREE.Group()
    const base = baseOf(b.pts)
    const top = groundHeight(b.c.x, b.c.z) + b.h
    const side = facadeMat(b.style, FLOOR_H, SINK)
    const roof = new THREE.MeshLambertMaterial({ color: STYLE_ROOF[b.style] })
    const parts: [THREE.BufferGeometry, THREE.BufferGeometry][] = []
    if (b.groundH && b.ground.length && b.ground[0] !== b.pts) {
      // 一樓騎樓通道：地面層只有部分量體，上方整棟
      for (const gp of b.ground) parts.push(prism(gp, base - SINK, base + b.groundH))
      parts.push(prism(b.pts, base + b.groundH, top))
    } else {
      parts.push(prism(b.pts, base - SINK, top))
    }
    for (const [caps, sides] of parts) {
      const wall = new THREE.Mesh(sides, side)
      const cap = new THREE.Mesh(caps, roof)
      for (const m of [wall, cap]) {
        m.castShadow = true
        m.receiveShadow = true
        m.userData.num = b.num
        m.userData.bid = b.id
        this.occluders.push(m)
        g.add(m)
      }
    }
    if (b.style === 'scaffold') {
      // 施工中：鷹架內的混凝土結構體
      const [cc, cs] = prism(inset(b.pts, 0.82), base - SINK, top - 2.5)
      const coreMat = new THREE.MeshLambertMaterial({ color: 0xb9b6ae })
      g.add(new THREE.Mesh(cc, coreMat), new THREE.Mesh(cs, coreMat))
    } else {
      // 女兒牆
      const [, parapet] = prism(b.pts, top, top + 1)
      g.add(new THREE.Mesh(parapet, new THREE.MeshLambertMaterial({ color: new THREE.Color(STYLE_ROOF[b.style]).multiplyScalar(0.85), side: THREE.DoubleSide })))
      this.addRoof(b, g, top)
    }
    // 輪廓線，方便總覽辨識
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.ExtrudeGeometry(shapeOf(b.pts), { depth: top - base, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, base, 0), 30), new THREE.LineBasicMaterial({ color: 0x5a4a42, transparent: true, opacity: 0.45 }))
    g.add(edges)
    this.addBuildingSigns(b, g, base, top)
    return g
  }

  /** 屋頂：太陽能板、斜屋頂、玻璃天窗或屋頂機房（依空拍影片） */
  private addRoof(b: Building, g: THREE.Group, top: number): void {
    const solarPlane = (pts: Vec2[], y: number) => {
      const geo = new THREE.ShapeGeometry(shapeOf(pts))
      geo.rotateX(-Math.PI / 2)
      const tex = solarTexture()
      tex.repeat.set(0.5, 1)
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }))
      m.position.y = y
      m.receiveShadow = true
      return m
    }
    switch (b.roof) {
      case 'solar':
        g.add(solarPlane(inset(b.pts, 0.82), top + 1.25))
        break
      case 'solarGreen': {
        const base = new THREE.ShapeGeometry(shapeOf(inset(b.pts, 0.97)))
        base.rotateX(-Math.PI / 2)
        const gm = new THREE.Mesh(base, new THREE.MeshLambertMaterial({ color: 0x3fae6a }))
        gm.position.y = top + 0.06
        g.add(gm, solarPlane(inset(b.pts, 0.8), top + 0.5))
        break
      }
      case 'hip': {
        const metal = new THREE.MeshLambertMaterial({ color: 0x8e979e })
        const steps: [number, number, number][] = [
          [0.9, 0, 1.4],
          [0.72, 1.4, 2.6],
          [0.5, 2.6, 3.4],
        ]
        for (const [k, y0, y1] of steps) {
          const [cap, side] = prism(inset(b.pts, k), top + y0, top + y1)
          const a = new THREE.Mesh(cap, metal)
          const c = new THREE.Mesh(side, metal)
          a.castShadow = c.castShadow = true
          g.add(a, c)
        }
        break
      }
      case 'atrium': {
        const glass = new THREE.MeshLambertMaterial({ color: 0x6fc3a8, transparent: true, opacity: 0.85 })
        const [cap, side] = prism(inset(b.pts, 0.62), top, top + 3.2)
        g.add(new THREE.Mesh(cap, glass), new THREE.Mesh(side, glass))
        break
      }
      case 'metal': {
        const mat = new THREE.MeshLambertMaterial({ color: 0xb8bdc1 })
        const [cap, side] = prism(inset(b.pts, 0.82), top, top + 3.8)
        const a = new THREE.Mesh(cap, mat)
        const c = new THREE.Mesh(side, mat)
        a.castShadow = c.castShadow = true
        g.add(a, c)
        break
      }
      default:
        if (b.h > 10 && b.box.x1 - b.box.x0 > 14 && pointInPolygon(b.c, b.pts)) {
          const unit = new THREE.Mesh(new THREE.BoxGeometry(5, 2.4, 4), new THREE.MeshLambertMaterial({ color: 0xbdbdb8 }))
          unit.position.set(b.c.x, top + 1.2, b.c.z)
          unit.castShadow = true
          g.add(unit)
        }
    }
  }

  private signPlane(tex: THREE.Texture, w: number, h: number): THREE.Mesh {
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
  }

  private placeOnFace(g: THREE.Group, b: Building, target: Vec2, sign: THREE.Mesh, y: number, along = 0): void {
    const f = faceToward(b.pts, target)
    const tx = f.n.z
    const tz = -f.n.x
    sign.position.set(f.mid.x + f.n.x * 0.12 + tx * along, y, f.mid.z + f.n.z * 0.12 + tz * along)
    sign.rotation.y = f.yaw
    g.add(sign)
  }

  private addBuildingSigns(b: Building, g: THREE.Group, base: number, top: number): void {
    const gate = START.pos
    const plaza = centroid(AREAS.find(a => a.id === 'school-plaza')!.pts)
    const speech = centroid(AREAS.find(a => a.id === 'speech')!.pts)
    const track = { x: TRACK.x, z: TRACK.z }
    const vertical = (text: string, color: string, bg: string, w: number, h: number) =>
      this.signPlane(signTexture(text, { color, bg, vertical: true, w: 256, h: Math.round((256 * h) / w), size: 180 }), w, h)
    switch (b.id) {
      case 'W': {
        // 0034：屋頂「世新大學」白底紅字大招牌，面向木柵路（南）
        const f = faceToward(b.pts, { x: b.c.x + 10, z: b.c.z + 120 })
        const bb = new THREE.Group()
        const back = new THREE.Mesh(new THREE.BoxGeometry(17.4, 5, 0.3), new THREE.MeshLambertMaterial({ color: 0xe6e3dd }))
        back.position.set(0, 4.5, -0.2)
        const panel = this.signPlane(signTexture('世新大學', { color: '#c0182b', bg: '#fbfaf7' }), 17, 4.6)
        panel.position.set(0, 4.5, 0)
        bb.add(back, panel)
        for (const sx of [-6, 0, 6]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 0.3), new THREE.MeshLambertMaterial({ color: 0x777777 }))
          post.position.set(sx, 1.1, -0.4)
          bb.add(post)
        }
        bb.position.set(f.mid.x - f.n.x * 4, top, f.mid.z - f.n.z * 4)
        bb.rotation.y = f.yaw
        bb.traverse(o => (o.castShadow = true))
        g.add(bb)
        break
      }
      case 'J':
        this.placeOnFace(g, b, gate, vertical('新聞大樓', '#ffffff', '#5b2f78', 2.2, 9), base + 9, 12)
        break
      case 'ADM':
        this.placeOnFace(g, b, speech, this.signPlane(signTexture('行政大樓', { color: '#b3202f' }), 7, 1.75), top - 2.5)
        break
      case 'G':
        this.placeOnFace(g, b, speech, this.signPlane(signTexture('通識大樓', { color: '#555b62', sub: 'General Studies Building' }), 7, 1.75), top - 2.5)
        break
      case 'L':
        this.placeOnFace(g, b, speech, this.signPlane(signTexture('圖書館', { color: '#c0182b', bg: '#f6f4ef' }), 8, 2), top - 3)
        break
      case 'C':
        this.placeOnFace(g, b, DESTINATION, this.signPlane(signTexture('傳播大廈', { color: '#a3122b', bg: '#f7f3ec', sub: 'COLLEGE OF JOURNALISM & COMMUNICATIONS' }), 11, 2.75), base + 8)
        this.placeOnFace(g, b, track, vertical('世新大學', '#ffffff', '#a3122b', 2.6, 11), base + 12, 4)
        break
      case 'A':
        this.placeOnFace(g, b, plaza, this.signPlane(signTexture('大禮堂', { color: '#b3202f', bg: '#f2f0ea' }), 6, 1.5), base + 7.6)
        this.placeOnFace(g, b, plaza, vertical('世新我的驕傲', '#ffd84a', '#283a73', 2.4, 12), base + 13, -6)
        break
      case 'M':
        this.placeOnFace(g, b, { x: b.c.x, z: b.c.z + 60 }, this.signPlane(signTexture('世新大學管理學院', { color: '#b3202f', bg: '#ffffff' }), 10, 1.4), base + 3)
        this.addMgmtFacade(g, b, base, top)
        break
      case 'OM':
        // 地面照片 second_021–049：巨幅藍綠海報掛在面向噴水池廣場的東面（金屬雨庇以上）
        this.placeOnFace(g, b, { x: b.c.x + 60, z: b.c.z }, this.signPlane(omBannerTexture(), 7.6, 19), top - 11)
        break
    }
  }

  /** 多邊形三角化後細分（邊長 ≤ maxEdge）並逐點貼地；uv 以 uvScale m 為一單位 */
  private drapePoly(poly: Vec2[], lift: number, maxEdge: number, uvScale: number): THREE.BufferGeometry {
    const flat = new THREE.ShapeGeometry(shapeOf(poly))
    flat.rotateX(-Math.PI / 2)
    const geo = new TessellateModifier(maxEdge, 10).modify(flat)
    const p = geo.attributes.position as THREE.BufferAttribute
    const uv: number[] = []
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const z = p.getZ(i)
      p.setY(i, groundHeight(x, z) + lift)
      uv.push(x / uvScale, z / uvScale)
    }
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.computeVertexNormals()
    return geo
  }

  /** 管理學院北面：兩層高石材圓柱柱廊、懸挑白色框帶、白色豎框、西端綠色玻璃圓柱塔與玻璃雨庇（second_024–050） */
  private addMgmtFacade(g: THREE.Group, b: Building, base: number, top: number): void {
    // 原始（未經編輯器調整）的北面外牆線；若使用者存過 M 的位移／旋轉，套用同一轉換
    const e = LOADED_EDITS[b.id]
    const c0 = e ? { x: b.c.x - e.dx, z: b.c.z - e.dz } : b.c
    const tf = (p: Vec2): Vec2 => (e ? transformPoint(p, c0, e) : p)
    const F0 = { x: 200.1, z: 216.9 }
    const U = { x: -0.9816, z: 0.1911 }
    const N = { x: 0.1911, z: 0.9816 }
    const P = (s: number, o: number) => tf({ x: F0.x + U.x * s + N.x * o, z: F0.z + U.z * s + N.z * o })
    const yaw = Math.atan2(-U.z, U.x) + (e?.rot ?? 0)
    const LEN = 57
    const GH = 7.6
    const white = new THREE.MeshLambertMaterial({ color: 0xf1f0eb })
    const stone = new THREE.MeshLambertMaterial({ color: 0xe2e0da })
    const steel = new THREE.MeshPhongMaterial({ color: 0xbfc5ca, specular: 0xffffff, shininess: 80 })
    const along = (s0: number, s1: number, o: number, y0: number, y1: number, d: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s1 - s0, y1 - y0, d), mat)
      const c = P((s0 + s1) / 2, o)
      m.position.set(c.x, (y0 + y1) / 2, c.z)
      m.rotation.y = yaw
      m.castShadow = m.receiveShadow = true
      g.add(m)
      return m
    }
    // 柱廊大圓柱（柱心在外牆線內 0.8 m）
    const cols: number[] = []
    for (let s = 4; s <= 51; s += 6.7) cols.push(s)
    for (const s of cols) {
      const p = P(s, 0.8)
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, GH + 2, 20), stone)
      col.position.set(p.x, base + GH / 2 - 1, p.z)
      col.castShadow = col.receiveShadow = true
      g.add(col)
      this.obstacles.push({ x: p.x, z: p.z, r: 0.7 })
    }
    // 柱頂懸挑框帶、白色豎框、中段與頂部框帶
    along(-0.3, LEN + 0.3, -0.15, base + GH - 0.3, base + GH + 0.9, 0.7, white)
    // 柱廊白色天花板（朝下的面只受半球光地面色照明，故加自發光避免呈橄欖綠）
    along(-0.3, LEN + 0.3, 1.75, base + GH - 0.42, base + GH - 0.3, 3.7, new THREE.MeshLambertMaterial({ color: 0xf1f0eb, emissive: 0x8d8b85 }))
    for (const s of cols) along(s - 0.25, s + 0.25, -0.2, base + GH + 0.9, top, 0.4, white)
    const mid = base + GH + (top - base - GH) * 0.5
    along(-0.3, LEN + 0.3, -0.12, mid - 0.25, mid + 0.25, 0.35, white)
    along(-0.3, LEN + 0.3, -0.15, top - 1.1, top + 1.0, 0.5, white)
    // 西端綠色玻璃圓柱塔（水平白帶）
    const cp = P(LEN - 1.2, -0.6)
    const cylH = top - base + 1.5
    const glass = new THREE.MeshLambertMaterial({ color: 0x5bb8a5, emissive: 0x0c2a24 })
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.0, cylH + 2, 28), glass)
    cyl.position.set(cp.x, base - 2 + (cylH + 2) / 2, cp.z)
    cyl.castShadow = true
    g.add(cyl)
    for (let y = base + FLOOR_H; y < base + cylH; y += FLOOR_H) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(3.06, 3.06, 0.24, 28), white)
      band.position.set(cp.x, y, cp.z)
      g.add(band)
    }
    const capM = new THREE.Mesh(new THREE.CylinderGeometry(3.12, 3.12, 0.5, 28), white)
    capM.position.set(cp.x, base + cylH, cp.z)
    g.add(capM)
    this.obstacles.push({ x: cp.x, z: cp.z, r: 3.2 })
    // 西端入口鋼構玻璃雨庇
    const cg = new THREE.MeshLambertMaterial({ color: 0xa8d4d2, transparent: true, opacity: 0.55, depthWrite: false })
    along(44, 50.5, 0.15, base + 4.3, base + 4.45, 6.8, cg)
    along(44, 50.5, -3.2, base + 4.15, base + 4.5, 0.16, steel)
    for (const s of [44.2, 50.3]) {
      const p = P(s, -3.1)
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.6, 8), steel)
      post.position.set(p.x, base + 2.0, p.z)
      g.add(post)
      this.obstacles.push({ x: p.x, z: p.z, r: 0.15 })
    }
  }

  /** 管院噴水池廣場、OM 前米色低樓、東側夾牆坡道、北緣花台樹籬與燈柱（second_000–050） */
  private addMgmtPlaza(): void {
    const scene = this.scene
    const at = (x: number, z: number) => groundHeight(x, z)
    const granite = new THREE.MeshLambertMaterial({ color: 0x17191c })
    const graniteTop = new THREE.MeshLambertMaterial({ color: 0x2c2f34 })
    const led = new THREE.MeshBasicMaterial({ color: 0x7a4dff })
    const warm = new THREE.MeshBasicMaterial({ color: 0xffd39a })
    const steel = new THREE.MeshPhongMaterial({ color: 0xc4c9ce, specular: 0xffffff, shininess: 90 })
    const box = (w: number, h: number, d: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
      m.castShadow = m.receiveShadow = true
      return m
    }
    // 1. 廣場淺灰拋光磁磚（貼地，屬地面鋪面不列入可移動物件）
    const plaza = AREAS.find(a => a.id === 'm-plaza')
    if (plaza) {
      const tex = paleTileTexture()
      const m = new THREE.Mesh(
        this.drapePoly(plaza.pts, 0.07, 1.2, 1.2),
        new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      )
      m.receiveShadow = true
      scene.add(m)
      // 柱廊下地面（北面外牆線內 3.6 m）同款磁磚
      const F0 = { x: 200.1, z: 216.9 }
      const U = { x: -0.9816, z: 0.1911 }
      const N = { x: 0.1911, z: 0.9816 }
      const P = (s_: number, o: number): Vec2 => ({ x: F0.x + U.x * s_ + N.x * o, z: F0.z + U.z * s_ + N.z * o })
      const arc = new THREE.Mesh(
        this.drapePoly([P(-0.3, -0.2), P(57.2, -0.2), P(57.2, 3.7), P(-0.3, 3.7)], 0.07, 1.2, 1.2),
        m.material,
      )
      arc.receiveShadow = true
      scene.add(arc)
    }
    // 2. 噴水池：放射磁磚圓盤、深灰環帶、黑色八角水池（紫色光帶）、不鏽鋼球與鋼環、內圈黑石椅
    const F = { x: 176, z: 210.5 }
    this.capture('obj:m-fountain', '管院噴水池（不鏽鋼球雕塑與石椅）', '', 'ground', () => {
      const y0 = at(F.x, F.z)
      const g = new THREE.Group()
      const drapeRing = (r0: number, r1: number, seg: number, lift: number, mat: THREE.Material) => {
        const geo = new THREE.RingGeometry(r0, r1, 72, seg)
        geo.rotateX(-Math.PI / 2)
        const p = geo.attributes.position as THREE.BufferAttribute
        for (let i = 0; i < p.count; i++) p.setY(i, at(F.x + p.getX(i), F.z + p.getZ(i)) - y0 + lift)
        geo.computeVertexNormals()
        const m = new THREE.Mesh(geo, mat)
        m.receiveShadow = true
        g.add(m)
      }
      drapeRing(0.05, 11, 18, 0.11, new THREE.MeshLambertMaterial({ map: radialPavingTexture(), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }))
      drapeRing(9.2, 9.8, 1, 0.13, new THREE.MeshLambertMaterial({ color: 0x3b3e43, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }))
      drapeRing(9.8, 10.3, 1, 0.13, new THREE.MeshLambertMaterial({ color: 0x9a9b9c, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }))
      const oct = (r: number, h: number, y: number, mat: THREE.Material, open = false) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 8, 1, open), mat)
        m.position.y = y + h / 2
        m.rotation.y = Math.PI / 8
        m.castShadow = m.receiveShadow = true
        g.add(m)
        return m
      }
      oct(4.1, 0.45, -0.2, granite)
      oct(4.16, 0.09, 0.08, led, true)
      oct(3.3, 0.85, 0.25, granite)
      oct(3.36, 0.08, 0.32, led, true)
      oct(3.36, 0.08, 1.06, graniteTop)
      const water = oct(3.0, 0.04, 1.12, new THREE.MeshPhongMaterial({ color: 0x2b4457, specular: 0x9fb8c8, shininess: 100 }))
      water.castShadow = false
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.3, 0.7, 20), granite)
      ped.position.y = 1.5
      g.add(ped)
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(1.35, 32, 20),
        new THREE.MeshPhongMaterial({ color: 0xc9cdd2, specular: 0xffffff, shininess: 140, emissive: 0x2a2d31 }),
      )
      ball.position.y = 2.85
      ball.castShadow = true
      g.add(ball)
      const eq = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.07, 8, 72), steel)
      eq.rotation.x = Math.PI / 2
      eq.rotation.y = 0.12
      eq.position.y = 2.85
      g.add(eq)
      for (const a of [0.5, 0.5 + Math.PI / 2]) {
        const mer = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.06, 8, 72), steel)
        mer.rotation.y = a
        mer.position.y = 2.85
        g.add(mer)
      }
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), warm)
        l.position.set(3.05 * Math.cos(a), 1.2, 3.05 * Math.sin(a))
        g.add(l)
      }
      // 內圈黑色花崗石長方塊座椅（避開東西南北四個通道）
      for (let k = 0; k < 8; k++) {
        const th = ((k + 0.5) * Math.PI) / 4
        const bx = 7 * Math.cos(th)
        const bz = 7 * Math.sin(th)
        const bench = new THREE.Group()
        const body = box(3.4, 0.42, 0.7, granite)
        body.position.y = 0.31
        const cap = box(3.45, 0.06, 0.75, graniteTop)
        cap.position.y = 0.55
        const glow = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.06, 0.78), led)
        glow.position.y = 0.08
        bench.add(body, cap, glow)
        bench.position.set(bx, at(F.x + bx, F.z + bz) - y0, bz)
        bench.rotation.y = -th - Math.PI / 2
        g.add(bench)
        for (const t of [-1.2, 0, 1.2]) this.obstacles.push({ x: F.x + bx - Math.sin(th) * t, z: F.z + bz + Math.cos(th) * t, r: 0.55 })
      }
      this.obstacles.push({ x: F.x, z: F.z, r: 4.3 })
      g.position.set(F.x, y0, F.z)
      scene.add(g)
    })
    // 3. 廣場邊緣長條黑石椅
    this.capture('obj:m-benches', '管院廣場邊緣長條石椅', '', 'ground', () => {
      for (const deg of [20, -20, 235]) {
        const th = (deg * Math.PI) / 180
        const x = F.x + 12.6 * Math.cos(th)
        const z = F.z + 12.6 * Math.sin(th)
        const bench = new THREE.Group()
        const body = box(4.5, 0.45, 0.6, granite)
        body.position.y = 0.3
        const cap = box(4.55, 0.06, 0.65, graniteTop)
        cap.position.y = 0.55
        const glow = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.06, 0.68), led)
        glow.position.y = 0.08
        bench.add(body, cap, glow)
        bench.position.set(x, at(x, z), z)
        bench.rotation.y = -th - Math.PI / 2
        scene.add(bench)
        for (const t of [-1.6, 0, 1.6]) this.obstacles.push({ x: x - Math.sin(th) * t, z: z + Math.cos(th) * t, r: 0.5 })
      }
    })
    // 4. OM 東面前的米色低樓：褐色橫百葉＋紅字「世新大學管理學院」、玻璃門、灰色金屬雨庇
    this.capture('obj:om-annex', '全媒體大樓前米色低樓（管院紅字招牌）', '', 'ground', () => {
      const C = { x: 160.95, z: 205.78 }
      const rot = 0.191
      const g = new THREE.Group()
      const body = box(5.5, 5.3, 8.6, new THREE.MeshLambertMaterial({ color: 0xd9cfbd }))
      body.position.y = 2.15
      const canopy = box(6.6, 0.16, 9.4, new THREE.MeshLambertMaterial({ color: 0x6c7279 }))
      canopy.position.set(0.55, 5.15, 0)
      const back = box(0.08, 2.4, 4.6, new THREE.MeshLambertMaterial({ color: 0x3b3733 }))
      back.position.set(2.79, 1.75, 1.9)
      g.add(body, canopy, back)
      const slatMat = new THREE.MeshLambertMaterial({ color: 0x7a6656 })
      for (let i = 0; i < 10; i++) {
        const sl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 4.6), slatMat)
        sl.position.set(2.86, 0.65 + i * 0.24, 1.9)
        g.add(sl)
      }
      const slot = box(0.06, 3.6, 0.9, new THREE.MeshLambertMaterial({ color: 0x2e2e31 }))
      slot.position.set(2.8, 2.0, -0.6)
      g.add(slot)
      // 紅字招牌（透明底）
      const cv = document.createElement('canvas')
      cv.width = 1024
      cv.height = 128
      const cx = cv.getContext('2d')!
      cx.fillStyle = '#d42a2f'
      cx.strokeStyle = '#d42a2f'
      cx.lineWidth = 8
      cx.beginPath()
      cx.arc(70, 64, 42, 0, Math.PI * 2)
      cx.stroke()
      cx.font = '900 40px sans-serif'
      cx.textAlign = 'center'
      cx.fillText('世新', 70, 78)
      cx.font = '800 86px "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif'
      cx.textAlign = 'left'
      cx.fillText('世新大學管理學院', 140, 96)
      const st = new THREE.CanvasTexture(cv)
      st.colorSpace = THREE.SRGBColorSpace
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.58), new THREE.MeshBasicMaterial({ map: st, transparent: true }))
      sign.position.set(2.93, 1.95, 1.9)
      sign.rotation.y = Math.PI / 2
      g.add(sign)
      const frame = box(0.2, 2.9, 2.1, new THREE.MeshLambertMaterial({ color: 0xe6e6e2 }))
      frame.position.set(2.8, 1.45, -2.4)
      const door = box(0.06, 2.5, 1.6, new THREE.MeshLambertMaterial({ color: 0x2e4b47 }))
      door.position.set(2.92, 1.25, -2.4)
      g.add(frame, door)
      const y = at(C.x, C.z)
      g.position.set(C.x, y, C.z)
      g.rotation.y = rot
      scene.add(g)
      const cos = Math.cos(rot)
      const sin = Math.sin(rot)
      for (const lx of [-1.5, 1.4]) for (const lz of [-3, -1, 1, 3]) {
        this.obstacles.push({ x: C.x + lx * cos + lz * sin, z: C.z - lx * sin + lz * cos, r: 1.4 })
      }
    })
    // 5. 東側夾牆坡道：灰藍小方磚坡面、兩側洗石子矮牆、不鏽鋼欄杆與扶手（second_008–021）
    this.capture('obj:m-ramp', '管院東側夾牆坡道（洗石子牆＋不鏽鋼扶手）', '', 'none', () => {
      const A = { x: 201.6, z: 216.4 }
      const B = { x: 190.2, z: 200.6 }
      const L = Math.hypot(B.x - A.x, B.z - A.z)
      const d = { x: (B.x - A.x) / L, z: (B.z - A.z) / L }
      const r = { x: -d.z, z: d.x }
      const yA = at(A.x, A.z)
      const yB = at(B.x, B.z)
      const floor = new THREE.Mesh(
        this.ribbon([A, B], 2.6, 0.12),
        new THREE.MeshLambertMaterial({ color: 0x8f99a3, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
      )
      floor.receiveShadow = true
      scene.add(floor)
      const g = new THREE.Group()
      g.position.set((A.x + B.x) / 2, (yA + yB) / 2, (A.z + B.z) / 2)
      g.rotation.y = Math.atan2(-d.z, d.x)
      const tilt = new THREE.Group()
      tilt.rotation.z = Math.atan2(yB - yA, L)
      g.add(tilt)
      const wall = (off: number, h: number, th: number) => {
        const m = box(L + 0.6, h + 0.6, th, new THREE.MeshLambertMaterial({ map: pebbleTexture(L / 1.6, (h + 0.6) / 1.6) }))
        m.position.set(0, h / 2 - 0.3, off)
        tilt.add(m)
        const capS = box(L + 0.7, 0.08, th + 0.06, new THREE.MeshLambertMaterial({ color: 0xa39c90 }))
        capS.position.set(0, h + 0.04, off)
        tilt.add(capS)
      }
      wall(1.5, 1.45, 0.35)
      wall(-1.5, 0.95, 0.3)
      const railTop = (off: number, y: number) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, L, 8), steel)
        m.rotation.z = Math.PI / 2
        m.position.set(0, y, off)
        tilt.add(m)
      }
      railTop(1.5, 2.45)
      railTop(1.5, 1.95)
      railTop(-1.5, 1.05)
      for (let t = -L / 2 + 0.4; t <= L / 2; t += 1.2) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 6), steel)
        post.position.set(t, 1.95, 1.5)
        tilt.add(post)
      }
      for (let t = -L / 2 + 0.6; t <= L / 2; t += 2.4) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.12, 6), steel)
        post.position.set(t, 1.0, -1.5)
        tilt.add(post)
      }
      // 牆外側（小巷面）的禁菸標示
      const cv = document.createElement('canvas')
      cv.width = 96
      cv.height = 128
      const cx = cv.getContext('2d')!
      cx.fillStyle = '#ffffff'
      cx.fillRect(0, 0, 96, 128)
      cx.strokeStyle = '#d0202a'
      cx.lineWidth = 8
      cx.beginPath()
      cx.arc(48, 46, 30, 0, Math.PI * 2)
      cx.moveTo(27, 25)
      cx.lineTo(69, 67)
      cx.stroke()
      cx.fillStyle = '#222222'
      cx.font = '700 20px sans-serif'
      cx.textAlign = 'center'
      cx.fillText('禁止吸菸', 48, 112)
      const st = new THREE.CanvasTexture(cv)
      st.colorSpace = THREE.SRGBColorSpace
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.6), new THREE.MeshLambertMaterial({ map: st }))
      sign.position.set(-L / 2 + 2.5, 0.85, 1.5 + 0.19)
      tilt.add(sign)
      scene.add(g)
      for (let t = 0; t <= L; t += 1) {
        for (const off of [1.5, -1.5]) this.obstacles.push({ x: A.x + d.x * t + r.x * off, z: A.z + d.z * t + r.z * off, r: 0.25 })
      }
    })
    // 6. 北緣草坪、洗石子花台矮牆（暖色投光燈）、樹籬與小樹
    this.capture('obj:m-hedge', '管院廣場北緣草坪、花台與樹籬', '', 'none', () => {
      const lawnPoly: Vec2[] = [
        { x: 162, z: 192.8 },
        { x: 186, z: 192.8 },
        { x: 189.2, z: 198.6 },
        { x: 176, z: 195.9 },
        { x: 162, z: 196.1 },
      ]
      const lawn = new THREE.Mesh(
        this.drapePoly(lawnPoly, 0.09, 1, 1),
        new THREE.MeshLambertMaterial({ color: 0x5e9a46, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      )
      lawn.receiveShadow = true
      scene.add(lawn)
      const edge: Vec2[] = [
        { x: 162, z: 196.25 },
        { x: 176, z: 196.05 },
        { x: 189.4, z: 198.9 },
      ]
      const wallMat = new THREE.MeshLambertMaterial({ map: pebbleTexture(4, 0.4) })
      for (let i = 0; i < edge.length - 1; i++) {
        const a = edge[i]
        const b = edge[i + 1]
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        const yaw = Math.atan2(-(b.z - a.z), b.x - a.x)
        const m = box(len, 0.75, 0.3, wallMat)
        m.position.set((a.x + b.x) / 2, at((a.x + b.x) / 2, (a.z + b.z) / 2) + 0.15, (a.z + b.z) / 2)
        m.rotation.y = yaw
        scene.add(m)
        for (let t = 1.5; t < len; t += 3) {
          const px = a.x + ((b.x - a.x) * t) / len
          const pz = a.z + ((b.z - a.z) * t) / len
          const l = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.06), warm)
          l.position.set(px + Math.sin(yaw) * 0.17, at(px, pz) + 0.3, pz + Math.cos(yaw) * 0.17)
          l.rotation.y = yaw
          scene.add(l)
        }
      }
      const hedgeMats = [new THREE.MeshLambertMaterial({ color: 0x3c6a32 }), new THREE.MeshLambertMaterial({ color: 0x467a3a })]
      let k = 0
      for (let x = 162.5; x < 186; x += 3, k++) {
        const h = 1.3 + ((k * 37) % 5) * 0.06
        const m = box(3.05, h, 1.1, hedgeMats[k % 2])
        m.position.set(x + 1.5, at(x + 1.5, 193.5) + h / 2 - 0.1, 193.5)
        scene.add(m)
      }
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6a5242 })
      const leaf = new THREE.MeshLambertMaterial({ color: 0x4f8a3e, flatShading: true })
      for (const [tx, tz] of [
        [170.5, 194.9],
        [181.5, 195.4],
      ]) {
        const y = at(tx, tz)
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 3.4, 7), trunkMat)
        trunk.position.set(tx, y + 1.7, tz)
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0, 1), leaf)
        crown.position.set(tx, y + 4.4, tz)
        crown.scale.set(1, 0.85, 1)
        crown.castShadow = trunk.castShadow = true
        scene.add(trunk, crown)
      }
    })
    // 7. 黑色燈柱
    const lamps: Vec2[] = [
      { x: 185, z: 197.3 },
      { x: 172, z: 195.4 },
      { x: 163.5, z: 195.6 },
      { x: 192.5, z: 213.5 },
      { x: 162.6, z: 215.6 },
    ]
    lamps.forEach((p, i) => {
      this.capture(`obj:m-lamp-${i + 1}`, `管院廣場燈柱 ${i + 1}`, '', 'ground', () => {
        const y = at(p.x, p.z)
        const g = new THREE.Group()
        const dark = new THREE.MeshLambertMaterial({ color: 0x1f2226 })
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 8), dark)
        pole.position.y = 2.1
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.5, 0.36), dark)
        head.position.y = 4.45
        const glow = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.3, 0.38), new THREE.MeshBasicMaterial({ color: 0xfff1cf }))
        glow.position.y = 4.4
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.22, 4), dark)
        cap.position.y = 4.81
        cap.rotation.y = Math.PI / 4
        g.add(pole, head, glow, cap)
        g.traverse(o => (o.castShadow = true))
        g.position.set(p.x, y, p.z)
        scene.add(g)
        this.obstacles.push({ x: p.x, z: p.z, r: 0.2 })
      })
    })
  }

  private addNeighbors(): void {
    // 每棟獨立網格（牆與屋頂同一幾何、兩組材質），編輯模式可個別移動。
    // 空拍 0042/0045：周邊民宅外牆以白、淺灰、米色磁磚為主，夾雜粉褐色磚牆；
    // 屋頂多為灰色水泥，約半數有藍、綠、灰色鐵皮頂樓加蓋。
    const baseWall = facadeMat('city', 3.2, 6.4)
    const WALLS = [0xffffff, 0xf4f1ea, 0xe9e2d4, 0xdcd6cc, 0xf0dcd0, 0xd8c3b0, 0xc9a595, 0xbfc3c4]
    const wallMats = WALLS.map(c => {
      const m = baseWall.clone()
      m.color.setHex(c)
      return m
    })
    const ROOFS = [0x9a9893, 0x8c8a86, 0xa9a59c, 0x7f8183]
    const SHEDS = [0x4f7fa8, 0x5e8fb5, 0x6f9a7a, 0x9fb7a8, 0xb9b6ae, 0x9a5a45]
    const roofMats = new Map<number, THREE.Material>()
    const roofMat = (c: number) => {
      let m = roofMats.get(c)
      if (!m) roofMats.set(c, (m = new THREE.MeshLambertMaterial({ color: c })))
      return m
    }
    const hash = (s: string) => {
      let h = 2166136261
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
      return (h >>> 0) / 4294967296
    }
    for (const n of NEIGHBORS) {
      const base = baseOf(n.pts)
      const c = centroid(n.pts)
      const top = groundHeight(c.x, c.z) + n.h
      const [cp, sd] = prism(n.pts, base - 6.4, top)
      const geo = mergeGeometries([sd, cp], true)
      geo.translate(-c.x, 0, -c.z)
      const h1 = hash(n.id)
      const h2 = hash(n.id + '#')
      const wall = n.sid ? baseWall : wallMats[Math.floor(h1 * wallMats.length)]
      const roof = n.roof ?? ROOFS[Math.floor(h2 * ROOFS.length)]
      const mesh = new THREE.Mesh(geo, [wall, roofMat(roof)])
      mesh.castShadow = mesh.receiveShadow = true
      const pivot = new THREE.Group()
      pivot.position.set(c.x, 0, c.z)
      pivot.add(mesh)
      // 頂樓加蓋：輪廓向質心縮至 55%，高 2.6 m
      const area = Math.abs(n.pts.reduce((s, p, i) => {
        const q = n.pts[(i + 1) % n.pts.length]
        return s + p.x * q.z - q.x * p.z
      }, 0)) / 2
      if (!n.sid && area > 40 && h2 < 0.55) {
        const inner = n.pts.map(p => ({ x: c.x + (p.x - c.x) * 0.55, z: c.z + (p.z - c.z) * 0.55 }))
        const [icp, isd] = prism(inner, top - 0.2, top + 2.6)
        const ig = mergeGeometries([isd, icp], true)
        ig.translate(-c.x, 0, -c.z)
        const shed = roofMat(SHEDS[Math.floor(hash(n.id + 's') * SHEDS.length)])
        const add = new THREE.Mesh(ig, [roofMat(0xd9d6cf), shed])
        add.castShadow = true
        pivot.add(add)
      }
      this.scene.add(pivot)
      const base0: Edit = LOADED_EDITS[n.id] ?? { dx: 0, dz: 0, rot: 0 }
      const mv: Movable = {
        id: n.id,
        kind: 'neighbor',
        label: n.sid ? `周邊民宅 ${n.sid}` : '周邊民宅',
        home: { x: c.x - base0.dx, z: c.z - base0.dz },
        edit: { ...base0 },
        dataLevel: true,
        apply: e => {
          mv.edit = { ...e }
          pivot.position.set(c.x + e.dx - base0.dx, 0, c.z + e.dz - base0.dz)
          pivot.rotation.y = e.rot - base0.rot
          pivot.updateMatrixWorld(true)
        },
        bounds: t => t.setFromObject(pivot),
      }
      this.movables.add(mv, pivot)
    }
  }

  // ─── 前校門拱門與隧道 ───────────────────────────────
  private addGateAndTunnel(): void {
    const a = TUNNEL.pts[0]
    const b = TUNNEL.pts[TUNNEL.pts.length - 1]
    const half = TUNNEL.w / 2
    const stone = stoneTexture()
    stone.repeat.set(0.18, 0.18)
    const stoneMat = new THREE.MeshLambertMaterial({ map: stone })
    const trim = new THREE.MeshLambertMaterial({ color: 0xc89580 })

    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf2efe8 })
    const makePortal = (at: Vec2, facingYaw: number, withSign: boolean, ho: number, depth: number) => {
      const gate = new THREE.Group()
      const W = ho + 3.5
      const H = 4.6 + ho + 2.4
      const shape = new THREE.Shape()
      shape.moveTo(-W, 0)
      shape.lineTo(-ho, 0)
      shape.lineTo(-ho, 4.6)
      shape.absarc(0, 4.6, ho, Math.PI, 0, true)
      shape.lineTo(ho, 0)
      shape.lineTo(W, 0)
      shape.lineTo(W, H)
      shape.lineTo(-W, H)
      shape.closePath()
      // 外口為粉色石拱；隧道內口（0042 空拍）為覆滿藤蔓的白色拱
      const arch = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 }), withSign ? stoneMat : whiteMat)
      arch.position.z = -depth
      arch.castShadow = arch.receiveShadow = true
      arch.userData.num = '01'
      this.occluders.push(arch)
      gate.add(arch)
      const ringShape = new THREE.Shape()
      ringShape.absarc(0, 4.6, ho + 0.8, 0, Math.PI, false)
      ringShape.lineTo(-ho, 4.6)
      ringShape.absarc(0, 4.6, ho, Math.PI, 0, true)
      ringShape.closePath()
      const ring = new THREE.Mesh(new THREE.ExtrudeGeometry(ringShape, { depth: 0.3, bevelEnabled: false, curveSegments: 24 }), trim)
      ring.position.z = 0.01
      gate.add(ring)
      const cornice = new THREE.Mesh(new THREE.BoxGeometry(2 * W + 1.4, 1.2, depth + 1.2), trim)
      cornice.position.set(0, H + 0.6, -depth / 2 + 0.3)
      cornice.castShadow = true
      gate.add(cornice)
      if (withSign) {
        for (const s of [-1, 1]) {
          const wing = new THREE.Mesh(new THREE.BoxGeometry(6.5, 7.5, 2.6), stoneMat)
          wing.position.set(s * (W + 3.25), 3.75, -1.6)
          wing.castShadow = true
          gate.add(wing)
          const wingTop = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.9, 3.4), trim)
          wingTop.position.set(s * (W + 3.45), 7.9, -1.4)
          gate.add(wingTop)
          const pilaster = new THREE.Mesh(new THREE.BoxGeometry(1.4, H - 0.6, 0.5), trim)
          pilaster.position.set(s * (ho + 1.6), (H - 0.6) / 2, 0.2)
          gate.add(pilaster)
        }
        const sign = this.signPlane(signTexture('世新大學', { color: '#8a5a3c', sub: 'Shih Hsin University' }), 8.5, 2.15)
        sign.position.set(0, H - 1.5, 0.02)
        gate.add(sign)
        const led = this.signPlane(signTexture('歡迎蒞臨世新大學', { color: '#ff4b3a', bg: '#1a1a1a', size: 120 }), 3.6, 0.56)
        led.position.set(0, 4.6 + ho * 0.72, -0.6)
        gate.add(led)
      }
      gate.position.set(at.x, groundHeight(at.x, at.z), at.z)
      gate.rotation.y = facingYaw
      this.scene.add(gate)
    }
    // 前校門：拱門正面平行木柵路（與新聞大樓、世界大廈立面同向），隧道由門口垂直進入
    const G = GATE_FRAME
    const frontYaw = Math.atan2(-G.nIn.x, -G.nIn.z)
    const GATE_DEPTH = 5.5
    const P = TUNNEL.pts
    const last = P.length - 1
    const exitLen = Math.hypot(P[last].x - P[last - 1].x, P[last].z - P[last - 1].z) || 1
    const exitDir = { x: (P[last].x - P[last - 1].x) / exitLen, z: (P[last].z - P[last - 1].z) / exitLen }
    const exitYaw = Math.atan2(-exitDir.x, -exitDir.z)
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x5d5e62 })
    this.capture('obj:gate', '前校門', '01', 'ground', () => {
      makePortal(a, frontYaw, true, G.halfOpen, GATE_DEPTH)
      // 門體內地板（地形在此挖空）
      const fw = 2 * (G.halfOpen + 1.4)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, 5.7), floorMat)
      floor.rotation.set(-Math.PI / 2, 0, 0)
      const holder = new THREE.Group()
      holder.add(floor)
      floor.position.set(0, 0, -5.7 / 2 + 0.2)
      holder.position.set(a.x, groundHeight(a.x, a.z) + 0.04, a.z)
      holder.rotation.y = frontYaw
      floor.receiveShadow = true
      this.scene.add(holder)
    })
    this.capture('obj:tunnel-exit', '隧道內口（白色拱）', '', 'ground', () => {
      makePortal(b, exitYaw + Math.PI, false, half, 3)
      const bf = new THREE.Mesh(new THREE.PlaneGeometry(2 * (half + 1.6), 7), floorMat)
      bf.rotation.x = -Math.PI / 2
      bf.receiveShadow = true
      const bh = new THREE.Group()
      bh.add(bf)
      const bc = { x: b.x - exitDir.x * 2, z: b.z - exitDir.z * 2 }
      bh.position.set(bc.x, groundHeight(bc.x, bc.z) + 0.04, bc.z)
      bh.rotation.y = exitYaw
      this.scene.add(bh)
    })

    // 隧道拱頂與側牆：沿折線逐段擺放；每段多延伸一點，轉彎外側才不會露縫。
    // 拱頂與側牆投射陰影，避免陽光穿過拱頂把山坡的鋸齒影子打在隧道地面上。
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xe9e4da, emissive: 0x4a463f, side: THREE.DoubleSide })
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff1c9 })
    const vault = new THREE.Shape()
    vault.absarc(0, 0, half + 0.8, 0, Math.PI, false)
    vault.lineTo(-half, 0)
    vault.absarc(0, 0, half, Math.PI, 0, true)
    vault.closePath()
    const pieces: { p0: Vec2; p1: Vec2 }[] = []
    for (let i = 1; i < P.length; i++) {
      const q = P[i - 1]
      const r = P[i]
      const l = Math.hypot(r.x - q.x, r.z - q.z)
      const k = Math.max(1, Math.ceil(l / 4))
      for (let j = 0; j < k; j++) {
        const t0 = j / k
        const t1 = (j + 1) / k
        pieces.push({ p0: { x: q.x + (r.x - q.x) * t0, z: q.z + (r.z - q.z) * t0 }, p1: { x: q.x + (r.x - q.x) * t1, z: q.z + (r.z - q.z) * t1 } })
      }
    }
    // 第一段從校門立面後 0.1 m 起算（門洞內是拱門自己的內壁）
    {
      const f = pieces[0]
      const l = Math.hypot(f.p1.x - f.p0.x, f.p1.z - f.p0.z)
      const k = 0.1 / l
      f.p0 = { x: f.p0.x + (f.p1.x - f.p0.x) * k, z: f.p0.z + (f.p1.z - f.p0.z) * k }
    }
    this.capture('obj:tunnel', '隧道', '', 'none', () => {
      pieces.forEach(({ p0, p1 }, i) => {
        const l = Math.hypot(p1.x - p0.x, p1.z - p0.z)
        if (l < 0.05) return
        const yawP = Math.atan2(-(p1.x - p0.x) / l, -(p1.z - p0.z) / l)
        const first = i === 0
        const lastP = i === pieces.length - 1
        // 首段不往門外延伸，末段不往出口外延伸
        const ext0 = first ? 0 : 0.25
        const ext1 = lastP ? 0 : 0.25
        const L = l + ext0 + ext1
        const mid = (l + ext1 - ext0) / 2
        const dx = (p1.x - p0.x) / l
        const dz = (p1.z - p0.z) / l
        const c = { x: p0.x + dx * mid, z: p0.z + dz * mid }
        const g = new THREE.Group()
        const geo = new THREE.ExtrudeGeometry(vault, { depth: L, bevelEnabled: false, curveSegments: 16 })
        geo.translate(0, 0, -L / 2)
        const v = new THREE.Mesh(geo, wallMat)
        v.position.y = 4.6
        v.name = 'tunnel-vault'
        v.castShadow = v.receiveShadow = true
        g.add(v)
        this.occluders.push(v)
        if (i % 2 === 0) {
          const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, Math.min(1.6, l)), lightMat)
          lamp.position.set(0, 4.6 + half - 0.08, 0)
          g.add(lamp)
        }
        for (const sd of [-1, 1]) {
          const wall = new THREE.Mesh(new THREE.BoxGeometry(0.8, 6.6, L), wallMat)
          wall.position.set(sd * (half + 0.4), 1.3, 0)
          wall.castShadow = wall.receiveShadow = true
          g.add(wall)
          this.occluders.push(wall)
        }
        g.position.set(c.x, groundHeight(c.x, c.z), c.z)
        g.rotation.y = yawP
        this.scene.add(g)
      })
    })
  }

  private addStage(): void {
    const y = groundHeight(STAGE.x, STAGE.z)
    const wood = new THREE.MeshLambertMaterial({ color: 0x9b6b4b })
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(STAGE.r, STAGE.r, 1.0, 32), wood)
    deck.position.set(STAGE.x, y + 0.5, STAGE.z)
    deck.castShadow = deck.receiveShadow = true
    this.scene.add(deck)
    // 0037 空拍：白色橢圓膜頂
    const roof = new THREE.Mesh(new THREE.SphereGeometry(STAGE.r + 1.6, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xf7f6f2, side: THREE.DoubleSide }))
    roof.scale.set(1.45, 0.16, 0.95)
    roof.position.set(STAGE.x, y + 6.2, STAGE.z)
    roof.castShadow = true
    this.scene.add(roof)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5.4), new THREE.MeshLambertMaterial({ color: 0x5b4636 }))
      post.position.set(STAGE.x + Math.cos(a) * (STAGE.r - 0.4), y + 3.5, STAGE.z + Math.sin(a) * (STAGE.r - 0.4))
      this.scene.add(post)
    }
    this.obstacles.push({ x: STAGE.x, z: STAGE.z, r: STAGE.r })
  }

  // ─── 依空拍影片補上的附屬構造 ──────────────────────────
  private addCampusDetails(): void {
    const scene = this.scene
    const at = (x: number, z: number) => groundHeight(x, z)

    // 舍我樓圓柱樓梯塔（0034_124、0037_117）：粉米色、白色橫帶；嵌入牆面，只做外觀
    const bandTex = (() => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 128
      const x = c.getContext('2d')!
      x.fillStyle = '#dcae98'
      x.fillRect(0, 0, 64, 128)
      x.fillStyle = '#f6efe8'
      x.fillRect(0, 0, 64, 8)
      x.fillRect(0, 14, 64, 4)
      const t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      return t
    })()
    const R = buildingById('R')
    const S = buildingById('S')
    const cyl = (x: number, z: number, r: number, h: number, sign?: string) => {
      const y0 = at(x, z) - 1
      const t = bandTex.clone()
      t.needsUpdate = true
      t.repeat.set(4, h / FLOOR_H)
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 28), new THREE.MeshLambertMaterial({ map: t }))
      m.position.set(x, y0 + h / 2, z)
      m.castShadow = m.receiveShadow = true
      this.occluders.push(m)
      scene.add(m)
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.25, r + 0.25, 0.6, 28), new THREE.MeshLambertMaterial({ color: 0xf2ece4 }))
      cap.position.set(x, y0 + h + 0.3, z)
      scene.add(cap)
      if (sign) {
        // 面向西側中庭的「舍我樓 She-Wo Building」字樣
        const p = this.signPlane(signTexture('舍我樓', { color: '#2a2a2a', vertical: true, w: 256, h: 640, size: 180 }), 2.6, 6.5)
        p.position.set(x - r - 0.05, y0 + h - 7, z)
        p.rotation.y = -Math.PI / 2
        scene.add(p)
        const en = this.signPlane(signTexture('She-Wo Building', { color: '#2a2a2a', size: 110 }), 4.4, 1.1)
        en.position.set(x - r - 0.05, y0 + h - 11.4, z)
        en.rotation.y = -Math.PI / 2
        scene.add(en)
      }
    }
    // 南翼西端半圓樓梯塔（正射：白色圓角屋頂 x -38～-30.5）
    this.capture('obj:R-tower', '舍我樓 R 西端樓梯塔', '', 'ground', () => cyl(R.box.x0 - 2.5, (R.box.z0 + R.box.z1) / 2, 3.4, R.h + 2))
    // 「舍我樓 She-Wo Building」大圓柱：主塔西端與入口棟交會處，字樣面向西側中庭（正射圓形屋頂 (2,-43)）
    this.capture('obj:S-tower', '舍我樓 圓柱塔（招牌）', '', 'ground', () => cyl(S.box.x0 - 0.8, -43, 3.4, S.h - 3, 'sign'))
    // 主塔西面的三道三角形磚柱（DJI_0038_053：鋸齒狀凸出、面磚深褐），立在弧形裙樓之上
    this.capture('obj:S-prisms', '舍我樓 主塔西面三角磚柱', '', 'none', () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0x86594b })
      for (const z of [-59.5, -55, -50.5]) {
        const y0 = at(S.box.x0, z) + 3.6
        const h = S.h - 3.6
        const g = new THREE.CylinderGeometry(3.2, 3.2, h, 3)
        const m = new THREE.Mesh(g, mat)
        // 三角柱一角朝西、一邊貼牆
        m.rotation.y = -Math.PI / 2
        m.position.set(S.box.x0 + 1.4, y0 + h / 2, z)
        m.castShadow = m.receiveShadow = true
        this.occluders.push(m)
        scene.add(m)
      }
    })
    // 弧形裙樓頂的植栽槽與女兒牆（0038_053：裙樓頂一圈綠籬）
    this.capture('obj:SW-planter', '舍我樓 弧形裙樓植栽', '', 'none', () => {
      const SW = BUILDINGS.find(b => b.id === 'SW')
      if (!SW) return
      const y = at(3, -55) + SW.h
      const ring = new THREE.Mesh(new THREE.TorusGeometry(6.6, 0.75, 6, 24, Math.PI), new THREE.MeshLambertMaterial({ color: 0x4f7d3a }))
      ring.rotation.set(-Math.PI / 2, 0, Math.PI / 2)
      ring.position.set(3, y + 0.25, -55)
      scene.add(ring)
      const lip = new THREE.Mesh(new THREE.TorusGeometry(7.45, 0.18, 4, 24, Math.PI), new THREE.MeshLambertMaterial({ color: 0x8c6152 }))
      lip.rotation.copy(ring.rotation)
      lip.position.set(3, y + 0.5, -55)
      scene.add(lip)
    })
    // 南翼北面的退台陽台（0034_124、0042_022 紅框：面向北側中庭，每層一道白色欄杆陽台）
    this.capture('obj:R-balcony', '舍我樓 R 北面陽台', '', 'none', () => {
      const slabM = new THREE.MeshLambertMaterial({ color: 0xd9cfc4 })
      const railM = new THREE.MeshLambertMaterial({ color: 0xf0ece6 })
      const x0 = R.box.x0 + 1
      const x1 = R.box.x0 + 33
      const zf = R.box.z0
      // 一樓為拱廊（addSheWoHall），陽台與拱窗立面自二樓樓板起算
      const base = baseOf(R.pts) + (R.groundH ?? 0)
      const floors = Math.floor((R.h - (R.groundH ?? 0)) / FLOOR_H) - 1
      // 0042_030：北面為整片拱窗立面（每開間一拱），貼在陽台後方
      const archTex = (() => {
        const c = document.createElement('canvas')
        c.width = 128
        c.height = 128
        const x = c.getContext('2d')!
        x.fillStyle = '#b48b7b'
        x.fillRect(0, 0, 128, 128)
        x.fillStyle = '#4b3a35'
        x.beginPath()
        x.moveTo(26, 118)
        x.lineTo(26, 52)
        x.arc(64, 52, 38, Math.PI, 0)
        x.lineTo(102, 118)
        x.closePath()
        x.fill()
        x.fillStyle = '#7f98ad'
        x.fillRect(38, 70, 52, 48)
        x.fillStyle = '#d8cdc2'
        x.fillRect(0, 118, 128, 10)
        const t = new THREE.CanvasTexture(c)
        t.colorSpace = THREE.SRGBColorSpace
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.repeat.set((x1 - x0) / 3.6, floors)
        return t
      })()
      const face = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, floors * FLOOR_H), new THREE.MeshLambertMaterial({ map: archTex }))
      face.rotation.y = Math.PI
      face.position.set((x0 + x1) / 2, base + (floors * FLOOR_H) / 2, zf - 0.06)
      scene.add(face)
      for (let f = 1; f <= floors; f++) {
        const depth = 0.8 + Math.max(0, 2 - f) * 0.6
        const y = base + f * FLOOR_H
        const slab = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.28, depth), slabM)
        slab.position.set((x0 + x1) / 2, y, zf - depth / 2)
        slab.castShadow = true
        const rail = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 1.0, 0.12), railM)
        rail.position.set((x0 + x1) / 2, y + 0.6, zf - depth + 0.06)
        scene.add(slab, rail)
      }
    })
    // 屋頂水塔：主塔兩大兩小、入口棟南段兩座（正射圓形）
    this.capture('obj:she-tanks', '舍我樓屋頂水塔', '', 'none', () => {
      const tank = new THREE.MeshLambertMaterial({ color: 0xe9e6e0 })
      const put = (x: number, z: number, r: number, h: number, b: typeof S) => {
        const y = groundHeight(b.c.x, b.c.z) + b.h
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), tank)
        m.position.set(x, y + h / 2, z)
        m.castShadow = true
        scene.add(m)
        const top = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), tank)
        top.scale.y = 0.35
        top.position.set(x, y + h, z)
        scene.add(top)
      }
      const SE = buildingById('SE')
      put(11.3, -52, 2.3, 3, S)
      put(17.4, -52, 2.3, 3, S)
      put(27, -51.5, 1.3, 2.4, S)
      put(31, -51.5, 1.3, 2.4, S)
      put(10, -28, 1.5, 2.6, SE)
      put(10, -24.3, 1.5, 2.6, SE)
    })

    // 八方廣場旁的紅色角錐屋頂小塔＝電梯塔（使用者 2026-10-09 紅框），改由 addDeck2F 建立

    // 山坡上的紅色八角涼亭（0034_95、0034_124）
    this.capture('obj:pavilion', '紅色八角涼亭', '', 'terrain', () => {
      const x = -30
      const z = 12
      const y = terrainHeight(x, z)
      const g = new THREE.Group()
      const red = new THREE.MeshLambertMaterial({ color: 0xb8242f })
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3), red)
        p.position.set(Math.cos(a) * 2.6, 1.5, Math.sin(a) * 2.6)
        g.add(p)
      }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4, 2.2, 8), new THREE.MeshLambertMaterial({ color: 0xd2753d }))
      roof.position.y = 4.1
      const floor = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 0.6, 8), new THREE.MeshLambertMaterial({ color: 0xd8d2c6 }))
      floor.position.y = 0.1
      g.add(roof, floor)
      g.traverse(o => (o.castShadow = true))
      g.position.set(x, y, z)
      scene.add(g)
    })

    // 通識大樓面向言論廣場的圓形雨遮（0042_144）
    this.capture('obj:G-canopy', '通識大樓圓形雨遮', '', 'ground', () => {
      const G = buildingById('G')
      const sp = centroid(AREAS.find(a => a.id === 'speech')!.pts)
      const f = faceToward(G.pts, sp)
      const y = at(f.mid.x, f.mid.z)
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 0.5, 40, 1, false, 0, Math.PI), new THREE.MeshLambertMaterial({ color: 0xe7e5e0 }))
      disc.position.set(f.mid.x, y + 4.6, f.mid.z)
      disc.rotation.y = f.yaw - Math.PI / 2
      disc.castShadow = true
      scene.add(disc)
      for (const a of [0.35, 1.0, 1.65, 2.3, 2.8]) {
        const lx = Math.cos(a) * 7
        const lz = Math.sin(a) * 7
        const ang = f.yaw - Math.PI / 2
        const px = f.mid.x + lx * Math.cos(ang) + lz * Math.sin(ang)
        const pz = f.mid.z - lx * Math.sin(ang) + lz * Math.cos(ang)
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 4.6), new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }))
        post.position.set(px, y + 2.3, pz)
        scene.add(post)
      }
    })

    // 新聞大樓臨木柵路的白色斜坡格柵牆（0034_26）
    this.capture('obj:J-grille', '新聞大樓格柵牆', '', 'ground', () => {
      const J = buildingById('J')
      const f = faceToward(J.pts, { x: J.c.x, z: J.c.z + 100 })
      const len = Math.min(f.len, 40)
      const tex = (() => {
        const c = document.createElement('canvas')
        c.width = 256
        c.height = 64
        const x = c.getContext('2d')!
        x.fillStyle = '#f4f4f1'
        x.fillRect(0, 0, 256, 64)
        x.fillStyle = '#c9cbcb'
        for (let i = 0; i < 64; i += 8) x.fillRect(0, i, 256, 3)
        const t = new THREE.CanvasTexture(c)
        t.colorSpace = THREE.SRGBColorSpace
        return t
      })()
      const geo = new THREE.PlaneGeometry(len, 7.5)
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }))
      const y = baseOf(J.pts)
      m.position.set(f.mid.x + f.n.x * 2.6, y + 2.6, f.mid.z + f.n.z * 2.6)
      m.rotation.set(0, f.yaw, 0)
      m.rotateX(-0.75)
      m.receiveShadow = true
      scene.add(m)
    })

    // 地形範圍外的市區地面，避免道路懸空、邊緣露出背景
    {
      let min = Infinity
      for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 20; j++) {
          min = Math.min(min, groundHeight(BOUNDS.minX + ((BOUNDS.maxX - BOUNDS.minX) * i) / 20, BOUNDS.minZ + ((BOUNDS.maxZ - BOUNDS.minZ) * j) / 20))
        }
      }
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(3200, 3200), new THREE.MeshLambertMaterial({ color: 0x9e9c98 }))
      plane.rotation.x = -Math.PI / 2
      plane.position.set((BOUNDS.minX + BOUNDS.maxX) / 2, min - 1.2, (BOUNDS.minZ + BOUNDS.maxZ) / 2)
      plane.receiveShadow = true
      scene.add(plane)
    }
  }

  private addBackGate(): void {
    const y = groundHeight(BACK_GATE.x, BACK_GATE.z)
    const len = Math.hypot(BACK_GATE.dir.x, BACK_GATE.dir.z)
    const d = { x: BACK_GATE.dir.x / len, z: BACK_GATE.dir.z / len }
    const perp = { x: -d.z, z: d.x }
    const mat = new THREE.MeshLambertMaterial({ map: facadeTexture('brick') })
    const g = new THREE.Group()
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 5, 1.2), mat)
      p.position.set(s * 3.2, 2.5, 0)
      p.castShadow = true
      g.add(p)
      this.obstacles.push({ x: BACK_GATE.x + perp.x * s * 3.2, z: BACK_GATE.z + perp.z * s * 3.2, r: 0.8 })
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(7.6, 1.1, 1.4), new THREE.MeshLambertMaterial({ color: 0x5b5f63 }))
    beam.position.y = 5.4
    g.add(beam)
    const sign = this.signPlane(signTexture('後校門', { color: '#ffffff' }), 3.8, 0.95)
    sign.position.set(0, 5.4, -0.72)
    sign.rotation.y = Math.PI
    g.add(sign)
    g.position.set(BACK_GATE.x, y, BACK_GATE.z)
    g.rotation.y = Math.atan2(perp.x, perp.z) - Math.PI / 2
    this.scene.add(g)
  }

  // ─── 圍欄 ─────────────────────────────────────────
  /**
   * 依 0037_057–086、0042_098–114 空拍：
   * - 操場北側沿試院路：紅磚矮牆＋墨綠欄杆，牆內為椰子樹步道與座椅；西北角繞過試院路迴車圓環
   * - 大禮堂北側到後校門：同款磚牆欄杆，後校門兩柱之間開口
   * - 網球場（大禮堂東側）：約 4 m 高墨綠色菱形鐵絲網，朝跑道一側留門
   * - 跑道東南側（傳播大廈車道旁）：1.2 m 欄杆
   * 圍欄會阻擋行走；編輯模式可整段拖曳、旋轉。
   */
  private addFences(): void {
    const tex = (draw: (g: CanvasRenderingContext2D) => void, rx: number, ry: number) => {
      const c = document.createElement('canvas')
      c.width = c.height = 64
      const g = c.getContext('2d')!
      draw(g)
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 4
      t.repeat.set(rx, ry)
      return t
    }
    const green = '#2c4f42'
    // 欄杆直條：每 0.13 m 一支
    const pickets = tex(g => {
      g.fillStyle = green
      g.fillRect(26, 0, 12, 64)
    }, 1 / 0.13, 1)
    // 菱形鐵絲網：每 0.5 m 一格
    const chain = tex(g => {
      g.strokeStyle = green
      g.lineWidth = 5
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(64, 64)
      g.moveTo(64, 0)
      g.lineTo(0, 64)
      g.stroke()
    }, 1 / 0.5, 1 / 0.5)
    const M = {
      brick: new THREE.MeshLambertMaterial({ color: 0x9c4f3c }),
      coping: new THREE.MeshLambertMaterial({ color: 0xd8cfc4 }),
      metal: new THREE.MeshLambertMaterial({ color: 0x2c4f42 }),
      pickets: new THREE.MeshLambertMaterial({ map: pickets, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }),
      chain: new THREE.MeshLambertMaterial({ map: chain, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    }
    type Style = 'street' | 'mesh' | 'rail'
    const build = (pts: Vec2[], style: Style) => {
      const parts = new Map<THREE.Material, THREE.BufferGeometry[]>()
      const put = (mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, yaw: number) => {
        geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)))
        const l = parts.get(mat) ?? []
        l.push(geo)
        parts.set(mat, l)
      }
      // 依實際尺寸設定面板 UV（公尺），讓直條與網目密度一致
      const panel = (len: number, h: number) => {
        const p = new THREE.PlaneGeometry(len, h)
        const uv = p.attributes.uv as THREE.BufferAttribute
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * h)
        return p
      }
      const railH = style === 'mesh' ? 4 : style === 'rail' ? 1.2 : 0.85
      const wallH = style === 'street' ? 0.9 : 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        const L = Math.hypot(b.x - a.x, b.z - a.z)
        const n = Math.max(1, Math.ceil(L / 2.5))
        for (let k = 0; k < n; k++) {
          const p = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n }
          const q = { x: a.x + ((b.x - a.x) * (k + 1)) / n, z: a.z + ((b.z - a.z) * (k + 1)) / n }
          const len = L / n
          const mx = (p.x + q.x) / 2
          const mz = (p.z + q.z) / 2
          const yaw = Math.atan2(-(q.z - p.z), q.x - p.x)
          const y0 = Math.min(groundHeight(p.x, p.z), groundHeight(q.x, q.z))
          const y1 = Math.max(groundHeight(p.x, p.z), groundHeight(q.x, q.z))
          let top = y0
          if (wallH) {
            // 磚牆往下埋到坡面較低處，避免斜坡上懸空
            const h = wallH + (y1 - y0) + 1.2
            put(M.brick, new THREE.BoxGeometry(len + 0.02, h, 0.32), mx, y1 + wallH - h / 2, mz, yaw)
            put(M.coping, new THREE.BoxGeometry(len + 0.06, 0.08, 0.42), mx, y1 + wallH + 0.04, mz, yaw)
            top = y1 + wallH + 0.08
          }
          put(style === 'mesh' ? M.chain : M.pickets, panel(len, railH), mx, top + railH / 2, mz, yaw)
          put(M.metal, new THREE.BoxGeometry(len, 0.06, 0.06), mx, top + railH, mz, yaw)
          if (style !== 'mesh') put(M.metal, new THREE.BoxGeometry(len, 0.05, 0.05), mx, top + 0.08, mz, yaw)
          put(M.metal, new THREE.BoxGeometry(0.08, railH + (wallH ? 0 : 0.3), 0.08), p.x, top + railH / 2 - (wallH ? 0 : 0.15), p.z, 0)
          if (k === n - 1 && i === pts.length - 1) put(M.metal, new THREE.BoxGeometry(0.08, railH, 0.08), q.x, top + railH / 2, q.z, 0)
        }
        // 阻擋行走：每 0.7 m 一個碰撞點
        const m = Math.max(1, Math.ceil(L / 0.7))
        for (let k = 0; k <= m; k++) this.obstacles.push({ x: a.x + ((b.x - a.x) * k) / m, z: a.z + ((b.z - a.z) * k) / m, r: 0.3 })
      }
      for (const [mat, geos] of parts) {
        const mesh = new THREE.Mesh(mergeGeometries(geos), mat)
        mesh.castShadow = mat !== M.chain && mat !== M.pickets
        mesh.receiveShadow = true
        this.scene.add(mesh)
      }
    }
    const P = (a: [number, number][]) => a.map(([x, z]) => ({ x, z }))
    // 後校門兩側（柱位見 addBackGate；西側止於綠色玻璃雨棚北緣）
    const gl = Math.hypot(BACK_GATE.dir.x, BACK_GATE.dir.z)
    const gp = { x: -BACK_GATE.dir.z / gl, z: BACK_GATE.dir.x / gl }
    const pillar = (s: number) => ({ x: BACK_GATE.x + gp.x * s * 3.9, z: BACK_GATE.z + gp.z * s * 3.9 })
    const west = pillar(-1)
    const east = pillar(1)
    this.capture('obj:fence-backgate-w', '圍欄：後校門西側', '', 'ground', () => build([{ x: 76, z: -56.4 }, west], 'street'))
    this.capture('obj:fence-backgate-e', '圍欄：後校門東側（大禮堂北側）', '', 'ground', () => build([east, ...P([[100, -55.3], [136, -55.5]])], 'street'))
    this.capture('obj:fence-track-nw', '圍牆：操場西北角（試院路迴車圓環）', '', 'ground', () =>
      build(P([[136, -55.5], [141, -54.8], [145.5, -52.6], [148.6, -49], [150.2, -45.2], [153, -43.6], [158, -43.3]]), 'street'),
    )
    this.capture('obj:fence-track-n', '圍欄：操場北側（試院路）', '', 'ground', () =>
      build(P([[158, -43.3], [167, -45.6], [176, -48.6], [215, -41.6], [240, -37], [252, -33], [262, -30]]), 'street'),
    )
    this.capture('obj:fence-track-se', '欄杆：跑道東南側', '', 'ground', () => build(P([[217.5, 9.4], [247.5, 11.6]]), 'rail'))
    // 網球場鐵絲網：依 OSM 球場輪廓外推 0.6 m，東側（朝跑道）留 2.4 m 門
    const court = AREAS.find(a => a.id === 'tennis')
    if (court) {
      const c = centroid(court.pts)
      const ring = court.pts.map(p => {
        const l = Math.hypot(p.x - c.x, p.z - c.z) || 1
        return { x: p.x + ((p.x - c.x) / l) * 0.6, z: p.z + ((p.z - c.z) / l) * 0.6 }
      })
      // 找最靠東的一邊放門
      let ei = 0
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const e = ring[ei]
        const f = ring[(ei + 1) % ring.length]
        if (a.x + b.x > e.x + f.x) ei = i
      }
      const a = ring[ei]
      const b = ring[(ei + 1) % ring.length]
      const L = Math.hypot(b.x - a.x, b.z - a.z)
      const u = { x: (b.x - a.x) / L, z: (b.z - a.z) / L }
      const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      const d1 = { x: m.x + u.x * 1.2, z: m.z + u.z * 1.2 }
      const d0 = { x: m.x - u.x * 1.2, z: m.z - u.z * 1.2 }
      const line: Vec2[] = [d1]
      for (let k = 1; k <= ring.length; k++) line.push(ring[(ei + k) % ring.length])
      line.push(d0)
      this.capture('obj:fence-tennis', '網球場鐵絲網', '', 'ground', () => build(line, 'mesh'))
    }
  }

  private addStreetDressing(): void {
    this.capture('obj:sign-muzha', '路牌：木柵路一段', '', 'ground', () => {
    const sign = this.signPlane(signTexture('木柵路一段', { color: '#ffffff', bg: '#2f6a46', size: 120 }), 4.8, 1.2)
    // 路牌立在校門西側人行道，不擋住校門正面
    const T = GATE_FRAME.tan
    const p = { x: START.pos.x - T.x * 16, z: START.pos.z - T.z * 16 }
    const y = groundHeight(p.x, p.z)
    sign.position.set(p.x, y + 4, p.z)
    sign.rotation.y = Math.atan2(-GATE_FRAME.nIn.x, -GATE_FRAME.nIn.z)
    this.scene.add(sign)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4), new THREE.MeshLambertMaterial({ color: 0x777777 }))
    pole.position.set(p.x, y + 2, p.z - 0.1)
    this.scene.add(pole)
    })
    this.capture('obj:sign-shiyuan', '路牌：試院路', '', 'ground', () => {
    const shi = this.signPlane(signTexture('試院路', { color: '#ffffff', bg: '#2f6a46', size: 120 }), 3.6, 1)
    const q = { x: BACK_GATE.x + 3, z: BACK_GATE.z - 7 }
    shi.position.set(q.x, groundHeight(q.x, q.z) + 3.6, q.z)
    this.scene.add(shi)
    })
  }

  // ─── 植栽 ─────────────────────────────────────────
  private addTrees(): void {
    const r = rng(42)
    const trees: { x: number; z: number; s: number; palm?: boolean; obs?: Obstacle }[] = []
    // 山坡樹林
    // 依正射影像樹冠遮罩種樹：只長在航照上有樹冠、且不是步道／建物／場地的位置
    const noTree = AREAS.filter(a => a.kind === 'sports' || a.kind === 'court' || a.kind === 'field' || a.kind === 'plaza')
    const plazaAreas = AREAS.filter(a => a.kind === 'plaza')
    let guard = 0
    while (trees.length < 5600 && guard++ < 200000) {
      const x = BOUNDS.minX + r() * (BOUNDS.maxX - BOUNDS.minX)
      const z = BOUNDS.minZ + r() * (BOUNDS.maxZ - BOUNDS.minZ)
      if (!canopyAt(x, z)) continue
      const p = { x, z }
      const bw = bankWeight(x, z)
      const h = Math.max(hillAt(x, z), bw * 10)
      const tp = tunnelParam(p)
      if (tp.d < TUNNEL.w / 2 + 2 && tp.t > -0.05 && tp.t < 1.05 && h < 11) continue
      if (bw > 0.02) {
        // 宿舍山坡（DJI_0043_000–012）：坡面是連成一片的闊葉林；坡腳 2 m 內留給綠籬，冠幅不蓋過紅磚坡道
        const bp = bankProject(x, z)
        if (bp.d < 2.2 || insideSolid(p, 1.8) || onPaved(p) || Math.hypot(x - D2_LIFT_AT.x, z - D2_LIFT_AT.z) < 4.5) continue
        trees.push({ x, z, s: bp.d < 6 ? 1.0 + r() * 0.4 : 1.25 + r() * 0.75 })
        continue
      }
      // 校門正前方與門體兩側保持淨空
      if (Math.hypot(x - GATE_FRAME.a.x, z - GATE_FRAME.a.z) < GATE_CLEAR_R && gateDepth(p) < 4) continue
      if (h < 1.6) {
        // 平地上的樹：避開步道、建物與主動線
        if (onPaved(p) || insideSolid(p, 2.5) || distToPolyline(p, ROUTE) < 6) continue
        if (noTree.some(a => pointInPolygon(p, a.pts))) continue
        if (BUILDINGS.some(b => pointInPolygon(p, b.pts))) continue
      } else if (insideSolid(p, 1.5) || (h < 8 && onPaved(p)) || noTree.some(a => pointInPolygon(p, a.pts))) continue
      // 空拍中山坡樹冠連成一片：山坡樹放大（冠幅約 9–15 m），平地行道樹維持較小
      // 緊鄰廣場（言論廣場、舍我樓北側平台等）的林緣樹較小，避免樹冠蓋住廣場（13757/13765）
      const nearPlaza = [0, 1, 2, 3, 4, 5, 6, 7].some(k => {
        const q = { x: x + Math.cos((k * Math.PI) / 4) * 9, z: z + Math.sin((k * Math.PI) / 4) * 9 }
        return plazaAreas.some(a => pointInPolygon(q, a.pts))
      })
      trees.push({ x, z, s: h < 1.6 ? 0.8 + r() * 0.5 : insideSolid(p, 6) || nearPlaza ? 0.9 + r() * 0.35 : 1.5 + r() * 1.1 })
    }
    // 學校廣場樹陣：0052_059 空拍為大禮堂前西側的規則格狀樹陣（plazaSurvey.ts）
    {
      const tg = PLAZA_SURVEY.treeGrid
      for (let x = tg.x0; x <= tg.x1 + 0.01; x += tg.step) {
        for (let z = tg.z0; z <= tg.z1 + 0.01; z += tg.step) {
          const p = { x, z }
          if (distToPolyline(p, ROUTE) < 2.5 || Math.hypot(p.x - STAGE.x, p.z - STAGE.z) < STAGE.r + 3) continue
          if (insideSolid(p, 2)) continue
          const obs = { x, z, r: 0.5 }
          trees.push({ x, z, s: 0.85 + r() * 0.2, obs })
          this.obstacles.push(obs)
        }
      }
    }
    // 舍我樓西側中庭西緣的棕櫚（DJI_0038_053）
    // 言論廣場：通識大樓前圓環南側一列大王椰子（13757/13765）
    for (const q of [{ x: -11.5, z: -38.5 }, { x: -99, z: -19.6 }, { x: -95, z: -20.6 }, { x: -91, z: -21.6 }, { x: -87, z: -22.6 }]) {
      const obs = { x: q.x, z: q.z, r: 0.4 }
      trees.push({ x: q.x, z: q.z, s: 0.8, palm: true, obs })
      this.obstacles.push(obs)
    }
    // 言論廣場：圓環東側（通識大樓東端前）的大樹
    {
      const obs = { x: -71.5, z: -42.5, r: 0.7 }
      trees.push({ x: obs.x, z: obs.z, s: 1.35, obs })
      this.obstacles.push(obs)
    }
    // 隧道出口紅磚坡道南側：女一舍電梯塔以東、玻璃弧廊以北的林帶大樹（DJI_0043 第 24 秒）
    for (const [s, o, sc] of [[54, -8.6, 1.15], [60, -11, 1.3], [66, -12.8, 1.1]]) {
      const q = splitPoint(s, o)
      if (insideSolid(q, 1.5) || onPaved(q)) continue
      const obs = { x: q.x, z: q.z, r: 0.6 }
      trees.push({ x: q.x, z: q.z, s: sc, obs })
      this.obstacles.push(obs)
    }
    // 宿舍山坡坡面大樹：坡面中段到坡肩一排大冠幅闊葉樹（DJI_0043_000–007）
    {
      const rb = rng(203)
      for (let t = 2; t < BANK_LEN - 1; t += 4.2) {
        const { p, dir } = toeSample(t)
        const d = 4.5 + rb() * 6
        const q = { x: p.x - dir.z * d, z: p.z + dir.x * d }
        if (bankWeight(q.x, q.z) < 0.25 || insideSolid(q, 2.5) || onPaved(q)) continue
        if (Math.hypot(q.x - D2_LIFT_AT.x, q.z - D2_LIFT_AT.z) < 5 || distToPolyline(q, [D2_STAIR_A, D2_STAIR_B]) < 3) continue
        trees.push({ x: q.x, z: q.z, s: 1.35 + rb() * 0.6 })
      }
    }
    // 操場北緣的大王椰子
    const north = PATHS.find(p => p.id === 'track-north')
    if (north) {
      const pts = resample(north.pts, 8)
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1]
        const b = pts[i + 1]
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
        const n = { x: (b.z - a.z) / len, z: -(b.x - a.x) / len }
        const side = n.z < 0 ? 1 : -1
        const q = { x: pts[i].x + n.x * side * 2.6, z: pts[i].z + n.z * side * 2.6 }
        if (insideSolid(q, 1) || !onPaved(q)) continue
        const obs = { x: q.x, z: q.z, r: 0.4 }
        trees.push({ x: q.x, z: q.z, s: 1, palm: true, obs })
        this.obstacles.push(obs)
      }
    }

    const normal = trees.filter(t => !t.palm)
    const palms = trees.filter(t => t.palm)
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.34, 3, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a33 }), normal.length)
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 1), new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), normal.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const col = new THREE.Color()
    const usedIds = new Set<string>()
    const idFor = (kind: string, x: number, z: number) => {
      let id = `${kind}@${x.toFixed(1)},${z.toFixed(1)}`
      while (usedIds.has(id)) id += '+'
      usedIds.add(id)
      return id
    }
    const treeIds: string[] = []
    normal.forEach((t, i) => {
      const sy = t.s * (0.9 + r() * 0.5)
      const spin = r() * 6
      const place = (x: number, z: number, rot: number) => {
        const y = terrainHeight(x, z)
        m.compose(new THREE.Vector3(x, y + 1.5 * t.s, z), q.identity(), new THREE.Vector3(t.s, t.s, t.s))
        trunk.setMatrixAt(i, m)
        m.compose(new THREE.Vector3(x, y + 3 * t.s + 1.6 * sy, z), q.setFromEuler(new THREE.Euler(0, spin + rot, 0)), new THREE.Vector3(t.s * 1.1, sy, t.s * 1.1))
        crown.setMatrixAt(i, m)
      }
      place(t.x, t.z, 0)
      if (t.s >= 1.5) col.setHSL(0.25 + r() * 0.07, 0.36 + r() * 0.16, 0.12 + r() * 0.08)
      else col.setHSL(0.24 + r() * 0.08, 0.4 + r() * 0.18, 0.16 + r() * 0.08)
      crown.setColorAt(i, col)
      const id = idFor('tree', t.x, t.z)
      treeIds.push(id)
      const top = 3 * t.s + 3.2 * sy
      const mv: Movable = {
        id,
        kind: 'tree',
        label: '樹木',
        home: { x: t.x, z: t.z },
        edit: { dx: 0, dz: 0, rot: 0 },
        dataLevel: false,
        apply: e => {
          mv.edit = { ...e }
          const x = t.x + e.dx
          const z = t.z + e.dz
          place(x, z, e.rot)
          if (t.obs) {
            t.obs.x = x
            t.obs.z = z
          }
          trunk.instanceMatrix.needsUpdate = crown.instanceMatrix.needsUpdate = true
          trunk.boundingSphere = crown.boundingSphere = null
        },
        bounds: b => {
          const x = t.x + mv.edit.dx
          const z = t.z + mv.edit.dz
          const y = terrainHeight(x, z)
          const rr = 2.6 * t.s
          return b.set(new THREE.Vector3(x - rr, y, z - rr), new THREE.Vector3(x + rr, y + top, z + rr))
        },
      }
      this.movables.add(mv)
    })
    this.movables.addInstanced(trunk, treeIds)
    this.movables.addInstanced(crown, treeIds)
    trunk.castShadow = crown.castShadow = true
    crown.receiveShadow = true
    this.scene.add(trunk, crown)

    if (palms.length) {
      const pTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.28, 10, 6), new THREE.MeshLambertMaterial({ color: 0x9a8f7f }), palms.length)
      const pCrown = new THREE.InstancedMesh(new THREE.ConeGeometry(2.0, 1.1, 7, 1, true), new THREE.MeshLambertMaterial({ color: 0x6fb04a, side: THREE.DoubleSide }), palms.length)
      const palmIds: string[] = []
      palms.forEach((t, i) => {
        const place = (x: number, z: number, rot: number) => {
          const y = groundHeight(x, z)
          m.compose(new THREE.Vector3(x, y + 5, z), q.identity(), new THREE.Vector3(1, 1, 1))
          pTrunk.setMatrixAt(i, m)
          m.compose(new THREE.Vector3(x, y + 9.8, z), q.setFromEuler(new THREE.Euler(Math.PI, i + rot, 0)), new THREE.Vector3(1, 1, 1))
          pCrown.setMatrixAt(i, m)
        }
        place(t.x, t.z, 0)
        const id = idFor('palm', t.x, t.z)
        palmIds.push(id)
        const mv: Movable = {
          id,
          kind: 'palm',
          label: '大王椰子',
          home: { x: t.x, z: t.z },
          edit: { dx: 0, dz: 0, rot: 0 },
          dataLevel: false,
          apply: e => {
            mv.edit = { ...e }
            const x = t.x + e.dx
            const z = t.z + e.dz
            place(x, z, e.rot)
            if (t.obs) {
              t.obs.x = x
              t.obs.z = z
            }
            pTrunk.instanceMatrix.needsUpdate = pCrown.instanceMatrix.needsUpdate = true
            pTrunk.boundingSphere = pCrown.boundingSphere = null
          },
          bounds: b => {
            const x = t.x + mv.edit.dx
            const z = t.z + mv.edit.dz
            const y = groundHeight(x, z)
            return b.set(new THREE.Vector3(x - 2, y, z - 2), new THREE.Vector3(x + 2, y + 10.5, z + 2))
          },
        }
        this.movables.add(mv)
      })
      this.movables.addInstanced(pTrunk, palmIds)
      this.movables.addInstanced(pCrown, palmIds)
      pTrunk.castShadow = pCrown.castShadow = true
      this.scene.add(pTrunk, pCrown)
    }
  }

  private addLamps(): void {
    const total = routeLength(ROUTE)
    const spots: Vec2[] = []
    for (let s = 30; s < total - 10; s += 22) {
      const { p, dir } = samplePath(ROUTE, s)
      if (tunnelParam(p).d < TUNNEL.w) continue
      const side = spots.length % 2 ? 1 : -1
      const q = { x: p.x - dir.z * 2.2 * side, z: p.z + dir.x * 2.2 * side }
      if (!isWalkable(q, 1.2)) continue
      spots.push(q)
    }
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, 4.2, 6), new THREE.MeshLambertMaterial({ color: 0x2f2f33 }), spots.length)
    const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff3d2 }), spots.length)
    const m = new THREE.Matrix4()
    const ids: string[] = []
    spots.forEach((p, i) => {
      const place = (x: number, z: number) => {
        const y = groundHeight(x, z)
        m.makeTranslation(x, y + 2.1, z)
        pole.setMatrixAt(i, m)
        m.makeTranslation(x, y + 4.3, z)
        head.setMatrixAt(i, m)
      }
      place(p.x, p.z)
      const obs = { x: p.x, z: p.z, r: 0.2 }
      this.obstacles.push(obs)
      const id = `lamp@${p.x.toFixed(1)},${p.z.toFixed(1)}`
      ids.push(id)
      const mv: Movable = {
        id,
        kind: 'lamp',
        label: '路燈',
        home: { x: p.x, z: p.z },
        edit: { dx: 0, dz: 0, rot: 0 },
        dataLevel: false,
        apply: e => {
          mv.edit = { ...e }
          obs.x = p.x + e.dx
          obs.z = p.z + e.dz
          place(obs.x, obs.z)
          pole.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = true
          pole.boundingSphere = head.boundingSphere = null
        },
        bounds: b => {
          const y = groundHeight(obs.x, obs.z)
          return b.set(new THREE.Vector3(obs.x - 0.5, y, obs.z - 0.5), new THREE.Vector3(obs.x + 0.5, y + 4.7, obs.z + 0.5))
        },
      }
      this.movables.add(mv)
    })
    this.movables.addInstanced(pole, ids)
    this.movables.addInstanced(head, ids)
    this.scene.add(pole, head)
  }

  /** 學校廣場東側咖啡座陽傘與西北角綠色玻璃雨棚（0052_059、0086、0096 空拍） */
  private addPlazaFurniture(): void {
    const U = PLAZA_SURVEY.umbrellas
    // 0042_128：咖啡座陽傘紅、綠、白交錯
    const canvasMats = [0xd2475a, 0x5aa65a, 0xf1ede4].map(c => new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide }))
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x6c6c6c })
    const tableMat = new THREE.MeshLambertMaterial({ color: 0x8a6a4c })
    let k = 0
    for (let x = U.x0; x <= U.x1 + 0.01; x += U.step) {
      const p = { x, z: U.z }
      if (insideSolid(p, 1)) continue
      k++
      this.capture(`obj:umbrella-${k}`, `咖啡座陽傘 ${k}`, '', 'ground', () => {
        const y = groundHeight(p.x, p.z)
        const g = new THREE.Group()
        const top = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 8, 1, true), canvasMats[k % 3])
        top.position.y = 2.6
        const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6), poleMat)
        pl.position.y = 1.3
        const tb = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 12), tableMat)
        tb.position.y = 0.75
        g.add(top, pl, tb)
        g.traverse(o => (o.castShadow = true))
        g.position.set(p.x, y, p.z)
        this.scene.add(g)
        this.obstacles.push({ x: p.x, z: p.z, r: 0.6 })
      })
    }
    const C = PLAZA_SURVEY.canopy
    this.capture('obj:plaza-canopy', '學校廣場綠色玻璃雨棚', '', 'ground', () => {
      const y = groundHeight(C.x, C.z)
      const g = new THREE.Group()
      const glass = new THREE.Mesh(new THREE.BoxGeometry(C.w, 0.2, C.d), new THREE.MeshLambertMaterial({ color: 0x5fae8c, transparent: true, opacity: 0.75 }))
      glass.position.y = 3.6
      glass.rotation.x = 0.1
      g.add(glass)
      const frame = new THREE.MeshLambertMaterial({ color: 0xe8e8e4 })
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.6), frame)
          post.position.set(sx * (C.w / 2 - 0.4), 1.8 - sz * 0.45, sz * (C.d / 2 - 0.4))
          g.add(post)
        }
      g.traverse(o => (o.castShadow = true))
      g.position.set(C.x, y, C.z)
      g.rotation.y = C.rot
      this.scene.add(g)
    })
  }

  /**
   * 舍我樓前庭周邊（使用者藍框照片 DJI_0042_128，自大禮堂上空向西拍）：
   * 前庭南側水泥車道西端的石砌告示牆、牆後花圃與矮牆、前庭西南角階梯（資料層 she-court-steps）、
   * 林緣露天咖啡座（三座深色四坡頂小亭＋木平台）、主塔南面西端的半圓陽台、入口棟門廊雨遮，
   * 以及主塔東段／附屬棟南面那條很長的米黃色半圓拱頂雨棚。
   */
  private addCourtSurroundings(): void {
    const scene = this.scene
    const at = (x: number, z: number) => groundHeight(x, z)
    // 告示牆：水泥車道西端南側，石材牆面＋深色告示板
    this.capture('obj:court-sign', '前庭南側告示牆', '', 'ground', () => {
      const x = 27.5
      const z = -9.6
      const y = at(x, z)
      const g = new THREE.Group()
      const wall = new THREE.Mesh(new THREE.BoxGeometry(6.2, 2.2, 0.7), new THREE.MeshLambertMaterial({ color: 0xbdb7ad }))
      wall.position.y = 1.1
      const board = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.2, 0.1), new THREE.MeshLambertMaterial({ color: 0x5b5f63 }))
      board.position.set(0, 1.3, -0.4)
      g.add(wall, board)
      g.traverse(o => (o.castShadow = true))
      g.position.set(x, y, z)
      g.rotation.y = 0.25
      scene.add(g)
      for (const dx of [-2.4, -0.8, 0.8, 2.4]) this.obstacles.push({ x: x + dx, z: z - dx * 0.25, r: 0.6 })
    })
    // 花圃：前庭西南角、R 棟東端與階梯之間的灌木叢，外緣一道矮牆
    this.capture('obj:court-garden', '前庭西南花圃', '', 'ground', () => {
      const x0 = 12.8
      const x1 = 18.6
      const z0 = -29.5
      const z1 = -17.5
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      const y = at(cx, cz)
      const g = new THREE.Group()
      const bed = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.9, z1 - z0), new THREE.MeshLambertMaterial({ color: 0x8d8478 }))
      bed.position.y = 0.45
      const shrub = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.4, 1.0, z1 - z0 - 0.4), new THREE.MeshLambertMaterial({ color: 0x3f6f35 }))
      shrub.position.y = 1.3
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.1, z1 - z0 + 3), new THREE.MeshLambertMaterial({ color: 0xc9c3b8 }))
      wall.position.set(x1 - cx + 0.3, 0.55, 1.5)
      g.add(bed, shrub, wall)
      for (const [dx, dz, r] of [[-1.2, -3.5, 1.6], [1.0, 1.5, 1.9], [-0.8, 4.2, 1.4]] as const) {
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshLambertMaterial({ color: 0x4d8a3c, flatShading: true }))
        crown.position.set(dx, 2.6 + r * 0.6, dz)
        g.add(crown)
      }
      g.traverse(o => (o.castShadow = true))
      g.position.set(cx, y, cz)
      scene.add(g)
      for (let z = z0 + 1.2; z < z1; z += 2.4) for (const x of [x0 + 1.5, x1 - 1.5]) this.obstacles.push({ x, z, r: 1.6 })
    })
    // 林緣露天咖啡座：木平台＋三座深色四坡頂小亭
    this.capture('obj:cafe-deck', '林緣露天咖啡座平台', '', 'ground', () => {
      const deck = new THREE.Mesh(
        this.ribbon([{ x: 44, z: -2.45 }, { x: 78, z: -3.45 }], 10, 0.25),
        new THREE.MeshLambertMaterial({ color: 0x8a6448, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      )
      deck.receiveShadow = true
      scene.add(deck)
    })
    const hutRoof = new THREE.MeshLambertMaterial({ color: 0x4a3c34, flatShading: true })
    const hutPost = new THREE.MeshLambertMaterial({ color: 0x6b4a33 })
    ;[
      { x: 48.5, z: -2.5, rot: 0.15 },
      { x: 56.5, z: -0.8, rot: 0.15 },
      { x: 65, z: 0.4, rot: 0.15 },
    ].forEach((h, i) => {
      this.capture(`obj:cafe-hut-${i + 1}`, `咖啡座小亭 ${i + 1}`, '', 'ground', () => {
        const y = at(h.x, h.z) + 0.25
        const g = new THREE.Group()
        const roof = new THREE.Mesh(new THREE.ConeGeometry(3.7, 1.6, 4), hutRoof)
        roof.rotation.y = Math.PI / 4
        roof.position.y = 3.4
        g.add(roof)
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.7, 0.18), hutPost)
            post.position.set(sx * 2.1, 1.35, sz * 2.1)
            g.add(post)
          }
        const table = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.8), hutPost)
        table.position.y = 0.75
        g.add(table)
        g.traverse(o => (o.castShadow = true))
        g.position.set(h.x, y, h.z)
        g.rotation.y = h.rot
        scene.add(g)
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.obstacles.push({ x: h.x + sx * 2.1, z: h.z + sz * 2.1, r: 0.25 })
      })
    })
    // 主塔南面西端的半圓陽台（二樓，下方一個圓形花台）
    this.capture('obj:S-bay', '舍我樓 主塔南面半圓陽台', '', 'none', () => {
      const x = 18.8
      const z = -47.5
      const y = at(x, z)
      const mat = new THREE.MeshLambertMaterial({ color: 0xb0897a })
      const slab = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.35, 16, 1, false, -Math.PI / 2, Math.PI), mat)
      slab.position.set(x, y + 4.4, z)
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 1.1, 16, 1, true, -Math.PI / 2, Math.PI), new THREE.MeshLambertMaterial({ color: 0xc9a798, side: THREE.DoubleSide }))
      rail.position.set(x, y + 5.1, z)
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.7, 14), new THREE.MeshLambertMaterial({ color: 0x9b7465 }))
      pot.position.set(x, y + 0.35, z + 1.6)
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 1), new THREE.MeshLambertMaterial({ color: 0x4d8a3c, flatShading: true }))
      bush.position.set(x, y + 1.1, z + 1.6)
      for (const m of [slab, rail, pot, bush]) {
        m.castShadow = true
        scene.add(m)
      }
      this.obstacles.push({ x, z: z + 1.6, r: 0.9 })
    })
    // 入口棟門廊改由 addSheWoHall 建立（挑高門廊＋門楣）
    // 主塔東段／附屬棟南面的長拱頂雨棚：米黃色半透明、半圓斷面，北側貼牆、南側一排細柱
    this.capture('obj:court-arcade', '前庭東側長拱頂雨棚', '', 'none', () => {
      const xa = 36.5
      const xb = 69
      const z = -48.2
      const len = xb - xa
      const y = at((xa + xb) / 2, z)
      const g = new THREE.Group()
      const vault = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, len, 14, 1, true, 0, Math.PI),
        new THREE.MeshLambertMaterial({ color: 0xd8c896, transparent: true, opacity: 0.88, side: THREE.DoubleSide }),
      )
      vault.rotation.z = Math.PI / 2
      vault.position.y = 2.9
      g.add(vault)
      const post = new THREE.MeshLambertMaterial({ color: 0xe6e2da })
      for (let t = -len / 2 + 1; t <= len / 2 - 0.5; t += 4) {
        for (const dz of [-2.1, 2.1]) {
          const pm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.9), post)
          pm.position.set(t, 1.45, dz)
          g.add(pm)
        }
        this.obstacles.push({ x: (xa + xb) / 2 + t, z: z + 2.1, r: 0.15 })
      }
      g.traverse(o => (o.castShadow = true))
      g.position.set((xa + xb) / 2, y, z)
      scene.add(g)
    })
  }
  /**
   * 言論廣場與通識大樓前（使用者自舍我樓高樓層向西拍攝 13744–13765）：
   * 通識大樓東南面的半圓「圓環」——二樓半圓露台（紅傘）、灰色半環形雨棚、柱列與下方圓弧階梯；
   * 廣場上的灰色條紋鋪面、黑色基座雕像、古典路燈、深灰咖啡傘、圓環南側草皮；
   * 舍我樓 R 北側的白色張力膜雨棚、沿中庭北上小徑的長條白雨棚、木平台；
   * 以及通識大樓與行政大樓之間的空橋（東南面 LED 看板）與灰色電梯塔。
   */
  private addYanlun(): void {
    const scene = this.scene
    const at = (x: number, z: number) => groundHeight(x, z)
    // 圓環：二樓半圓平台（data.ts ROTUNDA；NLSC 正射灰色半環雨棚），半圓朝東南（法向 0.492, 0.870）
    const C = { x: ROTUNDA.x, z: ROTUNDA.z }
    const yaw = ROTUNDA.yaw
    const toWorld = (lx: number, lz: number) => ({
      x: C.x + lx * Math.cos(yaw) + lz * Math.sin(yaw),
      z: C.z - lx * Math.sin(yaw) + lz * Math.cos(yaw),
    })
    const half = (r0: number, r1: number, depth: number) => {
      const sh = new THREE.Shape()
      const N = 32
      for (let i = 0; i <= N; i++) {
        const a = (Math.PI * i) / N
        if (i === 0) sh.moveTo(r1 * Math.cos(a), r1 * Math.sin(a))
        else sh.lineTo(r1 * Math.cos(a), r1 * Math.sin(a))
      }
      if (r0 > 0) for (let i = N; i >= 0; i--) sh.lineTo(r0 * Math.cos((Math.PI * i) / N), r0 * Math.sin((Math.PI * i) / N))
      sh.closePath()
      const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false })
      g.rotateX(Math.PI / 2)
      return g
    }
    // 使用者 2026-10-09：灰磚坡道上去是二樓；圓環是二樓平台東端的半圓露台，南側扇形階梯下到一樓言論廣場
    this.capture('obj:G-rotunda', '通識大樓前圓環（二樓半圓平台、扇形階梯與雨棚）', '', 'none', () => {
      const R0 = ROTUNDA.r0
      const R1 = ROTUNDA.r1
      let hOut = 0
      for (let i = 0; i <= 12; i++) {
        const a = (Math.PI * i) / 12
        const p = toWorld(-R1 * Math.cos(a), R1 * Math.sin(a))
        hOut += terrainBaseHeight(p.x, p.z)
      }
      hOut /= 13
      const bottom = hOut - 0.7
      const g = new THREE.Group()
      const N = 17
      const dr = (R1 - R0) / N
      const dh = (DECK_H - hOut) / N
      const odd: THREE.BufferGeometry[] = []
      const even: THREE.BufferGeometry[] = []
      for (let i = 0; i < N; i++) {
        const t = DECK_H - (i + 1) * dh
        const gg = half(R0 + i * dr - 0.01, R0 + (i + 1) * dr, t - bottom)
        gg.translate(0, t, 0)
        ;(i % 2 ? odd : even).push(gg)
      }
      const stepA = new THREE.Mesh(mergeGeometries(even), new THREE.MeshLambertMaterial({ color: 0xbca99d }))
      const stepB = new THREE.Mesh(mergeGeometries(odd), new THREE.MeshLambertMaterial({ color: 0xcdbcb0 }))
      stepA.receiveShadow = stepB.receiveShadow = true
      const discGeo = half(0, R0, DECK_H + 0.02 - bottom)
      discGeo.translate(0, DECK_H + 0.02, 0)
      const disc = new THREE.Mesh(discGeo, new THREE.MeshLambertMaterial({ color: 0xa65a4a }))
      disc.receiveShadow = true
      const roseGeo = half(2.6, 3.2, 0.03)
      roseGeo.translate(0, DECK_H + 0.05, 0)
      const rose = new THREE.Mesh(roseGeo, new THREE.MeshLambertMaterial({ color: 0xd7b49a }))
      const roofGeo = half(6.0, 11.8, 0.45)
      roofGeo.translate(0, DECK_H + 3.8, 0)
      const roof = new THREE.Mesh(roofGeo, new THREE.MeshLambertMaterial({ color: 0x8e9398 }))
      g.add(stepA, stepB, disc, rose, roof)
      const colMat = new THREE.MeshLambertMaterial({ color: 0xdedbd4 })
      for (let i = 0; i < 7; i++) {
        const a = (Math.PI * (i + 0.5)) / 7
        const lx = 10.4 * Math.cos(a)
        const lz = 10.4 * Math.sin(a)
        const k = Math.min(N - 1, Math.floor((10.4 - R0) / dr))
        const y0 = DECK_H - (k + 1) * dh
        const hgt = DECK_H + 3.35 - y0
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, hgt, 10), colMat)
        col.position.set(lx, y0 + hgt / 2, lz)
        g.add(col)
        const w = toWorld(lx, lz)
        this.obstacles.push({ x: w.x, z: w.z, r: 0.3 })
      }
      // 露台上的紅色陽傘
      const red = new THREE.MeshLambertMaterial({ color: 0xd2404a, side: THREE.DoubleSide })
      for (const lx of [-2.6, 2.6]) {
        const top = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.55, 8, 1, true), red)
        top.position.set(lx, DECK_H + 2.5, 3.6)
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.3), colMat)
        pole.position.set(lx, DECK_H + 1.15, 3.6)
        g.add(top, pole)
      }
      g.traverse(o => (o.castShadow = true))
      g.position.set(C.x, 0, C.z)
      g.rotation.y = yaw
      scene.add(g)
    })
    // 灰色條紋鋪面（廣場的折線分隔帶與圓環外圍弧帶）
    this.capture('obj:yanlun-stripes', '言論廣場灰色條紋鋪面', '', 'none', () => {
      const lines: Vec2[][] = [
        [{ x: -36, z: -42 }, { x: -58, z: -42 }, { x: -60.5, z: -36 }, { x: -70.8, z: -36.3 }],
        [{ x: -71.4, z: -25.0 }, { x: -63, z: -22.2 }, { x: -45, z: -22.2 }],
        [{ x: -60.5, z: -36 }, { x: -63, z: -22.2 }],
      ]
      const arc: Vec2[] = []
      for (let i = 0; i <= 24; i++) {
        const a = (Math.PI * i) / 24
        arc.push(toWorld(14.4 * Math.cos(a), 14.4 * Math.sin(a)))
      }
      lines.push(arc)
      const mat = new THREE.MeshLambertMaterial({ color: 0x7f8286, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
      const m = new THREE.Mesh(mergeGeometries(lines.map(l => this.ribbon(l, 1.3, 0.17))), mat)
      m.receiveShadow = true
      scene.add(m)
    })
    // 雕像：黑色兩階基座＋深色銅像
    this.capture('obj:yanlun-statue', '言論廣場雕像', '', 'ground', () => {
      const x = -56
      const z = -47
      const g = new THREE.Group()
      const dark = new THREE.MeshLambertMaterial({ color: 0x2a2c2e })
      const bronze = new THREE.MeshLambertMaterial({ color: 0x3b3430 })
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.7, 3.8), dark)
      b1.position.y = 0.35
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.6, 2.6), dark)
      b2.position.y = 1.0
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.45, 1.7, 10), bronze)
      body.position.set(-0.6, 2.15, 0)
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), bronze)
      head.position.set(-0.6, 3.2, 0)
      const slab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 0.35), bronze)
      slab.position.set(0.8, 1.95, 0.1)
      slab.rotation.z = -0.25
      g.add(b1, b2, body, head, slab)
      g.traverse(o => (o.castShadow = true))
      g.position.set(x, at(x, z), z)
      g.rotation.y = 0.5
      scene.add(g)
      this.obstacles.push({ x, z, r: 2.6 })
    })
    // 古典黑色路燈
    const lampMat = new THREE.MeshLambertMaterial({ color: 0x1f2124 })
    const glow = new THREE.MeshBasicMaterial({ color: 0xfff2cc })
    ;[
      [-47, -40],
      [-60, -39.5],
      [-70, -33],
      [-71.7, -23.4],
      [-58, -25.5],
      [-47, -30],
    ].forEach(([x, z], i) => {
      this.capture(`obj:yanlun-lamp-${i + 1}`, `言論廣場路燈 ${i + 1}`, '', 'ground', () => {
        const g = new THREE.Group()
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 3.6, 8), lampMat)
        post.position.y = 1.8
        const lan = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.14, 0.5, 6), glow)
        lan.position.y = 3.85
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.3, 6), lampMat)
        cap.position.y = 4.25
        g.add(post, lan, cap)
        g.position.set(x, at(x, z), z)
        scene.add(g)
        this.obstacles.push({ x, z, r: 0.2 })
      })
    })
    // 深灰咖啡傘（廣場南側、舍我樓 R 西端前）
    const grey = new THREE.MeshLambertMaterial({ color: 0x55595e, side: THREE.DoubleSide })
    const pole = new THREE.MeshLambertMaterial({ color: 0x6c6c6c })
    ;[
      [-44, -31.5],
      [-48.5, -28.5],
      [-44, -25.5],
      [-48.5, -22.8],
    ].forEach(([x, z], i) => {
      this.capture(`obj:yanlun-umbrella-${i + 1}`, `言論廣場咖啡傘 ${i + 1}`, '', 'ground', () => {
        const g = new THREE.Group()
        const top = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.55, 8, 1, true), grey)
        top.position.y = 2.6
        const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6), pole)
        pl.position.y = 1.3
        const tb = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 12), pole)
        tb.position.y = 0.75
        g.add(top, pl, tb)
        g.traverse(o => (o.castShadow = true))
        g.position.set(x, at(x, z), z)
        scene.add(g)
        this.obstacles.push({ x, z, r: 0.6 })
      })
    })
    // 圓環南側草皮與矮籬
    this.capture('obj:yanlun-lawn', '圓環南側草皮', '', 'ground', () => {
      // 扇形階梯外（r≈17.5 m）
      const x = -77.2
      const z = -15.9
      const g = new THREE.Group()
      const lawn = new THREE.Mesh(new THREE.BoxGeometry(6, 0.25, 3.6), new THREE.MeshLambertMaterial({ color: 0x5f9e4a }))
      lawn.position.y = 0.12
      const hedge = new THREE.MeshLambertMaterial({ color: 0x3f6f35 })
      for (const dz of [-1.9, 1.9]) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.6, 0.35), hedge)
        h.position.set(0, 0.3, dz)
        g.add(h)
      }
      g.add(lawn)
      g.position.set(x, at(x, z), z)
      g.rotation.y = yaw
      scene.add(g)
    })
    // 舍我樓 R 北側白色張力膜雨棚（中庭西側階梯上方），下有長椅
    const white = new THREE.MeshLambertMaterial({ color: 0xf4f4f1, side: THREE.DoubleSide })
    const frame = new THREE.MeshLambertMaterial({ color: 0xd9d9d6 })
    this.capture('obj:she-tent', '舍我樓北側白色雨棚', '', 'ground', () => {
      const x0 = -22.5
      const x1 = -13.5
      const z0 = -49
      const z1 = -41.5
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      const g = new THREE.Group()
      const R = 6
      const span = Math.asin((z1 - z0) / 2 / R)
      const geo = new THREE.CylinderGeometry(R, R, x1 - x0, 18, 1, true, Math.PI / 2 - span, span * 2)
      geo.rotateZ(Math.PI / 2)
      const roof = new THREE.Mesh(geo, white)
      roof.position.y = 4.2 - R
      g.add(roof)
      const edgeY = 4.2 - R + R * Math.cos(span)
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, edgeY), frame)
          post.position.set(sx * ((x1 - x0) / 2), edgeY / 2, sz * ((z1 - z0) / 2))
          g.add(post)
          this.obstacles.push({ x: cx + sx * ((x1 - x0) / 2), z: cz + sz * ((z1 - z0) / 2), r: 0.15 })
        }
      const wood = new THREE.MeshLambertMaterial({ color: 0x7a5236 })
      for (const dx of [-2.5, 0.5, 3]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.45, 0.6), wood)
        b.position.set(dx, 0.22, -2.6)
        g.add(b)
      }
      g.traverse(o => (o.castShadow = true))
      g.position.set(cx, at(cx, cz), cz)
      scene.add(g)
    })
    // 沿中庭北上小徑的長條白色雨棚
    this.capture('obj:she-walk-canopy', '中庭北上小徑白色雨棚', '', 'ground', () => {
      const x = -10.2
      const za = -45.5
      const zb = -57
      const g = new THREE.Group()
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3, 0.18, za - zb), white)
      roof.position.y = 3.1
      g.add(roof)
      for (let t = 0; t <= za - zb + 0.01; t += 3.8) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.1), frame)
        post.position.set(-1.45, 1.55, (za - zb) / 2 - t)
        g.add(post)
        this.obstacles.push({ x: x - 1.45, z: za - t, r: 0.12 })
      }
      g.traverse(o => (o.castShadow = true))
      g.position.set(x, at(x, (za + zb) / 2), (za + zb) / 2)
      scene.add(g)
    })
    // 木平台（白雨棚西側，北緣欄杆）
    this.capture('obj:she-deck', '舍我樓北側木平台', '', 'ground', () => {
      const x0 = -35
      const x1 = -24
      const z0 = -51.5
      const z1 = -43
      const g = new THREE.Group()
      const deck = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.3, z1 - z0), new THREE.MeshLambertMaterial({ color: 0xc9ab86 }))
      deck.position.y = 0.15
      deck.receiveShadow = true
      g.add(deck)
      const rail = new THREE.MeshLambertMaterial({ color: 0x4a3a2e })
      const top = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.08, 0.08), rail)
      top.position.set(0, 1.25, -(z1 - z0) / 2)
      g.add(top)
      for (let t = 0; t <= x1 - x0 + 0.01; t += 1.1) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.06), rail)
        b.position.set(-(x1 - x0) / 2 + t, 0.8, -(z1 - z0) / 2)
        g.add(b)
      }
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      g.position.set(cx, at(cx, cz), cz)
      scene.add(g)
    })
    // 通識大樓 ↔ 行政大樓 空橋：兩層高的白色連通棟，懸於兩樓之間（下方仍是往圖書館的階梯）
    const A = { x: -110.8, z: -25.1 }
    const B = { x: -104.0, z: -30.0 }
    const linkYaw = Math.atan2(-(B.z - A.z), B.x - A.x)
    const len = Math.hypot(B.x - A.x, B.z - A.z) + 1.2
    this.capture('obj:G-ADM-bridge', '通識大樓－行政大樓連結走道', '', 'ground', () => {
      const mx = (A.x + B.x) / 2
      const mz = (A.z + B.z) / 2
      const g = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(len, 7, 6), new THREE.MeshLambertMaterial({ color: 0xeeeeea }))
      body.position.y = 8
      const band = new THREE.Mesh(new THREE.BoxGeometry(len - 0.6, 1.4, 6.1), new THREE.MeshLambertMaterial({ color: 0x55626c }))
      band.position.y = 6.6
      const band2 = band.clone()
      band2.position.y = 9.9
      g.add(body, band, band2)
      // LED 看板（面向東南的言論廣場）
      const cv = document.createElement('canvas')
      cv.width = 256
      cv.height = 160
      const ctx = cv.getContext('2d')!
      const grd = ctx.createLinearGradient(0, 0, 256, 160)
      grd.addColorStop(0, '#2a1440')
      grd.addColorStop(1, '#7a1a3a')
      ctx.fillStyle = grd
      ctx.fillRect(0, 0, 256, 160)
      ctx.fillStyle = '#ffd34d'
      ctx.font = 'bold 44px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('世新大學', 128, 78)
      ctx.fillStyle = '#ffffff'
      ctx.font = '22px sans-serif'
      ctx.fillText('SHIH HSIN', 128, 118)
      const tex = new THREE.CanvasTexture(cv)
      tex.colorSpace = THREE.SRGBColorSpace
      const led = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 3.2), new THREE.MeshBasicMaterial({ map: tex }))
      led.position.set(0, 7.8, 3.08)
      const ledFrame = new THREE.Mesh(new THREE.BoxGeometry(5.6, 3.6, 0.15), new THREE.MeshLambertMaterial({ color: 0x8b2a2a }))
      ledFrame.position.set(0, 7.8, 3.0)
      g.add(ledFrame, led)
      g.traverse(o => (o.castShadow = true))
      g.position.set(mx, at(mx, mz), mz)
      g.rotation.y = linkYaw
      scene.add(g)
    })
  }
  /**
   * 舍我樓一樓（2026-10-09 使用者街景 214742／214822／214834／214908／214915）：
   * 入口棟三層挑高穿堂（z -42.5～-33、高 10.4 m）＋東面門廊門楣「德智兼修 手腦並用」、
   * 門內二／三樓弧形磚陽台與粗磚柱列；南翼 R 北面一樓半圓拱廊（樓內 3 m 走廊）與二樓懸挑磚陽台；
   * 西口磚造直跑樓梯（圓柱腳往南升到二樓平台）；門口北側看板、小木亭、黃色陽傘，南側石砌花台。
   */
  private addSheWoHall(): void {
    const scene = this.scene
    const at = (x: number, z: number) => groundHeight(x, z)
    const SE = buildingById('SE')
    const R = buildingById('R')
    const yS = baseOf(SE.pts)
    const yR = baseOf(R.pts)
    const HALL_H = SE.groundH ?? 10.4
    const ARC_H = R.groundH ?? 4.4
    const HX0 = 2.5
    const HX1 = 16.5
    const HZ0 = -42.5
    const HZ1 = -33
    const tex = sheBrickTexture()
    const brick = new THREE.MeshLambertMaterial({ map: tex })
    const brickDeep = new THREE.MeshLambertMaterial({ map: tex, color: 0xd9c9c0 })
    const concrete = new THREE.MeshLambertMaterial({ color: 0x8e8981 })
    // 天花／樓板底面只受半球光的地面色（綠）照射會偏綠，改用不受光材質
    const soffit = new THREE.MeshBasicMaterial({ color: 0xb3ada3 })
    const box = (w: number, h: number, d: number, mat: THREE.Material) => {
      const g = new THREE.BoxGeometry(w, h, d)
      scaleBoxUV(g, w, h, d, 2)
      const m = new THREE.Mesh(g, mat)
      m.castShadow = m.receiveShadow = true
      return m
    }
    // 貼地的格子地磚（依地面高程逐點抬升）
    const tileTex = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 128
      const x = c.getContext('2d')!
      x.fillStyle = '#6f6b66'
      x.fillRect(0, 0, 128, 128)
      x.fillStyle = '#8b8781'
      x.fillRect(2, 2, 60, 60)
      x.fillRect(66, 66, 60, 60)
      x.fillStyle = '#817d77'
      x.fillRect(66, 2, 60, 60)
      x.fillRect(2, 66, 60, 60)
      const t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      return t
    })()
    const tileMat = new THREE.MeshLambertMaterial({ map: tileTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    const tiles = (x0: number, x1: number, z0: number, z1: number, lift = 0.07) => {
      const w = x1 - x0
      const d = z1 - z0
      const g = new THREE.PlaneGeometry(w, d, Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(d / 2)))
      g.rotateX(-Math.PI / 2)
      g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2)
      const pos = g.getAttribute('position')
      const uv = g.getAttribute('uv')
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k)
        const z = pos.getZ(k)
        pos.setY(k, at(x, z) + lift)
        uv.setXY(k, (x - x0) / 1, (z - z0) / 1)
      }
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, tileMat)
      m.receiveShadow = true
      scene.add(m)
    }
    const ceiling = (x0: number, x1: number, z0: number, z1: number, y: number) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
      g.rotateX(Math.PI / 2)
      const m = new THREE.Mesh(g, soffit)
      m.position.set((x0 + x1) / 2, y - 0.03, (z0 + z1) / 2)
      scene.add(m)
    }
    const globe = (x: number, y: number, z: number, nx: number, nz: number) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.45), concrete)
      arm.position.set(x + nx * 0.22, y, z + nz * 0.22)
      arm.rotation.y = Math.atan2(nx, nz)
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 10), new THREE.MeshLambertMaterial({ color: 0xf6ead0, emissive: 0x7a6a45 }))
      s.position.set(x + nx * 0.5, y + 0.05, z + nz * 0.5)
      scene.add(arm, s)
    }

    // ── 入口棟挑高穿堂 ─────────────────────────
    this.capture('obj:SE-hall', '舍我樓 挑高穿堂（柱列、天花、地磚）', '', 'none', () => {
      tiles(HX0, HX1 + 1.2, HZ0, HZ1, 0.14)
      ceiling(HX0, HX1, HZ0, HZ1, yS + HALL_H)
      // 天花嵌燈
      const lamp = new THREE.MeshBasicMaterial({ color: 0xfff6e0 })
      for (let x = 4.5; x < HX1; x += 4) {
        for (const z of [-40, -35.5]) {
          const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.5), lamp)
          p.rotation.x = Math.PI / 2
          p.position.set(x, yS + HALL_H - 0.06, z)
          scene.add(p)
        }
      }
      // 兩側粗磚柱列（214908：柱與牆之間形成凹間）
      // 西端北側為圓柱塔所在，北列只放兩根
      for (const [x, z] of [[7.2, HZ0 + 0.6], [11.2, HZ0 + 0.6], [3.4, HZ1 - 0.6], [7.2, HZ1 - 0.6], [11.2, HZ1 - 0.6]] as [number, number][]) {
        {
          const m = box(1.2, HALL_H, 1.2, brick)
          m.position.set(x, yS + HALL_H / 2, z)
          this.occluders.push(m)
          scene.add(m)
          this.obstacles.push({ x, z, r: 0.85 })
        }
      }
      // 側牆上的公告欄與深色木門
      const board = new THREE.MeshLambertMaterial({ color: 0x3f5a48 })
      const door = new THREE.MeshLambertMaterial({ color: 0x3e2f27 })
      for (const [x, z, s, mat, w, h, y] of [
        [9.2, HZ0 + 0.03, 1, door, 1.8, 2.4, 0],
        [13.4, HZ0 + 0.03, 1, board, 2.0, 1.1, 1.0],
        [5.3, HZ1 - 0.03, -1, door, 1.8, 2.4, 0],
        [9.2, HZ1 - 0.03, -1, board, 1.8, 1.1, 1.0],
        [13.4, HZ1 - 0.03, -1, door, 2.2, 2.6, 0],
      ] as [number, number, number, THREE.Material, number, number, number][]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
        p.position.set(x, at(x, z) + y + h / 2, z)
        if (s < 0) p.rotation.y = Math.PI
        scene.add(p)
      }
    })

    // ── 東面挑高門廊：粗磚柱＋混凝土門楣「德智兼修 手腦並用」 ──
    this.capture('obj:SE-portal', '舍我樓 東面挑高門廊（門楣）', '', 'none', () => {
      for (const z of [HZ0 - 0.2, HZ1 + 0.2]) {
        const m = box(1.7, HALL_H, 1.7, brickDeep)
        m.position.set(HX1 - 0.35, yS + HALL_H / 2, z)
        this.occluders.push(m)
        scene.add(m)
        this.obstacles.push({ x: HX1 - 0.35, z, r: 1.0 })
        globe(HX1 + 0.5, at(HX1, z) + 3.3, z + (z < -38 ? 0.95 : -0.95), 1, 0)
      }
      const L = HZ1 - HZ0 + 2.2
      const lintel = box(1.2, 1.7, L, concrete)
      lintel.position.set(HX1 + 0.35, yS + HALL_H - 0.85, (HZ0 + HZ1) / 2)
      scene.add(lintel)
      const txt = this.signPlane(signTexture('德智兼修　手腦並用', { color: '#ece4d4', w: 1024, h: 128, size: 92 }), 8.2, 1.0)
      txt.position.set(HX1 + 0.97, yS + HALL_H - 0.85, (HZ0 + HZ1) / 2)
      txt.rotation.y = Math.PI / 2
      scene.add(txt)
    })

    // ── 門內二／三樓弧形磚陽台（橫跨挑空，東面外凸） ──
    this.capture('obj:SE-bridges', '舍我樓 穿堂二／三樓弧形陽台', '', 'none', () => {
      const lens = (xc: number, half: number, bulE: number, bulW: number, z0: number, z1: number) => {
        const s = new THREE.Shape()
        const zm = (z0 + z1) / 2
        const hz = (z1 - z0) / 2
        const N = 14
        for (let i = 0; i <= N; i++) {
          const z = z0 + ((z1 - z0) * i) / N
          const k = 1 - ((z - zm) / hz) ** 2
          const x = xc + half + bulE * k
          if (i === 0) s.moveTo(x, -z)
          else s.lineTo(x, -z)
        }
        for (let i = N; i >= 0; i--) {
          const z = z0 + ((z1 - z0) * i) / N
          const k = 1 - ((z - zm) / hz) ** 2
          s.lineTo(xc - half - bulW * k, -z)
        }
        return s
      }
      for (const [xc, lvl] of [
        [9.2, 4.4],
        [9.6, 7.6],
      ] as [number, number][]) {
        const y = yS + lvl
        const slabG = new THREE.ExtrudeGeometry(lens(xc, 1.1, 1.3, 0.5, HZ0, HZ1), { depth: 0.38, bevelEnabled: false })
        slabG.rotateX(-Math.PI / 2)
        const slab = new THREE.Mesh(slabG, soffit)
        slab.position.y = y - 0.38
        slab.castShadow = true
        const outer = lens(xc, 1.1, 1.3, 0.5, HZ0, HZ1)
        const inner = lens(xc, 0.85, 1.3, 0.5, HZ0 + 0.25, HZ1 - 0.25)
        outer.holes.push(new THREE.Path(inner.getPoints()))
        const parG = new THREE.ExtrudeGeometry(outer, { depth: 1.1, bevelEnabled: false })
        const puv = parG.getAttribute('uv')
        for (let k = 0; k < puv.count; k++) puv.setXY(k, puv.getX(k) / 2, puv.getY(k) / 2)
        parG.rotateX(-Math.PI / 2)
        const par = new THREE.Mesh(parG, brick)
        par.position.y = y
        par.castShadow = true
        this.occluders.push(par)
        scene.add(slab, par)
      }
    })

    // ── 南翼 R 北面一樓半圓拱廊＋二樓懸挑磚陽台 ──
    this.capture('obj:R-arcade', '舍我樓 R 北面拱廊與二樓陽台', '', 'none', () => {
      const XA = -29
      const XB = HX0
      const N = 8
      const bay = (XB - XA) / N
      const PIER = 0.9
      const SPRING = 2.55
      const s = new THREE.Shape()
      s.moveTo(XA - 0.01, 0)
      s.lineTo(XA - 0.01, ARC_H)
      s.lineTo(XB, ARC_H)
      s.lineTo(XB, 0)
      for (let i = N - 1; i >= 0; i--) {
        const xa = XA + i * bay + (i === 0 ? PIER : PIER / 2)
        const xb = XA + (i + 1) * bay - (i === N - 1 ? 0.35 : PIER / 2)
        const r = (xb - xa) / 2
        s.lineTo(xb, 0)
        s.lineTo(xb, SPRING)
        s.absarc((xa + xb) / 2, SPRING, r, 0, Math.PI, false)
        s.lineTo(xa, 0)
      }
      s.lineTo(XA - 0.01, 0)
      const g = new THREE.ExtrudeGeometry(s, { depth: 0.9, bevelEnabled: false })
      const uv = g.getAttribute('uv')
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) / 2, uv.getY(k) / 2)
      const wall = new THREE.Mesh(g, brick)
      wall.position.set(0, yR, -35)
      wall.castShadow = wall.receiveShadow = true
      this.occluders.push(wall)
      scene.add(wall)
      for (let i = 1; i < N; i++) {
        const px = XA + i * bay
        this.obstacles.push({ x: px, z: -34.55, r: 0.55 })
        if (i % 2 === 1) globe(px, at(px, -35) + 3.0, -35, 0, -1)
      }
      // 走廊地磚與天花
      tiles(XA, XB, -35, -32, 0.14)
      ceiling(XA, XB, -35, -32, yR + ARC_H)
      // 二樓懸挑陽台：深 3.5 m、磚欄杆、灰色底板（向東延伸跨過穿堂西口）
      const y2 = yR + ARC_H
      const x0 = -27
      const x1 = 5.4
      const D = 3.5
      const slab = box(x1 - x0, 0.42, D, soffit)
      slab.position.set((x0 + x1) / 2, y2 - 0.21, -35 - D / 2)
      scene.add(slab)
      const rail = box(x1 - x0, 1.1, 0.28, brick)
      rail.position.set((x0 + x1) / 2, y2 + 0.55, -35 - D + 0.14)
      this.occluders.push(rail)
      scene.add(rail)
      for (const x of [x0 + 0.14, x1 - 0.14]) {
        const end = box(0.28, 1.1, D, brick)
        end.position.set(x, y2 + 0.55, -35 - D / 2)
        scene.add(end)
      }
    })

    // ── 西口磚造直跑樓梯：圓柱腳（北）往南升到二樓平台，平台接南翼二樓陽台 ──
    this.capture('obj:she-west-stair', '舍我樓 西口磚造樓梯', '', 'none', () => {
      const XS0 = -3.7
      const XS1 = -1.9
      const ZB = -46.2
      const ZT = -40.4
      const ZL = -38.5
      const y0 = at((XS0 + XS1) / 2, ZB)
      const rise = yR + ARC_H - y0
      // 下方實心磚楔
      const tri = new THREE.Shape()
      tri.moveTo(-ZB, 0)
      tri.lineTo(-ZT, rise - 0.2)
      tri.lineTo(-ZT, 0)
      tri.lineTo(-ZB, 0)
      const wg = new THREE.ExtrudeGeometry(tri, { depth: XS1 - XS0, bevelEnabled: false })
      const wuv = wg.getAttribute('uv')
      for (let k = 0; k < wuv.count; k++) wuv.setXY(k, wuv.getX(k) / 2, wuv.getY(k) / 2)
      wg.rotateY(Math.PI / 2)
      const wedge = new THREE.Mesh(wg, brick)
      wedge.position.set(XS0, y0, 0)
      wedge.castShadow = wedge.receiveShadow = true
      this.occluders.push(wedge)
      scene.add(wedge)
      // 踏階
      const stepM = new THREE.MeshLambertMaterial({ color: 0xc2b3a6 })
      const n = Math.round(rise / 0.17)
      const run = (ZT - ZB) / n
      for (let i = 0; i < n; i++) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(XS1 - XS0 - 0.4, rise / n, run + 0.02), stepM)
        st.position.set((XS0 + XS1) / 2, y0 + (i + 0.5) * (rise / n), ZB + (i + 0.5) * run)
        st.receiveShadow = true
        scene.add(st)
      }
      // 斜向磚欄杆（兩側）
      const len = Math.hypot(ZT - ZB, rise)
      const ang = Math.atan2(rise, ZT - ZB)
      for (const x of [XS0 + 0.12, XS1 - 0.12]) {
        const p = box(0.24, 1.0, len, brick)
        p.rotation.x = -ang
        p.position.set(x, y0 + rise / 2 + 0.5, (ZB + ZT) / 2)
        scene.add(p)
      }
      // 二樓平台（懸挑，下方可通行）
      const land = box(XS1 - XS0 + 0.6, 0.4, ZL - ZT + 0.2, soffit)
      land.position.set((XS0 + XS1) / 2 + 0.3, yR + ARC_H - 0.2, (ZT + ZL) / 2)
      scene.add(land)
      const lr = box(0.24, 1.1, ZL - ZT + 0.2, brick)
      lr.position.set(XS0 + 0.12, yR + ARC_H + 0.55, (ZT + ZL) / 2)
      scene.add(lr)
      // 底部兩道半圓石階（214822）
      for (let i = 0; i < 2; i++) {
        const r = 1.6 - i * 0.45
        const st = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.17, 20, 1, false, Math.PI / 2, Math.PI), stepM)
        st.position.set((XS0 + XS1) / 2, y0 + 0.085 + i * 0.17, ZB)
        scene.add(st)
      }
      for (let z = ZB + 0.5; z <= -41.3; z += 1.0) this.obstacles.push({ x: (XS0 + XS1) / 2, z, r: 0.95 })
      this.obstacles.push({ x: (XS0 + XS1) / 2, z: ZB - 0.6, r: 0.9 })
    })

    // ── 圓柱塔底部弧形玻璃帶（面向西側中庭）與阻擋 ──
    this.capture('obj:S-tower-glass', '舍我樓 圓柱塔底部玻璃帶', '', 'none', () => {
      const cx = buildingById('S').box.x0 - 0.8
      const cz = -43
      const g = new THREE.Mesh(
        new THREE.CylinderGeometry(3.48, 3.48, 3.0, 28, 1, true, Math.PI, Math.PI * 0.9),
        new THREE.MeshLambertMaterial({ color: 0x5f8f96, emissive: 0x1d3438, side: THREE.DoubleSide }),
      )
      g.position.set(cx, at(cx, cz) + 1.7, cz)
      scene.add(g)
      const band = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.35, 28, 1, true, Math.PI, Math.PI * 0.9), concrete)
      band.position.set(cx, at(cx, cz) + 3.4, cz)
      scene.add(band)
      this.obstacles.push({ x: cx, z: cz, r: 3.4 })
    })

    // ── 東口外擺設：北側桁架看板、小木亭、黃色陽傘；南側石砌花台 ──
    this.capture('obj:she-gate-props', '舍我樓 東口看板、小木亭、陽傘、花台', '', 'none', () => {
      const truss = new THREE.MeshLambertMaterial({ color: 0x9aa0a4 })
      const bx = 17.6
      for (const z of [-46.0, -43.6]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.0, 0.12), truss)
        p.position.set(bx, at(bx, z) + 1.5, z)
        scene.add(p)
        this.obstacles.push({ x: bx, z, r: 0.25 })
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 2.5), truss)
      beam.position.set(bx, at(bx, -44.8) + 3.0, -44.8)
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.6), new THREE.MeshLambertMaterial({ map: signTexture('世新', { sub: '活動公告', color: '#b3202f', bg: '#f1f0ea', w: 512, h: 384 }) }))
      banner.position.set(bx + 0.08, at(bx, -44.8) + 2.0, -44.8)
      banner.rotation.y = Math.PI / 2
      scene.add(beam, banner)
      // 小木亭
      const wood = new THREE.MeshLambertMaterial({ color: 0x8a6446 })
      const kx = 17.5
      const kz = -46.95
      const k = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 0.8), wood)
      k.position.set(kx, at(kx, kz) + 0.55, kz)
      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 1.0), new THREE.MeshLambertMaterial({ color: 0x5b3f2c }))
      roof.position.set(kx, at(kx, kz) + 2.1, kz)
      for (const dx of [-0.55, 0.55]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.08), wood)
        p.position.set(kx + dx, at(kx, kz) + 1.6, kz + 0.3)
        scene.add(p)
      }
      scene.add(k, roof)
      this.obstacles.push({ x: kx, z: kz, r: 0.75 })
      // 黃色陽傘
      const ux = 21.6
      const uz = -44.4
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4), truss)
      pole.position.set(ux, at(ux, uz) + 1.2, uz)
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.55, 8), new THREE.MeshLambertMaterial({ color: 0xe9c43a }))
      cone.position.set(ux, at(ux, uz) + 2.45, uz)
      cone.castShadow = true
      scene.add(pole, cone)
      this.obstacles.push({ x: ux, z: uz, r: 0.3 })
      // 南側低矮石砌花台
      const px = 17.9
      const pz = -31.2
      const pl = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.65, 1.2), new THREE.MeshLambertMaterial({ color: 0xa8a092 }))
      pl.position.set(px, at(px, pz) + 0.32, pz)
      pl.castShadow = pl.receiveShadow = true
      const hedge = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.6, 0.95), new THREE.MeshLambertMaterial({ color: 0x3f6b33 }))
      hedge.position.set(px, at(px, pz) + 0.92, pz)
      scene.add(pl, hedge)
      this.obstacles.push({ x: px - 0.7, z: pz, r: 0.7 }, { x: px + 0.7, z: pz, r: 0.7 })
    })
  }
  /**
   * 二樓平台（使用者 2026-10-09 藍框 DJI_0037_108＋對照圖標註）：行政大樓前灰磚坡道（上層）爬上去即二樓平台，
   * 不是回到廣場同一層。平台前緣下方是一樓商店與粉紅磚一層小樓（屋頂＝平台），面向一樓紅磚言論廣場；
   * 平台東端接圓環半圓露台與扇形階梯（addYanlun），前緣中段為紅色角錐屋頂的電梯塔（一樓 ↔ 二樓）。
   */
  private addDeck2F(): void {
    if (DECK_2F.length < 3) return
    const scene = this.scene
    const base = (x: number, z: number) => terrainBaseHeight(x, z)
    const top = DECK_H + 0.02
    const outward = (a: Vec2, b: Vec2): Vec2 => {
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1
      let n = { x: (b.z - a.z) / L, z: -(b.x - a.x) / L }
      const m = { x: (a.x + b.x) / 2 + n.x * 0.6, z: (a.z + b.z) / 2 + n.z * 0.6 }
      if (insideDeck(m.x, m.z)) n = { x: -n.x, z: -n.z }
      return n
    }
    /** 立面帶：沿 a→b，自一樓地面（外側 0.5 m 的地形高）到平台面；uLen＝一張貼圖的長度、vH＝貼圖代表的高度 */
    const facade = (a: Vec2, b: Vec2, mat: THREE.Material, uLen: number, vH: number): THREE.Mesh => {
      const n = outward(a, b)
      const L = Math.hypot(b.x - a.x, b.z - a.z)
      const N = Math.max(1, Math.ceil(L / 1.5))
      const pos: number[] = []
      const uv: number[] = []
      const idx: number[] = []
      for (let i = 0; i <= N; i++) {
        const t = i / N
        const x = a.x + (b.x - a.x) * t + n.x * 0.05
        const z = a.z + (b.z - a.z) * t + n.z * 0.05
        const g0 = base(x + n.x * 0.5, z + n.z * 0.5)
        pos.push(x, g0 - 0.3, z, x, top, z)
        uv.push((L * t) / uLen, -0.3 / vH, (L * t) / uLen, (top - g0) / vH)
        if (i < N) {
          const k = i * 2
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
        }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      const m = new THREE.Mesh(geo, mat)
      m.receiveShadow = true
      return m
    }
    const F = DECK_FRONT
    const [P0, F1, F2, F3, F4, F5, W13] = F
    const W7 = rotundaWorld(-ROTUNDA.r0, 0)
    const E7 = rotundaWorld(ROTUNDA.r0, 0)
    const [E13, GP] = DECK_EAST

    this.capture('obj:deck-2f', '二樓平台（行政大樓前坡道頂 → 通識大樓前）', '', 'none', () => {
      // 平台板：灰磚面＋水泥側面，向下延伸到一樓地面以下
      const lowest = Math.min(...DECK_2F.map(p => base(p.x, p.z))) - 0.8
      const sh = new THREE.Shape(DECK_2F.map(p => new THREE.Vector2(p.x, p.z)))
      const geo = new THREE.ExtrudeGeometry(sh, { depth: top - lowest, bevelEnabled: false })
      geo.rotateX(Math.PI / 2)
      geo.translate(0, top, 0)
      const slab = new THREE.Mesh(geo, [new THREE.MeshLambertMaterial({ color: 0xa3a19b }), new THREE.MeshLambertMaterial({ color: 0x9d9a94 })])
      slab.receiveShadow = true
      scene.add(slab)
      // 粉紅磚小樓的磁磚屋頂（正射：平台中段偏暖色的磁磚面）
      const tile = [admFace(42.6, 0.8), admFace(50.0, 0.4), admFace(50.0, 8.4), admFace(42.6, 8.4)]
      const tg = new THREE.ShapeGeometry(new THREE.Shape(tile.map(p => new THREE.Vector2(p.x, p.z))))
      tg.rotateX(Math.PI / 2)
      tg.translate(0, top + 0.015, 0)
      const tm = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ color: 0xbf8f80, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }))
      tm.receiveShadow = true
      scene.add(tm)
      // 前緣：一樓店面（商店街延續）、粉紅磚小樓、擋土牆
      const shopMat = new THREE.MeshLambertMaterial({ map: shopTexture(), side: THREE.DoubleSide })
      const pinkTex = pinkBrickTexture(false)
      const houseTex = pinkBrickTexture(true)
      const pinkMat = new THREE.MeshLambertMaterial({ map: pinkTex, side: THREE.DoubleSide })
      const houseMat = new THREE.MeshLambertMaterial({ map: houseTex, side: THREE.DoubleSide })
      scene.add(facade(P0, F1, shopMat, 12, 4.5))
      scene.add(facade(F2, F3, pinkMat, 8, 4.5))
      scene.add(facade(F3, F4, houseMat, 8, 4.5))
      scene.add(facade(F4, F5, pinkMat, 8, 4.5))
      scene.add(facade(F5, W13, pinkMat, 8, 4.5))
      scene.add(facade(E13, GP, pinkMat, 8, 4.5))
      // 平台邊緣欄杆（灰色金屬）
      const railGeos: THREE.BufferGeometry[] = []
      const rail = (a: Vec2, b: Vec2) => {
        const n = outward(a, b)
        const L = Math.hypot(b.x - a.x, b.z - a.z)
        const yaw = Math.atan2(-(b.z - a.z), b.x - a.x)
        const ox = -n.x * 0.15
        const oz = -n.z * 0.15
        const bar = new THREE.BoxGeometry(L, 0.07, 0.07)
        bar.rotateY(yaw)
        bar.translate((a.x + b.x) / 2 + ox, top + 1.05, (a.z + b.z) / 2 + oz)
        railGeos.push(bar)
        const mid = new THREE.BoxGeometry(L, 0.05, 0.05)
        mid.rotateY(yaw)
        mid.translate((a.x + b.x) / 2 + ox, top + 0.55, (a.z + b.z) / 2 + oz)
        railGeos.push(mid)
        const k = Math.max(1, Math.round(L / 1.4))
        for (let i = 0; i <= k; i++) {
          const t = i / k
          const post = new THREE.BoxGeometry(0.06, 1.05, 0.06)
          post.translate(a.x + (b.x - a.x) * t + ox, top + 0.52, a.z + (b.z - a.z) * t + oz)
          railGeos.push(post)
        }
      }
      rail(P0, F1)
      for (let i = 2; i < F.length - 1; i++) rail(F[i], F[i + 1])
      rail(W13, W7)
      rail(E7, E13)
      rail(E13, GP)
      const rm = new THREE.Mesh(mergeGeometries(railGeos), new THREE.MeshLambertMaterial({ color: 0x8f9499 }))
      rm.castShadow = true
      scene.add(rm)
      // 前緣、圓環兩端與東側擋土牆：一樓 ↔ 二樓高差不可直接跨越
      const block = (a: Vec2, b: Vec2) => {
        const L = Math.hypot(b.x - a.x, b.z - a.z)
        const k = Math.max(1, Math.ceil(L / 0.8))
        for (let i = 0; i <= k; i++) this.obstacles.push({ x: a.x + ((b.x - a.x) * i) / k, z: a.z + ((b.z - a.z) * i) / k, r: 0.45 })
      }
      block(P0, F1)
      for (let i = 2; i < F.length - 1; i++) block(F[i], F[i + 1])
      block(W13, W7)
      block(E7, E13)
      block(E13, GP)
    })

    // 電梯塔：橘褐框藍綠玻璃、紅色角錐屋頂（DJI_0037_108 紅框；街景 13765）；一樓門朝廣場、二樓門朝平台
    this.capture('obj:red-tower', '電梯塔（一樓廣場 ↔ 二樓平台）', '', 'none', () => {
      const { x, z, w } = DECK_LIFT
      const yaw = Math.atan2(-ADM_DIR.z, ADM_DIR.x)
      const fx = x + (-ADM_DIR.z) * (w / 2 + 0.6)
      const fz = z + ADM_DIR.x * (w / 2 + 0.6)
      const y = base(fx, fz)
      const H = 15.5
      const g = new THREE.Group()
      liftTower(g, w, H)
      const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.82, 2.6, 4), new THREE.MeshLambertMaterial({ color: 0xb8242f }))
      roof.position.y = H + 0.6 + 1.3
      roof.rotation.y = Math.PI / 4
      g.add(roof)
      // 二樓門（朝西北的平台）
      const door2 = new THREE.Mesh(new THREE.BoxGeometry(w * 0.55, 2.4, 0.2), new THREE.MeshLambertMaterial({ color: 0x8d8f91 }))
      door2.position.set(0, DECK_H - y + 1.2, -w / 2 - 0.05)
      g.add(door2)
      g.traverse(o => (o.castShadow = true))
      g.position.set(x, y, z)
      g.rotation.y = yaw
      const glass = g.children.find(c => (c as THREE.Mesh).geometry instanceof THREE.BoxGeometry && ((c as THREE.Mesh).geometry as THREE.BoxGeometry).parameters.height === H)
      if (glass) this.occluders.push(glass as THREE.Mesh)
      scene.add(g)
      this.obstacles.push({ x, z, r: 2.6 })
    })
  }
  /**
   * 隧道出口 → 行政大樓的上下兩層（使用者 2026-10-05 街景截圖）：
   * 分界線（ramp-1 北緣）上為行政大樓下層商店街店面（出口段為紅磚牆＋公告欄），頂上灰色欄杆；
   * 上層行政大樓東南面前：紅磚花台＋圓形灌木、入口大雨庇、雙球路燈；
   * 下層南側：出口旁垂直綠牆、雙球路燈、女一舍橘褐框電梯塔與往隧道方向下降的綠色頂棚鋼梯。
   */
  private addTunnelExitTerrace(): void {
    const scene = this.scene
    const at = (x: number, z: number) => groundHeight(x, z)
    const E = SPLIT_EDGE
    const lowAt = (s: number) => {
      const p = splitPoint(s, E - 0.05)
      return at(p.x, p.z)
    }
    const upAt = (s: number) => {
      const p = splitPoint(s, E + 0.05)
      return at(p.x, p.z)
    }
    const wallStrip = (s0: number, s1: number, mat: THREE.Material, uLen: number) => {
      const pos: number[] = []
      const uv: number[] = []
      const idx: number[] = []
      const n = Math.max(2, Math.ceil((s1 - s0) / 1))
      for (let i = 0; i <= n; i++) {
        const t = s0 + ((s1 - s0) * i) / n
        const p = splitPoint(t, E)
        const y0 = lowAt(t) - 0.3
        const y1 = upAt(t) + (mat === shopMatRef ? 0.05 : 0.9)
        pos.push(p.x, y0, p.z, p.x, y1, p.z)
        uv.push(t / uLen, -0.3 / 4.5, t / uLen, (y1 - y0 - 0.3) / 4.5)
        if (i < n) {
          const k = i * 2
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      g.setIndex(idx)
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, mat)
      m.castShadow = true
      m.receiveShadow = true
      scene.add(m)
    }
    // 整片鋪面：下層粉紅磚（出口外寬廣場、往東收窄）、上層灰色格紋磚（至行政大樓東南面）
    const pave = (s0: number, s1: number, oA: (s: number) => number, oB: (s: number) => number, color: number, lift: number) => {
      const pos: number[] = []
      const idx: number[] = []
      const n = Math.max(2, Math.ceil(s1 - s0))
      const K = 8
      for (let i = 0; i <= n; i++) {
        const t = s0 + ((s1 - s0) * i) / n
        for (let k = 0; k <= K; k++) {
          const o = oA(t) + ((oB(t) - oA(t)) * k) / K
          const p = splitPoint(t, o)
          pos.push(p.x, at(p.x, p.z) + lift, p.z)
          if (i < n && k < K) {
            const a = i * (K + 1) + k
            idx.push(a, a + K + 1, a + 1, a + 1, a + K + 1, a + K + 2)
          }
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setIndex(idx)
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }))
      m.receiveShadow = true
      scene.add(m)
    }
    // DJI_0043 俯拍：隧道口前紅磚鋪滿谷底（上層平台未開始）、中段約 7.5 m、往言論廣場端扇形放寬
    pave(0.5, UPPER_START, lowerSouth, () => LOWER_NORTH_OPEN, 0xa86b5b, 0.1)
    pave(UPPER_START, SPLIT_LEN, lowerSouth, () => E - 0.06, 0xa86b5b, 0.1)
    pave(UPPER_START, SPLIT_LEN, () => E + 0.06, upperNorth, 0xa3a19c, 0.11)
    // 女一舍側植栽帶（照片第 31／37 秒：紅磚南緣 → 綠色頂棚鋼梯 → 宿舍之間滿是灌木與地被）
    pave(4, 48, () => -10.5, t => lowerSouth(t) - 0.12, 0x3b6331, 0.06)
    // 電梯塔以東至言論廣場端：紅磚南緣與玻璃弧廊之間的林帶地被（第 24 秒）
    pave(48, 72, () => -16, t => lowerSouth(t) - 0.12, 0x34592c, 0.04)
    {
      const rr = rng(4307)
      const geo = new THREE.IcosahedronGeometry(1, 1)
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff })
      const N = 90
      const inst = new THREE.InstancedMesh(geo, mat, N)
      const m4 = new THREE.Matrix4()
      const col = new THREE.Color()
      let n = 0
      for (let tries = 0; n < N && tries < 2000; tries++) {
        const t = 4 + rr() * 44
        const o = -10 + rr() * (lowerSouth(t) - 0.9 + 10)
        const p = splitPoint(t, o)
        if (insideSolid(p, 0.6)) continue
        const r0 = 0.45 + rr() * 0.55
        m4.makeScale(r0 * (1 + rr() * 0.4), r0 * 0.75, r0 * (1 + rr() * 0.4))
        m4.setPosition(p.x, at(p.x, p.z) + r0 * 0.45, p.z)
        inst.setMatrixAt(n, m4)
        inst.setColorAt(n, col.setHSL(0.27 + rr() * 0.06, 0.45, 0.22 + rr() * 0.1))
        n++
      }
      inst.count = n
      inst.castShadow = true
      inst.receiveShadow = true
      scene.add(inst)
    }
    // 紅磚上的淺色弧線（照片第 15／24／31 秒：橫越坡道、弧頂朝隧道口）
    {
      const lineMat = new THREE.MeshLambertMaterial({ color: 0xc9b2a6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
      for (let s0 = 6; s0 < SPLIT_LEN - 2; s0 += 8.5) {
        const pos: number[] = []
        const idx: number[] = []
        const N = 12
        const oS = lowerSouth(s0) + 0.3
        const oN = (s0 < UPPER_START ? LOWER_NORTH_OPEN : E) - 0.3
        for (let i = 0; i <= N; i++) {
          const u = i / N
          const o = oS + (oN - oS) * u
          const sc = s0 - 1.4 * Math.sin(Math.PI * u)
          for (const ds of [-0.13, 0.13]) {
            const q = splitPoint(sc + ds, o)
            pos.push(q.x, at(q.x, q.z) + 0.13, q.z)
          }
          if (i < N) {
            const a = i * 2
            idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
          }
        }
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        g.setIndex(idx)
        g.computeVertexNormals()
        const m = new THREE.Mesh(g, lineMat)
        m.receiveShadow = true
        scene.add(m)
      }
    }
    const shopMat = new THREE.MeshLambertMaterial({ map: shopTexture(), side: THREE.DoubleSide })
    const shopMatRef = shopMat
    const brickMat = new THREE.MeshLambertMaterial({ map: brickBoardTexture(), side: THREE.DoubleSide })
    const S_BRICK = 9
    const S_SHOP = 19
    const S_END = SPLIT_LEN - 0.5
    // 店面牆＋擋土牆（拖曳時整段一起移動；兩層高程屬地形資料，不隨之改變）
    this.capture('obj:adm-shops', '行政大樓下層商店街', '', 'none', () => {
      wallStrip(S_BRICK, S_SHOP, brickMat, 8)
      wallStrip(S_SHOP, S_END, shopMat, 12)
      // 店面雨庇與黑色方柱
      const awn = new THREE.MeshLambertMaterial({ color: 0x2a2c2f })
      const col = new THREE.MeshLambertMaterial({ color: 0x151618 })
      for (let t = S_SHOP; t < S_END - 1; t += 3) {
        const a = splitPoint(t, E - 0.9)
        const b = splitPoint(t + 3, E - 0.9)
        const y = lowAt(t + 1.5) + 3.0
        const m = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.18, 1.8), awn)
        m.position.set((a.x + b.x) / 2, y, (a.z + b.z) / 2)
        m.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x)
        scene.add(m)
      }
      for (let t = S_SHOP + 2; t < S_END - 1; t += 6) {
        const p = splitPoint(t, E - 1.6)
        const y = lowAt(t)
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.0, 0.35), col)
        m.position.set(p.x, y + 1.5, p.z)
        scene.add(m)
        this.obstacles.push({ x: p.x, z: p.z, r: 0.25 })
      }
      // 上層外緣灰色欄杆
      const rail = new THREE.MeshLambertMaterial({ color: 0x9aa0a4 })
      for (let t = S_SHOP; t < S_END; t += 2) {
        const a = splitPoint(t, E + 0.2)
        const b = splitPoint(Math.min(S_END, t + 2), E + 0.2)
        const ya = upAt(t)
        const yb = upAt(Math.min(S_END, t + 2))
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.08), rail)
        top.position.set((a.x + b.x) / 2, (ya + yb) / 2 + 1.1, (a.z + b.z) / 2)
        top.rotation.order = 'YZX'
        top.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x)
        top.rotation.z = Math.atan2(yb - ya, len)
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.1, 0.07), rail)
        post.position.set(a.x, ya + 0.55, a.z)
        scene.add(top, post)
      }
      // 分界線不可跨越（高差 > 0.4 m 處）
      for (let t = 4; t < S_END; t += 0.8) {
        if (splitDelta(t) < 0.4) continue
        const p = splitPoint(t, E)
        this.obstacles.push({ x: p.x, z: p.z, r: 0.45 })
      }
    })

    // 行政大樓東南面前：紅磚花台＋圓形灌木、入口雨庇
    const A0 = { x: -138.7, z: 4.1 }
    const A1 = { x: -106.2, z: -18.7 }
    const aLen = Math.hypot(A1.x - A0.x, A1.z - A0.z)
    const ad = { x: (A1.x - A0.x) / aLen, z: (A1.z - A0.z) / aLen }
    const an = { x: -ad.z, z: ad.x } // 朝東南（遠離大樓）
    const aYaw = Math.atan2(-ad.z, ad.x)
    const onFace = (t: number, off: number) => ({ x: A0.x + ad.x * t + an.x * off, z: A0.z + ad.z * t + an.z * off })
    this.capture('obj:adm-planters', '行政大樓前紅磚花台', '', 'none', () => {
      const brick = new THREE.MeshLambertMaterial({ color: 0x9c4a39 })
      const soil = new THREE.MeshLambertMaterial({ color: 0x2f5a2c })
      const shrub = new THREE.MeshLambertMaterial({ color: 0x2c5a2a })
      for (const [t0, t1] of [
        [1.5, 21],
        [29, 38.5],
      ]) {
        for (let t = t0; t < t1; t += 2.5) {
          const len = Math.min(2.5, t1 - t)
          const p = onFace(t + len / 2, 1.1)
          const y = at(p.x, p.z)
          const box = new THREE.Mesh(new THREE.BoxGeometry(len, 0.8, 1.5), brick)
          box.position.set(p.x, y + 0.4, p.z)
          box.rotation.y = aYaw
          const top = new THREE.Mesh(new THREE.BoxGeometry(len - 0.1, 0.06, 1.3), soil)
          top.position.set(p.x, y + 0.82, p.z)
          top.rotation.y = aYaw
          const b = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), shrub)
          b.position.set(p.x, y + 1.25, p.z)
          b.scale.y = 0.85
          scene.add(box, top, b)
        }
      }
    })
    this.capture('obj:adm-porch', '行政大樓入口雨庇', '', 'ground', () => {
      const p = onFace(25, 2.4)
      const y = at(p.x, p.z)
      const g = new THREE.Group()
      const white = new THREE.MeshLambertMaterial({ color: 0xeeeeea })
      const slab = new THREE.Mesh(new THREE.BoxGeometry(7, 0.5, 5), white)
      slab.position.y = 4.6
      g.add(slab)
      for (const sx of [-3, 3]) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.4, 0.5), white)
        c.position.set(sx, 2.2, 2.1)
        g.add(c)
      }
      g.traverse(o => (o.castShadow = true))
      g.position.set(p.x, y, p.z)
      g.rotation.y = aYaw
      scene.add(g)
      for (const sx of [-3, 3]) {
        const q = { x: p.x + ad.x * sx + an.x * 2.1, z: p.z + ad.z * sx + an.z * 2.1 }
        this.obstacles.push({ x: q.x, z: q.z, r: 0.35 })
      }
    })

    // 雙球路燈：上層沿行政大樓、下層沿步道南緣
    const lamps: Vec2[] = []
    for (const t of [4, 13, 33]) lamps.push(onFace(t, 2.6))
    for (const t of [14, 27, 40, 62, 72]) lamps.push(splitPoint(t, lowerSouth(t) + 0.6))
    lamps.forEach((p, i) => {
      this.capture(`obj:globe-lamp-${i + 1}`, '雙球路燈', '', 'ground', () => {
        const g = globeLamp()
        g.position.set(p.x, at(p.x, p.z), p.z)
        g.traverse(o => (o.castShadow = true))
        scene.add(g)
        this.obstacles.push({ x: p.x, z: p.z, r: 0.25 })
      })
    })

    // 出口旁南側垂直綠牆（擋土牆覆滿植栽）
    this.capture('obj:exit-greenwall', '隧道出口垂直綠牆', '', 'none', () => {
      const mat = new THREE.MeshLambertMaterial({ color: 0x3d6b33 })
      const mat2 = new THREE.MeshLambertMaterial({ color: 0x4f8040 })
      for (let t = 1; t < 20; t += 2) {
        const a = splitPoint(t, lowerSouth(t) - 0.6)
        const b = splitPoint(t + 2, lowerSouth(t + 2) - 0.6)
        const y = at((a.x + b.x) / 2, (a.z + b.z) / 2)
        const h = 4.6 + Math.sin(t) * 0.5
        const m = new THREE.Mesh(new THREE.BoxGeometry(2.05, h, 0.9), t % 4 < 2 ? mat : mat2)
        m.position.set((a.x + b.x) / 2, y + h / 2 - 0.3, (a.z + b.z) / 2)
        m.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x)
        scene.add(m)
        this.obstacles.push({ x: m.position.x, z: m.position.z, r: 0.9 })
      }
    })

    // 女一舍面向步道的橘褐框電梯塔（OSM 輪廓凸出處）與往隧道口方向下降的綠色頂棚鋼梯
    const T = D2_LIFT_AT
    const fd = D2_STAIR_DIR // 沿女一舍北面、朝隧道口
    // 坡頂平台約高出紅磚坡道 10 m（DJI_0043_000–007）：電梯塔與鋼梯都要接到平台高程
    const yPlateau = plateauAt(T.x, T.z) + 0.15
    const fYaw = Math.atan2(-fd.z, fd.x)
    this.capture('obj:D2-lift', '女一舍電梯塔', '', 'ground', () => {
      const g = new THREE.Group()
      liftTower(g, 4.4, Math.max(14, yPlateau - at(T.x, T.z) + 9))
      g.traverse(o => (o.castShadow = true))
      g.position.set(T.x, at(T.x, T.z), T.z)
      g.rotation.y = fYaw
      scene.add(g)
      this.obstacles.push({ x: T.x, z: T.z, r: 2.6 })
    })
    this.capture('obj:D2-canopy', '女一舍綠色頂棚樓梯', '', 'none', () => {
      const L = 17
      const start = D2_STAIR_A
      const yTop = yPlateau
      const rise = Math.max(6.5, yTop - at(D2_STAIR_B.x, D2_STAIR_B.z))
      const g = new THREE.Group()
      const steel = new THREE.MeshLambertMaterial({ color: 0x8f969b })
      const green = new THREE.MeshLambertMaterial({ color: 0x35a34e })
      const slope = Math.atan2(rise, L)
      const run = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(L, rise), 0.3, 2.2), steel)
      run.position.set(L / 2, -rise / 2, 0)
      run.rotation.z = -slope
      g.add(run)
      const landing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 2.6), steel)
      landing.position.set(-0.8, 0, 0)
      g.add(landing)
      // 鋸齒狀綠色頂棚：每 4.25 m 一片，前高後低
      for (let k = 0; k < 4; k++) {
        const x0 = (k * L) / 4
        const y = -rise * ((x0 + L / 8) / L) + 2.9
        const roof = new THREE.Mesh(new THREE.BoxGeometry(L / 4 + 0.15, 0.15, 2.8), green)
        roof.position.set(x0 + L / 8, y, 0)
        roof.rotation.z = -Math.atan2(rise, L) + 0.12
        // 側面欄杆
        for (const sz of [-1.05, 1.05]) {
          const r = new THREE.Mesh(new THREE.BoxGeometry(L / 4, 0.06, 0.06), steel)
          r.position.set(x0 + L / 8, -rise * ((x0 + L / 8) / L) + 1.0, sz)
          r.rotation.z = -Math.atan2(rise, L)
          g.add(r)
        }
        g.add(roof)
        for (const sz of [-1.2, 1.2]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.9, 0.12), steel)
          post.position.set(x0 + 0.3, -rise * ((x0 + 0.3) / L) + 1.45, sz)
          g.add(post)
        }
      }
      // 梯段下方支柱：落到坡面
      for (let k = 1; k < 5; k++) {
        const lx = (k * L) / 5
        const wx = start.x + fd.x * lx
        const wz = start.z + fd.z * lx
        const yRun = yTop - rise * (lx / L)
        const hCol = yRun - terrainHeight(wx, wz)
        if (hCol < 0.6) continue
        for (const sz of [-0.9, 0.9]) {
          const col = new THREE.Mesh(new THREE.BoxGeometry(0.22, hCol, 0.22), steel)
          col.position.set(lx, -rise * (lx / L) - hCol / 2, sz)
          g.add(col)
        }
      }
      g.traverse(o => (o.castShadow = true))
      g.position.set(start.x, yTop, start.z)
      g.rotation.y = fYaw
      scene.add(g)
      for (let t = 0; t <= L; t += 1.5) this.obstacles.push({ x: start.x + fd.x * t, z: start.z + fd.z * t, r: 1.1 })
    })
  }
  // ─── 宿舍山坡（使用者 2026-10-09「宿舍往後走那片山沒做好」；DJI_0043_000–012 空拍）────────
  // 紅磚坡道南緣：灰色矮牆＋小灌木綠籬 → 陡峭林坡約 10 m → 坡頂平台（女一舍、男二舍、玻璃頂走廊）；
  // 平台東端面對施工中的 B 以混凝土擋土牆切坡（照片左下鷹架上方的灰牆）。
  private addDormBank(): void {
    if (BANK_TOE.length < 2) return
    const scene = this.scene
    const toe = BANK_TOE
    const toeAt = toeSample
    const nearLift = (p: Vec2, r: number) => Math.hypot(p.x - D2_LIFT_AT.x, p.z - D2_LIFT_AT.z) < r
    // 坡腳灰色矮牆與綠籬
    this.capture('obj:bank-toe', '宿舍山坡坡腳矮牆與綠籬', '', 'none', () => {
      const g = new THREE.Group()
      const wallMat = new THREE.MeshLambertMaterial({ color: 0x8c8a83 })
      const STEP = 2
      for (let t = 0; t < BANK_LEN - 0.3; t += STEP) {
        const a = toeAt(t).p
        const b = toeAt(Math.min(BANK_LEN, t + STEP)).p
        const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
        if (nearLift(mid, 3)) continue
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        const ya = groundHeight(a.x, a.z)
        const yb = groundHeight(b.x, b.z)
        const m = new THREE.Mesh(new THREE.BoxGeometry(len + 0.06, 1.0, 0.3), wallMat)
        m.position.set(mid.x, (ya + yb) / 2 + 0.15, mid.z)
        m.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x)
        m.rotation.z = Math.atan2(yb - ya, len)
        m.receiveShadow = true
        g.add(m)
      }
      // 綠籬：坡腳內側一排修剪過的小灌木（照片中沿坡道南緣的一列淺綠色圓叢）
      const pos: THREE.Vector3[] = []
      for (let t = 0.5; t < BANK_LEN; t += 0.85) {
        const { p, dir } = toeAt(t)
        const q = { x: p.x - dir.z * 0.75, z: p.z + dir.x * 0.75 }
        if (nearLift(q, 3) || distToPolyline(q, [D2_STAIR_A, D2_STAIR_B]) < 1.5) continue
        pos.push(new THREE.Vector3(q.x, terrainHeight(q.x, q.z) + 0.45, q.z))
      }
      const hedge = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.62, 1), new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), pos.length)
      const m4 = new THREE.Matrix4()
      const col = new THREE.Color()
      const rr = rng(77)
      pos.forEach((v, i) => {
        const sc = 0.85 + rr() * 0.35
        m4.compose(v, new THREE.Quaternion(), new THREE.Vector3(sc, sc * 0.8, sc))
        hedge.setMatrixAt(i, m4)
        hedge.setColorAt(i, col.setHSL(0.25 + rr() * 0.04, 0.45, 0.24 + rr() * 0.06))
      })
      hedge.castShadow = true
      g.add(hedge)
      scene.add(g)
    })
    // 坡面地被灌木：連續覆蓋坡面（照片中坡面幾乎看不到裸土）
    this.capture('obj:bank-shrubs', '宿舍山坡坡面灌木', '', 'none', () => {
      const rr = rng(91)
      const pos: { v: THREE.Vector3; s: number }[] = []
      for (let t = 0; t < BANK_LEN; t += 1.1) {
        const { p, dir } = toeAt(t)
        for (let k = 0; k < 3; k++) {
          const d = 1.4 + rr() * 7.5
          const q = { x: p.x - dir.z * d + (rr() - 0.5) * 1.2, z: p.z + dir.x * d + (rr() - 0.5) * 1.2 }
          if (bankWeight(q.x, q.z) < 0.03 || insideSolid(q, 1.2) || onPaved(q) || nearLift(q, 3.2)) continue
          if (distToPolyline(q, [D2_STAIR_A, D2_STAIR_B]) < 1.8) continue
          const sc = 1.1 + rr() * 1.3
          pos.push({ v: new THREE.Vector3(q.x, terrainHeight(q.x, q.z) + sc * 0.55, q.z), s: sc })
        }
      }
      const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), pos.length)
      const m4 = new THREE.Matrix4()
      const col = new THREE.Color()
      pos.forEach((o, i) => {
        m4.compose(o.v, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rr() * 6.28, 0)), new THREE.Vector3(o.s * 1.15, o.s * 0.85, o.s))
        mesh.setMatrixAt(i, m4)
        // 空拍中坡面是淺黃綠（陽光面）與深綠交錯
        mesh.setColorAt(i, col.setHSL(0.24 + rr() * 0.08, 0.34 + rr() * 0.18, rr() < 0.25 ? 0.24 + rr() * 0.06 : 0.13 + rr() * 0.08))
      })
      mesh.castShadow = true
      mesh.receiveShadow = true
      scene.add(mesh)
    })
    // B 西側切坡擋土牆（平台東端）
    this.capture('obj:bank-cut-wall', '宿舍平台東端擋土牆', '', 'none', () => {
      const xw = BANK_CUT_X1 - 0.1
      const xTop = BANK_CUT_X1 - 2.6
      const pos: number[] = []
      const idx: number[] = []
      const z0 = toe[toe.length - 1].z + 0.4
      const z1 = BANK_CUT_Z + 6
      const n = Math.ceil((z1 - z0) / 1)
      for (let i = 0; i <= n; i++) {
        const z = z0 + ((z1 - z0) * i) / n
        const yb = groundHeight(xw + 0.6, z) - 0.3
        const yt = Math.max(yb + 0.3, terrainHeight(xTop, z) + 0.3)
        pos.push(xw, yb, z, xw, yt, z)
        if (i > 0) {
          const k = (i - 1) * 2
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
        }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      const wall = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x9a978f, side: THREE.DoubleSide }))
      wall.receiveShadow = true
      // 牆頂壓頂
      const cap = new THREE.Group()
      for (let i = 0; i < n; i++) {
        const za = z0 + ((z1 - z0) * i) / n
        const zb = z0 + ((z1 - z0) * (i + 1)) / n
        const ya = pos[(i * 2 + 1) * 3 + 1]
        const yb = pos[(i * 2 + 3) * 3 + 1]
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.3, zb - za + 0.05), new THREE.MeshLambertMaterial({ color: 0x84827b }))
        c.position.set(xw - 0.1, (ya + yb) / 2, (za + zb) / 2)
        c.rotation.x = -Math.atan2(yb - ya, zb - za)
        cap.add(c)
      }
      const g = new THREE.Group()
      g.add(wall, cap)
      scene.add(g)
    })
    // 坡頂玻璃頂走廊：電梯塔頂 → 女一舍東北角 → 男二舍西端入口（照片 000–003 中坡頂的白色長廊）
    this.capture('obj:dorm-corridor', '宿舍坡頂玻璃頂走廊', '', 'none', () => {
      const line: Vec2[] = [
        { x: -131.5, z: 20.9 },
        { x: -128.3, z: 20.3 },
        { x: -125.0, z: 23.4 },
        { x: -120.0, z: 23.9 },
        { x: -103.0, z: 19.2 },
      ]
      const g = new THREE.Group()
      const deckMat = new THREE.MeshLambertMaterial({ color: 0xb9b5ad })
      const frameMat = new THREE.MeshLambertMaterial({ color: 0xe9e7e1 })
      const roofMat = new THREE.MeshLambertMaterial({ color: 0xdfe6e2 })
      const glassMat = new THREE.MeshLambertMaterial({ color: 0x9fc4bd, transparent: true, opacity: 0.45, depthWrite: false })
      const W = 3
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1]
        const b = line[i]
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len }
        const nrm = { x: dir.z, z: -dir.x } // 北側（坡道側）
        const ya = plateauAt(a.x, a.z) + 0.2
        const yb = plateauAt(b.x, b.z) + 0.2
        const yaw = Math.atan2(-dir.z, dir.x)
        const pitch = Math.atan2(yb - ya, len)
        const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
        const ym = (ya + yb) / 2
        const box = (sx: number, sy: number, sz: number, off: number, dy: number, mat: THREE.Material) => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat)
          m.position.set(mid.x + nrm.x * off, ym + dy, mid.z + nrm.z * off)
          m.rotation.y = yaw
          m.rotation.z = pitch
          g.add(m)
          return m
        }
        box(len + 0.1, 0.3, W, 0, -0.15, deckMat)
        box(len + 0.3, 0.16, W + 0.6, 0, 2.95, roofMat)
        box(len, 1.0, 0.08, W / 2, 0.5, glassMat) // 北側玻璃欄板
        box(len, 0.08, 0.1, W / 2, 1.05, frameMat)
        const nCol = Math.max(1, Math.round(len / 3))
        for (let k = 0; k <= nCol; k++) {
          const u = k / nCol
          const x = a.x + (b.x - a.x) * u
          const z = a.z + (b.z - a.z) * u
          const y = ya + (yb - ya) * u
          for (const off of [-W / 2, W / 2]) {
            const c = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.95, 0.16), frameMat)
            c.position.set(x + nrm.x * off, y + 1.47, z + nrm.z * off)
            g.add(c)
            // 走廊懸在坡面上時的支柱
            const gy = terrainHeight(x + nrm.x * off, z + nrm.z * off)
            if (y - gy > 0.5) {
              const pst = new THREE.Mesh(new THREE.BoxGeometry(0.3, y - gy, 0.3), deckMat)
              pst.position.set(x + nrm.x * off, (y + gy) / 2 - 0.15, z + nrm.z * off)
              g.add(pst)
            }
          }
        }
      }
      g.traverse(o => (o.castShadow = true))
      scene.add(g)
    })
  }
  private addRouteArrows(): void {
    const tex = arrowTexture()
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, opacity: 0.85 })
    const total = routeLength(ROUTE)
    for (let s = 8; s < total - 4; s += 16) {
      const { p, dir } = samplePath(ROUTE, s)
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), mat)
      m.rotation.order = 'YXZ'
      m.rotation.set(-Math.PI / 2, 0, 0)
      m.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), Math.atan2(-dir.x, -dir.z))
      m.position.set(p.x, groundHeight(p.x, p.z) + 0.2, p.z)
      this.scene.add(m)
    }
  }

  private addBeacon(): void {
    const g = new THREE.Group()
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 34, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xd6336c, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    )
    beam.position.y = 17
    g.add(beam)
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.8, 40), new THREE.MeshBasicMaterial({ color: 0xd6336c, side: THREE.DoubleSide }))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.22
    g.add(ring)
    g.position.set(DESTINATION.x, groundHeight(DESTINATION.x, DESTINATION.z), DESTINATION.z)
    this.beacon = g
    this.scene.add(g)
  }

  private addLabels(): void {
    for (const l of LANDMARKS) {
      const el = document.createElement('div')
      el.className = 'label' + (l.num === '19' ? ' is-goal' : '') + (l.onRoute ? ' on-route' : '')
      el.innerHTML = `<b>${l.num}</b><span>${l.name}</span>`
      el.dataset.num = l.num
      const obj = new CSS2DObject(el)
      const pos = new THREE.Vector3(l.at.x, groundHeight(l.at.x, l.at.z) + l.labelHeight, l.at.z)
      obj.position.copy(pos)
      this.scene.add(obj)
      this.labels.push({ obj, landmark: l, pos })
    }
  }
}

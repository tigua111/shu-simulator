import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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
  type AreaKind,
  type Building,
  type BuildingStyle,
  type PathKind,
  type Vec2,
} from './data'
import { LANDMARKS, type Landmark } from './landmarks'
import { CANOPY } from './canopy'
import { LOADED_EDITS, type Edit } from './edits'
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
/** 該點在航照上是否為樹冠 */
export function canopyAt(x: number, z: number): boolean {
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
      const seed = !inForest || (pv && !inTunnel) || insideSolid(p, 2)
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
    this.addPlazaFurniture()
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
      pos.setY(k, groundHeight(x, z) + hill)
      const jitter = (r() - 0.5) * 0.06
      const p = { x, z }
      let set = false
      const tree = canopyAt(x, z) && !onPaved(p)
      if (tree) {
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
    }
    const groups = new Map<PathKind, THREE.BufferGeometry[]>()
    for (const p of PATHS) {
      const g = this.ribbon(p.pts, p.w, style[p.kind].lift)
      if (!groups.has(p.kind)) groups.set(p.kind, [])
      groups.get(p.kind)!.push(g)
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
        break
      case 'OM': {
        // 0045：西面巨幅藍色海報
        const c = document.createElement('canvas')
        c.width = 256
        c.height = 768
        const x = c.getContext('2d')!
        const gr = x.createLinearGradient(0, 0, 0, 768)
        gr.addColorStop(0, '#5fc4e8')
        gr.addColorStop(1, '#173a78')
        x.fillStyle = gr
        x.fillRect(0, 0, 256, 768)
        x.fillStyle = 'rgba(20,30,50,0.85)'
        x.fillRect(104, 190, 48, 250)
        x.beginPath()
        x.arc(128, 170, 30, 0, Math.PI * 2)
        x.fill()
        x.fillStyle = '#ffffff'
        x.font = '700 60px "Noto Sans TC",sans-serif'
        x.textAlign = 'center'
        x.fillText('全媒體', 128, 560)
        x.fillText('大樓', 128, 636)
        const tex = new THREE.CanvasTexture(c)
        tex.colorSpace = THREE.SRGBColorSpace
        this.placeOnFace(g, b, { x: b.c.x - 60, z: b.c.z }, this.signPlane(tex, 7, 21), base + 15)
        break
      }
    }
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
    this.capture('obj:R-tower', '舍我樓 R 西端樓梯塔', '', 'ground', () => cyl(R.box.x0 - 2.5, -24.5, 3.3, R.h + 2))
    // 「舍我樓 She-Wo Building」大圓柱：主塔西端與入口棟交會處，字樣面向西側中庭（正射圓形屋頂 (2,-43)）
    this.capture('obj:S-tower', '舍我樓 圓柱塔（招牌）', '', 'ground', () => cyl(S.box.x0 - 0.8, -43, 3.4, S.h - 3, 'sign'))
    // 南翼北面的退台陽台（0034_124、0042_022 紅框：面向北側中庭，每層一道白色欄杆陽台）
    this.capture('obj:R-balcony', '舍我樓 R 北面陽台', '', 'none', () => {
      const slabM = new THREE.MeshLambertMaterial({ color: 0xd9cfc4 })
      const railM = new THREE.MeshLambertMaterial({ color: 0xf0ece6 })
      const x0 = R.box.x0 + 1
      const x1 = R.box.x0 + 33
      const zf = R.box.z0
      const base = groundHeight((x0 + x1) / 2, zf) - 0.2
      const floors = Math.floor(R.h / FLOOR_H) - 1
      for (let f = 1; f <= floors; f++) {
        const depth = 1.2 + Math.max(0, 3 - f) * 0.6
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

    // 八方廣場旁的紅橘色四層小塔，頂部尖頂（0034_72、0042_144）
    this.capture('obj:red-tower', '紅色小塔', '', 'ground', () => {
      const x = -100
      const z = -14
      const y = at(x, z)
      const g = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(4, 13, 4), new THREE.MeshLambertMaterial({ color: 0xc9573a }))
      body.position.y = 6.5
      const win = new THREE.MeshLambertMaterial({ color: 0x4d6b5a })
      for (let k = 0; k < 4; k++) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.6, 4.1), win)
        w.position.y = 2.4 + k * 3
        g.add(w)
      }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 2.6, 4), new THREE.MeshLambertMaterial({ color: 0xb8242f }))
      roof.position.y = 14.3
      roof.rotation.y = Math.PI / 4
      g.add(body, roof)
      g.traverse(o => (o.castShadow = true))
      g.position.set(x, y, z)
      g.rotation.y = 0.55
      this.occluders.push(body)
      scene.add(g)
      this.obstacles.push({ x, z, r: 2.8 })
    })

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

    // 女一舍面向隧道坡道的綠色頂棚樓梯（0042_164）
    this.capture('obj:D2-canopy', '綠色頂棚樓梯', '', 'ground', () => {
      const D2 = buildingById('D2')
      const tunnelExit = TUNNEL.pts[TUNNEL.pts.length - 1]
      const f = faceToward(D2.pts, tunnelExit)
      const len = Math.min(f.len, 22)
      const cx = f.mid.x + f.n.x * 2.6
      const cz = f.mid.z + f.n.z * 2.6
      const y = at(cx, cz)
      const g = new THREE.Group()
      const roof = new THREE.Mesh(new THREE.BoxGeometry(len, 0.25, 4), new THREE.MeshLambertMaterial({ color: 0x3fae55 }))
      roof.position.y = 4.2
      roof.rotation.z = 0.12
      g.add(roof)
      for (const s of [-0.45, 0, 0.45]) {
        for (const d of [-1.7, 1.7]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4.2), new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }))
          post.position.set(s * len, 2.1 + s * len * 0.12, d)
          g.add(post)
        }
      }
      g.position.set(cx, y, cz)
      g.rotation.y = f.yaw + Math.PI / 2
      g.traverse(o => (o.castShadow = true))
      scene.add(g)
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
    let guard = 0
    while (trees.length < 5600 && guard++ < 200000) {
      const x = BOUNDS.minX + r() * (BOUNDS.maxX - BOUNDS.minX)
      const z = BOUNDS.minZ + r() * (BOUNDS.maxZ - BOUNDS.minZ)
      if (!canopyAt(x, z)) continue
      const p = { x, z }
      const h = hillAt(x, z)
      const tp = tunnelParam(p)
      if (tp.d < TUNNEL.w / 2 + 2 && tp.t > -0.05 && tp.t < 1.05 && h < 11) continue
      // 校門正前方與門體兩側保持淨空
      if (Math.hypot(x - GATE_FRAME.a.x, z - GATE_FRAME.a.z) < GATE_CLEAR_R && gateDepth(p) < 4) continue
      if (h < 1.6) {
        // 平地上的樹：避開步道、建物與主動線
        if (onPaved(p) || insideSolid(p, 2.5) || distToPolyline(p, ROUTE) < 6) continue
        if (noTree.some(a => pointInPolygon(p, a.pts))) continue
        if (BUILDINGS.some(b => pointInPolygon(p, b.pts))) continue
      } else if (insideSolid(p, 1.5)) continue
      // 空拍中山坡樹冠連成一片：山坡樹放大（冠幅約 9–15 m），平地行道樹維持較小
      trees.push({ x, z, s: h < 1.6 ? 0.8 + r() * 0.5 : insideSolid(p, 6) ? 1.0 + r() * 0.3 : 1.5 + r() * 1.1 })
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
    const canvasMat = new THREE.MeshLambertMaterial({ color: 0xf1ede4, side: THREE.DoubleSide })
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
        const top = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 8, 1, true), canvasMat)
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

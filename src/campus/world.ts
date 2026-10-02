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
  centroid,
  groundHeight,
  type AreaKind,
  type Building,
  type BuildingStyle,
  type PathKind,
  type Vec2,
} from './data'
import { LANDMARKS, type Landmark } from './landmarks'
import { distToPolyline, insideSolid, isWalkable, onPaved, pathAt, pointInPolygon, resample, routeLength, samplePath, type Obstacle } from './geometry'
import { STYLE_ROOF, arrowTexture, courtTexture, facadeTexture, signTexture, stoneTexture } from './textures'

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

function tunnelParam(p: Vec2): { d: number; t: number } {
  const a = TUNNEL.pts[0]
  const b = TUNNEL.pts[TUNNEL.pts.length - 1]
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2
  return { d: distToPolyline(p, TUNNEL.pts), t }
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
      if (tp.d < TUNNEL.w / 2 + 4 && tp.t > 0.015 && tp.t < 0.985) h = Math.max(h, 10)
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
  const m = new THREE.MeshLambertMaterial({ map: t })
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
  readonly obstacles: Obstacle[] = []
  /** 用來判斷標籤是否被建築遮住的網格 */
  readonly occluders: THREE.Object3D[] = []
  readonly sun: THREE.DirectionalLight
  private beacon!: THREE.Group

  constructor() {
    const scene = this.scene
    scene.fog = new THREE.Fog(0xdfe8ec, 260, 1100)
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
    for (const b of BUILDINGS) scene.add(this.makeBuilding(b))
    this.addNeighbors()
    this.addGateAndTunnel()
    this.addStage()
    this.addBackGate()
    this.addStreetDressing()
    this.addTrees()
    this.addLamps()
    this.addRouteArrows()
    this.addBeacon()
    this.addLabels()
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
    const geo = new THREE.SphereGeometry(1400, 32, 16)
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(0x7fb4e3) }, horizon: { value: new THREE.Color(0xe6eef0) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 horizon; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 1.6, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, h), 1.0); }',
    })
    const sky = new THREE.Mesh(geo, mat)
    sky.renderOrder = -1
    sky.frustumCulled = false
    this.scene.add(sky)
    // 遠方山稜（木柵、景美一帶）
    const r = rng(7)
    const ridgeMat = new THREE.MeshLambertMaterial({ color: 0x6f8f6a })
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2
      const dist = 720 + r() * 120
      const m = new THREE.Mesh(new THREE.ConeGeometry(110 + r() * 80, 70 + r() * 90, 6), ridgeMat)
      m.position.set(20 + Math.cos(a) * dist, 0, 65 + Math.sin(a) * dist)
      this.scene.add(m)
    }
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
    const forest = new THREE.Color(0x46733a)
    const lawn = new THREE.Color(0x86b35c)
    const urban = new THREE.Color(0xb3ada4)
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
      if (hill > 0.5) {
        c.copy(forest).offsetHSL(jitter * 0.5, 0, jitter)
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
        if (inForest) c.copy(lawn).offsetHSL(jitter * 0.4, 0, jitter)
        else c.copy(urban).offsetHSL(0, 0, jitter * 0.6)
      }
      colors[k * 3] = c.r
      colors[k * 3 + 1] = c.g
      colors[k * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }))
    ground.receiveShadow = true
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
    const fm = new THREE.Mesh(new THREE.ShapeGeometry(fieldShape, 24), new THREE.MeshLambertMaterial({ color: 0x4f9e4a }))
    fm.rotation.x = -Math.PI / 2
    fm.position.y = 0.005
    fm.receiveShadow = true
    g.add(fm)
    g.position.set(TRACK.x, y, TRACK.z)
    g.rotation.y = TRACK.rot
    this.scene.add(g)
    // OSM 球場（綠色場地、網球場、東側小球場）
    const court = new THREE.MeshLambertMaterial({ map: courtTexture() })
    for (const a of AREAS) {
      if (a.kind !== 'court' && a.kind !== 'field') continue
      const yy = groundHeight(centroid(a.pts).x, centroid(a.pts).z) + (a.kind === 'field' ? 0.19 : 0.17)
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
      this.scene.add(m)
    }
    // 球場籃架（綠色場地兩端）
    const fieldArea = AREAS.find(a => a.id === 'field')
    if (fieldArea) {
      const c = centroid(fieldArea.pts)
      const ax = { x: Math.cos(TRACK.rot), z: -Math.sin(TRACK.rot) }
      const pole = new THREE.MeshLambertMaterial({ color: 0x2f6fb0 })
      const board = new THREE.MeshLambertMaterial({ color: 0xffffff })
      for (const s of [-1, 1]) {
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
      }
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
        this.occluders.push(m)
        g.add(m)
      }
    }
    // 女兒牆
    const [, parapet] = prism(b.pts, top, top + 1)
    const pm = new THREE.Mesh(parapet, new THREE.MeshLambertMaterial({ color: new THREE.Color(STYLE_ROOF[b.style]).multiplyScalar(0.85), side: THREE.DoubleSide }))
    g.add(pm)
    // 屋頂設備
    if (b.h > 10 && b.box.x1 - b.box.x0 > 14) {
      const unit = new THREE.Mesh(new THREE.BoxGeometry(5, 2.4, 4), new THREE.MeshLambertMaterial({ color: 0xbdbdb8 }))
      unit.position.set(b.c.x, top + 1.2, b.c.z)
      unit.castShadow = true
      if (pointInPolygon(b.c, b.pts)) g.add(unit)
    }
    // 輪廓線，方便總覽辨識
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.ExtrudeGeometry(shapeOf(b.pts), { depth: top - base, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, base, 0), 30), new THREE.LineBasicMaterial({ color: 0x5a4a42, transparent: true, opacity: 0.45 }))
    g.add(edges)
    this.addBuildingSigns(b, g, base, top)
    return g
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
    switch (b.id) {
      case 'W':
        this.placeOnFace(g, b, gate, this.signPlane(signTexture('世新大學', { color: '#b3202f', bg: '#f1ece6' }), 14, 3.5), top - 2.5)
        break
      case 'J':
        this.placeOnFace(g, b, gate, this.signPlane(signTexture('新聞大樓', { color: '#b3202f', bg: '#f4e2da' }), 9, 2.25), top - 3)
        break
      case 'C':
        this.placeOnFace(g, b, DESTINATION, this.signPlane(signTexture('傳播大廈', { color: '#a3122b', bg: '#f7f3ec', sub: 'COLLEGE OF JOURNALISM & COMMUNICATIONS' }), 11, 2.75), base + 8)
        break
      case 'A': {
        const plaza = AREAS.find(a => a.id === 'school-plaza')!
        this.placeOnFace(g, b, centroid(plaza.pts), this.signPlane(signTexture('大禮堂', { color: '#b3202f', bg: '#f2f0ea' }), 9, 2.25), top - 4)
        break
      }
      case 'S': {
        const plaza = AREAS.find(a => a.id === 'school-plaza')!
        this.placeOnFace(g, b, centroid(plaza.pts), this.signPlane(signTexture('舍我樓', { color: '#ffffff', vertical: true, w: 256, h: 768, size: 210 }), 2.4, 7.2), top - 8)
        break
      }
      case 'L': {
        const sp = AREAS.find(a => a.id === 'speech')!
        this.placeOnFace(g, b, centroid(sp.pts), this.signPlane(signTexture('圖書館', { color: '#6b4a3a', bg: '#f1ede6' }), 8, 2), top - 3)
        break
      }
      case 'M':
        this.placeOnFace(g, b, { x: b.c.x, z: b.c.z + 60 }, this.signPlane(signTexture('管理學院', { color: '#b3202f' }), 12, 3), top - 3)
        break
      case 'OM':
        this.placeOnFace(g, b, { x: b.c.x - 40, z: b.c.z }, this.signPlane(signTexture('全媒體大樓', { color: '#ffffff', bg: '#35506a' }), 9, 2.25), top - 3)
        break
    }
  }

  private addNeighbors(): void {
    const caps: THREE.BufferGeometry[] = []
    const sides: THREE.BufferGeometry[] = []
    for (const n of NEIGHBORS) {
      const base = baseOf(n.pts)
      const c = centroid(n.pts)
      const [cp, sd] = prism(n.pts, base - 6.4, groundHeight(c.x, c.z) + n.h)
      caps.push(cp)
      sides.push(sd)
    }
    if (!caps.length) return
    const wall = new THREE.Mesh(mergeGeometries(sides), facadeMat('city', 3.2, 6.4))
    const roof = new THREE.Mesh(mergeGeometries(caps), new THREE.MeshLambertMaterial({ color: STYLE_ROOF.city }))
    for (const m of [wall, roof]) {
      m.castShadow = true
      m.receiveShadow = true
      this.scene.add(m)
    }
  }

  // ─── 前校門拱門與隧道 ───────────────────────────────
  private addGateAndTunnel(): void {
    const a = TUNNEL.pts[0]
    const b = TUNNEL.pts[TUNNEL.pts.length - 1]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len }
    const yaw = Math.atan2(-dir.x, -dir.z)
    const half = TUNNEL.w / 2
    const stone = stoneTexture()
    stone.repeat.set(0.18, 0.18)
    const stoneMat = new THREE.MeshLambertMaterial({ map: stone })
    const trim = new THREE.MeshLambertMaterial({ color: 0xc89580 })

    const makePortal = (at: Vec2, facingYaw: number, withSign: boolean) => {
      const gate = new THREE.Group()
      const shape = new THREE.Shape()
      shape.moveTo(-8, 0)
      shape.lineTo(-half, 0)
      shape.lineTo(-half, 4.6)
      shape.absarc(0, 4.6, half, Math.PI, 0, true)
      shape.lineTo(half, 0)
      shape.lineTo(8, 0)
      shape.lineTo(8, 11)
      shape.lineTo(-8, 11)
      shape.closePath()
      const arch = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false, curveSegments: 20 }), stoneMat)
      arch.position.z = -3
      arch.castShadow = arch.receiveShadow = true
      arch.userData.num = '01'
      this.occluders.push(arch)
      gate.add(arch)
      const ringShape = new THREE.Shape()
      ringShape.absarc(0, 4.6, half + 0.8, 0, Math.PI, false)
      ringShape.lineTo(-half, 4.6)
      ringShape.absarc(0, 4.6, half, Math.PI, 0, true)
      ringShape.closePath()
      const ring = new THREE.Mesh(new THREE.ExtrudeGeometry(ringShape, { depth: 0.3, bevelEnabled: false, curveSegments: 20 }), trim)
      ring.position.z = 0.01
      gate.add(ring)
      const cornice = new THREE.Mesh(new THREE.BoxGeometry(17.4, 1.2, 4.2), trim)
      cornice.position.set(0, 11.6, -1.5)
      cornice.castShadow = true
      gate.add(cornice)
      if (withSign) {
        for (const s of [-1, 1]) {
          const wing = new THREE.Mesh(new THREE.BoxGeometry(6.5, 7.5, 2.6), stoneMat)
          wing.position.set(s * 11, 3.75, -1.6)
          wing.castShadow = true
          gate.add(wing)
          const wingTop = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.9, 3.4), trim)
          wingTop.position.set(s * 11.2, 7.9, -1.4)
          gate.add(wingTop)
          const pilaster = new THREE.Mesh(new THREE.BoxGeometry(1.4, 10.4, 0.5), trim)
          pilaster.position.set(s * 6.6, 5.2, 0.2)
          gate.add(pilaster)
        }
        const sign = this.signPlane(signTexture('世新大學', { color: '#8a5a3c', sub: 'Shih Hsin University' }), 7.5, 1.9)
        sign.position.set(0, 9.3, 0.02)
        gate.add(sign)
        const led = this.signPlane(signTexture('歡迎蒞臨世新大學', { color: '#ff4b3a', bg: '#1a1a1a', size: 120 }), 3.2, 0.5)
        led.position.set(0, 6.2, -1)
        gate.add(led)
      }
      gate.position.set(at.x, groundHeight(at.x, at.z), at.z)
      gate.rotation.y = facingYaw
      this.scene.add(gate)
    }
    // 前校門：拱門正面朝向木柵路（與隧道前進方向相反）
    makePortal(a, yaw, true)
    makePortal(b, yaw + Math.PI, false)

    // 隧道拱頂與側牆
    const segLen = 4
    const n = Math.ceil(len / segLen)
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xe9e4da, side: THREE.DoubleSide })
    const brickMat = new THREE.MeshLambertMaterial({ map: facadeTexture('brick') })
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff1c9 })
    const vault = new THREE.Shape()
    vault.absarc(0, 0, half + 0.8, 0, Math.PI, false)
    vault.lineTo(-half, 0)
    vault.absarc(0, 0, half, Math.PI, 0, true)
    vault.closePath()
    const vaultGeo = new THREE.ExtrudeGeometry(vault, { depth: segLen + 0.05, bevelEnabled: false, curveSegments: 16 })
    vaultGeo.translate(0, 0, -(segLen + 0.05) / 2)
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * (len / n)
      const c = { x: a.x + dir.x * s, z: a.z + dir.z * s }
      const y = groundHeight(c.x, c.z)
      const seg = new THREE.Group()
      const v = new THREE.Mesh(vaultGeo, wallMat)
      v.position.y = 4.6
      v.receiveShadow = true
      seg.add(v)
      for (const sd of [-1, 1]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(0.8, 6.6, len / n + 0.05), brickMat)
        wall.position.set(sd * (half + 0.4), 1.3, 0)
        seg.add(wall)
      }
      if (i % 2 === 0) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 1.6), lightMat)
        lamp.position.set(0, 4.6 + half - 0.08, 0)
        seg.add(lamp)
      }
      seg.position.set(c.x, y, c.z)
      seg.rotation.y = yaw
      this.scene.add(seg)
    }
  }

  private addStage(): void {
    const y = groundHeight(STAGE.x, STAGE.z)
    const wood = new THREE.MeshLambertMaterial({ color: 0x9b6b4b })
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(STAGE.r, STAGE.r, 1.0, 32), wood)
    deck.position.set(STAGE.x, y + 0.5, STAGE.z)
    deck.castShadow = deck.receiveShadow = true
    this.scene.add(deck)
    const roof = new THREE.Mesh(new THREE.SphereGeometry(STAGE.r + 0.8, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xf1efe9, side: THREE.DoubleSide }))
    roof.scale.y = 0.35
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

  private addStreetDressing(): void {
    const sign = this.signPlane(signTexture('木柵路一段', { color: '#ffffff', bg: '#2f6a46', size: 120 }), 4.8, 1.2)
    const p = { x: START.pos.x + 8, z: START.pos.z + 2 }
    const y = groundHeight(p.x, p.z)
    sign.position.set(p.x, y + 4, p.z)
    sign.rotation.y = Math.PI * 0.08
    this.scene.add(sign)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4), new THREE.MeshLambertMaterial({ color: 0x777777 }))
    pole.position.set(p.x, y + 2, p.z - 0.1)
    this.scene.add(pole)
    const shi = this.signPlane(signTexture('試院路', { color: '#ffffff', bg: '#2f6a46', size: 120 }), 3.6, 1)
    const q = { x: BACK_GATE.x + 3, z: BACK_GATE.z - 7 }
    shi.position.set(q.x, groundHeight(q.x, q.z) + 3.6, q.z)
    this.scene.add(shi)
  }

  // ─── 植栽 ─────────────────────────────────────────
  private addTrees(): void {
    const r = rng(42)
    const trees: { x: number; z: number; s: number; palm?: boolean }[] = []
    // 山坡樹林
    let guard = 0
    while (trees.length < 3200 && guard++ < 60000) {
      const x = BOUNDS.minX + r() * (BOUNDS.maxX - BOUNDS.minX)
      const z = BOUNDS.minZ + r() * (BOUNDS.maxZ - BOUNDS.minZ)
      const h = hillAt(x, z)
      if (h < 1.6) continue
      const tp = tunnelParam({ x, z })
      if (tp.d < TUNNEL.w / 2 + 2 && tp.t > -0.05 && tp.t < 1.05 && h < 11) continue
      trees.push({ x, z, s: 1.0 + r() * 1.0 })
    }
    // 學校廣場樹陣（避開主動線、舞台與後校門步道）
    const plaza = AREAS.find(a => a.id === 'school-plaza')!
    for (let x = 0; x < 120; x += 9) {
      for (let z = -80; z < 20; z += 9) {
        const p = { x: x + (r() - 0.5) * 2, z: z + (r() - 0.5) * 2 }
        if (!pointInPolygon(p, plaza.pts)) continue
        if (distToPolyline(p, ROUTE) < 5 || Math.hypot(p.x - STAGE.x, p.z - STAGE.z) < STAGE.r + 5) continue
        if (pathAt(p) || insideSolid(p, 3)) continue
        trees.push({ x: p.x, z: p.z, s: 0.8 + r() * 0.3 })
        this.obstacles.push({ x: p.x, z: p.z, r: 0.5 })
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
        trees.push({ x: q.x, z: q.z, s: 1, palm: true })
        this.obstacles.push({ x: q.x, z: q.z, r: 0.4 })
      }
    }

    const normal = trees.filter(t => !t.palm)
    const palms = trees.filter(t => t.palm)
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.34, 3, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a33 }), normal.length)
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 1), new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), normal.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const col = new THREE.Color()
    normal.forEach((t, i) => {
      const y = terrainHeight(t.x, t.z)
      m.compose(new THREE.Vector3(t.x, y + 1.5 * t.s, t.z), q.identity(), new THREE.Vector3(t.s, t.s, t.s))
      trunk.setMatrixAt(i, m)
      const sy = t.s * (0.9 + r() * 0.5)
      m.compose(new THREE.Vector3(t.x, y + 3 * t.s + 1.6 * sy, t.z), q.setFromEuler(new THREE.Euler(0, r() * 6, 0)), new THREE.Vector3(t.s * 1.1, sy, t.s * 1.1))
      crown.setMatrixAt(i, m)
      col.setHSL(0.24 + r() * 0.08, 0.45 + r() * 0.2, 0.24 + r() * 0.12)
      crown.setColorAt(i, col)
    })
    trunk.castShadow = crown.castShadow = true
    crown.receiveShadow = true
    this.scene.add(trunk, crown)

    if (palms.length) {
      const pTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.28, 10, 6), new THREE.MeshLambertMaterial({ color: 0x9a8f7f }), palms.length)
      const pCrown = new THREE.InstancedMesh(new THREE.ConeGeometry(2.0, 1.1, 7, 1, true), new THREE.MeshLambertMaterial({ color: 0x6fb04a, side: THREE.DoubleSide }), palms.length)
      palms.forEach((t, i) => {
        const y = groundHeight(t.x, t.z)
        m.compose(new THREE.Vector3(t.x, y + 5, t.z), q.identity(), new THREE.Vector3(1, 1, 1))
        pTrunk.setMatrixAt(i, m)
        m.compose(new THREE.Vector3(t.x, y + 9.8, t.z), q.setFromEuler(new THREE.Euler(Math.PI, i, 0)), new THREE.Vector3(1, 1, 1))
        pCrown.setMatrixAt(i, m)
      })
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
    spots.forEach((p, i) => {
      const y = groundHeight(p.x, p.z)
      m.makeTranslation(p.x, y + 2.1, p.z)
      pole.setMatrixAt(i, m)
      m.makeTranslation(p.x, y + 4.3, p.z)
      head.setMatrixAt(i, m)
      this.obstacles.push({ x: p.x, z: p.z, r: 0.2 })
    })
    this.scene.add(pole, head)
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


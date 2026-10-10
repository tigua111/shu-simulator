import * as THREE from 'three'
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * 黑色奧迪四門房車（程序化幾何；本地座標：原點在車底中心地面、+x 車頭、+z 右側）。
 *
 * 結構：`root`（編輯器可移動）底下放四個輪子與 `shell`（車殼）。車殼掛在簡化的懸吊彈簧上：
 * 每次敲擊會沿落點往下壓、左右／前後晃動；爆胎時對應角落下沉。
 *
 * 破壞：車身與車艙細分成約 0.14 m 的網格，敲打時依落點把頂點沿錘擊方向推入，
 * 外圈微微拱起、中心帶有皺摺雜訊，漆面刮成底漆灰／刮痕銀；玻璃第一下蛛網裂、第二下碎落一地；
 * 頭尾燈破裂熄滅；後照鏡、四環標誌、車牌、水箱護罩會被敲落；輪胎敲兩下爆胎。
 * 損壞 20% 起警報與雙黃燈、50% 冒煙、80% 起火、100% 全毀（玻璃全碎、四輪全爆）。
 */
export const CAR_L = 5.2
export const CAR_W = 1.95

export type HitEffect = 'dent' | 'crack' | 'shatter' | 'break' | 'detach' | 'clang' | 'thud' | 'deflate'
export type Milestone = 'alarm' | 'smoke' | 'fire' | 'totaled'
export interface HitInfo {
  zone: string
  effect: HitEffect
  added: number
  total: number
  /** 重擊（玻璃碎裂、爆胎、高力道）：鏡頭與音效加重 */
  heavy: boolean
  /** 本次敲擊跨過的損壞門檻 */
  milestones: Milestone[]
}
interface Panel {
  mesh: THREE.Mesh
  orig: Float32Array
}
interface Glass {
  mesh: THREE.Mesh
  ctx: CanvasRenderingContext2D
  tex: THREE.CanvasTexture
  hits: number
  broken: boolean
  zone: string
  center: THREE.Vector3
}
interface Wheel {
  group: THREE.Group
  tire: THREE.Mesh
  x: number
  z: number
  hits: number
  flat: boolean
}
interface Debris {
  obj: THREE.Object3D
  v: THREE.Vector3
  w: THREE.Vector3
  life: number
  rest: boolean
  ground: number
  kind: 'solid' | 'spark' | 'loose'
}
interface Puff {
  s: THREE.Sprite
  life: number
  max: number
  grow: number
  v: THREE.Vector3
  peak: number
}

const PAINT = new THREE.Color(0x0c0d10)
const SCRATCH = new THREE.Color(0xb9bdc4)
const PRIMER = new THREE.Color(0x767b83)
const DAMAGE_W = 1.25

/** 每個部位的凹痕參數：半徑、深度、累積位移上限、損壞量 */
const DENT: Record<string, { r: number; d: number; max: number; w: number }> = {
  車頂: { r: 0.62, d: 0.24, max: 0.3, w: 11 },
  車柱: { r: 0.26, d: 0.07, max: 0.15, w: 4 },
  前保險桿: { r: 0.34, d: 0.1, max: 0.3, w: 5 },
  後保險桿: { r: 0.34, d: 0.1, max: 0.3, w: 5 },
  引擎蓋: { r: 0.58, d: 0.22, max: 0.42, w: 10 },
  後車廂: { r: 0.52, d: 0.19, max: 0.4, w: 9 },
  葉子板: { r: 0.42, d: 0.15, max: 0.36, w: 7 },
  車門: { r: 0.48, d: 0.17, max: 0.4, w: 8 },
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
/** 頂點編號 → 0–1 的固定雜訊（皺摺用，同一頂點每次都一樣，凹痕才會越敲越皺） */
function hash(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function panelGeometry(shape: THREE.Shape, width: number, bt: number, bs: number): THREE.BufferGeometry {
  const depth = width - 2 * bt
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelSegments: 3, curveSegments: 12 })
  g.translate(0, 0, -depth / 2)
  g = new TessellateModifier(0.14, 8).modify(g)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-4)
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) PAINT.toArray(col, i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

function glassCanvas(): { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const ctx = c.getContext('2d')!
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  paintGlass(ctx)
  return { ctx, tex }
}
function paintGlass(ctx: CanvasRenderingContext2D): void {
  const { width: w, height: h } = ctx.canvas
  ctx.clearRect(0, 0, w, h)
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgba(38,52,66,0.96)')
  g.addColorStop(1, 'rgba(12,18,24,0.97)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  // 斜向反光帶
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.beginPath()
  ctx.moveTo(w * 0.25, 0)
  ctx.lineTo(w * 0.42, 0)
  ctx.lineTo(w * 0.22, h)
  ctx.lineTo(w * 0.05, h)
  ctx.fill()
}
/** 蛛網裂痕：放射線＋同心折線；severity 0–1 決定範圍 */
function drawCracks(ctx: CanvasRenderingContext2D, u: number, v: number, severity: number, r: () => number): void {
  const { width: w, height: h } = ctx.canvas
  const cx = u * w
  const cy = (1 - v) * h
  const R = 40 + severity * 160
  const n = 11 + Math.floor(r() * 7)
  const rays: { a: number; l: number }[] = []
  ctx.lineCap = 'round'
  // 撞擊點周圍的霧白碎粉
  const fog = ctx.createRadialGradient(cx, cy, 1, cx, cy, 14 + severity * 26)
  fog.addColorStop(0, 'rgba(235,242,250,0.85)')
  fog.addColorStop(1, 'rgba(235,242,250,0)')
  ctx.fillStyle = fog
  ctx.beginPath()
  ctx.arc(cx, cy, 14 + severity * 26, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(232,240,250,0.95)'
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.4
    const l = R * (0.55 + r() * 0.65)
    rays.push({ a, l })
    ctx.lineWidth = 1.2 + r() * 1.1
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    const seg = 5
    for (let k = 1; k <= seg; k++) {
      const aa = a + (r() - 0.5) * 0.28
      ctx.lineTo(cx + Math.cos(aa) * (l * k) / seg, cy + Math.sin(aa) * (l * k) / seg)
    }
    ctx.stroke()
  }
  for (const f of [0.2, 0.42, 0.66, 0.9]) {
    if (f > 0.5 && severity < 0.3) continue
    ctx.lineWidth = 0.9
    ctx.beginPath()
    rays.forEach((ray, i) => {
      const d = Math.min(ray.l, R * f) * (0.85 + r() * 0.3)
      const x = cx + Math.cos(ray.a) * d
      const y = cy + Math.sin(ray.a) * d
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.stroke()
  }
  ctx.fillStyle = 'rgba(245,250,255,0.98)'
  ctx.beginPath()
  ctx.arc(cx, cy, 3 + severity * 6, 0, Math.PI * 2)
  ctx.fill()
}
/** 碎裂：中間透空，只留框邊鋸齒狀殘片 */
function drawShattered(ctx: CanvasRenderingContext2D, r: () => number): void {
  const { width: w, height: h } = ctx.canvas
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(30,42,54,0.95)'
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  const pts: [number, number][] = []
  const N = 30
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const k = 0.7 + r() * 0.26
    pts.push([w / 2 + Math.cos(a) * (w / 2) * k, h / 2 + Math.sin(a) * (h / 2) * k])
  }
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = N - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.closePath()
  ctx.fill('evenodd')
  ctx.strokeStyle = 'rgba(228,236,246,0.9)'
  ctx.lineWidth = 1.2
  for (const [x, y] of pts) {
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (x - w / 2) * 0.3 * r(), y + (y - h / 2) * 0.3 * r())
    ctx.stroke()
  }
}

function radialTexture(stops: [number, string][], size = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2 - 1)
  for (const [o, col] of stops) grd.addColorStop(o, col)
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
/** 撞擊閃光：中心白、四道光芒 */
function starTexture(): THREE.CanvasTexture {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.18, 'rgba(255,236,170,0.95)')
  grd.addColorStop(0.5, 'rgba(255,170,60,0.25)')
  grd.addColorStop(1, 'rgba(255,140,40,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, S, S)
  g.globalCompositeOperation = 'lighter'
  for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
    g.save()
    g.translate(S / 2, S / 2)
    g.rotate(a)
    const len = a === 0 || a === Math.PI / 2 ? S / 2 : S / 3
    const lg = g.createLinearGradient(-len, 0, len, 0)
    lg.addColorStop(0, 'rgba(255,240,200,0)')
    lg.addColorStop(0.5, 'rgba(255,250,235,0.9)')
    lg.addColorStop(1, 'rgba(255,240,200,0)')
    g.fillStyle = lg
    g.fillRect(-len, -2, len * 2, 4)
    g.restore()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export class Audi {
  readonly root = new THREE.Group()
  /** 車殼（懸吊彈跳、爆胎傾斜）；輪子直接掛在 root */
  readonly shell = new THREE.Group()
  readonly targets: THREE.Mesh[] = []
  damage = 0
  hits = 0
  /** 警報剩餘秒數（>0 時雙黃燈閃爍；音效由劇情控制器處理） */
  alarmT = 0
  totaled = false
  private panels = new Map<THREE.Object3D, Panel>()
  private glass = new Map<THREE.Object3D, Glass>()
  private lights = new Map<THREE.Object3D, { zone: string; broken: boolean; shard: number }>()
  private loose = new Map<THREE.Object3D, { zone: string; group: THREE.Object3D; off: boolean }>()
  private trimHits = new Map<THREE.Object3D, number>()
  private wheels: Wheel[] = []
  private debris: Debris[] = []
  private puffs: Puff[] = []
  private smokeT = 0
  private fireT = 0
  private blinkT = 0
  private rand = rng(8888)
  private sus = { y: 0, vy: 0, rx: 0, vrx: 0, rz: 0, vrz: 0 }
  private tilt = { y: 0, rx: 0, rz: 0 }
  private readonly shardGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.05, 0, 0), new THREE.Vector3(0.06, 0, 0.012), new THREE.Vector3(0, 0.075, -0.012)])
  private readonly sparkGeo = new THREE.BoxGeometry(0.028, 0.028, 0.2)
  private readonly sparkMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, toneMapped: false })
  private readonly chipMat = new THREE.MeshLambertMaterial({ color: 0x15161a, side: THREE.DoubleSide })
  private readonly shardMats = new Map<number, THREE.Material>()
  private readonly smokeTex = radialTexture([
    [0, 'rgba(255,255,255,0.9)'],
    [1, 'rgba(255,255,255,0)'],
  ])
  private readonly fireTex = radialTexture([
    [0, 'rgba(255,250,210,1)'],
    [0.35, 'rgba(255,170,40,0.9)'],
    [0.7, 'rgba(220,60,10,0.45)'],
    [1, 'rgba(160,20,0,0)'],
  ])
  private readonly starTex = starTexture()
  private headMat: THREE.MeshLambertMaterial
  private tailMat: THREE.MeshLambertMaterial
  private readonly tmpV = new THREE.Vector3()
  private readonly inv = new THREE.Matrix4()

  constructor() {
    this.shardGeo.computeVertexNormals()
    this.root.add(this.shell)
    const paint = new THREE.MeshPhongMaterial({ color: 0xffffff, vertexColors: true, specular: 0x5a606c, shininess: 70 })
    const black = new THREE.MeshPhongMaterial({ color: 0x0b0b0d, specular: 0x333333, shininess: 40 })
    const chrome = new THREE.MeshPhongMaterial({ color: 0xc9ced4, specular: 0xffffff, shininess: 120 })
    const rubber = new THREE.MeshLambertMaterial({ color: 0x1a1a1c })
    // ── 車身（下半部）：含前後輪拱 ──
    const s = new THREE.Shape()
    s.moveTo(-2.42, 0.25)
    s.lineTo(-1.92, 0.254)
    s.absarc(-1.5, 0.36, 0.43, Math.PI + 0.25, -0.25, true)
    s.lineTo(1.08, 0.254)
    s.absarc(1.5, 0.36, 0.43, Math.PI + 0.25, -0.25, true)
    s.lineTo(2.42, 0.25)
    s.lineTo(2.56, 0.32)
    s.lineTo(2.62, 0.5)
    s.lineTo(2.6, 0.68)
    s.lineTo(2.48, 0.8)
    s.lineTo(2.2, 0.87)
    s.lineTo(1.3, 0.98)
    s.lineTo(-1.5, 1.0)
    s.lineTo(-2.1, 0.99)
    s.lineTo(-2.48, 0.93)
    s.lineTo(-2.6, 0.8)
    s.lineTo(-2.62, 0.55)
    s.lineTo(-2.56, 0.33)
    s.closePath()
    this.addPanel(new THREE.Mesh(panelGeometry(s, CAR_W, 0.07, 0.05), paint), 'body')
    // ── 車艙（A/B/C 柱與車頂）──
    const c = new THREE.Shape()
    c.moveTo(-1.55, 0.95)
    c.lineTo(1.32, 0.95)
    c.lineTo(0.42, 1.4)
    c.lineTo(-0.1, 1.45)
    c.lineTo(-0.8, 1.42)
    c.closePath()
    this.addPanel(new THREE.Mesh(panelGeometry(c, 1.5, 0.08, 0.04), paint), 'cabin')
    // ── 玻璃：側窗（前後各兩片）、前擋、後擋 ──
    const side = (pts: [number, number][], zone: string) => {
      const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))
      for (const sz of [-1, 1]) {
        const g = new THREE.ShapeGeometry(sh)
        fitUV(g, 0, 1)
        g.translate(0, 0, sz * 0.756)
        this.addGlass(g, zone)
      }
    }
    side(
      [
        [-0.22, 1.0],
        [1.18, 1.0],
        [0.42, 1.36],
        [-0.22, 1.4],
      ],
      '車窗',
    )
    side(
      [
        [-1.4, 1.0],
        [-0.32, 1.0],
        [-0.32, 1.4],
        [-0.78, 1.38],
      ],
      '車窗',
    )
    const slope = (p0: [number, number], p1: [number, number], u0: number, u1: number, w0: number, w1: number, zone: string) => {
      const dx = p1[0] - p0[0]
      const dy = p1[1] - p0[1]
      const l = Math.hypot(dx, dy)
      // 外法線：前擋朝前上、後擋朝後上
      let nx = -dy / l
      let ny = dx / l
      if (ny < 0) {
        nx = -nx
        ny = -ny
      }
      const off = 0.047
      const at = (u: number) => [p0[0] + dx * u + nx * off, p0[1] + dy * u + ny * off]
      const [ax, ay] = at(u0)
      const [bx, by] = at(u1)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute([ax, ay, -w0, ax, ay, w0, bx, by, w1, bx, by, -w1], 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
      g.setIndex([0, 1, 2, 0, 2, 3])
      g.computeVertexNormals()
      this.addGlass(g, zone)
    }
    slope([1.32, 0.95], [0.42, 1.4], 0.07, 0.94, 0.66, 0.6, '擋風玻璃')
    slope([-1.55, 0.95], [-0.8, 1.42], 0.08, 0.92, 0.64, 0.58, '後擋玻璃')
    // ── 輪胎與五輻鋁圈（掛在 root，不跟車殼晃） ──
    for (const x of [-1.5, 1.5]) {
      for (const sz of [-1, 1]) {
        const w = new THREE.Group()
        const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.24, 20), rubber)
        tire.rotation.x = Math.PI / 2
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.02, 18), chrome)
        rim.rotation.x = Math.PI / 2
        rim.position.z = sz * 0.122
        w.add(tire, rim)
        for (let k = 0; k < 5; k++) {
          const sp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.21, 0.012), black)
          sp.position.z = sz * 0.134
          sp.rotation.z = (k / 5) * Math.PI * 2
          sp.position.x = Math.sin(sp.rotation.z) * -0.1
          sp.position.y = Math.cos(sp.rotation.z) * 0.1
          w.add(sp)
        }
        w.position.set(x, 0.36, sz * 0.835)
        const idx = this.wheels.length
        w.traverse(o => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true
            o.userData.part = 'wheel'
            o.userData.zone = '輪胎'
            o.userData.wheel = idx
            this.targets.push(o)
          }
        })
        this.root.add(w)
        this.wheels.push({ group: w, tire, x, z: sz * 0.835, hits: 0, flat: false })
      }
    }
    // ── 頭燈、尾燈（左右分開，可各自打破；警報時閃雙黃燈）──
    this.headMat = new THREE.MeshLambertMaterial({ color: 0xf4f6f8, emissive: 0xc8d4e0 })
    this.tailMat = new THREE.MeshLambertMaterial({ color: 0xb3121c, emissive: 0x9a0d16 })
    for (const sz of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.085, 0.44), this.headMat)
      h.position.set(2.6, 0.7, sz * 0.64)
      h.rotation.z = 0.35
      this.addLight(h, '頭燈', 0xeef3f8)
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.56), this.tailMat)
      t.position.set(-2.62, 0.84, sz * 0.62)
      this.addLight(t, '尾燈', 0xc0141e)
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.035, 0.7), this.tailMat)
    bar.position.set(-2.63, 0.86, 0)
    this.addLight(bar, '尾燈', 0xc0141e)
    // ── 單框式水箱護罩＋四環標誌＋車牌 ──
    const grille = new THREE.Shape(
      (
        [
          [-0.38, 0.72],
          [0.38, 0.72],
          [0.47, 0.62],
          [0.42, 0.42],
          [0.32, 0.36],
          [-0.32, 0.36],
          [-0.42, 0.42],
          [-0.47, 0.62],
        ] as [number, number][]
      ).map(([x, y]) => new THREE.Vector2(x, y)),
    )
    const gg = new THREE.ShapeGeometry(grille)
    gg.rotateY(Math.PI / 2)
    gg.translate(2.672, 0, 0)
    // 以自身中心為原點，掉落時才會繞自己翻滾
    gg.computeBoundingBox()
    const gc = gg.boundingBox!.getCenter(new THREE.Vector3())
    gg.translate(-gc.x, -gc.y, -gc.z)
    const gm = new THREE.Mesh(gg, new THREE.MeshPhongMaterial({ color: 0x111214, specular: 0x444444, shininess: 60, side: THREE.DoubleSide }))
    gm.position.copy(gc)
    gm.userData.part = 'trim'
    gm.userData.zone = '水箱護罩'
    this.shell.add(gm)
    this.targets.push(gm)
    const rings = new THREE.Group()
    for (let k = 0; k < 4; k++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.009, 6, 22), chrome)
      r.rotation.y = Math.PI / 2
      r.position.set(0, 0, -0.12 + k * 0.08)
      rings.add(r)
    }
    rings.position.set(2.69, 0.64, 0)
    this.addLoose(rings, '四環標誌')
    const plate = (x: number, y: number, yaw: number) => {
      const cv = document.createElement('canvas')
      cv.width = 256
      cv.height = 88
      const g = cv.getContext('2d')!
      g.fillStyle = '#f4f4f0'
      g.fillRect(0, 0, 256, 88)
      g.strokeStyle = '#222'
      g.lineWidth = 6
      g.strokeRect(4, 4, 248, 80)
      g.fillStyle = '#16171a'
      g.font = 'bold 58px Arial, sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText('BOD-0001', 128, 47)
      const t = new THREE.CanvasTexture(cv)
      t.colorSpace = THREE.SRGBColorSpace
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide }))
      m.position.set(x, y, 0)
      m.rotation.y = yaw
      m.userData.part = 'trim'
      m.userData.zone = '車牌'
      this.shell.add(m)
      this.targets.push(m)
    }
    plate(2.685, 0.45, Math.PI / 2)
    plate(-2.69, 0.6, -Math.PI / 2)
    // ── 後照鏡（敲一下就掉）──
    for (const sz of [-1, 1]) {
      const m = new THREE.Group()
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.12), black)
      arm.position.z = sz * 0.06
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.2), paint.clone())
      ;(housing.material as THREE.MeshPhongMaterial).vertexColors = false
      ;(housing.material as THREE.MeshPhongMaterial).color.copy(PAINT)
      housing.position.set(-0.02, 0.03, sz * 0.2)
      m.add(arm, housing)
      m.position.set(0.98, 1.03, sz * 0.94)
      this.addLoose(m, '後照鏡')
    }
    // 門把（小鍍鉻條）
    for (const x of [0.4, -0.95]) {
      for (const sz of [-1, 1]) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.02), chrome)
        h.position.set(x, 0.9, sz * 0.982)
        this.shell.add(h)
      }
    }
    this.root.traverse(o => {
      if (o instanceof THREE.Mesh) o.castShadow = true
    })
  }

  private addPanel(m: THREE.Mesh, kind: 'body' | 'cabin'): void {
    m.userData.part = kind
    m.castShadow = true
    this.shell.add(m)
    this.targets.push(m)
    const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute
    this.panels.set(m, { mesh: m, orig: new Float32Array(pos.array) })
  }
  private addGlass(g: THREE.BufferGeometry, zone: string): void {
    const { ctx, tex } = glassCanvas()
    const m = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ map: tex, color: 0xffffff, specular: 0x8aa0b4, shininess: 110, transparent: true, side: THREE.DoubleSide, depthWrite: true }))
    m.userData.part = 'glass'
    m.userData.zone = zone
    this.shell.add(m)
    this.targets.push(m)
    g.computeBoundingBox()
    this.glass.set(m, { mesh: m, ctx, tex, hits: 0, broken: false, zone, center: g.boundingBox!.getCenter(new THREE.Vector3()) })
  }
  private addLight(m: THREE.Mesh, zone: string, shard: number): void {
    m.userData.part = 'light'
    m.userData.zone = zone
    this.shell.add(m)
    this.targets.push(m)
    this.lights.set(m, { zone, broken: false, shard })
  }
  private addLoose(g: THREE.Object3D, zone: string): void {
    this.shell.add(g)
    g.traverse(o => {
      if (o instanceof THREE.Mesh) {
        o.userData.part = 'loose'
        o.userData.zone = zone
        this.targets.push(o)
        this.loose.set(o, { zone, group: g, off: false })
      }
    })
  }
  /** 碎玻璃、已掉落零件讓射線穿過 */
  passThrough(o: THREE.Object3D): boolean {
    const g = this.glass.get(o)
    if (g?.broken) return true
    const l = this.loose.get(o)
    if (l?.off) return true
    return !!o.userData.fallen
  }

  /**
   * 一次錘擊。inter 為射線命中結果、dir 為錘擊方向（世界座標，單位向量）、power 約 0.85–1.8（含連擊加成）。
   * 依命中部位決定效果：車頂／引擎蓋凹得深、車門中等、保險桿與車柱較硬；玻璃先裂後碎；燈破；
   * 鏡、標誌、車牌、護罩掉落；輪胎第二下爆胎。
   */
  hit(inter: THREE.Intersection, dir: THREE.Vector3, power = 1): HitInfo {
    const o = inter.object
    const part = o.userData.part as string
    this.root.updateWorldMatrix(true, true)
    // 車殼座標（凹痕、部位判定）
    const sp = this.shell.worldToLocal(inter.point.clone())
    this.inv.copy(this.shell.matrixWorld).invert()
    const sd = dir.clone().transformDirection(this.inv)
    // root 座標（碎片、特效）
    const rp = this.root.worldToLocal(inter.point.clone())
    this.inv.copy(this.root.matrixWorld).invert()
    const rd = dir.clone().transformDirection(this.inv)
    // 入射角：垂直敲擊最有力
    let incidence = 1
    if (inter.face) {
      const n = inter.face.normal.clone().transformDirection(o.matrixWorld).transformDirection(this.inv)
      incidence = 0.5 + 0.5 * Math.min(1, Math.abs(n.dot(rd)))
    }
    const k = power * incidence
    let zone = (o.userData.zone as string) || '車身'
    let effect: HitEffect = 'dent'
    let added = 0
    let heavy = k > 1.3
    const before = this.damage
    this.hits++
    this.flash(rp, 0.55 + 0.35 * k)
    if (part === 'body' || part === 'cabin') {
      if (part === 'cabin') zone = sp.y > 1.34 ? '車頂' : '車柱'
      else if (Math.abs(sp.x) > 2.3) zone = sp.x > 0 ? '前保險桿' : '後保險桿'
      else if (sp.y > 0.86 && sp.x > 1.2) zone = '引擎蓋'
      else if (sp.y > 0.86 && sp.x < -1.5) zone = '後車廂'
      else if (sp.y < 0.85 && (Math.abs(sp.x - 1.5) < 0.62 || Math.abs(sp.x + 1.5) < 0.62)) zone = '葉子板'
      else zone = '車門'
      const P = DENT[zone]
      this.dent(o as THREE.Mesh, sp, sd, P.r * (0.9 + 0.2 * k), P.d * k, P.max)
      added = P.w * k
      this.chips(rp, rd, 6 + Math.round(6 * k))
      this.sparks(rp, rd, 10 + Math.round(8 * k))
      this.dust(rp, rd, 0x8a8f96, 3)
      // 車頂被敲凹：旁邊的車窗跟著震裂
      if (zone === '車頂') this.sympathy(sp, 1.15)
      else if (zone === '車門' || zone === '車柱') this.sympathy(sp, 0.55)
    } else if (part === 'glass') {
      const g = this.glass.get(o)!
      g.hits++
      const uv = inter.uv ?? new THREE.Vector2(0.5, 0.5)
      // 越靠玻璃中央，裂痕越大
      const center = 1 - Math.min(1, Math.hypot(uv.x - 0.5, uv.y - 0.5) * 1.6)
      if (g.hits >= 2 || (center > 0.5 && k > 1.2)) {
        this.shatter(g, rp, rd, 40)
        effect = 'shatter'
        added = 12 * k
        heavy = true
      } else {
        drawCracks(g.ctx, uv.x, uv.y, Math.min(1, 0.45 + center * 0.5) * Math.min(1.3, k), this.rand)
        g.tex.needsUpdate = true
        effect = 'crack'
        added = 6 * k
        this.shards(rp, rd, 0xbfd0dc, 10, 8)
      }
      this.dust(rp, rd, 0xdfe8f0, 2)
    } else if (part === 'light') {
      const l = this.lights.get(o)!
      if (!l.broken) {
        this.breakLight(o as THREE.Mesh, rp, rd, 16)
        effect = 'break'
        added = 6 * k
      } else {
        effect = 'clang'
        added = 1
      }
      this.sparks(rp, rd, 6)
    } else if (part === 'loose') {
      const l = this.loose.get(o)!
      if (!l.off) {
        this.detach(l.group, rd, 1.4)
        effect = 'detach'
        added = 5 * k
      } else effect = 'clang'
      this.sparks(rp, rd, 8)
    } else if (part === 'trim') {
      // 車牌／水箱護罩：連帶把保險桿敲凹；車牌第二下、護罩第三下掉落
      const body = this.targets[0]
      const bp = this.shell.worldToLocal(inter.point.clone())
      this.dent(body, bp, sd, 0.32, 0.09 * k, 0.3)
      zone = (o.userData.zone as string) || '保險桿'
      const n = (this.trimHits.get(o) ?? 0) + 1
      this.trimHits.set(o, n)
      if (n >= (zone === '車牌' ? 2 : 3)) {
        this.detach(o, rd, 1.6)
        effect = 'detach'
        added = 5 * k
      } else {
        effect = 'dent'
        added = 3 * k
        o.rotation.x += (this.rand() - 0.5) * 0.35
        o.rotation.z += (this.rand() - 0.5) * 0.2
      }
      this.chips(rp, rd, 5)
      this.sparks(rp, rd, 10)
    } else {
      // 輪胎：第一下彈回、第二下爆胎（該角落下沉）
      zone = '輪胎'
      const w = this.wheels[o.userData.wheel as number]
      if (w) {
        w.hits++
        if (!w.flat && w.hits >= 2) {
          this.deflate(w)
          effect = 'deflate'
          added = 8 * k
          heavy = true
          this.dust(rp, rd, 0x6f6a62, 5)
        } else {
          effect = w.flat ? 'clang' : 'thud'
          added = 1.5 * k
          this.dust(rp, rd, 0x55534f, 2)
        }
      } else effect = 'clang'
      this.sparks(rp, rd, 5)
    }
    // 車殼懸吊：往敲擊方向壓下、左右／前後晃動
    const imp = (heavy ? 1.6 : 1) * k
    this.sus.vy -= 0.9 * imp
    this.sus.vrx += 0.55 * imp * THREE.MathUtils.clamp(sp.z, -1, 1)
    this.sus.vrz -= 0.22 * imp * THREE.MathUtils.clamp(sp.x / 2.5, -1, 1)
    this.damage = Math.min(100, this.damage + added * DAMAGE_W)
    const milestones: Milestone[] = []
    const cross = (t: number, m: Milestone) => {
      if (before < t && this.damage >= t) milestones.push(m)
    }
    cross(20, 'alarm')
    cross(50, 'smoke')
    cross(80, 'fire')
    if (!this.totaled && this.damage >= 100) {
      this.totaled = true
      milestones.push('totaled')
      this.totalize(rp, rd)
      heavy = true
    }
    if (this.damage >= 20 && !this.totaled) this.alarmT = 9
    return { zone, effect, added: added * DAMAGE_W, total: this.damage, heavy, milestones }
  }

  /** 全毀：剩下的玻璃全碎、燈全破、四輪全爆、一大團塵煙 */
  private totalize(rp: THREE.Vector3, rd: THREE.Vector3): void {
    for (const g of this.glass.values()) if (!g.broken) this.shatter(g, g.center.clone(), rd, 14)
    for (const [m, l] of this.lights) if (!l.broken) this.breakLight(m as THREE.Mesh, m.position.clone(), rd, 6)
    for (const w of this.wheels) if (!w.flat) this.deflate(w)
    for (let i = 0; i < 10; i++) {
      const p = new THREE.Vector3((this.rand() - 0.5) * CAR_L, 0.4 + this.rand() * 0.8, (this.rand() - 0.5) * CAR_W)
      this.dust(p, rd, 0x4a4a4a, 1, 1.6)
    }
    this.sus.vy -= 2.2
    this.alarmT = 0
    void rp
  }

  private shatter(g: Glass, rp: THREE.Vector3, rd: THREE.Vector3, n: number): void {
    g.broken = true
    drawShattered(g.ctx, this.rand)
    g.tex.needsUpdate = true
    this.shards(rp, rd, 0x9fb4c4, n, 40)
  }
  private breakLight(m: THREE.Mesh, rp: THREE.Vector3, rd: THREE.Vector3, n: number): void {
    const l = this.lights.get(m)!
    l.broken = true
    m.material = new THREE.MeshLambertMaterial({ color: 0x2b2c30 })
    m.scale.x = 0.7
    this.shards(rp, rd, l.shard, n, 20)
  }
  /** 敲落零件：保留世界姿態改掛到 root，交給碎片系統 */
  private detach(obj: THREE.Object3D, rd: THREE.Vector3, kick: number): void {
    for (const rec of this.loose.values()) if (rec.group === obj) rec.off = true
    obj.traverse(o => (o.userData.fallen = true))
    this.root.attach(obj)
    const side = obj.position.z > 0.3 ? 1 : obj.position.z < -0.3 ? -1 : 0
    const front = obj.position.x > 2.3 ? 1 : obj.position.x < -2.3 ? -1 : 0
    this.debris.push({
      obj,
      v: new THREE.Vector3(rd.x * kick + front * 1.1, 1.1 + this.rand() * 0.8, rd.z * kick + side * 1.1),
      w: new THREE.Vector3(this.rand() * 10 - 5, this.rand() * 10 - 5, this.rand() * 10 - 5),
      life: 1e9,
      rest: false,
      ground: 0.05,
      kind: 'loose',
    })
  }
  private deflate(w: Wheel): void {
    w.flat = true
    w.tire.scale.z = 0.66
    w.group.position.y = 0.36 - 0.12
    // 依四輪爆胎狀況求車殼下沉平面：drop = a + b·x + c·z
    let a = 0
    let bx = 0
    let cz = 0
    for (const q of this.wheels) {
      const d = q.flat ? 0.13 : 0
      a += d / 4
      bx += (d * q.x) / (4 * q.x * q.x)
      cz += (d * q.z) / (4 * q.z * q.z)
    }
    this.tilt.y = -a
    this.tilt.rz = -bx
    this.tilt.rx = cz
    this.sus.vy -= 1.2
  }
  /** 車頂／車門被敲凹時，附近車窗跟著震出裂痕 */
  private sympathy(sp: THREE.Vector3, radius: number): void {
    for (const g of this.glass.values()) {
      if (g.broken || g.center.distanceTo(sp) > radius) continue
      g.hits = Math.max(g.hits, 1)
      drawCracks(g.ctx, 0.2 + this.rand() * 0.6, 0.75 + this.rand() * 0.2, 0.3, this.rand)
      g.tex.needsUpdate = true
    }
  }

  private dent(m: THREE.Mesh, lp: THREE.Vector3, ld: THREE.Vector3, r: number, depth: number, max: number): void {
    const p = this.panels.get(m)
    if (!p) return
    const geo = m.geometry
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const col = geo.getAttribute('color') as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const orig = p.orig
    const R = r * 1.25
    const R2 = R * R
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = arr[i * 3]
      const y = arr[i * 3 + 1]
      const z = arr[i * 3 + 2]
      const d2 = (x - lp.x) ** 2 + (y - lp.y) ** 2 + (z - lp.z) ** 2
      if (d2 >= R2) continue
      const t = Math.sqrt(d2) / r
      // 中心凹陷（帶皺摺雜訊）＋外圈被擠得微微拱起
      let f = 0
      if (t < 1) {
        f = 1 - t * t
        f *= f
        f *= 0.7 + 0.6 * hash(i)
      }
      const ring = t > 0.72 ? -0.2 * Math.sin(Math.min(1, (t - 0.72) / 0.53) * Math.PI) : 0
      const disp = depth * (f + ring)
      let nx = x + ld.x * disp
      let ny = y + ld.y * disp
      let nz = z + ld.z * disp
      // 累積位移上限，避免穿出另一側
      const ox = nx - orig[i * 3]
      const oy = ny - orig[i * 3 + 1]
      const oz = nz - orig[i * 3 + 2]
      const ol = Math.hypot(ox, oy, oz)
      if (ol > max) {
        nx = orig[i * 3] + (ox / ol) * max
        ny = orig[i * 3 + 1] + (oy / ol) * max
        nz = orig[i * 3 + 2] + (oz / ol) * max
      }
      arr[i * 3] = nx
      arr[i * 3 + 1] = ny
      arr[i * 3 + 2] = nz
      if (f <= 0) continue
      // 漆面：中心刮到底漆，外圈刮痕銀（範圍加大，黑漆上才看得出凹痕）
      c.fromBufferAttribute(col, i)
      const tt = Math.min(1, (f * 1.5 + 0.12) * (0.6 + this.rand() * 0.8))
      c.lerp(f > 0.5 ? PRIMER : SCRATCH, tt * 0.92)
      col.setXYZ(i, c.r, c.g, c.b)
    }
    pos.needsUpdate = true
    col.needsUpdate = true
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
  }

  // ─── 特效 ────────────────────────────────────────────
  private spawn(obj: THREE.Object3D, at: THREE.Vector3, v: THREE.Vector3, life: number, kind: Debris['kind'] = 'solid'): void {
    obj.position.copy(at)
    this.root.add(obj)
    this.debris.push({ obj, v, w: new THREE.Vector3(this.rand() * 16 - 8, this.rand() * 16 - 8, this.rand() * 16 - 8), life, rest: false, ground: 0.02, kind })
    // 上限：先清掉最舊、已落地的碎片
    if (this.debris.length > 360) {
      const i = this.debris.findIndex(d => d.kind === 'solid' && d.rest)
      const j = i >= 0 ? i : this.debris.findIndex(d => d.kind !== 'loose')
      if (j >= 0) {
        this.root.remove(this.debris[j].obj)
        this.debris.splice(j, 1)
      }
    }
  }
  private shardMat(color: number): THREE.Material {
    let m = this.shardMats.get(color)
    if (!m) {
      m = new THREE.MeshPhongMaterial({ color, specular: 0xffffff, shininess: 90, side: THREE.DoubleSide, transparent: true, opacity: 0.88 })
      this.shardMats.set(color, m)
    }
    return m
  }
  private shards(lp: THREE.Vector3, ld: THREE.Vector3, color: number, n: number, life: number): void {
    const mat = this.shardMat(color)
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.shardGeo, mat)
      m.scale.setScalar(0.5 + this.rand() * 1.4)
      const v = new THREE.Vector3(ld.x * (0.6 + this.rand() * 1.6) + (this.rand() - 0.5) * 3, 0.8 + this.rand() * 2.8, ld.z * (0.6 + this.rand() * 1.6) + (this.rand() - 0.5) * 3)
      this.spawn(m, lp.clone().add(new THREE.Vector3((this.rand() - 0.5) * 0.3, (this.rand() - 0.5) * 0.2, (this.rand() - 0.5) * 0.3)), v, life * (0.7 + this.rand() * 0.6))
    }
  }
  private chips(lp: THREE.Vector3, ld: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.shardGeo, this.chipMat)
      m.scale.setScalar(0.4 + this.rand() * 0.6)
      const v = new THREE.Vector3(-ld.x * 1.2 + (this.rand() - 0.5) * 2.6, 1.3 + this.rand() * 2, -ld.z * 1.2 + (this.rand() - 0.5) * 2.6)
      this.spawn(m, lp, v, 10 + this.rand() * 6)
    }
  }
  private sparks(lp: THREE.Vector3, ld: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.sparkGeo, this.sparkMat)
      const v = new THREE.Vector3(-ld.x * 3 + (this.rand() - 0.5) * 5, 1.8 + this.rand() * 3.2, -ld.z * 3 + (this.rand() - 0.5) * 5)
      this.spawn(m, lp, v, 0.35 + this.rand() * 0.45, 'spark')
    }
  }
  /** 撞擊點閃光（加色混合星芒） */
  private flash(lp: THREE.Vector3, size: number): void {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.starTex, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, toneMapped: false }))
    s.material.rotation = this.rand() * Math.PI
    s.position.copy(lp)
    s.renderOrder = 12
    this.root.add(s)
    this.puffs.push({ s, life: 0.11, max: 0.11, grow: -size * 4, v: new THREE.Vector3(), peak: 1 })
    s.scale.setScalar(size)
  }
  /** 塵煙／漆粉 */
  private dust(lp: THREE.Vector3, ld: THREE.Vector3, color: number, n: number, scale = 1): void {
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, color, transparent: true, depthWrite: false, opacity: 0.55 }))
      s.position.copy(lp)
      s.scale.setScalar(0.25 * scale)
      this.root.add(s)
      const v = new THREE.Vector3(-ld.x * 0.8 + (this.rand() - 0.5) * 1.2, 0.3 + this.rand() * 0.6, -ld.z * 0.8 + (this.rand() - 0.5) * 1.2)
      this.puffs.push({ s, life: 0.7 * scale, max: 0.7 * scale, grow: 1.4 * scale, v, peak: 0.55 })
    }
  }
  private emit(color: number, at: THREE.Vector3, life: number, size: number, grow: number, v: THREE.Vector3, peak: number, fire = false): void {
    if (this.puffs.length > 140) return
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial(
        fire
          ? { map: this.fireTex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }
          : { map: this.smokeTex, color, transparent: true, depthWrite: false, opacity: peak },
      ),
    )
    s.position.copy(at)
    s.scale.setScalar(size)
    this.root.add(s)
    this.puffs.push({ s, life, max: life, grow, v, peak })
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05)
    // ── 懸吊彈簧 ──
    const K = 170
    const C = 13
    const S = this.sus
    S.vy += (-K * (S.y - this.tilt.y) - C * S.vy) * step
    S.vrx += (-K * (S.rx - this.tilt.rx) - C * S.vrx) * step
    S.vrz += (-K * (S.rz - this.tilt.rz) - C * S.vrz) * step
    S.y += S.vy * step
    S.rx += S.vrx * step
    S.rz += S.vrz * step
    S.y = THREE.MathUtils.clamp(S.y, -0.3, 0.12)
    this.shell.position.y = S.y
    this.shell.rotation.x = S.rx
    this.shell.rotation.z = S.rz
    // ── 碎片 ──
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]
      d.life -= step
      if (d.life <= 0) {
        this.root.remove(d.obj)
        this.debris.splice(i, 1)
        continue
      }
      if (d.rest) continue
      d.v.y -= 9.8 * step
      d.obj.position.addScaledVector(d.v, step)
      if (d.kind === 'spark') {
        // 火花沿速度方向拉長
        this.tmpV.copy(d.obj.position).add(d.v)
        d.obj.lookAt(this.root.localToWorld(this.tmpV))
      } else {
        d.obj.rotation.x += d.w.x * step
        d.obj.rotation.y += d.w.y * step
        d.obj.rotation.z += d.w.z * step
      }
      if (d.obj.position.y < d.ground) {
        d.obj.position.y = d.ground
        if (d.kind === 'spark') {
          d.v.y *= -0.35
          d.v.x *= 0.6
          d.v.z *= 0.6
        } else if (Math.abs(d.v.y) < 1.2) {
          d.rest = true
          // 落地後平躺
          d.obj.rotation.x = Math.round(d.obj.rotation.x / Math.PI) * Math.PI
          d.obj.rotation.z = Math.round(d.obj.rotation.z / Math.PI) * Math.PI
        } else {
          d.v.y *= -0.32
          d.v.x *= 0.5
          d.v.z *= 0.5
          d.w.multiplyScalar(0.5)
        }
      }
    }
    // ── 警報：雙黃燈 ──
    if (this.alarmT > 0) {
      this.alarmT = Math.max(0, this.alarmT - step)
      this.blinkT += step
      const on = this.alarmT > 0 && this.blinkT % 0.5 < 0.25
      this.headMat.emissive.setHex(on ? 0xffa21a : 0xc8d4e0)
      this.tailMat.emissive.setHex(on ? 0xff8a10 : 0x9a0d16)
    }
    // ── 損壞冒煙／起火（位置跟著車殼的引擎蓋） ──
    if (this.damage >= 50) {
      this.smokeT -= step
      if (this.smokeT <= 0) {
        const dark = this.damage >= 75
        this.smokeT = dark ? 0.07 : 0.14
        const at = this.shell.localToWorld(new THREE.Vector3(1.7 + this.rand() * 0.7, 0.95, (this.rand() - 0.5) * 0.9))
        this.root.worldToLocal(at)
        this.emit(dark ? 0x222222 : 0x7a7a7a, at, dark ? 3.2 : 2.6, dark ? 0.55 : 0.4, dark ? 0.85 : 0.6, new THREE.Vector3(-0.2 + (this.rand() - 0.5) * 0.3, 0.9 + this.rand() * 0.5, (this.rand() - 0.5) * 0.3), dark ? 0.85 : 0.6)
      }
    }
    if (this.damage >= 80) {
      this.fireT -= step
      if (this.fireT <= 0) {
        this.fireT = 0.045
        const at = this.shell.localToWorld(new THREE.Vector3(1.55 + this.rand() * 0.9, 0.98, (this.rand() - 0.5) * 1.1))
        this.root.worldToLocal(at)
        const col = this.rand() < 0.5 ? 0xffb347 : 0xff7a1a
        this.emit(col, at, 0.45 + this.rand() * 0.3, 0.32 + this.rand() * 0.25, 0.9, new THREE.Vector3((this.rand() - 0.5) * 0.4, 1.6 + this.rand() * 1.2, (this.rand() - 0.5) * 0.4), 1, true)
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]
      p.life -= step
      if (p.life <= 0) {
        this.root.remove(p.s)
        p.s.material.dispose()
        this.puffs.splice(i, 1)
        continue
      }
      const age = 1 - p.life / p.max
      p.s.position.addScaledVector(p.v, step)
      p.s.scale.setScalar(Math.max(0.02, p.s.scale.x + p.grow * step))
      p.s.material.opacity = p.peak * Math.min(1, (1 - age) * 1.6)
    }
  }
}

function fitUV(g: THREE.BufferGeometry, ax: 0 | 1 | 2, ay: 0 | 1 | 2): void {
  g.computeBoundingBox()
  const b = g.boundingBox!
  const pos = g.getAttribute('position')
  const uv = new Float32Array(pos.count * 2)
  const min = [b.min.x, b.min.y, b.min.z]
  const size = [b.max.x - b.min.x || 1, b.max.y - b.min.y || 1, b.max.z - b.min.z || 1]
  for (let i = 0; i < pos.count; i++) {
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)]
    uv[i * 2] = (p[ax] - min[ax]) / size[ax]
    uv[i * 2 + 1] = (p[ay] - min[ay]) / size[ay]
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

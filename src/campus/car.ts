import * as THREE from 'three'
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * 黑色奧迪四門房車（程序化幾何；本地座標：原點在車底中心地面、+x 車頭、+z 右側）。
 * 車身與車艙細分成約 0.14 m 的網格，敲打時依落點把頂點沿錘擊方向推入（凹痕）並把漆面刷成刮痕灰；
 * 玻璃用 canvas 畫蛛網裂痕、第三下碎裂；頭尾燈破裂熄滅；後照鏡與四環標誌會被敲落。
 */
export const CAR_L = 5.2
export const CAR_W = 1.95

export type HitEffect = 'dent' | 'crack' | 'shatter' | 'break' | 'detach' | 'clang'
export interface HitInfo {
  zone: string
  effect: HitEffect
  added: number
  total: number
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
}
interface Debris {
  obj: THREE.Object3D
  v: THREE.Vector3
  w: THREE.Vector3
  life: number
  rest: boolean
  ground: number
  fade?: boolean
}

const PAINT = new THREE.Color(0x0c0d10)
const SCRATCH = new THREE.Color(0x8d9096)
const PRIMER = new THREE.Color(0x5b5f66)

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
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
  const R = 28 + severity * 120
  const n = 9 + Math.floor(r() * 6)
  const rays: { a: number; l: number }[] = []
  ctx.strokeStyle = 'rgba(228,236,246,0.92)'
  ctx.lineCap = 'round'
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.4
    const l = R * (0.55 + r() * 0.6)
    rays.push({ a, l })
    ctx.lineWidth = 1 + r() * 0.8
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    let px = cx
    let py = cy
    const seg = 4
    for (let k = 1; k <= seg; k++) {
      const aa = a + (r() - 0.5) * 0.25
      px = cx + Math.cos(aa) * (l * k) / seg
      py = cy + Math.sin(aa) * (l * k) / seg
      ctx.lineTo(px, py)
    }
    ctx.stroke()
  }
  for (const f of [0.28, 0.55, 0.85]) {
    if (f > 0.5 && severity < 0.35) continue
    ctx.lineWidth = 0.8
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
  ctx.fillStyle = 'rgba(240,246,255,0.95)'
  ctx.beginPath()
  ctx.arc(cx, cy, 2.5 + severity * 4, 0, Math.PI * 2)
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
  const N = 26
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const k = 0.62 + r() * 0.3
    pts.push([w / 2 + Math.cos(a) * (w / 2) * k, h / 2 + Math.sin(a) * (h / 2) * k])
  }
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = N - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.closePath()
  ctx.fill('evenodd')
  ctx.strokeStyle = 'rgba(228,236,246,0.85)'
  ctx.lineWidth = 1
  for (const [x, y] of pts) {
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (x - w / 2) * 0.3 * r(), y + (y - h / 2) * 0.3 * r())
    ctx.stroke()
  }
}

export class Audi {
  readonly root = new THREE.Group()
  readonly targets: THREE.Mesh[] = []
  damage = 0
  hits = 0
  private panels = new Map<THREE.Object3D, Panel>()
  private glass = new Map<THREE.Object3D, Glass>()
  private lights = new Map<THREE.Object3D, { zone: string; broken: boolean; shard: number }>()
  private loose = new Map<THREE.Object3D, { zone: string; group: THREE.Object3D; off: boolean }>()
  private debris: Debris[] = []
  private smoke: { s: THREE.Sprite; life: number }[] = []
  private smokeT = 0
  private rand = rng(8888)
  private shardGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.04, 0, 0), new THREE.Vector3(0.05, 0, 0.01), new THREE.Vector3(0, 0.06, -0.01)])
  private smokeMat: THREE.SpriteMaterial
  private sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd27a })

  constructor() {
    this.shardGeo.computeVertexNormals()
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
    // ── 輪胎與五輻鋁圈 ──
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
        w.traverse(o => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true
            o.userData.part = 'wheel'
            o.userData.zone = '輪胎'
            this.targets.push(o)
          }
        })
        this.root.add(w)
      }
    }
    // ── 頭燈、尾燈（左右分開，可各自打破）──
    const head = new THREE.MeshLambertMaterial({ color: 0xf4f6f8, emissive: 0xc8d4e0 })
    const tail = new THREE.MeshLambertMaterial({ color: 0xb3121c, emissive: 0x9a0d16 })
    for (const sz of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.085, 0.44), head)
      h.position.set(2.6, 0.7, sz * 0.64)
      h.rotation.z = 0.35
      this.addLight(h, '頭燈', 0xeef3f8)
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.56), tail)
      t.position.set(-2.62, 0.84, sz * 0.62)
      this.addLight(t, '尾燈', 0xc0141e)
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.035, 0.7), tail)
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
    const gm = new THREE.Mesh(gg, new THREE.MeshPhongMaterial({ color: 0x111214, specular: 0x444444, shininess: 60, side: THREE.DoubleSide }))
    gm.userData.part = 'trim'
    gm.userData.zone = '水箱護罩'
    this.root.add(gm)
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
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), new THREE.MeshLambertMaterial({ map: t }))
      m.position.set(x, y, 0)
      m.rotation.y = yaw
      m.userData.part = 'trim'
      m.userData.zone = '車牌'
      this.root.add(m)
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
        this.root.add(h)
      }
    }
    this.smokeMat = new THREE.SpriteMaterial({ map: smokeTexture(), color: 0x6d6d6d, transparent: true, depthWrite: false, opacity: 0.7 })
    this.root.traverse(o => {
      if (o instanceof THREE.Mesh) o.castShadow = true
    })
  }

  private addPanel(m: THREE.Mesh, kind: 'body' | 'cabin'): void {
    m.userData.part = kind
    m.castShadow = true
    this.root.add(m)
    this.targets.push(m)
    const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute
    this.panels.set(m, { mesh: m, orig: new Float32Array(pos.array) })
  }
  private addGlass(g: THREE.BufferGeometry, zone: string): void {
    const { ctx, tex } = glassCanvas()
    const m = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ map: tex, color: 0xffffff, specular: 0x8aa0b4, shininess: 110, transparent: true, side: THREE.DoubleSide, depthWrite: true }))
    m.userData.part = 'glass'
    m.userData.zone = zone
    this.root.add(m)
    this.targets.push(m)
    this.glass.set(m, { mesh: m, ctx, tex, hits: 0, broken: false, zone })
  }
  private addLight(m: THREE.Mesh, zone: string, shard: number): void {
    m.userData.part = 'light'
    m.userData.zone = zone
    this.root.add(m)
    this.targets.push(m)
    this.lights.set(m, { zone, broken: false, shard })
  }
  private addLoose(g: THREE.Object3D, zone: string): void {
    this.root.add(g)
    g.traverse(o => {
      if (o instanceof THREE.Mesh) {
        o.userData.part = 'loose'
        o.userData.zone = zone
        this.targets.push(o)
        this.loose.set(o, { zone, group: g, off: false })
      }
    })
  }
  /** 碎玻璃是否該讓射線穿過 */
  passThrough(o: THREE.Object3D): boolean {
    const g = this.glass.get(o)
    if (g?.broken) return true
    const l = this.loose.get(o)
    return !!l?.off
  }

  /**
   * 一次錘擊。inter 為射線命中結果、dir 為錘擊方向（世界座標，單位向量）、power 0.8–1.2。
   * 依命中部位決定效果：車頂／引擎蓋凹得深、車門中等、保險桿與車柱較硬；玻璃先裂後碎；燈破；鏡與標誌掉落；輪胎只會反彈。
   */
  hit(inter: THREE.Intersection, dir: THREE.Vector3, power = 1): HitInfo {
    const o = inter.object
    const part = o.userData.part as string
    const lp = this.root.worldToLocal(inter.point.clone())
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert()
    const ld = dir.clone().transformDirection(inv)
    // 入射角：垂直敲擊最有力
    let incidence = 1
    if (inter.face) {
      const n = inter.face.normal.clone().transformDirection(o.matrixWorld).transformDirection(inv)
      incidence = 0.45 + 0.55 * Math.min(1, Math.abs(n.dot(ld)))
    }
    const k = power * incidence
    let zone = (o.userData.zone as string) || '車身'
    let effect: HitEffect = 'dent'
    let added = 0
    this.hits++
    if (part === 'body' || part === 'cabin') {
      let r = 0.36
      let d = 0.09
      let w = 5
      if (part === 'cabin') {
        if (lp.y > 1.34) {
          zone = '車頂'
          r = 0.52
          d = 0.15
          w = 7
        } else {
          zone = '車柱'
          r = 0.2
          d = 0.04
          w = 2.5
        }
      } else if (Math.abs(lp.x) > 2.3) {
        zone = lp.x > 0 ? '前保險桿' : '後保險桿'
        r = 0.27
        d = 0.05
        w = 3
      } else if (lp.y > 0.86 && lp.x > 1.2) {
        zone = '引擎蓋'
        r = 0.46
        d = 0.13
        w = 6
      } else if (lp.y > 0.86 && lp.x < -1.5) {
        zone = '後車廂'
        r = 0.42
        d = 0.11
        w = 6
      } else if (lp.y < 0.85 && (Math.abs(lp.x - 1.5) < 0.62 || Math.abs(lp.x + 1.5) < 0.62)) {
        zone = '葉子板'
        r = 0.32
        d = 0.08
        w = 4.5
      } else {
        zone = '車門'
      }
      this.dent(o as THREE.Mesh, lp, ld, r * (0.9 + 0.2 * k), d * k)
      added = w * k
      this.chips(lp, ld, 3 + Math.round(4 * k))
    } else if (part === 'glass') {
      const g = this.glass.get(o)!
      g.hits++
      const uv = inter.uv ?? new THREE.Vector2(0.5, 0.5)
      // 越靠玻璃中央，裂痕越大
      const center = 1 - Math.min(1, Math.hypot(uv.x - 0.5, uv.y - 0.5) * 1.6)
      if (g.hits >= 3 || (g.hits >= 2 && center > 0.7 && k > 1)) {
        g.broken = true
        drawShattered(g.ctx, this.rand)
        g.tex.needsUpdate = true
        effect = 'shatter'
        added = 8 * k
        this.shards(lp, ld, 0x9fb4c4, 22)
      } else {
        drawCracks(g.ctx, uv.x, uv.y, Math.min(1, 0.3 + center * 0.5 + (g.hits - 1) * 0.3) * k, this.rand)
        g.tex.needsUpdate = true
        effect = 'crack'
        added = 4 * k
        this.shards(lp, ld, 0xbfd0dc, 5)
      }
    } else if (part === 'light') {
      const l = this.lights.get(o)!
      const m = o as THREE.Mesh
      if (!l.broken) {
        l.broken = true
        m.material = new THREE.MeshLambertMaterial({ color: 0x2b2c30 })
        m.scale.x = 0.7
        effect = 'break'
        added = 4 * k
        this.shards(lp, ld, l.shard, 12)
      } else {
        effect = 'clang'
        added = 0.5
      }
    } else if (part === 'loose') {
      const l = this.loose.get(o)!
      if (!l.off) {
        for (const rec of this.loose.values()) if (rec.group === l.group) rec.off = true
        effect = 'detach'
        added = 3 * k
        // 整組掉落：保留目前世界姿態，交給碎片系統
        const g = l.group
        g.updateMatrixWorld(true)
        this.debris.push({ obj: g, v: new THREE.Vector3(ld.x * 1.2, 0.6, ld.z * 1.2 + (g.position.z > 0 ? 0.8 : g.position.z < 0 ? -0.8 : 0)), w: new THREE.Vector3(this.rand() * 6 - 3, this.rand() * 6 - 3, this.rand() * 6 - 3), life: 1e9, rest: false, ground: 0.06 })
      } else {
        effect = 'clang'
      }
    } else if (part === 'trim') {
      // 車牌／水箱護罩：敲在保險桿上
      const body = this.targets[0]
      this.dent(body, lp, ld, 0.25, 0.04 * k)
      zone = (o.userData.zone as string) || '保險桿'
      effect = 'dent'
      added = 2 * k
      o.rotation.x += (this.rand() - 0.5) * 0.2
      this.chips(lp, ld, 3)
    } else {
      effect = 'clang'
      zone = '輪胎'
      added = 0
      this.sparks(lp, ld, 8)
    }
    this.damage = Math.min(100, this.damage + added)
    return { zone, effect, added, total: this.damage }
  }

  private dent(m: THREE.Mesh, lp: THREE.Vector3, ld: THREE.Vector3, r: number, depth: number): void {
    const p = this.panels.get(m)
    if (!p) return
    const geo = m.geometry
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const col = geo.getAttribute('color') as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const orig = p.orig
    const r2 = r * r
    const MAX = 0.32
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = arr[i * 3]
      const y = arr[i * 3 + 1]
      const z = arr[i * 3 + 2]
      const d2 = (x - lp.x) ** 2 + (y - lp.y) ** 2 + (z - lp.z) ** 2
      if (d2 >= r2) continue
      let f = 1 - d2 / r2
      f *= f
      let nx = x + ld.x * depth * f
      let ny = y + ld.y * depth * f
      let nz = z + ld.z * depth * f
      // 累積位移上限，避免穿出另一側
      const ox = nx - orig[i * 3]
      const oy = ny - orig[i * 3 + 1]
      const oz = nz - orig[i * 3 + 2]
      const ol = Math.hypot(ox, oy, oz)
      if (ol > MAX) {
        nx = orig[i * 3] + (ox / ol) * MAX
        ny = orig[i * 3 + 1] + (oy / ol) * MAX
        nz = orig[i * 3 + 2] + (oz / ol) * MAX
      }
      arr[i * 3] = nx
      arr[i * 3 + 1] = ny
      arr[i * 3 + 2] = nz
      // 漆面：中心刮到底漆，外圈刮痕
      c.fromBufferAttribute(col, i)
      const t = Math.min(1, f * (0.55 + this.rand() * 0.6))
      c.lerp(f > 0.6 ? PRIMER : SCRATCH, t * 0.7)
      col.setXYZ(i, c.r, c.g, c.b)
    }
    pos.needsUpdate = true
    col.needsUpdate = true
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
  }

  private spawn(obj: THREE.Object3D, at: THREE.Vector3, v: THREE.Vector3, life: number, fade = false): void {
    obj.position.copy(at)
    this.root.add(obj)
    this.debris.push({ obj, v, w: new THREE.Vector3(this.rand() * 14 - 7, this.rand() * 14 - 7, this.rand() * 14 - 7), life, rest: false, ground: 0.02, fade })
  }
  private shards(lp: THREE.Vector3, ld: THREE.Vector3, color: number, n: number): void {
    const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.shardGeo, mat)
      m.scale.setScalar(0.5 + this.rand() * 0.9)
      const v = new THREE.Vector3(ld.x * (0.4 + this.rand()) + (this.rand() - 0.5) * 2.2, 0.6 + this.rand() * 2.2, ld.z * (0.4 + this.rand()) + (this.rand() - 0.5) * 2.2)
      this.spawn(m, lp, v, 6 + this.rand() * 4)
    }
  }
  private chips(lp: THREE.Vector3, ld: THREE.Vector3, n: number): void {
    const mat = new THREE.MeshLambertMaterial({ color: 0x15161a, side: THREE.DoubleSide })
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.shardGeo, mat)
      m.scale.setScalar(0.35 + this.rand() * 0.4)
      const v = new THREE.Vector3(-ld.x * 0.8 + (this.rand() - 0.5) * 2, 1 + this.rand() * 1.6, -ld.z * 0.8 + (this.rand() - 0.5) * 2)
      this.spawn(m, lp, v, 4 + this.rand() * 3)
    }
    this.sparks(lp, ld, 3)
  }
  private sparks(lp: THREE.Vector3, ld: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.06), this.sparkMat)
      const v = new THREE.Vector3(-ld.x * 2 + (this.rand() - 0.5) * 3, 1.5 + this.rand() * 2, -ld.z * 2 + (this.rand() - 0.5) * 3)
      this.spawn(m, lp, v, 0.25 + this.rand() * 0.2, true)
    }
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05)
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
      d.obj.rotation.x += d.w.x * step
      d.obj.rotation.y += d.w.y * step
      d.obj.rotation.z += d.w.z * step
      if (d.obj.position.y < d.ground) {
        d.obj.position.y = d.ground
        if (Math.abs(d.v.y) < 1.2) {
          d.rest = true
          // 落地後平躺
          d.obj.rotation.x = Math.round(d.obj.rotation.x / Math.PI) * Math.PI
          d.obj.rotation.z = Math.round(d.obj.rotation.z / Math.PI) * Math.PI
        } else {
          d.v.y *= -0.3
          d.v.x *= 0.5
          d.v.z *= 0.5
          d.w.multiplyScalar(0.5)
        }
      }
    }
    // 損壞超過六成：引擎蓋冒煙
    if (this.damage >= 60) {
      this.smokeT -= step
      if (this.smokeT <= 0) {
        this.smokeT = 0.22
        const s = new THREE.Sprite(this.smokeMat.clone())
        s.position.set(1.9 + this.rand() * 0.4, 1.0, (this.rand() - 0.5) * 0.6)
        s.scale.setScalar(0.4)
        this.root.add(s)
        this.smoke.push({ s, life: 2.6 })
      }
    }
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const p = this.smoke[i]
      p.life -= step
      if (p.life <= 0) {
        this.root.remove(p.s)
        p.s.material.dispose()
        this.smoke.splice(i, 1)
        continue
      }
      p.s.position.y += step * 0.7
      p.s.position.x -= step * 0.15
      p.s.scale.setScalar(0.4 + (2.6 - p.life) * 0.55)
      p.s.material.opacity = Math.min(0.6, p.life / 2.6) * 0.8
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

function smokeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30)
  grd.addColorStop(0, 'rgba(255,255,255,0.9)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

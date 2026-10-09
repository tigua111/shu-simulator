/**
 * 大禮堂周邊重作（2026-10-10 使用者地面影片 VID_20261005_115341_000–008，配合 DJI_0052_059 空拍對位 w059.jpg）：
 * - 大禮堂西牆前：正面雙跑大樓梯 → 2F 入口平台（方柱門廊、雨遮、直書「大禮堂」）；
 *   西北角側樓梯（由西往東爬升）→ 平台 → 跨過沿西牆北行穿越通道的天橋 → 2F 側門，上方大型懸挑雨遮；
 *   花台與圓錐羅漢松、洋紅色 SHU 立體字、校園地圖看板、紫色直式布條、沿立面的長截水溝。
 * - 大禮堂立面：土黃色勒腳（水平分割溝）、勒腳上方橫向高窗帶、灰色牆角。
 * - 學校廣場：紅色菱格方塊＋灰色連鎖磚帶的鋪面。
 * - 八風舞台：深色基座、背側深色弧牆、白色柱列、白色扁圓碟形頂（OSM shelter 位置、w059 頂寬約 12 m）。
 * - 後校門：紅磚柱＋石帽＋柱頂黑色古典燈、黑色雙開鐵門（白天內開）；門內西側綠色四角攢尖頂警衛室。
 * 全部是程序幾何與程序貼圖；照片只作造型參考，未作貼圖。步行高度見 data.ts STAIR_PARTS／walkHeight。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js'
import { AREAS, AUD_2F, AUD_WALL_X, BACK_GATE, STAGE, STAIR_PARTS, audBase, groundHeight, stairH0, type Building, type Vec2 } from './data'
import type { Obstacle } from './geometry'
import { PLAZA_SURVEY } from './plazaSurvey'
import { signTexture } from './textures'

export interface PlazaCtx {
  scene: THREE.Scene
  obstacles: Obstacle[]
  capture: (id: string, label: string, num: string, follow: 'ground' | 'terrain' | 'none', build: () => void) => THREE.Group | null
  signPlane: (tex: THREE.Texture, w: number, h: number) => THREE.Mesh
}

// ─── 小工具 ─────────────────────────────────────────
function rand(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  return t
}
const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra })

/** 方塊 UV 以公尺計（tile m 一個貼圖週期） */
function meterBox(w: number, h: number, d: number, tile: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
  for (let f = 0; f < 6; f++) {
    const [a, b] = dims[f]
    for (let k = f * 4; k < f * 4 + 4; k++) uv.setXY(k, (uv.getX(k) * a) / tile, (uv.getY(k) * b) / tile)
  }
  return g
}

const UNDER = new THREE.MeshBasicMaterial({ color: 0xa3a29d })
/** 依材質分組、合併後一次加入場景 */
class Batch {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>()
  add(mat: THREE.Material, geo: THREE.BufferGeometry): void {
    const g = geo.index ? geo.toNonIndexed() : geo
    g.clearGroups()
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k)
    const l = this.parts.get(mat) ?? []
    l.push(g)
    this.parts.set(mat, l)
  }
  /** 軸向方塊：x0..x1、y0..y1、z0..z1 */
  box(mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, tile = 1): void {
    const g = meterBox(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), tile)
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    this.add(mat, g)
  }
  /** 以中心、尺寸、偏航角放置的方塊 */
  boxAt(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0, tile = 1): void {
    const g = meterBox(w, h, d, tile)
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)))
    this.add(mat, g)
  }
  /** 朝下的底板（雨遮、天橋底面）：場景半球光的地面色偏綠，底面改用不受光的灰色 */
  under(x0: number, x1: number, z0: number, z1: number, y: number): void {
    const g = new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0))
    g.rotateX(Math.PI / 2)
    g.translate((x0 + x1) / 2, y - 0.005, (z0 + z1) / 2)
    this.add(UNDER, g)
  }
  /** 圓桿：a → b */
  rod(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6): void {
    const d = new THREE.Vector3().subVectors(b, a)
    const L = d.length()
    if (L < 1e-4) return
    const g = new THREE.CylinderGeometry(r, r, L, seg)
    g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1)))
    this.add(mat, g)
  }
  flush(scene: THREE.Scene | THREE.Group, shadow = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    for (const [mat, geos] of this.parts) {
      const m = new THREE.Mesh(mergeGeometries(geos), mat)
      m.castShadow = shadow
      m.receiveShadow = true
      scene.add(m)
      out.push(m)
    }
    this.parts.clear()
    return out
  }
}

/**
 * 側牆（矮牆）擠出：profile 為沿 along 軸的 [位置, 頂高] 折線（底部統一到 yb），厚度 t。
 * axis 'z'：牆沿 z 延伸，占 x ∈ [xFar − t, xFar]；axis 'x'：牆沿 x 延伸，占 z ∈ [zNear, zNear + t]。
 */
function sideWall(b: Batch, mat: THREE.Material, axis: 'x' | 'z', at: number, t: number, profile: [number, number][], yb: number): void {
  const s = new THREE.Shape()
  s.moveTo(profile[0][0], yb)
  for (const [u, y] of profile) s.lineTo(u, y)
  s.lineTo(profile[profile.length - 1][0], yb)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false })
  if (axis === 'z') {
    // 局部 x（along）→ 世界 z；局部 z（厚度）→ 世界 −x
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.PI / 2))
    g.translate(at, 0, 0)
  } else g.translate(0, 0, at)
  b.add(mat, g)
}

/**
 * 實心踏階：n 級，沿 axis 由 (x0|z0) 端 h0 升到 (x1|z1) 端 h1，每級為底到 yb 的實心方塊，踏面前緣加止滑條。
 */
function steps(b: Batch, mat: THREE.Material, nose: THREE.Material, axis: 'x' | 'z', x0: number, x1: number, z0: number, z1: number, h0: number, h1: number, n: number, yb: number): void {
  for (let i = 0; i < n; i++) {
    const top = h0 + ((h1 - h0) * (i + 1)) / n
    if (axis === 'z') {
      const a = z0 + ((z1 - z0) * i) / n
      const c = z0 + ((z1 - z0) * (i + 1)) / n
      b.box(mat, x0, x1, yb, top, a, c)
      b.box(nose, x0 + 0.05, x1 - 0.05, top, top + 0.012, a, a + 0.06)
    } else {
      const a = x0 + ((x1 - x0) * i) / n
      const c = x0 + ((x1 - x0) * (i + 1)) / n
      b.box(mat, a, c, yb, top, z0, z1)
      b.box(nose, a, a + 0.06, top, top + 0.012, z0 + 0.05, z1 - 0.05)
    }
  }
}

// ─── 程序貼圖 ─────────────────────────────────────────
/** 學校廣場鋪面：4.8 m 一週期＝灰色連鎖磚帶 1.2 m＋紅色方塊 3.6 m（紅區 45° 斜砌＋菱格分割線） */
function plazaPavingTexture(): THREE.CanvasTexture {
  const S = 512
  const k = S / 4.8
  return canvasTex(S, S, g => {
    const r = rand(11)
    g.fillStyle = '#86837e'
    g.fillRect(0, 0, S, S)
    const pw = 0.2 * k
    const ph = 0.1 * k
    for (let row = 0, y = 0; y < S; row++, y += ph)
      for (let x = -pw; x < S; x += pw) {
        const o = (row % 2) * (pw / 2)
        const t = (150 + r() * 24) | 0
        g.fillStyle = `rgb(${t + 6},${t + 4},${t})`
        g.fillRect(x + o + 1, y + 1, pw - 2, ph - 2)
      }
    const x0 = 1.2 * k
    g.save()
    g.beginPath()
    g.rect(x0, x0, S - x0, S - x0)
    g.clip()
    g.fillStyle = '#6a3a33'
    g.fillRect(x0, x0, S - x0, S - x0)
    g.translate(x0 + (S - x0) / 2, x0 + (S - x0) / 2)
    g.rotate(Math.PI / 4)
    const R = S
    for (let row = 0, y = -R; y < R; row++, y += ph)
      for (let x = -R; x < R; x += pw) {
        const o = (row % 2) * (pw / 2)
        const t = r()
        g.fillStyle = `rgb(${(146 + t * 28) | 0},${(84 + t * 16) | 0},${(74 + t * 12) | 0})`
        g.fillRect(x + o + 1, y + 1, pw - 2, ph - 2)
      }
    // 菱格分割線（0.6 m）
    g.strokeStyle = 'rgba(70,32,28,0.55)'
    g.lineWidth = 2
    for (let u = -R; u < R; u += 0.6 * k * 2) {
      g.beginPath()
      g.moveTo(u, -R)
      g.lineTo(u, R)
      g.moveTo(-R, u)
      g.lineTo(R, u)
      g.stroke()
    }
    g.restore()
    // 紅區外框淺色收邊
    g.strokeStyle = '#bdb8b0'
    g.lineWidth = 4
    g.strokeRect(x0 + 2, x0 + 2, S - x0 - 4, S - x0 - 4)
  })
}
/** 土黃色勒腳：0.6 m 一道水平分割溝、1.8 m 一道直縫（貼圖 3.6 m 一週期） */
function plinthTexture(): THREE.CanvasTexture {
  return canvasTex(256, 256, g => {
    const r = rand(5)
    g.fillStyle = '#c4a15e'
    g.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '120,90,40' : '235,215,160'},0.08)`
      g.fillRect(r() * 256, r() * 256, 6, 3)
    }
    g.fillStyle = '#8e7140'
    for (let y = 0; y < 256; y += 256 / 6) g.fillRect(0, y, 256, 3)
    for (let x = 0; x < 256; x += 128) g.fillRect(x, 0, 2, 256)
  })
}
/** 高窗帶：深色玻璃、1.2 m 一道窗框（貼圖寬 1.2 m、高 1 單位） */
function clerestoryTexture(): THREE.CanvasTexture {
  return canvasTex(128, 64, g => {
    const gr = g.createLinearGradient(0, 0, 0, 64)
    gr.addColorStop(0, '#5d6f7b')
    gr.addColorStop(1, '#27323b')
    g.fillStyle = gr
    g.fillRect(0, 0, 128, 64)
    g.fillStyle = '#d9d9d4'
    g.fillRect(0, 0, 6, 64)
    g.fillRect(0, 0, 128, 5)
    g.fillRect(0, 59, 128, 5)
    g.fillRect(64, 0, 3, 64)
  })
}
/** 灰色清水混凝土矮牆：斜向刻線（貼圖 1.2 m 一週期） */
function incisedConcreteTexture(base: string): THREE.CanvasTexture {
  return canvasTex(128, 128, g => {
    const r = rand(3)
    g.fillStyle = base
    g.fillRect(0, 0, 128, 128)
    for (let i = 0; i < 300; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '60,60,60' : '255,255,255'},0.05)`
      g.fillRect(r() * 128, r() * 128, 4, 4)
    }
    g.strokeStyle = 'rgba(70,70,70,0.45)'
    g.lineWidth = 2
    for (let u = -128; u < 256; u += 32) {
      g.beginPath()
      g.moveTo(u, 128)
      g.lineTo(u + 128, 0)
      g.stroke()
    }
  })
}
/** 百葉（格柵）：0.15 m 一片 */
function louverTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, g => {
    g.fillStyle = '#1f2225'
    g.fillRect(0, 0, 64, 64)
    for (let y = 0; y < 64; y += 16) {
      const gr = g.createLinearGradient(0, y, 0, y + 16)
      gr.addColorStop(0, '#5a5f63')
      gr.addColorStop(1, '#2a2d30')
      g.fillStyle = gr
      g.fillRect(0, y + 2, 64, 11)
    }
  })
}
/** 玻璃門：深色玻璃＋不鏽鋼框（n 扇） */
function doorTexture(n: number): THREE.CanvasTexture {
  return canvasTex(128 * n, 256, g => {
    g.fillStyle = '#c9ccd0'
    g.fillRect(0, 0, 128 * n, 256)
    for (let i = 0; i < n; i++) {
      const gr = g.createLinearGradient(0, 0, 0, 256)
      gr.addColorStop(0, '#4f6573')
      gr.addColorStop(1, '#1b252c')
      g.fillStyle = gr
      g.fillRect(i * 128 + 8, 10, 112, 240)
      g.fillStyle = '#c9ccd0'
      g.fillRect(i * 128 + 60, 120, 8, 40)
    }
  })
}
/** 截水溝鐵格柵（橫向扁鐵，0.04 m 一條；貼圖 0.5 m 一週期） */
function grateTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, g => {
    g.fillStyle = '#121314'
    g.fillRect(0, 0, 64, 64)
    g.fillStyle = '#5b5e60'
    for (let y = 0; y < 64; y += 5) g.fillRect(0, y, 64, 2)
    g.fillRect(0, 0, 4, 64)
    g.fillRect(60, 0, 4, 64)
  })
}
/** 紅磚（丁順砌，0.23 × 0.075 m；貼圖 0.92 m 一週期） */
function redBrickTexture(): THREE.CanvasTexture {
  return canvasTex(128, 128, g => {
    const r = rand(9)
    g.fillStyle = '#cdbca8'
    g.fillRect(0, 0, 128, 128)
    const bw = 32
    const bh = 128 / 12
    for (let row = 0; row < 12; row++)
      for (let x = -bw; x < 128; x += bw) {
        const o = (row % 2) * (bw / 2)
        const t = r()
        g.fillStyle = `rgb(${(148 + t * 30) | 0},${(62 + t * 14) | 0},${(46 + t * 10) | 0})`
        g.fillRect(x + o + 1, row * bh + 1, bw - 2, bh - 2)
      }
  })
}
/** 校園地圖看板（示意版面，非真實地圖） */
function mapBoardTexture(): THREE.CanvasTexture {
  return canvasTex(512, 384, g => {
    g.fillStyle = '#f5f3ee'
    g.fillRect(0, 0, 512, 384)
    g.fillStyle = '#b3202f'
    g.fillRect(0, 0, 512, 64)
    g.fillStyle = '#ffffff'
    g.font = 'bold 40px "Noto Sans TC","Noto Sans CJK TC",sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('世新大學 校園導覽圖', 256, 34)
    g.fillStyle = '#cfe0c4'
    g.fillRect(24, 84, 464, 276)
    const r = rand(21)
    const cols = ['#e3b8a6', '#d8d2c6', '#f0d9a6', '#c9d6e2']
    for (let i = 0; i < 16; i++) {
      g.fillStyle = cols[i % 4]
      g.fillRect(40 + r() * 400, 100 + r() * 220, 30 + r() * 50, 20 + r() * 40)
    }
    g.strokeStyle = '#8a8a86'
    g.lineWidth = 6
    g.beginPath()
    g.moveTo(40, 330)
    g.bezierCurveTo(180, 300, 260, 160, 470, 120)
    g.stroke()
    g.fillStyle = '#b3202f'
    g.beginPath()
    g.arc(330, 190, 10, 0, Math.PI * 2)
    g.fill()
  })
}
/** 警衛室牆面：米白腰牆、大片玻璃窗（窗內可見桌面與螢幕的剪影）、綠色窗框 */
function guardWallTexture(door: boolean): THREE.CanvasTexture {
  return canvasTex(256, 160, g => {
    g.fillStyle = '#efe9dc'
    g.fillRect(0, 0, 256, 160)
    g.fillStyle = '#cfc6b4'
    g.fillRect(0, 150, 256, 10)
    const winX = door ? 120 : 16
    const winW = door ? 120 : 224
    const gr = g.createLinearGradient(0, 30, 0, 100)
    gr.addColorStop(0, '#9fb7c2')
    gr.addColorStop(1, '#40525c')
    g.fillStyle = gr
    g.fillRect(winX, 30, winW, 72)
    // 窗內桌面、螢幕剪影
    g.fillStyle = 'rgba(30,36,40,0.7)'
    g.fillRect(winX + 10, 84, winW - 20, 10)
    g.fillRect(winX + winW / 2 - 18, 62, 36, 22)
    g.strokeStyle = '#2f6a4b'
    g.lineWidth = 5
    g.strokeRect(winX, 30, winW, 72)
    g.beginPath()
    for (let x = winX + winW / 3; x < winX + winW - 4; x += winW / 3) {
      g.moveTo(x, 30)
      g.lineTo(x, 102)
    }
    g.stroke()
    if (door) {
      g.fillStyle = '#2f6a4b'
      g.fillRect(24, 22, 72, 128)
      g.fillStyle = '#9fb7c2'
      g.fillRect(34, 32, 52, 50)
      g.fillStyle = '#d8d2c0'
      g.fillRect(80, 92, 6, 14)
    }
  })
}

// ─── 共用 ─────────────────────────────────────────
const M = (() => {
  let m: ReturnType<typeof make> | null = null
  function make() {
    const inc = incisedConcreteTexture('#a4a39e')
    inc.repeat.set(1 / 1.2, 1 / 1.2)
    const incW = incisedConcreteTexture('#e3e1db')
    incW.repeat.set(1 / 1.2, 1 / 1.2)
    const lv = louverTexture()
    lv.repeat.set(1 / 0.6, 1 / 0.6)
    return {
      step: lam(0xb2b1ab),
      nose: lam(0x5d5c58),
      grayWall: lam(0xffffff, { map: inc }),
      whiteWall: lam(0xffffff, { map: incW }),
      white: lam(0xeceae4),
      // 雨遮、天橋板：底面多半背光，略加自發光避免被半球光染成橄欖綠
      slab: lam(0xc9c7c0, { emissive: 0x4a4946 }),
      plinth: lam(0xffffff, { map: plinthTexture() }),
      cornerGray: lam(0x8f908c),
      steel: lam(0xc9ccd1),
      black: lam(0x1d1e20),
      louver: lam(0xffffff, { map: lv, side: THREE.DoubleSide }),
      glass: lam(0x2c3a44),
      terraceTop: lam(0xb8b3aa),
      granite: lam(0x8c8e8b),
      soil: lam(0x4a3a2c),
      podocarpus: lam(0x2c5a2e),
      podocarpus2: lam(0x376b37),
      trunk: lam(0x5b4433),
      magenta: lam(0xc8177a),
    }
  }
  return () => (m ??= make())
})()

/** 大禮堂西牆線上的 2F 高度（相對海拔） */
const Y0 = () => audBase()

// ─── 大禮堂西牆前 ─────────────────────────────────────────
export function addAuditoriumFront(ctx: PlazaCtx): void {
  const W = AUD_WALL_X
  const H = AUD_2F
  const y0 = Y0()
  const yb = y0 - 0.8
  // 大樓梯踏面高度（相對 y0），z −34.6 → −26
  const mainLine = (z: number) => (z < -31 ? ((z + 34.6) / 3.6) * (H / 2) : z < -29.6 ? H / 2 : H / 2 + ((z + 29.6) / 3.6) * (H / 2))
  const pushLine = (a: Vec2, b: Vec2, r: number, step = 0.6) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z)
    const n = Math.max(1, Math.ceil(L / step))
    for (let i = 0; i <= n; i++) ctx.obstacles.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n, r })
  }

  ctx.capture('obj:aud-main-stair', '大禮堂正面大樓梯', '', 'none', () => {
    const m = M()
    const b = new Batch()
    steps(b, m.step, m.nose, 'z', 98.7, 104.3, -34.6, -31.0, y0, y0 + H / 2, 13, yb)
    b.box(m.step, 98.7, 104.3, yb, y0 + H / 2, -31.0, -29.6)
    steps(b, m.step, m.nose, 'z', 98.7, 104.3, -29.6, -26.0, y0 + H / 2, y0 + H, 13, yb)
    // 西側白色矮牆（底端白色方墩），東側灰色矮牆貼大禮堂西牆
    const prof: [number, number][] = [[-34.6, y0 + 1.1], [-31.0, y0 + H / 2 + 1.0], [-29.6, y0 + H / 2 + 1.0], [-26.0, y0 + H + 1.05]]
    sideWall(b, m.whiteWall, 'z', 98.7, 0.4, prof, yb)
    sideWall(b, m.grayWall, 'z', W, 0.3, prof, yb)
    b.box(m.white, 98.2, 98.8, yb, y0 + 1.7, -34.9, -34.3)
    // 中間扶手（不鏽鋼）
    const X = 101.5
    for (let z = -34.3; z <= -26.2; z += 1.15) {
      const h = y0 + mainLine(z)
      b.rod(m.steel, new THREE.Vector3(X, h, z), new THREE.Vector3(X, h + 0.95, z), 0.03)
    }
    const rail = (za: number, zb: number) => b.rod(m.steel, new THREE.Vector3(X, y0 + mainLine(za) + 0.95, za), new THREE.Vector3(X, y0 + mainLine(zb) + 0.95, zb), 0.035)
    rail(-34.4, -31.0)
    rail(-31.0, -29.6)
    rail(-29.6, -26.1)
    b.flush(ctx.scene)
    // 東側：貼牆的斜面格柵（沿樓梯坡度）
    const g = new THREE.BufferGeometry()
    const xg = W - 0.03
    const p = [
      [xg, y0 + 1.4, -34.6],
      [xg, y0 + H + 1.4, -26.0],
      [xg, y0 + H + 2.8, -26.0],
      [xg, y0 + 2.8, -34.6],
    ]
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.flat(), 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 8.6, 0, 8.6, 1.4, 0, 1.4].map(v => v / 0.6), 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    g.computeVertexNormals()
    ctx.scene.add(new THREE.Mesh(g, m.louver))
    // 碰撞：西側矮牆（地面層與樓梯上都擋）
    pushLine({ x: 98.5, z: -34.8 }, { x: 98.5, z: -26.0 }, 0.25)
  })

  ctx.capture('obj:aud-terrace', '大禮堂 2F 入口平台與門廊', '17', 'none', () => {
    const m = M()
    const top = y0 + H
    // 平台量體：土黃勒腳面＋淺色鋪面頂
    const pod = meterBox(W - 98.3, top - yb, 21.9, 3.6)
    const podMesh = new THREE.Mesh(pod, [m.plinth, m.plinth, m.terraceTop, m.plinth, m.plinth, m.plinth])
    podMesh.position.set((98.3 + W) / 2, (top + yb) / 2, (-26.0 + -4.1) / 2)
    podMesh.castShadow = podMesh.receiveShadow = true
    ctx.scene.add(podMesh)
    const b = new Batch()
    // 平台西面高窗帶
    const cl = clerestoryTexture()
    cl.repeat.set(20 / 1.2, 1)
    const clMat = lam(0xffffff, { map: cl })
    b.box(clMat, 98.24, 98.3, y0 + 2.6, y0 + 3.4, -25.0, -5.0)
    b.box(m.cornerGray, 98.18, 98.32, top - 0.3, top, -26.0, -4.1)
    // 白色矮牆（西、南）
    b.box(m.whiteWall, 98.3, 98.7, top, top + 1.05, -26.0, -4.1, 1.2)
    b.box(m.whiteWall, 98.3, 102.5, top, top + 1.05, -4.5, -4.1, 1.2)
    // 方柱門廊
    for (const z of [-24.6, -19.6, -14.6, -9.6, -5.0]) {
      b.box(m.white, 98.75, 99.45, top, top + 5.2, z - 0.35, z + 0.35)
      ctx.obstacles.push({ x: 99.1, z, r: 0.45 })
    }
    // 雨遮（混凝土厚板＋飾帶）
    b.box(m.slab, 97.9, W, top + 5.2, top + 5.8, -26.6, -3.9)
    b.under(97.9, W, -26.6, -3.9, top + 5.2)
    b.box(m.white, 97.9, 98.1, top + 4.9, top + 5.8, -26.6, -3.9)
    // 2F 玻璃門（西牆）
    const dt = doorTexture(6)
    b.box(lam(0xffffff, { map: dt }), W - 0.12, W - 0.02, top, top + 3.2, -21.0, -9.0)
    b.flush(ctx.scene)
    // 直書「大禮堂」（北側第一根方柱北面）與雨遮飾帶上的橫式字樣
    const v = ctx.signPlane(signTexture('大禮堂', { color: '#b3202f', bg: '#f6f3ec', vertical: true, w: 256, h: 768, size: 200 }), 0.62, 1.9)
    v.position.set(99.1, top + 2.6, -24.6 - 0.36)
    v.rotation.y = Math.PI
    ctx.scene.add(v)
    const hs = ctx.signPlane(signTexture('大禮堂', { color: '#b3202f', bg: '#f6f3ec' }), 4.4, 1.0)
    hs.position.set(97.88, top + 5.35, -15.3)
    hs.rotation.y = -Math.PI / 2
    ctx.scene.add(hs)
    // 平台外緣碰撞（地面層由步行高差規則擋住；此處只擋白色矮牆）
    pushLine({ x: 98.5, z: -26.0 }, { x: 98.5, z: -4.3 }, 0.25)
    pushLine({ x: 98.5, z: -4.3 }, { x: 102.4, z: -4.3 }, 0.25)
  })

  ctx.capture('obj:aud-side-stair', '大禮堂西北角側樓梯與天橋', '', 'none', () => {
    const m = M()
    const top = y0 + H
    const b = new Batch()
    // 樓梯腳的廣場比正面大樓梯腳略高：起點取實地高度，級數依 0.16 m 級高換算
    const sh0 = stairH0(STAIR_PARTS.find(s => s.id === 'side-flight')!)
    const nSide = Math.max(4, Math.round((H - sh0) / 0.1615))
    steps(b, m.step, m.nose, 'x', 88.4, 95.9, -49.4, -45.6, y0 + sh0, top, nSide, yb)
    // 平台（下方為實心量體，東面朝通道為黑色百葉門）
    b.box(m.grayWall, 95.9, 100.0, yb, top, -49.4, -41.8, 1.2)
    b.box(m.louver, 100.0, 100.04, y0, y0 + 2.3, -48.6, -47.0, 1)
    b.box(m.louver, 100.0, 100.04, y0, y0 + 2.3, -46.6, -45.0, 1)
    // 天橋（下方通道淨高約 3.6 m）
    b.box(m.slab, 100.0, W, top - 0.6, top, -44.5, -41.8)
    b.under(100.0, W, -44.5, -41.8, top - 0.6)
    // 矮牆：樓梯兩側（斜頂）、平台西／北／東、天橋兩側
    const rise: [number, number][] = [[88.4, y0 + sh0 + 1.05], [95.9, top + 1.05]]
    sideWall(b, m.grayWall, 'x', -45.6, 0.4, [...rise, [96.3, top + 1.05]], yb)
    sideWall(b, m.grayWall, 'x', -49.8, 0.4, [...rise, [100.0, top + 1.05]], yb)
    b.box(m.grayWall, 95.9, 96.3, top, top + 1.05, -45.2, -41.8, 1.2)
    b.box(m.grayWall, 95.9, 100.0, top, top + 1.05, -42.1, -41.8, 1.2)
    b.box(m.grayWall, 99.7, 100.0, top, top + 1.05, -49.4, -44.5, 1.2)
    b.box(m.grayWall, 100.0, W, top - 0.6, top + 1.05, -42.1, -41.8, 1.2)
    b.box(m.grayWall, 100.0, W, top - 0.6, top + 1.05, -44.5, -44.2, 1.2)
    // 不鏽鋼扶手（樓梯中線）
    for (let x = 88.6; x <= 95.8; x += 1.2) {
      const h = y0 + sh0 + ((x - 88.4) / 7.5) * (H - sh0)
      b.rod(m.steel, new THREE.Vector3(x, h, -47.5), new THREE.Vector3(x, h + 0.95, -47.5), 0.03)
    }
    b.rod(m.steel, new THREE.Vector3(88.5, y0 + sh0 + 1.0, -47.5), new THREE.Vector3(95.9, top + 0.95, -47.5), 0.035)
    // 2F 側門＋大型懸挑雨遮
    b.box(lam(0xffffff, { map: doorTexture(2) }), W - 0.12, W - 0.02, top, top + 2.6, -44.0, -42.3)
    b.box(m.slab, 98.6, W, top + 4.4, top + 5.1, -46.4, -40.4)
    b.under(98.6, W, -46.4, -40.4, top + 4.4)
    b.box(m.white, 98.6, W, top + 4.2, top + 5.1, -40.6, -40.4)
    b.box(m.white, 98.6, 98.8, top + 4.2, top + 5.1, -46.4, -40.4)
    b.flush(ctx.scene)
    // 碰撞：沿矮牆（天橋兩側不放，避免擋住下方通道）
    pushLine({ x: 88.4, z: -45.4 }, { x: 96.1, z: -45.4 }, 0.2)
    pushLine({ x: 88.4, z: -49.6 }, { x: 100.0, z: -49.6 }, 0.2)
    pushLine({ x: 96.1, z: -45.2 }, { x: 96.1, z: -41.95 }, 0.2)
    pushLine({ x: 96.1, z: -41.95 }, { x: 99.85, z: -41.95 }, 0.2)
    pushLine({ x: 99.85, z: -49.4 }, { x: 99.85, z: -44.6 }, 0.2)
  })

  ctx.capture('obj:aud-planter', '大禮堂西牆花台與羅漢松', '', 'ground', () => {
    const m = M()
    const g0 = groundHeight(103.8, -37.4)
    const b = new Batch()
    b.box(m.granite, 103.0, W, g0 - 0.3, g0 + 0.75, -39.8, -35.0)
    b.box(m.white, 102.95, W, g0 + 0.75, g0 + 0.82, -39.85, -34.95)
    b.box(m.soil, 103.1, W - 0.05, g0 + 0.82, g0 + 0.86, -39.7, -35.1)
    for (const z of [-39.0, -37.4, -35.8]) {
      const c1 = new THREE.ConeGeometry(0.6, 1.6, 10)
      c1.translate(103.8, g0 + 0.86 + 0.25 + 0.8, z)
      b.add(m.podocarpus, c1)
      const c2 = new THREE.ConeGeometry(0.42, 1.3, 10)
      c2.translate(103.8, g0 + 0.86 + 1.5 + 0.65, z)
      b.add(m.podocarpus2, c2)
      b.rod(m.trunk, new THREE.Vector3(103.8, g0 + 0.86, z), new THREE.Vector3(103.8, g0 + 1.2, z), 0.07)
      ctx.obstacles.push({ x: 103.8, z, r: 0.85 })
    }
    b.flush(ctx.scene)
  })

  ctx.capture('obj:aud-shu', '洋紅色 SHU 立體字', '', 'ground', () => {
    const m = M()
    const g0 = groundHeight(102.3, -37.4)
    const b = new Batch()
    b.box(m.magenta, 102.0, 102.6, g0 - 0.2, g0 + 0.3, -39.2, -35.6)
    const H1 = 1.2
    const s = 0.22
    // 面向西方：觀者左手邊為北（z 較小）
    const seg = (zc: number, u0: number, u1: number, v0: number, v1: number) => b.box(m.magenta, 102.15, 102.45, g0 + 0.3 + v0, g0 + 0.3 + v1, zc - 0.45 + u0, zc - 0.45 + u1)
    const S = -38.6
    seg(S, 0, 0.9, H1 - s, H1)
    seg(S, 0, s, H1 / 2 - s / 2, H1)
    seg(S, 0, 0.9, H1 / 2 - s / 2, H1 / 2 + s / 2)
    seg(S, 0.9 - s, 0.9, 0, H1 / 2 + s / 2)
    seg(S, 0, 0.9, 0, s)
    const Hh = -37.4
    seg(Hh, 0, s, 0, H1)
    seg(Hh, 0.9 - s, 0.9, 0, H1)
    seg(Hh, s, 0.9 - s, H1 / 2 - s / 2, H1 / 2 + s / 2)
    const U = -36.2
    seg(U, 0, s, 0, H1)
    seg(U, 0.9 - s, 0.9, 0, H1)
    seg(U, s, 0.9 - s, 0, s)
    b.flush(ctx.scene)
    for (const z of [S, Hh, U]) ctx.obstacles.push({ x: 102.3, z, r: 0.55 })
  })

  ctx.capture('obj:aud-mapboard', '校園地圖看板（大禮堂樓梯旁）', '', 'ground', () => {
    const m = M()
    const at = { x: 99.7, z: -36.6 }
    const g0 = groundHeight(at.x, at.z)
    const grp = new THREE.Group()
    const b = new Batch()
    for (const sx of [-1, 1]) {
      // 桁架柱：四角細桿＋斜撐
      for (const [ox, oz] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]]) b.rod(m.steel, new THREE.Vector3(sx * 1.0 + ox, 0, oz), new THREE.Vector3(sx * 1.0 + ox, 2.7, oz), 0.022)
      for (let y = 0.2; y < 2.6; y += 0.45) b.rod(m.steel, new THREE.Vector3(sx * 1.0 - 0.1, y, 0.1), new THREE.Vector3(sx * 1.0 + 0.1, y + 0.4, 0.1), 0.012)
    }
    b.rod(m.steel, new THREE.Vector3(-1.1, 2.65, 0), new THREE.Vector3(1.1, 2.65, 0), 0.05)
    b.flush(grp)
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.3, 0.05), [m.white, m.white, m.white, m.white, lam(0xffffff, { map: mapBoardTexture() }), m.white])
    board.position.set(0, 1.75, 0)
    grp.add(board)
    grp.position.set(at.x, g0, at.z)
    // 正面朝西北（廣場）
    grp.rotation.y = Math.atan2(-0.85, -0.53)
    grp.traverse(o => (o.castShadow = true))
    ctx.scene.add(grp)
    ctx.obstacles.push({ x: at.x, z: at.z, r: 0.9 })
  })

  ctx.capture('obj:aud-drain', '大禮堂前截水溝', '', 'none', () => {
    const gt = grateTexture()
    gt.repeat.set(1, 4)
    const grate = lam(0xffffff, { map: gt })
    const curb = lam(0xb9b6b0)
    const b = new Batch()
    for (let z = -41.2; z < -4.6; z += 2) {
      const z1 = Math.min(z + 2, -4.6)
      const h = groundHeight(97.6, (z + z1) / 2)
      b.box(grate, 97.38, 97.82, h - 0.1, h + 0.075, z, z1, 0.5)
      b.box(curb, 97.26, 97.38, h - 0.1, h + 0.09, z, z1)
      b.box(curb, 97.82, 97.94, h - 0.1, h + 0.09, z, z1)
    }
    b.flush(ctx.scene, false)
  })
}

/** 大禮堂立面（掛在建物群組上，隨建物編輯）：土黃勒腳、高窗帶、灰色牆角、紫色直式布條 */
export function addAuditoriumFacade(ctx: Pick<PlazaCtx, 'signPlane'>, g: THREE.Group, b: Building): void {
  const m = M()
  const y0 = Y0()
  const plTop = y0 + 2.95
  const ledge = y0 + AUD_2F
  const pts = b.pts
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    area += p.x * q.z - q.x * p.z
  }
  const cw = area > 0 ? 1 : -1
  const bt = new Batch()
  const cl = clerestoryTexture()
  const clMat = lam(0xffffff, { map: cl })
  const hiddenByTerrace = (p: Vec2) => p.x > 98.0 && p.x < AUD_WALL_X + 0.1 && p.z > -26.2 && p.z < -3.9
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const c = pts[(i + 1) % pts.length]
    const L = Math.hypot(c.x - a.x, c.z - a.z)
    if (L < 1.5) continue
    const t = { x: (c.x - a.x) / L, z: (c.z - a.z) / L }
    // 外法線（依多邊形繞向）
    const n = { x: (t.z * cw) as number, z: (-t.x * cw) as number }
    const mid = { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 }
    if (hiddenByTerrace({ x: mid.x + n.x * 1, z: mid.z + n.z * 1 })) continue
    const yaw = Math.atan2(-t.z, t.x)
    const ybot = Math.min(groundHeight(a.x + n.x, a.z + n.z), groundHeight(c.x + n.x, c.z + n.z)) - 0.6
    bt.boxAt(m.plinth, L, plTop - ybot, 0.26, mid.x + n.x * 0.13, (plTop + ybot) / 2, mid.z + n.z * 0.13, yaw, 3.6)
    const clg = new THREE.BoxGeometry(L - 0.6, 0.85, 0.08)
    const uv = clg.getAttribute('uv') as THREE.BufferAttribute
    for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * ((L - 0.6) / 1.2))
    clg.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(mid.x + n.x * 0.05, plTop + 0.48, mid.z + n.z * 0.05), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)))
    bt.add(clMat, clg)
    bt.boxAt(m.slab, L + 0.3, 0.32, 0.5, mid.x + n.x * 0.24, ledge - 0.16, mid.z + n.z * 0.24, yaw)
    // 牆角灰色方墩
    for (const p of [a, c]) bt.boxAt(m.cornerGray, 0.95, ledge - ybot, 0.95, p.x + n.x * 0.2, (ledge + ybot) / 2, p.z + n.z * 0.2, yaw)
  }
  bt.flush(g)
  // 紫色直式布條（照片 003：「學術菁英 研究創作獎」），掛在西牆北段
  let best: { p: Vec2; n: Vec2; yaw: number } | null = null
  let bd = Infinity
  const want = { x: AUD_WALL_X, z: -38.6 }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const c = pts[(i + 1) % pts.length]
    const L = Math.hypot(c.x - a.x, c.z - a.z)
    if (L < 2) continue
    const t = { x: (c.x - a.x) / L, z: (c.z - a.z) / L }
    const s = Math.max(1, Math.min(L - 1, (want.x - a.x) * t.x + (want.z - a.z) * t.z))
    const p = { x: a.x + t.x * s, z: a.z + t.z * s }
    const d = Math.hypot(p.x - want.x, p.z - want.z)
    if (d < bd) {
      bd = d
      const n = { x: t.z * cw, z: -t.x * cw }
      best = { p, n, yaw: Math.atan2(n.x, n.z) }
    }
  }
  if (best) {
    const ban = ctx.signPlane(signTexture('學術菁英', { color: '#f6d76a', bg: '#5a2a85', vertical: true, w: 256, h: 1024, size: 200 }), 1.5, 6.2)
    ban.position.set(best.p.x + best.n.x * 0.1, y0 + 9.6, best.p.z + best.n.z * 0.1)
    ban.rotation.y = best.yaw
    g.add(ban)
    const sub = ctx.signPlane(signTexture('研究創作獎', { color: '#ffffff', bg: '#5a2a85', vertical: true, w: 256, h: 1024, size: 180 }), 1.2, 5.2)
    sub.position.set(best.p.x + best.n.x * 0.1 + (best.n.z || 0) * 1.6, y0 + 9.2, best.p.z + best.n.z * 0.1 - (best.n.x || 0) * 1.6)
    sub.rotation.y = best.yaw
    g.add(sub)
  }
}

// ─── 學校廣場鋪面 ─────────────────────────────────────────
export function addPlazaPaving(scene: THREE.Scene): void {
  const tex = plazaPavingTexture()
  const mat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  for (const id of ['school-plaza', 'aud-front']) {
    const a = AREAS.find(x => x.id === id)
    if (!a) continue
    const shape = new THREE.Shape(a.pts.map(p => new THREE.Vector2(p.x, -p.z)))
    const flat = new THREE.ShapeGeometry(shape)
    flat.rotateX(-Math.PI / 2)
    const geo = new TessellateModifier(1.6, 12).modify(flat)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, groundHeight(x, z) + 0.05)
      uv[i * 2] = x / 4.8
      uv[i * 2 + 1] = -z / 4.8
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    mesh.renderOrder = 1
    scene.add(mesh)
  }
}

// ─── 八風舞台 ─────────────────────────────────────────
export function addStage(ctx: PlazaCtx): void {
  const C = { x: STAGE.x, z: STAGE.z }
  const y = groundHeight(C.x, C.z)
  // 舞台開口朝學校廣場（西北）
  const plaza = { x: 65, z: -28 }
  const f = { x: plaza.x - C.x, z: plaza.z - C.z }
  const fl = Math.hypot(f.x, f.z)
  const yaw = Math.atan2(-f.x / fl, -f.z / fl)
  const g = new THREE.Group()
  const dark = lam(0x3b3d41)
  const darkWall = lam(0x2b2c30, { side: THREE.DoubleSide })
  const whiteM = lam(0xf5f4ef)
  const rimM = lam(0xe2e0da)
  const A = 5.2
  const B = 4.2
  // 深色基座（橢圓，高 1 m；前緣三級弧形台階）
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.0, 40), dark)
  deck.scale.set(A, 1, B)
  deck.position.y = 0.5
  g.add(deck)
  for (let i = 0; i < 3; i++) {
    const h = (i + 1) / 4
    const st = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.33, 40, 1, false, Math.PI * 0.62, Math.PI * 0.76), dark)
    st.scale.set(A + 0.4 * (3 - i), h / 0.33, B + 0.4 * (3 - i))
    st.position.y = h / 2
    g.add(st)
  }
  // 背側深色弧牆（2.6 m）
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2.6, 40, 1, true, -Math.PI * 0.45, Math.PI * 0.9), darkWall)
  wall.scale.set(A - 0.5, 1, B - 0.5)
  wall.position.y = 1.0 + 1.3
  g.add(wall)
  // 白色柱列（環繞一圈 12 支，前方開口處間距較大）
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 5.0, 10), whiteM)
    col.position.set(Math.sin(a) * (A - 0.6), 1.0 + 2.5, Math.cos(a) * (B - 0.6))
    g.add(col)
  }
  // 白色扁圓碟形頂：上方低拱＋厚邊＋底面
  const RX = 6.3
  const RZ = 5.0
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 10, 0, Math.PI * 2, 0, Math.PI / 2), whiteM)
  dome.scale.set(RX, 0.75, RZ)
  dome.position.y = 6.35
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.4, 48), rimM)
  rim.scale.set(RX, 1, RZ)
  rim.position.y = 6.15
  const under = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0xc4c3be, side: THREE.DoubleSide }))
  under.rotation.x = Math.PI / 2
  under.scale.set(RX - 0.05, RZ - 0.05, 1)
  under.position.y = 5.95
  g.add(dome, rim, under)
  g.traverse(o => {
    o.castShadow = true
    o.receiveShadow = true
  })
  g.position.set(C.x, y, C.z)
  g.rotation.y = yaw
  ctx.scene.add(g)
  // 碰撞：基座橢圓以三個圓近似
  const sx = { x: Math.cos(yaw), z: -Math.sin(yaw) }
  for (const k of [-1, 0, 1]) ctx.obstacles.push({ x: C.x + sx.x * k * 2.4, z: C.z + sx.z * k * 2.4, r: k === 0 ? 4.2 : 3.2 })
}

// ─── 後校門與警衛室 ─────────────────────────────────────────
export function addBackGate(ctx: PlazaCtx): void {
  const y = groundHeight(BACK_GATE.x, BACK_GATE.z)
  const len = Math.hypot(BACK_GATE.dir.x, BACK_GATE.dir.z)
  const d = { x: BACK_GATE.dir.x / len, z: BACK_GATE.dir.z / len }
  const perp = { x: -d.z, z: d.x }
  const g = new THREE.Group()
  const bt = redBrickTexture()
  const brick = lam(0xffffff, { map: bt })
  const stone = lam(0xd9d3c8)
  const iron = lam(0x17181a)
  const glow = new THREE.MeshLambertMaterial({ color: 0xfff1c9, emissive: 0xffd98a, emissiveIntensity: 0.5 })
  const b = new Batch()
  for (const s of [-1, 1]) {
    const x = s * 3.45
    // 紅磚柱＋石帽
    b.add(brick, (() => {
      const geo = meterBox(0.9, 2.9, 0.9, 0.92)
      geo.translate(x, 1.45, 0)
      return geo
    })())
    b.box(stone, x - 0.55, x + 0.55, 2.9, 3.08, -0.55, 0.55)
    b.box(stone, x - 0.42, x + 0.42, 3.08, 3.2, -0.42, 0.42)
    // 柱頂黑色古典燈：短柱＋燈籠（四角框、暖光玻璃、尖頂）
    b.rod(iron, new THREE.Vector3(x, 3.2, 0), new THREE.Vector3(x, 3.75, 0), 0.07, 8)
    b.box(iron, x - 0.22, x + 0.22, 3.75, 3.82, -0.22, 0.22)
    b.box(glow, x - 0.16, x + 0.16, 3.82, 4.3, -0.16, 0.16)
    for (const [ox, oz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) b.box(iron, x + ox - 0.025, x + ox + 0.025, 3.82, 4.3, oz - 0.025, oz + 0.025)
    const cap = new THREE.ConeGeometry(0.3, 0.32, 4)
    cap.rotateY(Math.PI / 4)
    cap.translate(x, 4.46, 0)
    b.add(iron, cap)
    b.rod(iron, new THREE.Vector3(x, 4.6, 0), new THREE.Vector3(x, 4.78, 0), 0.025)
    // 黑色鐵門扇（白天往校內開，靠在柱內側）
    const hinge = { x: s * 3.0, z: 0.2 }
    const leafW = 2.9
    // 門扇沿 +z（校內）方向展開，略向開口內斜
    const ux = -s * Math.sin(0.12)
    const uz = Math.cos(0.12)
    const along = (t: number) => ({ x: hinge.x + ux * t, z: hinge.z + uz * t })
    const top = 1.95
    const P0 = along(0)
    const P1 = along(leafW)
    b.rod(iron, new THREE.Vector3(P0.x, 0.12, P0.z), new THREE.Vector3(P1.x, 0.12, P1.z), 0.03)
    b.rod(iron, new THREE.Vector3(P0.x, top, P0.z), new THREE.Vector3(P1.x, top, P1.z), 0.03)
    b.rod(iron, new THREE.Vector3(P0.x, 1.0, P0.z), new THREE.Vector3(P1.x, 1.0, P1.z), 0.02)
    for (let t = 0; t <= leafW + 1e-3; t += 0.13) {
      const P = along(t)
      b.rod(iron, new THREE.Vector3(P.x, 0.05, P.z), new THREE.Vector3(P.x, top + 0.18, P.z), 0.014, 5)
      const tip = new THREE.ConeGeometry(0.035, 0.12, 4)
      tip.translate(P.x, top + 0.24, P.z)
      b.add(iron, tip)
    }
  }
  b.flush(g)
  // 門牌（東柱外側）
  const plate = ctx.signPlane(signTexture('世新大學', { color: '#2b2b2b', bg: '#e9e2d4', vertical: true, w: 256, h: 768, size: 170 }), 0.42, 1.3)
  plate.position.set(3.45, 1.7, -0.46)
  plate.rotation.y = Math.PI
  g.add(plate)
  g.traverse(o => (o.castShadow = true))
  g.position.set(BACK_GATE.x, y, BACK_GATE.z)
  g.rotation.y = Math.atan2(perp.x, perp.z) - Math.PI / 2
  ctx.scene.add(g)
  for (const s of [-1, 1]) ctx.obstacles.push({ x: BACK_GATE.x + perp.x * s * 3.45, z: BACK_GATE.z + perp.z * s * 3.45, r: 0.7 })
}

export function addGuardHouse(ctx: PlazaCtx): void {
  const G = PLAZA_SURVEY.guardHouse
  const y = groundHeight(G.x, G.z)
  const g = new THREE.Group()
  const wallH = 2.7
  const plinth = lam(0x9a9790)
  const wallN = lam(0xffffff, { map: guardWallTexture(false) })
  const wallD = lam(0xffffff, { map: guardWallTexture(true) })
  const base = new THREE.Mesh(new THREE.BoxGeometry(G.w + 0.3, 0.32, G.d + 0.3), plinth)
  base.position.y = 0.06
  // 方塊面順序：+x、−x、+y、−y、+z、−z；門開在 +x（朝後校門通道）
  const body = new THREE.Mesh(new THREE.BoxGeometry(G.w, wallH, G.d), [wallD, wallN, lam(0xd9d4c8), lam(0xd9d4c8), wallN, wallN])
  body.position.y = 0.22 + wallH / 2
  // 綠色四角攢尖頂（出簷 0.6 m）＋簷板＋寶頂
  const RW = G.w + 1.2
  const RD = G.d + 1.2
  const roofGeo = new THREE.ConeGeometry(1, 1, 4, 1)
  roofGeo.rotateY(Math.PI / 4)
  roofGeo.scale(RW / Math.SQRT2, 1.7, RD / Math.SQRT2)
  const roof = new THREE.Mesh(roofGeo, lam(0x2f7a4c, { flatShading: true }))
  roof.position.y = 0.22 + wallH + 0.18 + 0.85
  const eave = new THREE.Mesh(new THREE.BoxGeometry(RW, 0.18, RD), lam(0x245f3b))
  eave.position.y = 0.22 + wallH + 0.09
  const fin = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), lam(0x245f3b))
  fin.position.y = 0.22 + wallH + 0.18 + 1.7 + 0.05
  const sign = ctx.signPlane(signTexture('警衛室', { color: '#ffffff', bg: '#2f6a4b' }), 1.3, 0.4)
  sign.position.set(G.w / 2 + 0.02, 0.22 + wallH - 0.32, -0.9)
  sign.rotation.y = Math.PI / 2
  g.add(base, body, roof, eave, fin, sign)
  g.traverse(o => {
    o.castShadow = true
    o.receiveShadow = true
  })
  g.position.set(G.x, y, G.z)
  g.rotation.y = G.rot
  ctx.scene.add(g)
  const ux = { x: Math.cos(G.rot), z: -Math.sin(G.rot) }
  const uz = { x: Math.sin(G.rot), z: Math.cos(G.rot) }
  for (const a of [-1, 1])
    for (const c of [-1, 1]) ctx.obstacles.push({ x: G.x + ux.x * a * 1.25 + uz.x * c * 0.85, z: G.z + ux.z * a * 1.25 + uz.z * c * 0.85, r: 1.25 })
}

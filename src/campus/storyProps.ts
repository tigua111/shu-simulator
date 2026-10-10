import * as THREE from 'three'
import { ADM_DIR, GATE_NORMAL, TUNNEL, admFace, groundHeight } from './data'
import { routeLength, samplePath, type Obstacle } from './geometry'
import type { PlazaCtx } from './audPlaza'
import { makePerson, makePistol, makeStool, type Person } from './people'
import { Audi, CAR_L } from './car'
import type { Vec2 } from './data'

/** 言論廣場成舍我銅像（world.ts obj:yanlun-statue）：位置與朝向，正面＝本地 +z */
export const STATUE = { x: -56, z: -47, yaw: 0.5 }
/** 投影輪播文字（使用者 2026-10-10 指定） */
export const PROJECTION_LINES = ['ＫＴＶ大學', '你再問一次 我還是會回答一樣的', '剪映大學', '噴泉大學', '沒有ＰＲ可以用剪映啊', '美圖秀秀大學', '沒系辦大學', '我們不是adobe的股東', 'canva大學']

export interface StoryProps {
  guard: { person: Person; pistol: THREE.Group; holster: THREE.Object3D; muzzle: THREE.Object3D; home: THREE.Vector3; homeYaw: number; obstacle: Obstacle } | null
  projector: { person: Person; screen: THREE.Mesh; beam: THREE.Mesh; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } | null
  protest: { speaker: Person; left: Person; right: Person; bubbleAnchor: THREE.Object3D } | null
  car: { audi: Audi; roofAnchor: THREE.Object3D } | null
  lift: { doors: THREE.Mesh[]; buttons: THREE.Mesh[]; anchor: THREE.Object3D } | null
}

const CJK = '"PingFang TC","Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei",sans-serif'

function yawFacing(dx: number, dz: number): number {
  return Math.atan2(dx, dz)
}
function lambert(color: number, extra: THREE.MeshLambertMaterialParameters = {}): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, ...extra })
}
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}
/** 依寬度自動縮放字級的多行文字 */
function fitText(g: CanvasRenderingContext2D, lines: string[], cx: number, cy: number, maxW: number, maxH: number, weight = 900): void {
  let size = Math.floor(maxH / lines.length / 1.18)
  g.font = `${weight} ${size}px ${CJK}`
  const widest = Math.max(...lines.map(l => g.measureText(l).width))
  if (widest > maxW) size = Math.floor((size * maxW) / widest)
  g.font = `${weight} ${size}px ${CJK}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const lh = size * 1.18
  lines.forEach((l, i) => g.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * lh))
}

// ─── 前校門警衛 ─────────────────────────────────────────
/** 拱門內 1.2 m、偏右 1.5 m 站崗，面向木柵路 */
export function guardHome(): { p: Vec2; yaw: number } {
  const a = TUNNEL.pts[0]
  const n = GATE_NORMAL
  const tan = { x: n.z, z: -n.x }
  return { p: { x: a.x + n.x * 1.2 + tan.x * 1.5, z: a.z + n.z * 1.2 + tan.z * 1.5 }, yaw: yawFacing(-n.x, -n.z) }
}
function addGuard(ctx: PlazaCtx, out: StoryProps): void {
  ctx.capture('obj:gate-guard', '前校門警衛', '', 'ground', () => {
    const { p, yaw } = guardHome()
    const person = makePerson({ shirt: 0x8fb0d4, pants: 0x1f2a3d, shoes: 0x111111, cap: 0x1f2a3d, belt: 0x141414, skin: 0xd9a983 })
    // 肩章、胸前名牌
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.01), lambert(0xd8b23a))
    badge.position.set(-0.09, 1.43, 0.13)
    person.body.add(badge)
    // 右腰槍套（握把外露）
    const holster = new THREE.Group()
    const case_ = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.12), lambert(0x111214))
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.08, 0.05), lambert(0x222326))
    grip.position.y = 0.11
    holster.add(case_, grip)
    holster.position.set(0.215, 0.9, 0.02)
    person.body.add(holster)
    // 手中的手槍（平時隱藏）
    const pistol = makePistol()
    pistol.rotation.x = Math.PI / 2
    pistol.position.set(0, -0.04, 0.02)
    pistol.visible = false
    person.handR.add(pistol)
    const muzzle = new THREE.Object3D()
    muzzle.position.set(0, 0.03, 0.17)
    pistol.add(muzzle)
    // 雙手背在身後（稍息）
    person.shoulderL.rotation.x = 0.25
    person.shoulderR.rotation.x = 0.25
    person.elbowL.rotation.x = -0.5
    person.elbowR.rotation.x = -0.5
    person.root.position.set(p.x, groundHeight(p.x, p.z) + 0.04, p.z)
    person.root.rotation.y = yaw
    person.root.traverse(o => (o.castShadow = true))
    ctx.scene.add(person.root)
    const obstacle: Obstacle = { x: p.x, z: p.z, r: 0.35 }
    ctx.obstacles.push(obstacle)
    out.guard = { person, pistol, holster, muzzle, home: person.root.position.clone(), homeYaw: yaw, obstacle }
  })
}

// ─── 隧道盡頭的投影人 ─────────────────────────────────────
function addProjector(ctx: PlazaCtx, out: StoryProps): void {
  ctx.capture('obj:tunnel-projector', '隧道投影（投影機與天花板文字）', '', 'none', () => {
    const P = TUNNEL.pts
    const L = routeLength(P)
    const sText = L - 12
    const sPerson = L - 3.4
    const R = 3.3
    const BASE = 4.6
    const ALPHA = 0.74
    const HALF = 1.45
    // 天花板上的弧形投影面：沿隧道折線取樣，貼著拱頂內側
    const NU = 18
    const NV = 8
    const pos: number[] = []
    const uv: number[] = []
    const idx: number[] = []
    for (let j = 0; j <= NV; j++) {
      const s = sText - HALF + (2 * HALF * j) / NV
      const { p, dir } = samplePath(P, s)
      const side = { x: -dir.z, z: dir.x }
      const y0 = groundHeight(p.x, p.z) + BASE
      for (let i = 0; i <= NU; i++) {
        const u = i / NU
        const th = Math.PI / 2 + ALPHA - 2 * ALPHA * u
        const lat = R * Math.cos(th)
        pos.push(p.x + side.x * lat, y0 + R * Math.sin(th), p.z + side.z * lat)
        // 文字上緣朝隧道入口（走進來的人抬頭看時近端在畫面上方）
        uv.push(u, 1 - j / NV)
      }
    }
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const a = j * (NU + 1) + i
        const b = a + 1
        const c = a + NU + 1
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    sg.setIndex(idx)
    sg.computeVertexNormals()
    const c = document.createElement('canvas')
    c.width = 1024
    c.height = 600
    const g = c.getContext('2d')!
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const screen = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, opacity: 1 }))
    screen.renderOrder = 3
    ctx.scene.add(screen)
    drawProjection(g, PROJECTION_LINES[0])
    tex.needsUpdate = true
    // 投影人：站在出口前靠牆，面向隧道入口、雙手捧投影機朝上
    const { p, dir } = samplePath(P, sPerson)
    const side = { x: -dir.z, z: dir.x }
    const pp = { x: p.x + side.x * 2.0, z: p.z + side.z * 2.0 }
    const gy = groundHeight(pp.x, pp.z)
    const person = makePerson({ shirt: 0x5d6470, sleeve: 0x5d6470, pants: 0x2f3e5c, shoes: 0xe8e8e8, hair: 0x241c18 })
    person.root.position.set(pp.x, gy, pp.z)
    const center = samplePath(P, sText).p
    const cy = groundHeight(center.x, center.z) + BASE + R
    person.root.rotation.y = yawFacing(center.x - pp.x, center.z - pp.z)
    person.shoulderL.rotation.x = -1.25
    person.shoulderR.rotation.x = -1.25
    person.shoulderL.rotation.z = -0.3
    person.shoulderR.rotation.z = 0.3
    person.elbowL.rotation.x = -0.55
    person.elbowR.rotation.x = -0.55
    person.head.rotation.x = -0.35
    person.root.traverse(o => (o.castShadow = true))
    ctx.scene.add(person.root)
    ctx.obstacles.push({ x: pp.x, z: pp.z, r: 0.4 })
    // 投影機：白色機身＋鏡頭，對準投影面中心
    person.root.updateMatrixWorld(true)
    const hands = new THREE.Vector3()
    person.handL.getWorldPosition(hands)
    const hr = new THREE.Vector3()
    person.handR.getWorldPosition(hr)
    hands.add(hr).multiplyScalar(0.5)
    const proj = new THREE.Group()
    const bodyM = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.11, 0.24), lambert(0xe9e9e6))
    const lensM = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 14), lambert(0x1a1c20))
    lensM.rotation.x = Math.PI / 2
    lensM.position.set(0.06, 0, 0.14)
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.038, 14), new THREE.MeshBasicMaterial({ color: 0xdff6ff, toneMapped: false }))
    glow.position.set(0.06, 0, 0.166)
    proj.add(bodyM, lensM, glow)
    proj.position.copy(hands).add(new THREE.Vector3(0, 0.08, 0))
    const target = new THREE.Vector3(center.x, cy, center.z)
    proj.lookAt(target)
    ctx.scene.add(proj)
    // 光束：鏡頭到投影面四角的淡藍色光錐
    proj.updateMatrixWorld(true)
    const lens = new THREE.Vector3(0.06, 0, 0.17).applyMatrix4(proj.matrixWorld)
    const corner = (u: number, v: number) => {
      const i = Math.round(u * NU)
      const j = Math.round((1 - v) * NV)
      const k = (j * (NU + 1) + i) * 3
      return new THREE.Vector3(pos[k], pos[k + 1], pos[k + 2])
    }
    const C = [corner(0.12, 0.15), corner(0.88, 0.15), corner(0.88, 0.85), corner(0.12, 0.85)]
    const bp: number[] = []
    for (let k = 0; k < 4; k++) {
      const a = C[k]
      const b = C[(k + 1) % 4]
      bp.push(lens.x, lens.y, lens.z, a.x, a.y, a.z, b.x, b.y, b.z)
    }
    const bg = new THREE.BufferGeometry()
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3))
    const beam = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }))
    beam.renderOrder = 2
    ctx.scene.add(beam)
    out.projector = { person, screen, beam, ctx: g, tex }
  })
}
/** 投影文字：亮青白字＋藍色光暈＋淡淡的投影框 */
export function drawProjection(g: CanvasRenderingContext2D, text: string): void {
  const { width: W, height: H } = g.canvas
  g.clearRect(0, 0, W, H)
  const grd = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.55)
  grd.addColorStop(0, 'rgba(150,220,255,0.30)')
  grd.addColorStop(1, 'rgba(150,220,255,0.0)')
  g.fillStyle = grd
  g.fillRect(W * 0.08, H * 0.12, W * 0.84, H * 0.76)
  const lines = text.includes(' ') ? text.split(' ') : [text]
  g.save()
  g.shadowColor = 'rgba(20,150,255,0.95)'
  g.shadowBlur = 26
  g.fillStyle = '#f2fdff'
  fitText(g, lines, W / 2, H / 2, W * 0.8, H * (lines.length > 1 ? 0.62 : 0.42))
  g.shadowBlur = 8
  g.shadowColor = 'rgba(0,40,90,0.9)'
  fitText(g, lines, W / 2, H / 2, W * 0.8, H * (lines.length > 1 ? 0.62 : 0.42))
  g.restore()
}

// ─── 言論廣場：銅像前的演講三人組＋海報 ─────────────────────────
function statueFrame(): { f: Vec2; l: Vec2; at: (fw: number, lat: number) => Vec2 } {
  const f = { x: Math.sin(STATUE.yaw), z: Math.cos(STATUE.yaw) }
  const l = { x: f.z, z: -f.x }
  return { f, l, at: (fw, lat) => ({ x: STATUE.x + f.x * fw + l.x * lat, z: STATUE.z + f.z * fw + l.z * lat }) }
}
function placard(text: string, color: string): THREE.Group {
  const g = new THREE.Group()
  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.9, 0.03), lambert(0x8b6a48))
  stick.position.y = 0.45
  const tex = canvasTexture(512, 256, x => {
    x.fillStyle = '#fbf7ee'
    x.fillRect(0, 0, 512, 256)
    x.fillStyle = color
    fitText(x, [text], 256, 128, 470, 150)
  })
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.34, 0.015), [lambert(0xeeeeee), lambert(0xeeeeee), lambert(0xeeeeee), lambert(0xeeeeee), new THREE.MeshLambertMaterial({ map: tex }), lambert(0xe2ded4)])
  board.position.y = 0.95
  g.add(stick, board)
  return g
}
function addProtest(ctx: PlazaCtx, out: StoryProps): void {
  const { f, l, at } = statueFrame()
  const yaw = yawFacing(f.x, f.z)
  ctx.capture('obj:yanlun-protest', '言論廣場演講三人組', '', 'ground', () => {
    const c = at(4.4, 0)
    const y = groundHeight(c.x, c.z)
    const stool = makeStool()
    stool.position.set(c.x, y, c.z)
    stool.rotation.y = yaw
    ctx.scene.add(stool)
    const speaker = makePerson({ shirt: 0xb8282f, pants: 0x22252b, shoes: 0x2b2b2b, hair: 0x1a1512 })
    speaker.root.position.set(c.x, y + 0.45, c.z)
    speaker.root.rotation.y = yaw
    // 左手拿著講稿
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.29), new THREE.MeshLambertMaterial({ color: 0xf7f5ee, side: THREE.DoubleSide }))
    paper.position.set(0, -0.1, 0.06)
    paper.rotation.set(-0.9, 0, 0)
    speaker.handL.add(paper)
    speaker.shoulderL.rotation.x = -0.95
    speaker.elbowL.rotation.x = -1.0
    ctx.scene.add(speaker.root)
    const side = (lat: number, st: { shirt: number; pants: number; hair: number }, text: string, color: string) => {
      const p = at(4.1, lat)
      const pr = makePerson({ ...st, shoes: 0x303030 })
      pr.root.position.set(p.x, groundHeight(p.x, p.z), p.z)
      pr.root.rotation.y = yaw + (lat > 0 ? -0.25 : 0.25)
      const pc = placard(text, color)
      // 手的本地 -y 是手臂伸出方向（舉高時朝上）：牌子翻轉後由手握住木棍下段
      pc.rotation.x = Math.PI
      pc.position.set(0, 0.22, 0)
      pr.handR.add(pc)
      pr.shoulderR.rotation.x = -2.8
      pr.elbowR.rotation.x = 0.1
      ctx.scene.add(pr.root)
      ctx.obstacles.push({ x: p.x, z: p.z, r: 0.4 })
      return pr
    }
    const left = side(-1.45, { shirt: 0x26282d, pants: 0x3b4a66, hair: 0x15110f }, '還我試拍檔期', '#b3121f')
    const right = side(1.45, { shirt: 0x3e5f8a, pants: 0x2a2c30, hair: 0x2a1f19 }, '荒謬世新大學', '#16181c')
    for (const pr of [speaker, left, right]) pr.root.traverse(o => (o.castShadow = true))
    ctx.obstacles.push({ x: c.x, z: c.z, r: 0.45 })
    const bubbleAnchor = new THREE.Object3D()
    // 泡泡放在講者右上方，不擋住後方海報
    bubbleAnchor.position.set(-0.75, 2.2, 0)
    speaker.root.add(bubbleAnchor)
    out.protest = { speaker, left, right, bubbleAnchor }
  })
  // 銅像後方的海報看板（立柱＋紙本海報）
  ctx.capture('obj:yanlun-poster', '銅像後方海報「荒謬世新大學，還我試拍檔期」', '', 'ground', () => {
    // 緊貼銅像後方、比樹冠低（兩側樹冠下緣約 3.5 m，海報中心 3.2 m）
    const c = at(-2.1, 0)
    const y = groundHeight(c.x, c.z)
    const g = new THREE.Group()
    const pole = lambert(0x1d1f22)
    for (const sx of [-1.85, 1.85]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.09, 4.05, 0.09), pole)
      m.position.set(sx, 2.025, -0.06)
      g.add(m)
    }
    const backer = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.75, 0.05), lambert(0x2c2e31))
    backer.position.set(0, 3.2, -0.06)
    const tex = canvasTexture(1024, 448, x => {
      x.fillStyle = '#f6f1e4'
      x.fillRect(0, 0, 1024, 448)
      // 紙張陰影與膠帶
      x.fillStyle = 'rgba(0,0,0,0.05)'
      for (let i = 0; i < 40; i++) x.fillRect(Math.random() * 1024, Math.random() * 448, 2, 30 + Math.random() * 80)
      x.fillStyle = 'rgba(230,216,160,0.85)'
      for (const [tx, ty, r] of [
        [40, 30, -0.5],
        [984, 30, 0.5],
        [40, 418, 0.5],
        [984, 418, -0.5],
      ]) {
        x.save()
        x.translate(tx, ty)
        x.rotate(r)
        x.fillRect(-55, -16, 110, 32)
        x.restore()
      }
      x.fillStyle = '#b3121f'
      fitText(x, ['荒謬世新大學，'], 512, 140, 900, 170)
      x.fillStyle = '#17181b'
      fitText(x, ['還我試拍檔期'], 512, 315, 900, 170)
    })
    // 背光面也看得清楚：以同一張貼圖做微弱自發光
    const poster = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.55), new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 }))
    poster.position.set(0, 3.2, -0.03)
    g.add(backer, poster)
    g.traverse(o => (o.castShadow = true))
    g.position.set(c.x, y, c.z)
    g.rotation.y = yaw
    ctx.scene.add(g)
    for (const sx of [-2.35, 2.35]) ctx.obstacles.push({ x: c.x + l.x * sx, z: c.z + l.z * sx, r: 0.15 })
  })
}

/** 銅像腳上的鐵鍊與大鎖（加進 obj:yanlun-statue 群組，座標為銅像本地） */
export function addStatueChain(g: THREE.Group): void {
  const link = new THREE.TorusGeometry(0.05, 0.014, 6, 10)
  const steel = new THREE.MeshPhongMaterial({ color: 0x7a7d82, specular: 0xbbbbbb, shininess: 70 })
  const geos: THREE.BufferGeometry[] = []
  const m4 = new THREE.Matrix4()
  const X = new THREE.Vector3(1, 0, 0)
  const ONE = new THREE.Vector3(1, 1, 1)
  // 環面在 XY 平面、沿 x 拉長成橢圓鏈環
  link.scale(1.35, 1, 1)
  const place = (pts: THREE.Vector3[], step = 0.085) => {
    let n = 0
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const d = b.clone().sub(a)
      const len = d.length()
      d.normalize()
      for (let t = 0; t < len; t += step) {
        const p = a.clone().addScaledVector(d, t)
        // 鏈環長軸對齊走向，相鄰環繞走向轉 90°
        const align = new THREE.Quaternion().setFromUnitVectors(X, d)
        const roll = new THREE.Quaternion().setFromAxisAngle(d, (n++ % 2) * (Math.PI / 2))
        m4.compose(p, roll.multiply(align), ONE)
        geos.push(link.clone().applyMatrix4(m4))
      }
    }
  }
  // 腳踝兩圈
  for (const [y, r] of [
    [1.4, 0.5],
    [1.55, 0.47],
  ]) {
    const ring: THREE.Vector3[] = []
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2
      ring.push(new THREE.Vector3(-0.6 + Math.cos(a) * r, y + Math.sin(a * 3) * 0.015, Math.sin(a) * r))
    }
    place(ring)
  }
  // 往前垂到基座兩角的鐵環
  place([new THREE.Vector3(-0.25, 1.4, 0.4), new THREE.Vector3(0.6, 1.33, 1.33), new THREE.Vector3(0.9, 0.74, 1.45), new THREE.Vector3(1.9, 0.73, 1.68)])
  place([new THREE.Vector3(-0.95, 1.4, 0.4), new THREE.Vector3(-1.5, 1.33, 1.33), new THREE.Vector3(-1.6, 0.74, 1.45), new THREE.Vector3(-2.2, 0.73, 1.68)])
  const merged = mergeAll(geos)
  const chain = new THREE.Mesh(merged, steel)
  chain.castShadow = true
  g.add(chain)
  // 大鎖頭
  const lock = new THREE.Group()
  const bodyL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.06), new THREE.MeshPhongMaterial({ color: 0xb08d3c, specular: 0xffe7a0, shininess: 60 }))
  const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 12, Math.PI), steel)
  shackle.position.y = 0.065
  lock.add(bodyL, shackle)
  lock.position.set(-0.6, 1.3, 0.54)
  g.add(lock)
  for (const [x, z] of [
    [1.9, 1.68],
    [-2.2, 1.68],
  ]) {
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.016, 6, 12), steel)
    eye.rotation.x = Math.PI / 2
    eye.position.set(x, 0.72, z)
    g.add(eye)
  }
}
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0
  let itotal = 0
  for (const g of geos) {
    total += g.getAttribute('position').count
    itotal += g.index ? g.index.count : 0
  }
  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  const idx = new Uint32Array(itotal)
  let o = 0
  let io = 0
  for (const g of geos) {
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    pos.set(p.array as Float32Array, o * 3)
    nor.set(n.array as Float32Array, o * 3)
    if (g.index) {
      const a = g.index.array
      for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + o
      io += a.length
    }
    o += p.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

// ─── 舍我樓一樓電梯 ───────────────────────────────────────
/** 穿堂南牆（z=-33，面朝北）東段：兩部不鏽鋼電梯、叫車按鈕、樓層顯示 */
export const LIFT_SPOT = { x: 13.55, z: -34.1 }
function addLift(ctx: PlazaCtx, out: StoryProps): void {
  ctx.capture('obj:SE-lift', '舍我樓一樓電梯', '', 'ground', () => {
    const Z = -33.0
    const y = groundHeight(13.55, -33.6)
    const g = new THREE.Group()
    const steel = new THREE.MeshPhongMaterial({ color: 0xb7bcc2, specular: 0xdddddd, shininess: 60 })
    const frame = new THREE.MeshPhongMaterial({ color: 0x8e9399, specular: 0xaaaaaa, shininess: 40 })
    const doors: THREE.Mesh[] = []
    for (const x of [12.75, 14.35]) {
      const fr = new THREE.Mesh(new THREE.BoxGeometry(1.36, 2.52, 0.06), frame)
      fr.position.set(x, 1.26, Z - 0.03)
      g.add(fr)
      for (const sx of [-1, 1]) {
        const d = new THREE.Mesh(new THREE.BoxGeometry(0.575, 2.2, 0.03), steel)
        d.position.set(x + sx * 0.29, 1.12, Z - 0.075)
        d.userData.home = d.position.x
        d.userData.dir = sx
        doors.push(d)
        g.add(d)
      }
      // 樓層顯示（紅色數字）
      const tex = canvasTexture(128, 48, x2 => {
        x2.fillStyle = '#0d0e10'
        x2.fillRect(0, 0, 128, 48)
        x2.fillStyle = '#ff3b2f'
        x2.font = 'bold 36px Arial, sans-serif'
        x2.textAlign = 'center'
        x2.textBaseline = 'middle'
        x2.fillText('▲ 1', 64, 26)
      })
      const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.16), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }))
      disp.position.set(x, 2.68, Z - 0.065)
      disp.rotation.y = Math.PI
      g.add(disp)
    }
    // 叫車按鈕
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.025), frame)
    panel.position.set(13.55, 1.15, Z - 0.07)
    g.add(panel)
    const buttons: THREE.Mesh[] = []
    for (const dy of [0.06, -0.06]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), new THREE.MeshLambertMaterial({ color: 0xd8d8d8, emissive: 0x000000 }))
      b.rotation.x = Math.PI / 2
      b.position.set(13.55, 1.15 + dy, Z - 0.09)
      buttons.push(b)
      g.add(b)
    }
    const signTex = canvasTexture(512, 96, x2 => {
      x2.fillStyle = '#2f3438'
      x2.fillRect(0, 0, 512, 96)
      x2.fillStyle = '#f4f1ea'
      fitText(x2, ['電梯　ELEVATOR'], 256, 50, 460, 70, 700)
    })
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.26), new THREE.MeshLambertMaterial({ map: signTex }))
    sign.position.set(13.55, 3.05, Z - 0.05)
    sign.rotation.y = Math.PI
    g.add(sign)
    // 門前深色地墊
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), new THREE.MeshLambertMaterial({ color: 0x3a3634, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }))
    mat.rotation.x = -Math.PI / 2
    mat.position.set(13.55, 0.02, Z - 0.75)
    g.add(mat)
    const anchor = new THREE.Object3D()
    anchor.position.set(LIFT_SPOT.x, 2.2, Z - 0.6)
    g.add(anchor)
    // 穿堂地磚比地面高 0.14 m
    g.position.y = y + 0.14
    ctx.scene.add(g)
    out.lift = { doors, buttons, anchor }
  })
}

// ─── 行政大樓斜坡頂的董事會專車 ───────────────────────────────
export const CAR_SPOT = { t: 31.5, off: 7.0 }
function addCar(ctx: PlazaCtx, out: StoryProps): void {
  ctx.capture('obj:adm-audi', '董事會專車（黑色奧迪）', '', 'ground', () => {
    const p = admFace(CAR_SPOT.t, CAR_SPOT.off)
    const audi = new Audi()
    audi.root.position.set(p.x, groundHeight(p.x, p.z) + 0.02, p.z)
    audi.root.rotation.y = Math.atan2(-ADM_DIR.z, ADM_DIR.x)
    ctx.scene.add(audi.root)
    const roofAnchor = new THREE.Object3D()
    roofAnchor.position.set(0, 2.15, 0)
    audi.root.add(roofAnchor)
    const obs: Obstacle[] = []
    for (let k = -2; k <= 2; k++) {
      const x = (k / 2) * (CAR_L / 2 - 0.85)
      obs.push({ x: p.x + ADM_DIR.x * x, z: p.z + ADM_DIR.z * x, r: 1.0 })
    }
    ctx.obstacles.push(...obs)
    out.car = { audi, roofAnchor }
  })
}

export function addStoryProps(ctx: PlazaCtx): StoryProps {
  const out: StoryProps = { guard: null, projector: null, protest: null, car: null, lift: null }
  addGuard(ctx, out)
  addProjector(ctx, out)
  addProtest(ctx, out)
  addLift(ctx, out)
  addCar(ctx, out)
  return out
}

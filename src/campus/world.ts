import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import {
  BACK_GATE,
  BUILDINGS,
  COURT,
  DESTINATION,
  GATE,
  LANDMARKS,
  LANES,
  PLAZAS,
  ROUTE,
  STAGE,
  TRACK,
  baseHeight,
  smoothstep,
  type Building,
  type Landmark,
  type Vec2,
} from './data'
import { buildingCorners, distToPolygonEdge, distToPolyline, insideBuilding, pointInPolygon, samplePath, routeLength, type Obstacle } from './geometry'
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

const NAMED = BUILDINGS.filter(b => b.num)

/** 地形：校內依坡道高度，校外為逐漸升高的山坡（建築腳下壓平）。 */
export function terrainHeight(x: number, z: number): number {
  const p = { x, z }
  const base = baseHeight(z)
  if (pointInPolygon(p)) return base
  let hill = Math.min(distToPolygonEdge(p) * 0.5, 24) * smoothstep(158, 150, z)
  if (hill > 0) {
    for (const b of BUILDINGS) {
      if (insideBuilding(p, b, 3)) return base
      if (insideBuilding(p, b, 9)) hill *= 0.4
    }
  }
  return base + hill
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
  private readonly lamps: THREE.Mesh[] = []

  constructor() {
    const scene = this.scene
    scene.fog = new THREE.Fog(0xdfe8ec, 180, 620)
    this.addSky()
    const hemi = new THREE.HemisphereLight(0xe4f0ff, 0x5d7a45, 1.7)
    scene.add(hemi)
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0005
    this.sun.shadow.normalBias = 0.4
    scene.add(this.sun, this.sun.target)
    this.setShadowFocus(0, -20, true)

    this.addGround()
    for (const b of BUILDINGS) scene.add(this.makeBuilding(b))
    this.addGate()
    this.addTrack()
    this.addCourt()
    this.addStage()
    this.addBackGate()
    this.addStreet()
    this.addTrees()
    this.addLamps()
    this.addRouteArrows()
    this.addBeacon()
    this.addLabels()
  }

  /** 陰影相機跟著玩家，總覽時涵蓋全校 */
  setShadowFocus(x: number, z: number, wide: boolean): void {
    const s = this.sun.shadow.camera
    const size = wide ? 260 : 110
    s.left = -size
    s.right = size
    s.top = size
    s.bottom = -size
    s.near = 1
    s.far = 700
    s.updateProjectionMatrix()
    const y = baseHeight(z)
    this.sun.target.position.set(x, y, z)
    this.sun.position.set(x - 120, y + 220, z + 90)
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
    const geo = new THREE.SphereGeometry(900, 32, 16)
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
    // 遠方山稜（木柵一帶的山）
    const r = rng(7)
    const ridgeMat = new THREE.MeshLambertMaterial({ color: 0x6f8f6a, fog: true })
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2
      const dist = 470 + r() * 80
      const m = new THREE.Mesh(new THREE.ConeGeometry(70 + r() * 60, 50 + r() * 70, 6), ridgeMat)
      m.position.set(Math.cos(a) * dist, 0, Math.sin(a) * dist - 20)
      this.scene.add(m)
    }
  }

  // ─── 地形與鋪面 ─────────────────────────────────────
  private addGround(): void {
    const size = 460
    const seg = 300
    const geo = new THREE.PlaneGeometry(size, size, seg, seg)
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, 0, -20)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const r = rng(11)
    const forest = new THREE.Color(0x4c7a3b)
    const lawn = new THREE.Color(0x86b35c)
    const route = new THREE.Color(0xb9705c)
    const lane = new THREE.Color(0xd6c0aa)
    const plaza = new THREE.Color(0xcf9f8a)
    const apron = new THREE.Color(0xcdbfb0)
    const asphalt = new THREE.Color(0x56565b)
    const sidewalk = new THREE.Color(0xb9b1a6)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const p = { x, z }
      pos.setY(i, terrainHeight(x, z))
      const inside = pointInPolygon(p)
      const jitter = (r() - 0.5) * 0.06
      if (!inside) {
        if (z > 150) c.copy(sidewalk)
        else c.copy(forest).offsetHSL(jitter * 0.5, 0, jitter)
      } else if (z > 131 && z < 151) {
        c.copy(asphalt)
      } else if (z >= 126) {
        c.copy(sidewalk)
      } else if (x > -107.6 && x < -100.4 && z > 90) {
        c.copy(route)
      } else if (distToPolyline(p, ROUTE) < 3.2) {
        c.copy(route)
      } else if (PLAZAS.some(pl => Math.hypot(x - pl.x, z - pl.z) < pl.r)) {
        c.copy(plaza)
      } else if (LANES.some(l => distToPolyline(p, l) < 2.6)) {
        c.copy(lane)
      } else if (NAMED.some(b => insideBuilding(p, b, 3.5))) {
        c.copy(apron)
      } else {
        c.copy(lawn).offsetHSL(jitter * 0.4, 0, jitter)
      }
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }))
    ground.receiveShadow = true
    this.scene.add(ground)
  }

  // ─── 建築 ─────────────────────────────────────────
  private makeBuilding(b: Building): THREE.Group {
    const g = new THREE.Group()
    const base = Math.min(...buildingCorners(b).map(p => baseHeight(p.z)))
    const sink = 8
    const H = b.h + sink
    const geo = new THREE.BoxGeometry(b.w, H, b.d)
    const uv = geo.attributes.uv as THREE.BufferAttribute
    const floorH = b.h / b.floors
    const bay = b.style === 'auditorium' ? 6 : 4
    for (let f = 0; f < 6; f++) {
      if (f === 2 || f === 3) continue
      const width = f < 2 ? b.d : b.w
      for (let v = 0; v < 4; v++) {
        const idx = f * 4 + v
        uv.setXY(idx, (uv.getX(idx) * width) / bay, (uv.getY(idx) * H - sink) / floorH)
      }
    }
    const side = new THREE.MeshLambertMaterial({ map: facadeTexture(b.style) })
    const roof = new THREE.MeshLambertMaterial({ color: STYLE_ROOF[b.style] })
    const body = new THREE.Mesh(geo, [side, side, roof, roof, side, side])
    body.position.y = H / 2 - sink
    body.castShadow = true
    body.receiveShadow = true
    body.userData.num = b.num
    this.occluders.push(body)
    g.add(body)
    const cap = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.6, 0.9, b.d + 0.6), new THREE.MeshLambertMaterial({ color: new THREE.Color(STYLE_ROOF[b.style]).multiplyScalar(0.85) }))
    cap.position.y = b.h + 0.45
    cap.castShadow = true
    g.add(cap)
    if (b.style !== 'city' && b.w > 14) {
      const unit = new THREE.Mesh(new THREE.BoxGeometry(Math.min(8, b.w * 0.3), 2.4, Math.min(6, b.d * 0.3)), new THREE.MeshLambertMaterial({ color: 0xbdbdb8 }))
      unit.position.set(-b.w * 0.18, b.h + 2, -b.d * 0.15)
      unit.castShadow = true
      g.add(unit)
    }
    this.addBuildingDetails(b, g)
    g.position.set(b.x, base, b.z)
    g.rotation.y = b.rot
    return g
  }

  private signPlane(tex: THREE.Texture, w: number, h: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: true }))
    return m
  }

  private addBuildingDetails(b: Building, g: THREE.Group): void {
    const front = b.d / 2 + 0.06
    const brick = new THREE.MeshLambertMaterial({ map: facadeTexture('brick') })
    switch (b.id) {
      case 'W': {
        // 頂樓「世新大學」招牌（面向木柵路）
        const panel = new THREE.Mesh(new THREE.BoxGeometry(17, 5, 0.5), new THREE.MeshLambertMaterial({ color: 0xd9dcdf }))
        panel.position.set(0, b.h + 3.4, b.d / 2 - 1.2)
        g.add(panel)
        const sign = this.signPlane(signTexture('世新大學', { color: '#b3202f' }), 16, 4)
        sign.position.set(0, b.h + 3.4, b.d / 2 - 0.9)
        g.add(sign)
        const side = this.signPlane(signTexture('世界', { color: '#b3202f', vertical: true, w: 256, h: 512, size: 200 }), 1.6, 3.2)
        side.position.set(b.w / 2 + 0.06, b.h - 4, b.d / 2 - 2)
        side.rotation.y = Math.PI / 2
        g.add(side)
        // 一樓騎樓
        const arcade = new THREE.Mesh(new THREE.BoxGeometry(b.w + 1, 0.5, 3), new THREE.MeshLambertMaterial({ color: 0x8b5a4a }))
        arcade.position.set(0, 3.6, b.d / 2 + 1.5)
        g.add(arcade)
        break
      }
      case 'C': {
        const sign = this.signPlane(signTexture('傳播大廈', { color: '#a3122b', bg: '#f7f3ec', sub: 'COLLEGE OF JOURNALISM & COMMUNICATIONS' }), 11, 2.75)
        sign.position.set(0, 7.2, front)
        g.add(sign)
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 3.5), new THREE.MeshLambertMaterial({ color: 0x9aa3ab }))
        canopy.position.set(0, 4, b.d / 2 + 1.75)
        canopy.castShadow = true
        g.add(canopy)
        const door = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), new THREE.MeshLambertMaterial({ color: 0x3c4c5c }))
        door.position.set(0, 1.7, front)
        g.add(door)
        // 側邊樓梯塔
        const tower = new THREE.Mesh(new THREE.BoxGeometry(5, b.h + 4 + 8, 5), new THREE.MeshLambertMaterial({ map: facadeTexture('whiteTile') }))
        tower.position.set(b.w / 2 + 2, (b.h + 4) / 2 - 4, -2)
        tower.castShadow = true
        g.add(tower)
        break
      }
      case 'A': {
        const sign = this.signPlane(signTexture('大禮堂', { color: '#b3202f', bg: '#f2f0ea' }), 9, 2.25)
        sign.position.set(0, b.h - 4, front)
        g.add(sign)
        const steps = new THREE.Mesh(new THREE.BoxGeometry(14, 1, 4), new THREE.MeshLambertMaterial({ color: 0xcfc7bd }))
        steps.position.set(0, 0.5, b.d / 2 + 2)
        g.add(steps)
        break
      }
      case 'R':
      case 'S': {
        // 舍我樓的圓柱樓梯塔
        const h = b.h + 3
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, h + 8, 20), brick)
        cyl.position.set(b.id === 'S' ? b.w / 2 : -b.w / 2, h / 2 - 4, b.d / 2)
        cyl.castShadow = true
        g.add(cyl)
        if (b.id === 'S') {
          const sign = this.signPlane(signTexture('舍我樓', { color: '#ffffff', vertical: true, w: 256, h: 768, size: 210 }), 2.2, 6.6)
          sign.position.set(-4, b.h - 6, front)
          g.add(sign)
        }
        break
      }
      case 'J': {
        const sign = this.signPlane(signTexture('新聞大樓', { color: '#b3202f', bg: '#f4e2da' }), 8, 2)
        sign.position.set(0, b.h - 2, front)
        g.add(sign)
        break
      }
      case 'M': {
        const sign = this.signPlane(signTexture('管理學院', { color: '#b3202f' }), 12, 3)
        sign.position.set(0, b.h + 2.2, -b.d / 2 + 2)
        sign.rotation.y = Math.PI
        const sign2 = sign.clone()
        sign2.rotation.y = -Math.PI / 2
        sign2.position.set(-b.w / 2 - 0.1, b.h - 3, 0)
        g.add(sign2)
        break
      }
    }
  }

  // ─── 前校門：粉色石造拱門 + 山洞隧道 ─────────────────
  private addGate(): void {
    const stone = stoneTexture()
    stone.repeat.set(0.18, 0.18)
    const stoneMat = new THREE.MeshLambertMaterial({ map: stone })
    const trim = new THREE.MeshLambertMaterial({ color: 0xc89580 })
    const gate = new THREE.Group()
    const half = GATE.width / 2
    const shape = new THREE.Shape()
    shape.moveTo(-7.5, 0)
    shape.lineTo(-half, 0)
    shape.lineTo(-half, 4.6)
    shape.absarc(0, 4.6, half, Math.PI, 0, true)
    shape.lineTo(half, 0)
    shape.lineTo(7.5, 0)
    shape.lineTo(7.5, 11)
    shape.lineTo(-7.5, 11)
    shape.closePath()
    const arch = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false, curveSegments: 20 }), stoneMat)
    arch.position.z = -3
    arch.castShadow = true
    arch.receiveShadow = true
    arch.userData.num = '01'
    this.occluders.push(arch)
    gate.add(arch)
    // 拱圈飾帶
    const ringShape = new THREE.Shape()
    ringShape.absarc(0, 4.6, half + 0.8, 0, Math.PI, false)
    ringShape.lineTo(-half, 4.6)
    ringShape.absarc(0, 4.6, half, Math.PI, 0, true)
    ringShape.closePath()
    const ring = new THREE.Mesh(new THREE.ExtrudeGeometry(ringShape, { depth: 0.3, bevelEnabled: false, curveSegments: 20 }), trim)
    ring.position.z = 0.01
    gate.add(ring)
    // 頂部挑簷
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(17, 1.2, 4.2), trim)
    cornice.position.set(0, 11.6, -1.5)
    cornice.castShadow = true
    gate.add(cornice)
    // 兩側低翼
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(6.5, 7.5, 2.6), stoneMat)
      wing.position.set(s * 10.7, 3.75, -1.6)
      wing.castShadow = true
      gate.add(wing)
      const wingTop = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.9, 3.4), trim)
      wingTop.position.set(s * 10.9, 7.9, -1.4)
      gate.add(wingTop)
      const pilaster = new THREE.Mesh(new THREE.BoxGeometry(1.4, 10.4, 0.5), trim)
      pilaster.position.set(s * 6.6, 5.2, 0.2)
      gate.add(pilaster)
      // 樹籬
      for (let i = 0; i < 3; i++) {
        const hedge = new THREE.Mesh(new THREE.CapsuleGeometry(0.8, 1.6, 4, 8), new THREE.MeshLambertMaterial({ color: 0x3f7a33 }))
        hedge.position.set(s * (8.6 + i * 2.1), 1.6, 1.4)
        hedge.castShadow = true
        gate.add(hedge)
      }
    }
    const sign = this.signPlane(signTexture('世新大學', { color: '#8a5a3c', sub: 'Shih Hsin University' }), 7.5, 1.9)
    sign.position.set(0, 9.3, 0.02)
    gate.add(sign)
    const led = this.signPlane(signTexture('歡迎蒞臨世新大學', { color: '#ff4b3a', bg: '#1a1a1a', size: 120 }), 3.2, 0.5)
    led.position.set(0, 6.2, -1)
    gate.add(led)
    gate.position.set(GATE.x, baseHeight(GATE.z), GATE.z)
    this.scene.add(gate)

    // 隧道：分段沿坡道向北
    const segLen = 4
    const n = Math.ceil((GATE.z - 3 - GATE.tunnelEndZ) / segLen)
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xe9e4da, side: THREE.DoubleSide })
    const brickMat = new THREE.MeshLambertMaterial({ map: facadeTexture('brick') })
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff1c9 })
    const vault = new THREE.Shape()
    vault.absarc(0, 0, half + 0.8, 0, Math.PI, false)
    vault.lineTo(-half, 0)
    vault.absarc(0, 0, half, Math.PI, 0, true)
    vault.closePath()
    const vaultGeo = new THREE.ExtrudeGeometry(vault, { depth: segLen + 0.05, bevelEnabled: false, curveSegments: 16 })
    for (let i = 0; i < n; i++) {
      const z0 = GATE.z - 3 - i * segLen
      const zc = z0 - segLen / 2
      const y = baseHeight(zc)
      const v = new THREE.Mesh(vaultGeo, wallMat)
      v.position.set(GATE.x, y + 4.6, z0 - segLen)
      g(v)
      for (const s of [-1, 1]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(0.8, 6.6, segLen + 0.05), brickMat)
        wall.position.set(GATE.x + s * (half + 0.4), y + 1.3, zc)
        g(wall)
      }
      if (i % 2 === 0) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 1.6), lightMat)
        lamp.position.set(GATE.x, y + 4.6 + half - 0.08, zc)
        this.scene.add(lamp)
      }
    }
    function g(m: THREE.Mesh) {
      m.receiveShadow = true
      gate.parent!.add(m)
    }
    // 隧道兩側與上方的山丘（不與隧道內部重疊，從拱門看進去仍是隧道）
    const hillMat = new THREE.MeshLambertMaterial({ color: 0x4c7a3b })
    const mounds: [number, number, number, number, number, number][] = [
      [GATE.x - 15, 2, 110, 10.5, 11, 17], // 西側
      [GATE.x + 8.5, 2, 108, 4.6, 10, 15], // 東側（世界大廈旁）
      [GATE.x, baseHeight(110) + 12.4, 110, 9, 3.6, 15], // 隧道頂
    ]
    for (const [x, y, z, sx, sy, sz] of mounds) {
      const hill = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), hillMat)
      hill.scale.set(sx, sy, sz)
      hill.position.set(x, y, z)
      hill.receiveShadow = true
      this.occluders.push(hill)
      this.scene.add(hill)
    }
    const exit = new THREE.Mesh(new THREE.BoxGeometry(GATE.width + 3, 1, 1.2), trim)
    exit.position.set(GATE.x, baseHeight(GATE.tunnelEndZ) + 9.2, GATE.tunnelEndZ + 1)
    this.scene.add(exit)
  }

  // ─── 操場 ─────────────────────────────────────────
  private addTrack(): void {
    const y = baseHeight(TRACK.z) + 0.05
    const stadium = (p: THREE.Path, len: number, r: number) => {
      p.moveTo(-len / 2, -r)
      p.lineTo(len / 2, -r)
      p.absarc(len / 2, 0, r, -Math.PI / 2, Math.PI / 2, false)
      p.lineTo(-len / 2, r)
      p.absarc(-len / 2, 0, r, Math.PI / 2, (Math.PI * 3) / 2, false)
      return p
    }
    const ring = (outer: number, inner: number, color: number, lift: number) => {
      const s = stadium(new THREE.Shape(), TRACK.straight, outer) as THREE.Shape
      s.holes.push(stadium(new THREE.Path(), TRACK.straight, inner))
      const m = new THREE.Mesh(new THREE.ShapeGeometry(s, 24), new THREE.MeshLambertMaterial({ color }))
      m.rotation.x = -Math.PI / 2
      m.position.set(TRACK.x, y + lift, TRACK.z)
      m.receiveShadow = true
      this.scene.add(m)
    }
    const inner = TRACK.outerR - TRACK.laneW
    ring(TRACK.outerR + 1.2, TRACK.outerR, 0xc9c0b4, 0)
    ring(TRACK.outerR, inner, 0xb5473a, 0.01)
    for (let k = 1; k < 5; k++) {
      const r = inner + (TRACK.laneW / 5) * k
      ring(r + 0.06, r - 0.06, 0xf4efe8, 0.02)
    }
    const field = stadium(new THREE.Shape(), TRACK.straight, inner) as THREE.Shape
    const f = new THREE.Mesh(new THREE.ShapeGeometry(field, 24), new THREE.MeshLambertMaterial({ color: 0x4f9e4a }))
    f.rotation.x = -Math.PI / 2
    f.position.set(TRACK.x, y + 0.01, TRACK.z)
    f.receiveShadow = true
    this.scene.add(f)
    // 場地線
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf4efe8 })
    const mid = new THREE.Mesh(new THREE.PlaneGeometry(0.15, inner * 2 - 2), lineMat)
    mid.rotation.x = -Math.PI / 2
    mid.position.set(TRACK.x, y + 0.03, TRACK.z)
    this.scene.add(mid)
    const circle = new THREE.Mesh(new THREE.RingGeometry(4.5, 4.65, 40), lineMat)
    circle.rotation.x = -Math.PI / 2
    circle.position.set(TRACK.x, y + 0.03, TRACK.z)
    this.scene.add(circle)
    // 球門
    const postMat = new THREE.MeshLambertMaterial({ color: 0xffffff })
    for (const s of [-1, 1]) {
      const gx = TRACK.x + s * (TRACK.straight / 2 + inner - 3)
      for (const dz of [-3, 3]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.2), postMat)
        post.position.set(gx, y + 1.1, TRACK.z + dz)
        this.scene.add(post)
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6), postMat)
      bar.rotation.x = Math.PI / 2
      bar.position.set(gx, y + 2.2, TRACK.z)
      this.scene.add(bar)
    }
  }

  private addCourt(): void {
    const y = baseHeight(COURT.z) + 0.06
    const m = new THREE.Mesh(new THREE.PlaneGeometry(COURT.w, COURT.d), new THREE.MeshLambertMaterial({ map: courtTexture() }))
    m.rotation.x = -Math.PI / 2
    m.position.set(COURT.x, y, COURT.z)
    m.receiveShadow = true
    this.scene.add(m)
    const pole = new THREE.MeshLambertMaterial({ color: 0x2f6fb0 })
    const board = new THREE.MeshLambertMaterial({ color: 0xffffff })
    for (const s of [-1, 1]) {
      const x = COURT.x + s * (COURT.w / 2 + 0.6)
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.6), pole)
      p.position.set(x, y + 1.8, COURT.z)
      p.castShadow = true
      this.scene.add(p)
      const bd = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 1.8), board)
      bd.position.set(x - s * 0.5, y + 3.3, COURT.z)
      this.scene.add(bd)
      this.obstacles.push({ x, z: COURT.z, r: 0.3 })
    }
  }

  private addStage(): void {
    const y = baseHeight(STAGE.z)
    const wood = new THREE.MeshLambertMaterial({ color: 0x9b6b4b })
    const deck = new THREE.Mesh(new THREE.BoxGeometry(STAGE.w, 1.2, STAGE.d), wood)
    deck.position.set(STAGE.x, y + 0.3, STAGE.z)
    deck.castShadow = deck.receiveShadow = true
    this.scene.add(deck)
    const roof = new THREE.Mesh(new THREE.BoxGeometry(STAGE.w + 1, 0.4, STAGE.d + 1), new THREE.MeshLambertMaterial({ color: 0xa3122b }))
    roof.position.set(STAGE.x, y + 6, STAGE.z)
    roof.castShadow = true
    this.scene.add(roof)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5.6), new THREE.MeshLambertMaterial({ color: 0x5b4636 }))
        const px = STAGE.x + sx * (STAGE.w / 2 - 0.4)
        const pz = STAGE.z + sz * (STAGE.d / 2 - 0.4)
        post.position.set(px, y + 3, pz)
        this.scene.add(post)
      }
    }
    // 舞台本身是障礙
    this.obstacles.push({ x: STAGE.x, z: STAGE.z, r: Math.min(STAGE.w, STAGE.d) / 2 })
    const sign = this.signPlane(signTexture('八風舞台', { color: '#ffffff' }), 6, 1.5)
    sign.position.set(STAGE.x, y + 5.2, STAGE.z - STAGE.d / 2 - 0.55)
    sign.rotation.y = Math.PI
    this.scene.add(sign)
  }

  private addBackGate(): void {
    const y = baseHeight(BACK_GATE.z)
    const mat = new THREE.MeshLambertMaterial({ map: facadeTexture('brick') })
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.4, 5, 1.4), mat)
      p.position.set(BACK_GATE.x + s * 5, y + 2.5, BACK_GATE.z)
      p.castShadow = true
      this.scene.add(p)
      this.obstacles.push({ x: BACK_GATE.x + s * 5, z: BACK_GATE.z, r: 1 })
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(11.4, 1.2, 1.6), new THREE.MeshLambertMaterial({ color: 0x5b5f63 }))
    beam.position.set(BACK_GATE.x, y + 5.4, BACK_GATE.z)
    this.scene.add(beam)
    const sign = this.signPlane(signTexture('後校門', { color: '#ffffff' }), 4.5, 1.1)
    sign.position.set(BACK_GATE.x, y + 5.4, BACK_GATE.z + 0.82)
    this.scene.add(sign)
  }

  private addStreet(): void {
    const white = new THREE.MeshBasicMaterial({ color: 0xf0f0ea })
    // 校門前斑馬線
    for (let i = 0; i < 8; i++) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 17), white)
      stripe.rotation.x = -Math.PI / 2
      stripe.position.set(GATE.x - 6 + i * 1.6, 0.04, 141)
      this.scene.add(stripe)
    }
    // 道路中線
    for (let x = -196; x < 8; x += 8) {
      if (Math.abs(x - GATE.x) < 12) continue
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.2), new THREE.MeshBasicMaterial({ color: 0xf2d16b }))
      dash.rotation.x = -Math.PI / 2
      dash.position.set(x, 0.04, 141)
      this.scene.add(dash)
    }
    const roadSign = this.signPlane(signTexture('木柵路一段（示意）', { color: '#ffffff', bg: '#2f6a46', size: 120 }), 4.8, 1.2)
    roadSign.position.set(GATE.x + 14, 4, 129.2)
    this.scene.add(roadSign)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4), new THREE.MeshLambertMaterial({ color: 0x777777 }))
    pole.position.set(GATE.x + 14, 2, 129.1)
    this.scene.add(pole)
  }

  // ─── 植栽 ─────────────────────────────────────────
  private addTrees(): void {
    const r = rng(42)
    const trees: { x: number; z: number; s: number; palm?: boolean }[] = []
    const avoidInside = (p: Vec2) =>
      distToPolyline(p, ROUTE) < 6 ||
      LANES.some(l => distToPolyline(p, l) < 4.5) ||
      PLAZAS.some(pl => Math.hypot(p.x - pl.x, p.z - pl.z) < pl.r + 3) ||
      NAMED.some(b => insideBuilding(p, b, 4)) ||
      (Math.abs(p.x - TRACK.x) < TRACK.straight / 2 + TRACK.outerR + 4 && Math.abs(p.z - TRACK.z) < TRACK.outerR + 4) ||
      (Math.abs(p.x - COURT.x) < COURT.w / 2 + 3 && Math.abs(p.z - COURT.z) < COURT.d / 2 + 3) ||
      Math.hypot(p.x - STAGE.x, p.z - STAGE.z) < 12 ||
      Math.hypot(p.x - BACK_GATE.x, p.z - BACK_GATE.z) < 9 ||
      p.z > 120
    let guard = 0
    while (trees.length < 1300 && guard++ < 40000) {
      const p = { x: -225 + r() * 450, z: -245 + r() * 390 }
      if (pointInPolygon(p)) continue
      const d = distToPolygonEdge(p)
      if (d < 1.5 || d > 70) continue
      if (BUILDINGS.some(b => insideBuilding(p, b, 2))) continue
      if (Math.abs(p.x - GATE.x) < 6 && p.z > 92 && p.z < 132) continue
      trees.push({ x: p.x, z: p.z, s: 0.9 + r() * 0.9 })
    }
    let inner = 0
    guard = 0
    while (inner < 180 && guard++ < 30000) {
      const p = { x: -180 + r() * 390, z: -220 + r() * 340 }
      if (!pointInPolygon(p) || distToPolygonEdge(p) < 2 || avoidInside(p)) continue
      trees.push({ x: p.x, z: p.z, s: 0.7 + r() * 0.5 })
      this.obstacles.push({ x: p.x, z: p.z, r: 0.5 })
      inner++
    }
    // 操場旁的大王椰子（依操場照片）
    for (let z = -136; z >= -172; z -= 6) {
      trees.push({ x: 86, z, s: 1, palm: true })
      this.obstacles.push({ x: 86, z, r: 0.4 })
    }
    for (let x = 108; x <= 150; x += 7) {
      trees.push({ x, z: -125, s: 1, palm: true })
      this.obstacles.push({ x, z: -125, r: 0.4 })
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
      m.compose(new THREE.Vector3(t.x, y + 1.5 * t.s, t.z), q, new THREE.Vector3(t.s, t.s, t.s))
      trunk.setMatrixAt(i, m)
      const sy = t.s * (0.9 + r() * 0.5)
      m.compose(new THREE.Vector3(t.x, y + 3 * t.s + 1.6 * sy, t.z), q.setFromEuler(new THREE.Euler(0, r() * 6, 0)), new THREE.Vector3(t.s * 1.1, sy, t.s * 1.1))
      crown.setMatrixAt(i, m)
      col.setHSL(0.24 + r() * 0.08, 0.45 + r() * 0.2, 0.26 + r() * 0.12)
      crown.setColorAt(i, col)
    })
    q.identity()
    trunk.castShadow = crown.castShadow = true
    crown.receiveShadow = true
    this.scene.add(trunk, crown)

    const pTrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.28, 10, 6), new THREE.MeshLambertMaterial({ color: 0x9a8f7f }), palms.length)
    const pCrown = new THREE.InstancedMesh(new THREE.ConeGeometry(2.7, 1.4, 7, 1, true), new THREE.MeshLambertMaterial({ color: 0x5a9a3e, side: THREE.DoubleSide }), palms.length)
    palms.forEach((t, i) => {
      const y = terrainHeight(t.x, t.z)
      m.compose(new THREE.Vector3(t.x, y + 5, t.z), q.identity(), new THREE.Vector3(1, 1, 1))
      pTrunk.setMatrixAt(i, m)
      m.compose(new THREE.Vector3(t.x, y + 9.6, t.z), q.setFromEuler(new THREE.Euler(Math.PI, i, 0)), new THREE.Vector3(1, 1, 1))
      pCrown.setMatrixAt(i, m)
    })
    pTrunk.castShadow = pCrown.castShadow = true
    this.scene.add(pTrunk, pCrown)
  }

  private addLamps(): void {
    const total = routeLength(ROUTE)
    const spots: Vec2[] = []
    for (let s = 30; s < total - 10; s += 20) {
      const { p, dir } = samplePath(ROUTE, s)
      const side = spots.length % 2 ? 1 : -1
      const q = { x: p.x - dir.z * 3.8 * side, z: p.z + dir.x * 3.8 * side }
      if (!pointInPolygon(q) || BUILDINGS.some(b => insideBuilding(q, b, 1.5))) continue
      if (q.x > -108 && q.x < -100 && q.z > 90) continue
      spots.push(q)
    }
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, 4.2, 6), new THREE.MeshLambertMaterial({ color: 0x2f2f33 }), spots.length)
    const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff3d2 }), spots.length)
    const m = new THREE.Matrix4()
    spots.forEach((p, i) => {
      const y = baseHeight(p.z)
      m.makeTranslation(p.x, y + 2.1, p.z)
      pole.setMatrixAt(i, m)
      m.makeTranslation(p.x, y + 4.3, p.z)
      head.setMatrixAt(i, m)
      this.obstacles.push({ x: p.x, z: p.z, r: 0.2 })
    })
    this.scene.add(pole, head)
    this.lamps.push(pole, head)
  }

  private addRouteArrows(): void {
    const tex = arrowTexture()
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, opacity: 0.85 })
    const total = routeLength(ROUTE)
    for (let s = 8; s < total - 4; s += 18) {
      const { p, dir } = samplePath(ROUTE, s)
      if (p.z > 92 && p.z < 129) continue
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), mat)
      m.rotation.x = -Math.PI / 2
      m.rotation.z = Math.atan2(-dir.x, -dir.z)
      m.position.set(p.x, terrainHeight(p.x, p.z) + 0.12, p.z)
      m.rotation.order = 'YXZ'
      m.rotation.set(-Math.PI / 2, 0, 0)
      m.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), Math.atan2(-dir.x, -dir.z))
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
    ring.position.y = 0.08
    g.add(ring)
    g.position.set(DESTINATION.x, baseHeight(DESTINATION.z), DESTINATION.z)
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
      const pos = new THREE.Vector3(l.at.x, baseHeight(l.at.z) + l.labelHeight, l.at.z)
      obj.position.copy(pos)
      this.scene.add(obj)
      this.labels.push({ obj, landmark: l, pos })
    }
  }
}

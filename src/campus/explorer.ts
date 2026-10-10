import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DESTINATION, ROUTE, START, groundHeight, inStairZone, walkHeight, type Vec2 } from './data'
import type { Landmark } from './landmarks'
import { resolveMove, routeLength, samplePath, type Obstacle } from './geometry'

export type Mode = 'walk' | 'overview' | 'tour'

const EYE = 1.65
/** 樓梯高差判定的身體周圍取樣點（公尺） */
const STEP_SAMPLES: [number, number][] = [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]]
const WALK_SPEED = 4.5
const RUN_SPEED = 10
const TOUR_SPEED = 7

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
}

interface Fly {
  fromPos: THREE.Vector3
  fromTarget: THREE.Vector3
  toPos: THREE.Vector3
  toTarget: THREE.Vector3
  t: number
  dur: number
}

export interface ExplorerEvents {
  modeChange: (mode: Mode) => void
  arrive: () => void
  tourProgress: (fraction: number) => void
}

export class Explorer {
  readonly camera: THREE.PerspectiveCamera
  readonly orbit: OrbitControls
  mode: Mode = 'walk'
  pos: Vec2 = { ...START.pos }
  yaw = START.yaw
  pitch = 0.04
  tourPaused = false
  /** 偏好減少動態效果 */
  reducedMotion = false
  /** 過場／對話中：停用移動與滑鼠環顧，鏡頭由劇情控制 */
  locked = false
  /** 劇情鏡頭特效：dy 眼高偏移、roll 側傾、shake 晃動強度 */
  readonly camFx = { dy: 0, roll: 0, shake: 0 }
  /** 劇情關卡：過濾每一步移動（例如校門警衛未放行前不得進門） */
  moveFilter: ((from: Vec2, to: Vec2) => Vec2) | null = null
  private eyeY = groundHeight(START.pos.x, START.pos.z) + EYE
  /** 目前站立高度（樓梯／天橋分層用） */
  private floorY = groundHeight(START.pos.x, START.pos.z)
  private keys = new Set<string>()
  private touchMove = { x: 0, y: 0 }
  private vel = { x: 0, z: 0 }
  private dragging = false
  private tourS = 0
  private readonly tourTotal = routeLength(ROUTE)
  private fly: Fly | null = null
  private arrived = false
  private readonly avatar: THREE.Group

  constructor(
    private readonly canvas: HTMLCanvasElement,
    scene: THREE.Scene,
    private readonly obstacles: Obstacle[],
    private readonly events: ExplorerEvents,
  ) {
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2600)
    this.camera.rotation.order = 'YXZ'
    this.orbit = new OrbitControls(this.camera, canvas)
    this.orbit.enabled = false
    this.orbit.enableDamping = true
    this.orbit.maxPolarAngle = Math.PI * 0.46
    this.orbit.minDistance = 30
    this.orbit.maxDistance = 1000
    this.orbit.screenSpacePanning = false

    this.avatar = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 2.2, 4, 10), new THREE.MeshLambertMaterial({ color: 0xa3122b }))
    body.position.y = 2.2
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.9, 14, 10), new THREE.MeshLambertMaterial({ color: 0xf2d2bd }))
    head.position.y = 4.6
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3, 3), new THREE.MeshBasicMaterial({ color: 0xd6336c }))
    arrow.rotation.x = -Math.PI / 2
    arrow.position.set(0, 0.4, -3)
    this.avatar.add(body, head, arrow)
    this.avatar.visible = false
    scene.add(this.avatar)

    window.addEventListener('keydown', e => {
      if ((e.target as HTMLElement | null)?.matches?.('input, textarea')) return
      this.keys.add(e.code)
      if (MOVE_KEYS[e.code]) {
        e.preventDefault()
        if (this.mode === 'tour') this.setMode('walk')
      }
    })
    window.addEventListener('keyup', e => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())

    canvas.addEventListener('pointerdown', e => {
      if (this.mode !== 'walk' || e.pointerType === 'touch' || this.locked) return
      this.dragging = true
      canvas.requestPointerLock?.()?.catch?.(() => undefined)
    })
    window.addEventListener('pointerup', () => (this.dragging = false))
    window.addEventListener('mousemove', e => {
      if (this.mode !== 'walk') return
      const locked = document.pointerLockElement === canvas
      if (!locked && !this.dragging) return
      // 指標鎖定剛開始或游標被重新置中時，瀏覽器偶爾送出一次異常大的位移（約半個視窗），
      // 直接略過，避免視角突然甩向天空
      const spike = Math.max(window.innerWidth, window.innerHeight) * 0.3
      if (Math.abs(e.movementX) > spike || Math.abs(e.movementY) > spike) return
      this.addLook(e.movementX * 0.0024, e.movementY * 0.0024)
    })
    this.applyWalkCamera()
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  addLook(dx: number, dy: number): void {
    if (this.locked) return
    if (this.mode === 'tour') this.setMode('walk')
    this.yaw -= dx
    this.pitch = Math.max(-1.25, Math.min(1.25, this.pitch - dy))
  }

  setTouchMove(x: number, y: number): void {
    this.touchMove = { x, y }
    if ((x || y) && this.mode === 'tour') this.setMode('walk')
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return
    const prev = this.mode
    this.mode = mode
    this.vel = { x: 0, z: 0 }
    if (mode === 'overview') {
      if (document.pointerLockElement) document.exitPointerLock()
      this.avatar.visible = true
      this.orbit.enabled = true
      // 總覽：框住前校門到傳播大廈的整個校園
      const target = new THREE.Vector3(-20, 24, -18)
      this.startFly(new THREE.Vector3(target.x - 40, 250, target.z + 215), target, this.camera.position.clone(), this.walkLookTarget())
    } else {
      this.avatar.visible = false
      this.orbit.enabled = false
      this.fly = null
      if (mode === 'tour') {
        if (prev !== 'tour') this.tourS = this.nearestRouteS()
        this.tourPaused = false
        if (document.pointerLockElement) document.exitPointerLock()
      }
      this.applyWalkCamera()
    }
    this.events.modeChange(mode)
  }

  /** 從校門口重新開始自動導覽 */
  restartTour(): void {
    this.arrived = false
    if (this.mode !== 'tour') this.setMode('tour')
    this.tourS = 0
    this.tourPaused = false
  }

  teleport(p: Vec2, look?: Vec2): void {
    this.pos = { ...p }
    if (look) this.yaw = Math.atan2(-(look.x - p.x), -(look.z - p.z))
    this.pitch = 0.08
    this.floorY = walkHeight(p.x, p.z)
    this.eyeY = this.floorY + EYE
    this.vel = { x: 0, z: 0 }
    if (this.mode === 'overview') this.avatar.position.set(p.x, this.floorY, p.z)
    this.applyWalkCamera()
  }

  /** 移到 p（保留視角與模式），用於劇情推回 */
  placeAt(p: Vec2): void {
    this.pos = { ...p }
    this.floorY = walkHeight(p.x, p.z, this.floorY)
    this.vel = { x: 0, z: 0 }
    this.applyWalkCamera(0.016)
  }

  goToLandmark(l: Landmark): void {
    if (this.mode === 'overview') {
      const y = groundHeight(l.at.x, l.at.z)
      const target = new THREE.Vector3(l.at.x, y + 6, l.at.z)
      const off = this.camera.position.clone().sub(this.orbit.target).setLength(Math.max(80, l.labelHeight * 3))
      off.y = Math.max(off.y, 45)
      this.startFly(target.clone().add(off), target)
      this.pos = { ...l.spot }
      this.yaw = Math.atan2(-(l.look.x - l.spot.x), -(l.look.z - l.spot.z))
      return
    }
    if (this.mode === 'tour') this.setMode('walk')
    this.teleport(l.spot, l.look)
  }

  resetToStart(): void {
    this.arrived = false
    if (this.mode !== 'walk') this.setMode('walk')
    this.teleport(START.pos, { x: START.pos.x, z: START.pos.z - 10 })
  }

  update(dt: number): void {
    if (this.mode === 'walk') this.updateWalk(dt)
    else if (this.mode === 'tour') this.updateTour(dt)
    else this.updateOverview(dt)
  }

  private updateWalk(dt: number): void {
    let mx = this.locked ? 0 : this.touchMove.x
    let my = this.locked ? 0 : this.touchMove.y
    if (!this.locked) {
      for (const k of this.keys) {
        const v = MOVE_KEYS[k]
        if (v) {
          mx += v[0]
          my += v[1]
        }
      }
    }
    const len = Math.hypot(mx, my)
    if (len > 1) {
      mx /= len
      my /= len
    }
    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || Math.hypot(this.touchMove.x, this.touchMove.y) > 0.95
    const speed = run ? RUN_SPEED : WALK_SPEED
    const fx = -Math.sin(this.yaw)
    const fz = -Math.cos(this.yaw)
    const rx = Math.cos(this.yaw)
    const rz = -Math.sin(this.yaw)
    const tx = (fx * my + rx * mx) * speed
    const tz = (fz * my + rz * mx) * speed
    const k = 1 - Math.exp(-dt * 12)
    this.vel.x += (tx - this.vel.x) * k
    this.vel.z += (tz - this.vel.z) * k
    if (Math.abs(this.vel.x) + Math.abs(this.vel.z) > 0.001) {
      const to = { x: this.pos.x + this.vel.x * dt, z: this.pos.z + this.vel.z * dt }
      let next = resolveMove(this.pos, to, 0.9, this.obstacles)
      if (this.moveFilter) next = this.moveFilter(this.pos, next)
      this.pos = inStairZone(next.x, next.z) || inStairZone(this.pos.x, this.pos.z) ? this.stepLimit(this.pos, next) : next
    }
    this.applyWalkCamera(dt)
    this.checkArrival()
  }

  /**
   * 大禮堂樓梯一帶：不可一步跨上／掉下超過 0.75 m 的高差（平台邊緣、樓梯側面、天橋兩側、樓梯下方實心量體）。
   * 以身體周圍 0.45 m 取樣，避免鏡頭貼進牆面；若目前位置本身就不合法（例如剛傳送），放行以免卡死。
   */
  private stepLimit(from: Vec2, to: Vec2): Vec2 {
    const cur = this.floorY
    const ok = (p: Vec2) => {
      for (const [ox, oz] of STEP_SAMPLES) if (Math.abs(walkHeight(p.x + ox, p.z + oz, cur) - cur) > 0.75) return false
      return true
    }
    if (!ok(from)) return to
    if (ok(to)) return to
    const sx = { x: to.x, z: from.z }
    if (ok(sx)) return sx
    const sz = { x: from.x, z: to.z }
    if (ok(sz)) return sz
    return from
  }

  private updateTour(dt: number): void {
    if (!this.tourPaused) this.tourS = Math.min(this.tourTotal, this.tourS + TOUR_SPEED * dt)
    const { p } = samplePath(ROUTE, this.tourS)
    const ahead = samplePath(ROUTE, Math.min(this.tourTotal, this.tourS + 10)).p
    this.pos = p
    if (Math.hypot(ahead.x - p.x, ahead.z - p.z) > 0.5) {
      const target = Math.atan2(-(ahead.x - p.x), -(ahead.z - p.z))
      let d = target - this.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.yaw += d * (1 - Math.exp(-dt * 2.5))
    }
    this.pitch += (0.02 - this.pitch) * (1 - Math.exp(-dt * 2))
    this.applyWalkCamera(dt)
    this.events.tourProgress(this.tourS / this.tourTotal)
    this.checkArrival()
    if (this.tourS >= this.tourTotal) {
      this.tourPaused = true
    }
  }

  private updateOverview(dt: number): void {
    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt / this.fly.dur)
      const e = this.reducedMotion ? 1 : 1 - Math.pow(1 - this.fly.t, 3)
      this.camera.position.lerpVectors(this.fly.fromPos, this.fly.toPos, e)
      this.orbit.target.lerpVectors(this.fly.fromTarget, this.fly.toTarget, e)
      if (this.fly.t >= 1) this.fly = null
    }
    this.orbit.update()
    this.avatar.position.set(this.pos.x, walkHeight(this.pos.x, this.pos.z, this.floorY), this.pos.z)
    this.avatar.rotation.y = this.yaw
    const d = this.camera.position.distanceTo(this.orbit.target)
    this.avatar.scale.setScalar(Math.max(1, d / 100))
  }

  private startFly(toPos: THREE.Vector3, toTarget: THREE.Vector3, fromPos = this.camera.position.clone(), fromTarget = this.orbit.target.clone()): void {
    this.fly = { fromPos, fromTarget, toPos, toTarget, t: 0, dur: 1.3 }
  }

  private walkLookTarget(): THREE.Vector3 {
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
    return this.camera.position.clone().add(dir.multiplyScalar(30))
  }

  private applyWalkCamera(dt = 1): void {
    this.floorY = walkHeight(this.pos.x, this.pos.z, this.floorY)
    const target = this.floorY + EYE
    this.eyeY += (target - this.eyeY) * (1 - Math.exp(-dt * 10))
    this.camera.position.set(this.pos.x, this.eyeY + this.camFx.dy, this.pos.z)
    const sh = this.reducedMotion ? 0 : this.camFx.shake
    const jx = sh ? (Math.random() - 0.5) * sh : 0
    const jy = sh ? (Math.random() - 0.5) * sh : 0
    this.camera.rotation.set(this.pitch + jx, this.yaw + jy, this.camFx.roll, 'YXZ')
  }

  private nearestRouteS(): number {
    let best = 0
    let bestD = Infinity
    for (let s = 0; s <= this.tourTotal; s += 2) {
      const { p } = samplePath(ROUTE, s)
      const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    return bestD < 25 ? best : 0
  }

  private checkArrival(): void {
    if (this.arrived) return
    if (Math.hypot(this.pos.x - DESTINATION.x, this.pos.z - DESTINATION.z) < 9) {
      this.arrived = true
      this.events.arrive()
    }
  }

  /** 供小地圖使用：目前視角中心與方向 */
  viewState(): { x: number; z: number; yaw: number } {
    if (this.mode === 'overview') {
      return { x: this.pos.x, z: this.pos.z, yaw: this.yaw }
    }
    return { x: this.pos.x, z: this.pos.z, yaw: this.yaw }
  }
}

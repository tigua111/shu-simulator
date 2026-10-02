import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DESTINATION, ROUTE, START, groundHeight, type Vec2 } from './data'
import type { Landmark } from './landmarks'
import { resolveMove, routeLength, samplePath, type Obstacle } from './geometry'

export type Mode = 'walk' | 'overview' | 'tour'

const EYE = 1.65
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
  private eyeY = groundHeight(START.pos.x, START.pos.z) + EYE
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
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1600)
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
      if (this.mode !== 'walk' || e.pointerType === 'touch') return
      this.dragging = true
      canvas.requestPointerLock?.()?.catch?.(() => undefined)
    })
    window.addEventListener('pointerup', () => (this.dragging = false))
    window.addEventListener('mousemove', e => {
      if (this.mode !== 'walk') return
      const locked = document.pointerLockElement === canvas
      if (!locked && !this.dragging) return
      this.addLook(e.movementX * 0.0024, e.movementY * 0.0024)
    })
    this.applyWalkCamera()
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  addLook(dx: number, dy: number): void {
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
    this.eyeY = groundHeight(p.x, p.z) + EYE
    this.vel = { x: 0, z: 0 }
    if (this.mode === 'overview') this.avatar.position.set(p.x, groundHeight(p.x, p.z), p.z)
    this.applyWalkCamera()
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
    let mx = this.touchMove.x
    let my = this.touchMove.y
    for (const k of this.keys) {
      const v = MOVE_KEYS[k]
      if (v) {
        mx += v[0]
        my += v[1]
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
      this.pos = resolveMove(this.pos, to, 0.9, this.obstacles)
    }
    this.applyWalkCamera(dt)
    this.checkArrival()
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
    this.avatar.position.set(this.pos.x, groundHeight(this.pos.x, this.pos.z), this.pos.z)
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
    const target = groundHeight(this.pos.x, this.pos.z) + EYE
    this.eyeY += (target - this.eyeY) * (1 - Math.exp(-dt * 10))
    this.camera.position.set(this.pos.x, this.eyeY, this.pos.z)
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
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

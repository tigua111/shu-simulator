import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Explorer } from './explorer'
import { GATE_NORMAL, TUNNEL } from './data'
import { PROJECTION_LINES, drawProjection, type StoryProps } from './storyProps'
import { CAR_L, CAR_W } from './car'
import { sfx, unlockAudio } from './sfx'
import { StoryUI, storyTag } from '../ui/storyUi'
import type { Vec2 } from './data'

/**
 * 互動劇情（使用者 2026-10-10 指定）：
 * 1. 前校門警衛盤查（三個選項；第三個會被擊斃，需按「復活」重來）
 * 2. 隧道盡頭投影機輪播文字
 * 3. 行政大樓斜坡頂的董事會專車：拿錘子砸車，依落點產生不同破壞
 * 4. 言論廣場銅像前的演講（台詞泡泡）
 * 5. 舍我樓一樓電梯：按 F 前往系辦
 */
export type GateState = 'idle' | 'intro' | 'choose' | 'reply' | 'draw' | 'dying' | 'dead'

export const GUARD_NAME = '警衛'
export const GATE_LINES = {
  intro: '您好，世新大學為封閉校園，請出示學生證。',
  choices: ['提供學生證', '我沒有學生證', '神麼破學校還要看學生證'],
  replies: ['好，你是世新的學生，進去吧。', '抱歉，你可能是記者，我不能讓你進去拍。', '趕快結束自己，這世界已無你存在的必要了。'],
  death: '世新大學解決了你。',
}
export const CAR_ROOF = '董事會專車'
export const CAR_PROMPT = '按下左鍵砸車'
export const CAR_LINE = '有錢不買adobe買豪車。'
export const LIFT_PROMPT = '按Ｆ前往各系系辦'
export const LIFT_REPLY = '噢抱歉，我忘記世新沒系辦'
const SPEECH = ['荒謬世新大學！', '還我試拍檔期！', '還我試拍檔期！！', '荒謬世新大學！！']

/** 校門口「警衛線」：門洞往外 0.6 m；沒有放行前不得越過 */
const A = TUNNEL.pts[0]
const N = GATE_NORMAL
const T = { x: N.z, z: -N.x }
const BARRIER = -0.6
const depth = (p: Vec2) => (p.x - A.x) * N.x + (p.z - A.z) * N.z
const lateral = (p: Vec2) => (p.x - A.x) * T.x + (p.z - A.z) * T.z

interface Tween {
  t: number
  dur: number
  fn: (k: number) => void
  done?: () => void
}
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export class Story {
  gate: GateState = 'idle'
  pass = false
  /** 第幾次對話（測試用） */
  gateTalks = 0
  equipped = false
  private armed = true
  private seq = 0
  private tweens: Tween[] = []
  private lookTarget: THREE.Vector3 | null = null
  private advanceWait: (() => void) | null = null
  private guardStep = new THREE.Vector3()
  private guardDraw = 0
  private projIdx = -1
  private time = 0
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()
  private readonly ray = new THREE.Raycaster()
  private readonly coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  // 場景提示標籤
  private carRoof: CSS2DObject | null = null
  private carPrompt: CSS2DObject | null = null
  private liftTag: CSS2DObject | null = null
  private bubble: CSS2DObject | null = null
  private liftReplyT = 0
  private liftDoorT = -1
  private nearCar = false
  private nearLift = false
  // 錘子
  private readonly hammer = new THREE.Group()
  private readonly hammerPivot = new THREE.Group()
  private swingT = -1
  private swingHit = false
  private equipT = 0
  private lastNdc: THREE.Vector2 | null = null
  private flashSprite: THREE.Sprite | null = null
  private flashT = 0

  constructor(
    private readonly explorer: Explorer,
    scene: THREE.Scene,
    private readonly props: StoryProps,
    readonly ui: StoryUI,
    canvas: HTMLCanvasElement,
    private readonly isEditing: () => boolean,
  ) {
    explorer.moveFilter = (from, to) => this.gateFilter(from, to)
    // capture() 會把群組內物件改成相對樞紐的座標：以建好後的實際位置為警衛站崗點
    if (props.guard) props.guard.home.copy(props.guard.person.root.position)
    ui.onChoice = i => this.choose(i)
    ui.onAdvance = () => {
      const w = this.advanceWait
      this.advanceWait = null
      w?.()
    }
    ui.onRevive = () => this.revive()
    ui.onAction = () => this.action(null)
    this.buildTags()
    this.buildHammer()
    if (!explorer.camera.parent) scene.add(explorer.camera)
    window.addEventListener(
      'keydown',
      e => {
        unlockAudio()
        if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return
        if (this.gate === 'choose') {
          const m = /^(?:Digit|Numpad)([1-3])$/.exec(e.code)
          if (m) {
            e.preventDefault()
            this.choose(Number(m[1]))
            return
          }
        }
        if (this.ui.dialogOpen && (e.code === 'Space' || e.code === 'Enter')) {
          e.preventDefault()
          this.ui.advance()
          return
        }
        if (e.code === 'KeyF' && !e.repeat && this.nearLift) {
          e.preventDefault()
          this.useLift()
        }
      },
      true,
    )
    canvas.addEventListener('pointerdown', e => {
      unlockAudio()
      if (e.button !== 0 || this.explorer.mode !== 'walk' || this.isEditing() || this.blocking) return
      if (!this.nearCar && !this.equipped) return
      const r = canvas.getBoundingClientRect()
      const ndc = this.explorer.isLocked || e.pointerType === 'touch' ? null : new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      this.action(ndc)
    })
  }

  /** 對話、射殺、死亡畫面期間：主程式不要處理快捷鍵 */
  get blocking(): boolean {
    return this.gate !== 'idle' || this.ui.dialogOpen || this.ui.deathOpen
  }

  // ─── 場景標籤 ──────────────────────────────────────
  private buildTags(): void {
    const mk = (text: string, cls: string, parent: THREE.Object3D | undefined, y = 0) => {
      if (!parent) return null
      const o = new CSS2DObject(storyTag(text, cls))
      o.position.y = y
      o.visible = false
      parent.add(o)
      return o
    }
    const car = this.props.car
    if (car) {
      this.carRoof = mk(CAR_ROOF, 'stag-roof', car.roofAnchor)
      this.carPrompt = mk(CAR_PROMPT, 'stag-act', car.audi.root, 0)
    }
    this.liftTag = mk(LIFT_PROMPT, 'stag-act', this.props.lift?.anchor)
    this.bubble = mk(SPEECH[0], 'stag-bubble', this.props.protest?.bubbleAnchor)
  }

  // ─── 錘子（掛在相機上的第一人稱模型） ─────────────────────────
  private buildHammer(): void {
    const wood = new THREE.MeshLambertMaterial({ color: 0x9a6b3f })
    const steel = new THREE.MeshPhongMaterial({ color: 0x5c6066, specular: 0xcccccc, shininess: 80 })
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.42, 8), wood)
    handle.position.y = 0.21
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.13, 8), new THREE.MeshLambertMaterial({ color: 0x1d1d1f }))
    grip.position.y = 0.06
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.17), steel)
    head.position.set(0, 0.43, -0.02)
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.03, 12), steel)
    face.rotation.x = Math.PI / 2
    face.position.set(0, 0.43, -0.115)
    const claw = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.08), steel)
    claw.position.set(0, 0.415, 0.09)
    claw.rotation.x = -0.5
    this.hammer.add(handle, grip, head, face, claw)
    this.hammer.traverse(o => {
      o.frustumCulled = false
      if (o instanceof THREE.Mesh) {
        o.castShadow = false
        o.renderOrder = 10
      }
    })
    this.hammer.rotation.z = 0.15
    this.hammerPivot.add(this.hammer)
    this.hammerPivot.position.set(0.3, -0.95, -0.42)
    this.hammerPivot.rotation.x = -0.25
    this.hammerPivot.visible = false
    this.explorer.camera.add(this.hammerPivot)
  }

  // ─── 前校門警衛 ──────────────────────────────────────
  private gateFilter(from: Vec2, to: Vec2): Vec2 {
    if (this.pass || this.explorer.mode !== 'walk') return to
    const dt = depth(to)
    if (dt > BARRIER && depth(from) <= BARRIER + 0.02 && Math.abs(lateral(to)) < 7) {
      return { x: to.x - N.x * (dt - BARRIER), z: to.z - N.z * (dt - BARRIER) }
    }
    return to
  }
  private guardHead(out: THREE.Vector3): THREE.Vector3 {
    const g = this.props.guard!
    g.person.head.getWorldPosition(out)
    out.y += 0.12
    return out
  }
  private wait(sec: number, id: number): Promise<boolean> {
    return new Promise(res => {
      this.tweens.push({ t: 0, dur: sec, fn: () => undefined, done: () => res(id === this.seq) })
    })
  }
  /** 等待秒數或使用者點擊／空白鍵 */
  private waitOrAdvance(sec: number, id: number): Promise<boolean> {
    this.ui.showNext(true)
    return new Promise(res => {
      let settled = false
      const fin = () => {
        if (settled) return
        settled = true
        this.advanceWait = null
        this.ui.showNext(false)
        res(id === this.seq)
      }
      this.advanceWait = fin
      this.tweens.push({ t: 0, dur: sec, fn: () => undefined, done: fin })
    })
  }
  private async startGate(): Promise<void> {
    if (!this.props.guard) return
    const id = ++this.seq
    this.gate = 'intro'
    this.armed = false
    this.gateTalks++
    this.explorer.locked = true
    if (document.pointerLockElement) document.exitPointerLock()
    this.lookTarget = this.guardHead(new THREE.Vector3())
    if (!(await this.wait(0.45, id))) return
    await this.ui.say(GUARD_NAME, GATE_LINES.intro)
    if (id !== this.seq) return
    this.gate = 'choose'
    this.ui.choices(GATE_LINES.choices)
  }
  /** 三選一（1：學生證、2：沒有學生證、3：嗆聲） */
  async choose(i: number): Promise<void> {
    if (this.gate !== 'choose' || i < 1 || i > 3) return
    const id = this.seq
    this.gate = 'reply'
    this.ui.choicesOpen = false
    await this.ui.say(GUARD_NAME, GATE_LINES.replies[i - 1])
    if (id !== this.seq) return
    if (i === 1) {
      if (!(await this.waitOrAdvance(1.6, id))) return
      this.ui.hideDialog()
      this.pass = true
      this.gate = 'idle'
      // 視線轉向隧道內，再交還操控
      const cp = this.explorer.camera.position
      this.lookTarget = new THREE.Vector3(A.x + N.x * 12, cp.y, A.z + N.z * 12)
      this.tween(0.6, () => undefined, () => this.release())
      // 警衛往玩家的另一側讓開（站崗點在門洞中線偏 +1.5 m）
      const side = lateral(this.explorer.pos) > 0.6 ? -2.3 - 1.5 : 2.9 - 1.5
      const step = new THREE.Vector3(T.x * side - N.x * 0.3, 0, T.z * side - N.z * 0.3)
      const from = this.guardStep.clone()
      this.tween(0.8, k => this.guardStep.lerpVectors(from, step, ease(k)))
    } else if (i === 2) {
      if (!(await this.waitOrAdvance(1.8, id))) return
      this.ui.hideDialog()
      // 被請離校門口：退回門外，需重新走近才會再對話
      const p0 = { ...this.explorer.pos }
      const back = depth(p0) + 8.5
      const p1 = { x: p0.x - N.x * back, z: p0.z - N.z * back }
      this.gate = 'reply'
      this.tween(
        0.7,
        k => {
          const e = ease(k)
          this.explorer.placeAt({ x: lerp(p0.x, p1.x, e), z: lerp(p0.z, p1.z, e) })
        },
        () => {
          if (id !== this.seq) return
          this.gate = 'idle'
          this.release()
          this.ui.subtitle('警衛不讓你進去。再走近校門可以重新對話。', 3200)
        },
      )
    } else {
      if (!(await this.wait(0.5, id))) return
      this.ui.hideDialog()
      this.gate = 'draw'
      // 拔槍、舉槍瞄準
      await new Promise<void>(res => this.tween(0.75, k => (this.guardDraw = ease(k)), res))
      if (id !== this.seq) return
      if (!(await this.wait(0.35, id))) return
      this.fire()
      this.gate = 'dying'
      this.lookTarget = null
      const pitch0 = this.explorer.pitch
      this.tween(
        1.35,
        k => {
          const e = ease(k)
          this.explorer.camFx.dy = -1.25 * e
          this.explorer.camFx.roll = 1.2 * e
          this.explorer.pitch = lerp(pitch0, 0.45, e)
          this.ui.setDying(e)
        },
        () => {
          if (id !== this.seq) return
          this.gate = 'dead'
          this.ui.showDeath(GATE_LINES.death)
        },
      )
    }
  }
  private fire(): void {
    const g = this.props.guard!
    sfx.gunshot()
    this.ui.flashScreen()
    this.explorer.camFx.shake = 0.08
    g.muzzle.getWorldPosition(this.tmp)
    if (!this.flashSprite) {
      const c = document.createElement('canvas')
      c.width = c.height = 64
      const x = c.getContext('2d')!
      const grd = x.createRadialGradient(32, 32, 1, 32, 32, 30)
      grd.addColorStop(0, 'rgba(255,255,230,1)')
      grd.addColorStop(0.35, 'rgba(255,190,60,0.9)')
      grd.addColorStop(1, 'rgba(255,120,0,0)')
      x.fillStyle = grd
      x.fillRect(0, 0, 64, 64)
      const t = new THREE.CanvasTexture(c)
      this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
      this.flashSprite.scale.setScalar(0.5)
      g.person.root.parent?.add(this.flashSprite)
    }
    const parent = this.flashSprite.parent ?? g.person.root
    this.flashSprite.position.copy(parent.worldToLocal(this.tmp.clone()))
    this.flashSprite.visible = true
    this.flashT = 0.09
  }
  private release(): void {
    this.explorer.locked = false
    this.lookTarget = null
  }
  /** 復活：回到校門外的起點，警衛收槍、關卡重置 */
  revive(): void {
    this.seq++
    this.tweens = []
    this.ui.hideDeath()
    this.ui.hideDialog()
    this.explorer.camFx.dy = 0
    this.explorer.camFx.roll = 0
    this.explorer.camFx.shake = 0
    this.guardDraw = 0
    this.guardStep.set(0, 0, 0)
    this.gate = 'idle'
    this.pass = false
    this.armed = true
    this.release()
    this.explorer.resetToStart()
  }
  private abortGate(): void {
    this.seq++
    this.tweens = []
    this.ui.hideDialog()
    this.gate = 'idle'
    this.armed = false
    this.release()
  }
  /** 測試／除錯：直接視為已出示學生證（煙霧測試專注在步道，不跑對話） */
  skipGate(): void {
    this.abortGate()
    this.pass = true
  }

  // ─── 砸車 ─────────────────────────────────────────
  private carLocal(p: Vec2): { lx: number; lz: number; d: number } {
    const root = this.props.car!.audi.root
    this.tmp.set(p.x, root.getWorldPosition(this.tmp2).y, p.z)
    root.worldToLocal(this.tmp)
    const dx = Math.max(Math.abs(this.tmp.x) - CAR_L / 2, 0)
    const dz = Math.max(Math.abs(this.tmp.z) - CAR_W / 2, 0)
    return { lx: this.tmp.x, lz: this.tmp.z, d: Math.hypot(dx, dz) }
  }
  /** 點擊／手機動作鈕：靠近車＝拿錘子或敲擊；靠近電梯＝按 F */
  action(ndc: THREE.Vector2 | null): void {
    if (this.blocking || this.explorer.mode !== 'walk') return
    if (this.nearLift && !this.nearCar && !this.equipped) {
      this.useLift()
      return
    }
    if (!this.equipped) {
      if (!this.nearCar) return
      this.equipped = true
      this.equipT = 0
      this.hammerPivot.visible = true
      this.ui.setHud(`損壞程度 ${Math.round(this.props.car!.audi.damage)}%`)
      this.ui.subtitle('你拿出了錘子。對準車子按左鍵敲下去。', 2600)
      return
    }
    if (this.swingT >= 0) return
    this.swingT = 0
    this.swingHit = false
    this.lastNdc = ndc
  }
  private strike(): void {
    const car = this.props.car!
    const cam = this.explorer.camera
    cam.updateMatrixWorld(true)
    this.ray.setFromCamera(this.lastNdc ?? new THREE.Vector2(0, 0), cam)
    this.ray.far = 3.8
    const hits = this.ray.intersectObjects(car.audi.targets, false).filter(h => !car.audi.passThrough(h.object))
    const h = hits[0]
    if (!h) {
      sfx.whoosh()
      return
    }
    const power = 0.85 + Math.random() * 0.3
    const info = car.audi.hit(h, this.ray.ray.direction, power)
    if (info.effect === 'crack') sfx.crack()
    else if (info.effect === 'shatter') sfx.shatter()
    else if (info.effect === 'break') sfx.pop()
    else sfx.metal(info.effect === 'clang' ? 0.5 : power)
    this.explorer.camFx.shake = 0.018
    this.ui.subtitle(`<b>你：</b>${CAR_LINE}`, 2400)
    this.ui.setHud(`${info.zone}・損壞程度 ${Math.round(info.total)}%`)
  }
  private unequip(): void {
    if (!this.equipped) return
    this.equipped = false
    this.hammerPivot.visible = false
    this.swingT = -1
    this.ui.setHud(null)
  }

  // ─── 電梯 ─────────────────────────────────────────
  private useLift(): void {
    const lift = this.props.lift
    if (!lift) return
    sfx.ding()
    this.liftReplyT = 3.4
    this.liftDoorT = 0
    const el = this.liftTag?.element
    if (el) {
      el.textContent = LIFT_REPLY
      el.classList.add('is-reply')
    }
    for (const b of lift.buttons) (b.material as THREE.MeshLambertMaterial).emissive.setHex(0xffb347)
  }

  private tween(dur: number, fn: (k: number) => void, done?: () => void): void {
    this.tweens.push({ t: 0, dur, fn, done })
  }

  update(dt: number): void {
    this.time += dt
    const t = this.time
    // 補間動畫
    if (this.tweens.length) {
      const list = this.tweens
      this.tweens = []
      const keep: Tween[] = []
      for (const tw of list) {
        tw.t += dt
        const k = Math.min(1, tw.t / tw.dur)
        tw.fn(k)
        if (k >= 1) tw.done?.()
        else keep.push(tw)
      }
      this.tweens = keep.concat(this.tweens)
    }
    const ex = this.explorer
    const walking = ex.mode === 'walk' && !this.isEditing()
    const p = ex.pos
    // 鏡頭特效衰減
    if (ex.camFx.shake > 0) ex.camFx.shake = Math.max(0, ex.camFx.shake - dt * 0.35)
    if (this.flashSprite && this.flashT > 0) {
      this.flashT -= dt
      if (this.flashT <= 0) this.flashSprite.visible = false
    }
    this.updateGuard(dt, walking, p)
    this.updateProjector(t)
    this.updateProtest(t, p)
    this.updateCar(dt, walking, p)
    this.updateLift(dt, walking, p)
    // 對話時讓視線轉向警衛
    if (this.lookTarget) {
      const cp = ex.camera.position
      const dx = this.lookTarget.x - cp.x
      const dz = this.lookTarget.z - cp.z
      const yaw = Math.atan2(-dx, -dz)
      const pitch = Math.atan2(this.lookTarget.y - cp.y, Math.hypot(dx, dz))
      const k = 1 - Math.exp(-dt * 6)
      ex.yaw += wrap(yaw - ex.yaw) * k
      ex.pitch += (pitch - ex.pitch) * k
    }
  }

  private updateGuard(dt: number, walking: boolean, p: Vec2): void {
    const g = this.props.guard
    if (!g) return
    const pr = g.person
    const parent = pr.root.parent
    if (!parent) return
    // 讓位：世界偏移轉成群組本地偏移
    const pyaw = parent.rotation.y
    const c = Math.cos(-pyaw)
    const s = Math.sin(-pyaw)
    pr.root.position.set(g.home.x + this.guardStep.x * c + this.guardStep.z * s, g.home.y, g.home.z - this.guardStep.x * s + this.guardStep.z * c)
    // 碰撞點跟著警衛走（讓位後不會擋在門口）
    pr.root.getWorldPosition(this.tmp)
    g.obstacle.x = this.tmp.x
    g.obstacle.z = this.tmp.z
    // 觸發與中止
    if (this.gate === 'idle' && !this.pass && walking) {
      const d = depth(p)
      if (!this.armed && d < -6.5) this.armed = true
      if (this.armed && d > -5.0 && d < 0.5 && Math.abs(lateral(p)) < 6) void this.startGate()
    } else if ((this.gate === 'intro' || this.gate === 'choose') && (!walking || Math.abs(depth(p)) > 12 || Math.abs(lateral(p)) > 10)) {
      // 對話中切換模式、傳送或重設：關閉對話
      this.abortGate()
    }
    // 面向玩家（附近或對話中），否則回到站崗方向
    pr.root.getWorldPosition(this.tmp)
    const dx = p.x - this.tmp.x
    const dz = p.z - this.tmp.z
    const near = Math.hypot(dx, dz) < 11 || this.gate !== 'idle'
    const want = near ? Math.atan2(dx, dz) - pyaw : g.homeYaw
    pr.root.rotation.y += wrap(want - pr.root.rotation.y) * (1 - Math.exp(-dt * 5))
    // 稍息 ↔ 舉槍：右臂（含手槍）指向玩家的眼睛
    const k = this.guardDraw
    let aimA = -Math.PI / 2
    let aimC = 0
    if (k > 0 && pr.shoulderR.parent) {
      pr.root.updateMatrixWorld(true)
      const d = pr.shoulderR.parent.worldToLocal(this.tmp2.copy(this.explorer.camera.position)).sub(pr.shoulderR.position).normalize()
      // 手臂原本朝 -y；Euler XYZ（b = 0）：v = (sin c, -cos c·cos a, -cos c·sin a)
      aimC = Math.asin(Math.max(-1, Math.min(1, d.x)))
      aimA = Math.atan2(-d.z, -d.y)
    }
    pr.shoulderR.rotation.x = lerp(0.25, aimA, k)
    pr.shoulderR.rotation.z = lerp(0, aimC, k)
    pr.elbowR.rotation.x = lerp(-0.5, 0, k)
    pr.shoulderL.rotation.x = lerp(0.25, -1.2, k)
    pr.elbowL.rotation.x = lerp(-0.5, -0.6, k)
    pr.shoulderL.rotation.z = lerp(0, 0.5, k)
    g.pistol.visible = k > 0.35
    ;(g.holster.children[1] as THREE.Object3D).visible = k <= 0.35
    // 舉槍時頭稍微低下瞄準
    pr.head.rotation.x = k * 0.08
  }

  private updateProjector(t: number): void {
    const pj = this.props.projector
    if (!pj) return
    const per = 3.6
    const idx = Math.floor(t / per) % PROJECTION_LINES.length
    const ph = (t % per) / per
    if (idx !== this.projIdx) {
      this.projIdx = idx
      drawProjection(pj.ctx, PROJECTION_LINES[idx])
      pj.tex.needsUpdate = true
    }
    let o = ph < 0.1 ? ph / 0.1 : ph > 0.88 ? (1 - ph) / 0.12 : 1
    o *= 0.93 + 0.07 * Math.sin(t * 37)
    ;(pj.screen.material as THREE.MeshBasicMaterial).opacity = o
    ;(pj.beam.material as THREE.MeshBasicMaterial).opacity = 0.015 + 0.06 * o
    pj.person.body.rotation.y = 0.05 * Math.sin(t * 0.7)
  }

  private updateProtest(t: number, p: Vec2): void {
    const pt = this.props.protest
    if (!pt) return
    const sp = pt.speaker
    const beat = Math.max(0, Math.sin(t * 5.2))
    sp.shoulderR.rotation.x = -1.9 - 0.7 * beat
    sp.shoulderR.rotation.z = 0.35 + 0.25 * Math.sin(t * 2.6)
    sp.elbowR.rotation.x = -0.3 - 0.5 * beat
    sp.body.rotation.x = 0.06 * Math.sin(t * 2.6)
    sp.head.rotation.x = -0.08 + 0.1 * beat
    sp.head.rotation.y = 0.35 * Math.sin(t * 0.9)
    sp.body.position.y = 0.025 * beat
    for (const [pr, ph] of [
      [pt.left, 0],
      [pt.right, 1.7],
    ] as const) {
      const b = Math.max(0, Math.sin(t * 3.1 + ph))
      pr.shoulderL.rotation.x = -2.2 - 0.6 * b
      pr.elbowL.rotation.x = -0.9 + 0.6 * b
      pr.shoulderR.rotation.z = 0.06 * Math.sin(t * 3.1 + ph)
      pr.body.position.y = 0.03 * b
    }
    if (this.bubble) {
      pt.bubbleAnchor.getWorldPosition(this.tmp)
      const near = this.explorer.mode === 'walk' && Math.hypot(this.tmp.x - p.x, this.tmp.z - p.z) < 18
      this.bubble.visible = near
      if (near) {
        const line = SPEECH[Math.floor(t / 2.3) % SPEECH.length]
        if (this.bubble.element.textContent !== line) this.bubble.element.textContent = line
      }
    }
  }

  private updateCar(dt: number, walking: boolean, p: Vec2): void {
    const car = this.props.car
    if (!car) return
    car.audi.update(dt)
    const { lx, lz, d } = this.carLocal(p)
    const centerD = Math.hypot(lx, lz)
    if (this.carRoof) this.carRoof.visible = walking && centerD < 24
    this.nearCar = walking && d < 1.9
    if (this.carPrompt) {
      this.carPrompt.visible = this.nearCar && !this.equipped
      if (this.carPrompt.visible) {
        // 提示放在最靠近玩家的車身側邊
        const cx = Math.max(-CAR_L / 2, Math.min(CAR_L / 2, lx))
        const cz = Math.max(-CAR_W / 2, Math.min(CAR_W / 2, lz))
        this.carPrompt.position.set(cx, 1.35, cz)
      }
    }
    if (this.equipped && (!walking || d > 6 || this.blocking)) this.unequip()
    // 手機：動作鈕
    if (this.coarse) {
      const label = this.nearCar ? (this.equipped ? '敲' : '砸車') : this.nearLift ? 'Ｆ' : this.equipped ? '敲' : null
      this.ui.setAction(walking && !this.blocking ? label : null)
    }
    this.ui.setCrosshair(this.equipped && (this.explorer.isLocked || this.coarse))
    // 錘子動畫：拿出 → 舉起 → 敲下 → 收回
    if (!this.equipped) return
    this.equipT = Math.min(1, this.equipT + dt / 0.25)
    const pv = this.hammerPivot
    pv.position.y = lerp(-0.95, -0.36, ease(this.equipT))
    if (this.swingT >= 0) {
      this.swingT += dt
      const s = this.swingT
      if (s < 0.07) pv.rotation.x = lerp(-0.25, 0.4, s / 0.07)
      else if (s < 0.15) pv.rotation.x = lerp(0.4, -1.15, (s - 0.07) / 0.08)
      else if (s < 0.45) pv.rotation.x = lerp(-1.15, -0.25, ease((s - 0.15) / 0.3))
      else {
        pv.rotation.x = -0.25
        this.swingT = -1
      }
      if (!this.swingHit && s >= 0.15) {
        this.swingHit = true
        this.strike()
      }
    } else {
      pv.rotation.x = -0.25 + 0.02 * Math.sin(this.time * 2)
    }
  }

  private updateLift(dt: number, walking: boolean, p: Vec2): void {
    const lift = this.props.lift
    if (!lift || !this.liftTag) return
    lift.anchor.getWorldPosition(this.tmp)
    this.nearLift = walking && !this.blocking && Math.hypot(this.tmp.x - p.x, this.tmp.z - p.z) < 3.2
    if (this.liftReplyT > 0) {
      this.liftReplyT -= dt
      if (this.liftReplyT <= 0) {
        this.liftTag.element.textContent = LIFT_PROMPT
        this.liftTag.element.classList.remove('is-reply')
        for (const b of lift.buttons) (b.material as THREE.MeshLambertMaterial).emissive.setHex(0x000000)
      }
    }
    this.liftTag.visible = this.nearLift || this.liftReplyT > 0
    // 電梯門：到站後開一條縫又關上
    if (this.liftDoorT >= 0) {
      this.liftDoorT += dt
      const s = this.liftDoorT
      const open = s < 0.6 ? 0 : s < 1.3 ? ease((s - 0.6) / 0.7) : s < 2.4 ? 1 : s < 3.1 ? 1 - ease((s - 2.4) / 0.7) : 0
      for (const d of lift.doors) d.position.x = (d.userData.home as number) + (d.userData.dir as number) * 0.32 * open
      if (s >= 3.1) this.liftDoorT = -1
    }
  }
}

import * as THREE from 'three'
import { ORIGIN, ORIGINAL_NEIGHBOR_POLYS, ORIGINAL_POLYS, centroid, type Vec2 } from './data'
import { LOADED_EDITS, isIdentity, saveEdits, transformPoint, type Edit, type Edits } from './edits'
import { KIND_LABEL, type Movable } from './movables'
import type { CampusWorld } from './world'

export interface EditSelection {
  id: string
  label: string
  num: string
  kind: string
  total: Edit
  /** 是否需重新整理才會更新碰撞與地形 */
  dataLevel: boolean
}

export interface EditorEvents {
  /** 選取或調整量改變 */
  change: (sel: EditSelection | null, editedCount: number) => void
}

const ZERO: Edit = { dx: 0, dz: 0, rot: 0 }

/**
 * 俯瞰下的物件編輯器：按住任何建模物件（校舍、民宅、樹、路燈、校門、舞台…）拖曳平移，Q/E（或按鈕）旋轉。
 * 調整量一律相對原始資料，存入 localStorage；校舍與民宅按「套用」重新整理後，地形高度與碰撞依新位置重建，
 * 其餘物件（含碰撞點）即時生效，下次啟動自動套用。
 */
export class BuildingEditor {
  active = false
  private selected: string | null = null
  private dragging = false
  private readonly ray = new THREE.Raycaster()
  private readonly ndc = new THREE.Vector2()
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly hit = new THREE.Vector3()
  private readonly grab = new THREE.Vector2()
  private readonly box = new THREE.Box3()
  private readonly helper: THREE.Box3Helper
  /** 標籤啟動時的位置與當時所屬物件的位置 */
  private readonly labelHome = new Map<THREE.Object3D, { pos: THREE.Vector3; at: Vec2 }>()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly world: CampusWorld,
    private readonly events: EditorEvents,
  ) {
    // 標籤建立於「資料層調整已套用、其他物件尚未移動」的位置
    for (const l of world.labels) {
      const m = this.byNum(l.landmark.num)
      const at = m ? (m.dataLevel ? this.posOf(m, LOADED_EDITS[m.id] ?? ZERO) : m.home) : { x: 0, z: 0 }
      this.labelHome.set(l.obj, { pos: l.obj.position.clone(), at })
    }
    for (const m of world.movables.items.values()) if (m.num && !isIdentity(m.edit)) this.moveLabels(m)
    this.helper = new THREE.Box3Helper(this.box, 0xd6336c)
    this.helper.visible = false
    ;(this.helper.material as THREE.LineBasicMaterial).depthTest = false
    this.helper.renderOrder = 10
    world.scene.add(this.helper)
    // capture：在 OrbitControls 之前攔截點到物件的按壓
    canvas.addEventListener('pointerdown', e => this.onDown(e), { capture: true })
    window.addEventListener('pointermove', e => this.onMove(e))
    window.addEventListener('pointerup', () => this.onUp())
    window.addEventListener('pointercancel', () => this.onUp())
    window.addEventListener('keydown', e => {
      if (!this.active || !this.selected) return
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      const step = e.shiftKey ? 1 : 5
      if (e.code === 'KeyQ') this.rotate(step)
      else if (e.code === 'KeyE') this.rotate(-step)
      else if (e.code === 'Escape') this.select(null)
    })
  }

  private get items(): Map<string, Movable> {
    return this.world.movables.items
  }

  private byNum(num: string): Movable | undefined {
    if (!num) return undefined
    for (const m of this.items.values()) if (m.num === num) return m
    return undefined
  }

  private posOf(m: Movable, e: Edit): Vec2 {
    return { x: m.home.x + e.dx, z: m.home.z + e.dz }
  }

  enable(): void {
    this.active = true
    this.emit()
  }

  disable(): void {
    this.active = false
    this.dragging = false
    this.select(null)
  }

  /** 已調整（相對原始資料）的物件數 */
  get editedCount(): number {
    return Object.keys(this.allEdits()).length
  }

  /** 是否有需要重新整理才完整生效的調整（校舍、民宅） */
  get needsReload(): boolean {
    for (const m of this.items.values()) {
      if (!m.dataLevel) continue
      const base = LOADED_EDITS[m.id] ?? ZERO
      if (Math.abs(base.dx - m.edit.dx) > 0.01 || Math.abs(base.dz - m.edit.dz) > 0.01 || Math.abs(base.rot - m.edit.rot) > 1e-4) return true
    }
    return false
  }

  /** 目前每個物件相對原始資料的總調整量 */
  allEdits(): Edits {
    const out: Edits = {}
    for (const m of this.items.values()) if (!isIdentity(m.edit)) out[m.id] = { ...m.edit }
    return out
  }

  rotate(deg: number): void {
    const m = this.selected ? this.items.get(this.selected) : undefined
    if (!m) return
    m.apply({ ...m.edit, rot: m.edit.rot + (deg * Math.PI) / 180 })
    this.commit(m)
  }

  resetSelected(): void {
    const m = this.selected ? this.items.get(this.selected) : undefined
    if (!m) return
    m.apply({ ...ZERO })
    this.commit(m)
  }

  resetAll(): void {
    for (const m of this.items.values()) {
      if (isIdentity(m.edit)) continue
      m.apply({ ...ZERO })
      this.moveLabels(m)
    }
    this.select(null)
    this.commit(null)
  }

  /** 匯入匯出檔（覆蓋目前的調整） */
  importEdits(edits: Edits): void {
    for (const m of this.items.values()) {
      const want = edits[m.id]
      if (!want && isIdentity(m.edit)) continue
      m.apply({ ...(want ?? ZERO) })
      this.moveLabels(m)
    }
    this.commit(null)
  }

  /** 匯出：每個調整過的物件（場景座標與經緯度；校舍與民宅另附新輪廓） */
  exportJson(): string {
    const { lat, lon, ox, oy } = ORIGIN
    const K = 111320 * Math.cos((lat * Math.PI) / 180)
    const toLL = (p: Vec2) => [+(lon + (p.x + ox) / K).toFixed(7), +(lat + (oy - p.z) / 110574).toFixed(7)]
    const r2 = (n: number) => +n.toFixed(2)
    const buildings: unknown[] = []
    const neighbors: unknown[] = []
    const objects: unknown[] = []
    for (const [id, e] of Object.entries(this.allEdits())) {
      const m = this.items.get(id)!
      const head = { id, kind: m.kind, name: m.label, num: m.num, dx: r2(e.dx), dz: r2(e.dz), rotDeg: r2((e.rot * 180) / Math.PI) }
      const raw = m.kind === 'building' ? ORIGINAL_POLYS[id] : m.kind === 'neighbor' ? ORIGINAL_NEIGHBOR_POLYS[id] : null
      if (raw) {
        const c0 = centroid(raw)
        const poly = raw.map(p => transformPoint(p, c0, e))
        const row = { ...head, poly: poly.map(p => [r2(p.x), r2(p.z)]), lonlat: poly.map(toLL) }
        ;(m.kind === 'building' ? buildings : neighbors).push(row)
      } else {
        const at = this.posOf(m, e)
        objects.push({ ...head, x: r2(at.x), z: r2(at.z), lonlat: toLL(at) })
      }
    }
    return JSON.stringify(
      {
        schema: 'shucampus.edits/v2',
        note: '場景座標單位公尺：x 向東、z 向南；dx/dz/rotDeg 為相對原始資料、繞原始中心的調整（rotDeg 正值為由上往下看逆時針）。',
        exportedAt: new Date().toISOString(),
        buildings,
        neighbors,
        objects,
      },
      null,
      2,
    )
  }

  private emit(): void {
    const m = this.selected ? this.items.get(this.selected) : undefined
    this.events.change(
      m ? { id: m.id, label: m.label, num: m.num ?? '', kind: KIND_LABEL[m.kind], total: { ...m.edit }, dataLevel: m.dataLevel } : null,
      this.editedCount,
    )
  }

  private commit(m: Movable | null): void {
    if (m) this.moveLabels(m)
    saveEdits(this.allEdits())
    this.refreshHelper()
    this.emit()
  }

  private moveLabels(m: Movable): void {
    if (!m.num) return
    const now = this.posOf(m, m.edit)
    for (const l of this.world.labels) {
      if (l.landmark.num !== m.num) continue
      const h = this.labelHome.get(l.obj)
      if (!h) continue
      l.obj.position.set(h.pos.x + now.x - h.at.x, h.pos.y, h.pos.z + now.z - h.at.z)
    }
  }

  private select(id: string | null): void {
    this.selected = id
    this.refreshHelper()
    this.emit()
  }

  private refreshHelper(): void {
    const m = this.selected ? this.items.get(this.selected) : undefined
    if (!m) {
      this.helper.visible = false
      return
    }
    m.bounds(this.box)
    this.helper.visible = !this.box.isEmpty()
  }

  private setRay(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.camera)
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return
    this.setRay(e)
    const hit = this.world.movables.pick(this.ray)
    if (!hit) return
    // 點到物件：攔下，不讓俯瞰鏡頭旋轉
    e.stopImmediatePropagation()
    e.preventDefault()
    if (this.selected !== hit.id) this.select(hit.id)
    const m = this.items.get(hit.id)!
    const at = this.posOf(m, m.edit)
    // 在點擊高度的水平面上拖曳，手感與游標一致
    this.plane.constant = -hit.point.y
    this.grab.set(at.x - hit.point.x, at.z - hit.point.z)
    this.dragging = true
    document.body.classList.add('is-dragging')
  }

  private onMove(e: PointerEvent): void {
    if (!this.dragging || !this.selected) return
    this.setRay(e)
    if (!this.ray.ray.intersectPlane(this.plane, this.hit)) return
    const m = this.items.get(this.selected)!
    m.apply({ dx: this.hit.x + this.grab.x - m.home.x, dz: this.hit.z + this.grab.y - m.home.z, rot: m.edit.rot })
    this.moveLabels(m)
    this.refreshHelper()
    this.emit()
  }

  private onUp(): void {
    if (!this.dragging) return
    this.dragging = false
    document.body.classList.remove('is-dragging')
    const m = this.selected ? this.items.get(this.selected) : undefined
    this.commit(m ?? null)
  }
}

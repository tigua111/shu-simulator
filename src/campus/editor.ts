import * as THREE from 'three'
import { BUILDINGS, ORIGIN, ORIGINAL_POLYS, centroid, type Building } from './data'
import { LOADED_EDITS, isIdentity, saveEdits, transformPoint, type Edit, type Edits } from './edits'
import type { CampusWorld } from './world'

export interface EditorEvents {
  /** 選取或調整量改變 */
  change: (sel: { b: Building; total: Edit } | null, editedCount: number) => void
}

/**
 * 俯瞰下的建築編輯器：按住建築拖曳平移、Q/E（或按鈕）旋轉。
 * 調整量相對原始資料累加並存入 localStorage；按「套用」重新整理後，地形高度與碰撞依新位置重建。
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
  private readonly helper: THREE.BoxHelper
  /** 啟動時各樞紐的原點（已含啟動前保存的調整） */
  private readonly home = new Map<string, THREE.Vector3>()
  private readonly labelHome = new Map<THREE.Object3D, THREE.Vector3>()
  private readonly byId = new Map(BUILDINGS.map(b => [b.id, b]))

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly world: CampusWorld,
    private readonly events: EditorEvents,
  ) {
    for (const [id, p] of world.buildingPivots) this.home.set(id, p.position.clone())
    for (const l of world.labels) this.labelHome.set(l.obj, l.obj.position.clone())
    this.helper = new THREE.BoxHelper(new THREE.Object3D(), 0xd6336c)
    this.helper.visible = false
    ;(this.helper.material as THREE.LineBasicMaterial).depthTest = false
    this.helper.renderOrder = 10
    world.scene.add(this.helper)
    // capture：在 OrbitControls 之前攔截點到建築的按壓
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

  enable(): void {
    this.active = true
    this.emit()
  }

  disable(): void {
    this.active = false
    this.dragging = false
    this.select(null)
  }

  /** 已調整（相對原始資料）的建築數 */
  get editedCount(): number {
    return Object.keys(this.allEdits()).length
  }

  /** 目前每棟相對原始資料的總調整量 */
  allEdits(): Edits {
    const out: Edits = {}
    for (const b of BUILDINGS) {
      const e = this.totalOf(b.id)
      if (!isIdentity(e)) out[b.id] = e
    }
    return out
  }

  private totalOf(id: string): Edit {
    const base = LOADED_EDITS[id] ?? { dx: 0, dz: 0, rot: 0 }
    const pivot = this.world.buildingPivots.get(id)
    const home = this.home.get(id)
    if (!pivot || !home) return base
    return { dx: base.dx + pivot.position.x - home.x, dz: base.dz + pivot.position.z - home.z, rot: base.rot + pivot.rotation.y }
  }

  rotate(deg: number): void {
    if (!this.selected) return
    const p = this.world.buildingPivots.get(this.selected)!
    p.rotation.y += (deg * Math.PI) / 180
    this.commit()
  }

  resetSelected(): void {
    if (!this.selected) return
    const id = this.selected
    const p = this.world.buildingPivots.get(id)!
    // 回到原始資料：抵銷啟動時已套用的調整
    const base = LOADED_EDITS[id]
    const home = this.home.get(id)!
    if (base) {
      // 啟動時的質心 = 原始質心 + 平移，故樞紐回到 home - 平移，旋轉抵銷
      p.position.set(home.x - base.dx, 0, home.z - base.dz)
      p.rotation.y = -base.rot
    } else {
      p.position.copy(home)
      p.rotation.y = 0
    }
    this.commit()
  }

  resetAll(): void {
    for (const b of BUILDINGS) {
      this.selected = b.id
      this.resetSelected()
    }
    this.selected = null
    this.helper.visible = false
    this.commit()
  }

  /** 匯入匯出檔（覆蓋目前的調整） */
  importEdits(edits: Edits): void {
    for (const b of BUILDINGS) {
      const p = this.world.buildingPivots.get(b.id)!
      const home = this.home.get(b.id)!
      const base = LOADED_EDITS[b.id] ?? { dx: 0, dz: 0, rot: 0 }
      const want = edits[b.id] ?? { dx: 0, dz: 0, rot: 0 }
      p.position.set(home.x + want.dx - base.dx, 0, home.z + want.dz - base.dz)
      p.rotation.y = want.rot - base.rot
      this.moveLabels(b)
    }
    this.commit()
  }

  /** 匯出：每棟調整量與新輪廓（場景座標與經緯度） */
  exportJson(): string {
    const { lat, lon, ox, oy } = ORIGIN
    const K = 111320 * Math.cos((lat * Math.PI) / 180)
    const toLL = (p: { x: number; z: number }) => {
      const x = p.x + ox
      const y = oy - p.z
      return [+(lon + x / K).toFixed(7), +(lat + y / 110574).toFixed(7)]
    }
    const edits = this.allEdits()
    const buildings = Object.entries(edits).map(([id, e]) => {
      const b = this.byId.get(id)!
      const raw = ORIGINAL_POLYS[id]
      const c0 = centroid(raw)
      const poly = raw.map(p => transformPoint(p, c0, e))
      return {
        id,
        num: b.num,
        name: b.name,
        dx: +e.dx.toFixed(2),
        dz: +e.dz.toFixed(2),
        rotDeg: +((e.rot * 180) / Math.PI).toFixed(2),
        poly: poly.map(p => [+p.x.toFixed(2), +p.z.toFixed(2)]),
        lonlat: poly.map(toLL),
      }
    })
    return JSON.stringify(
      {
        schema: 'shucampus.buildingEdits/v1',
        note: '場景座標單位公尺：x 向東、z 向南；dx/dz/rotDeg 為相對原始資料、繞原始質心的調整（rotDeg 正值為由上往下看逆時針）。',
        exportedAt: new Date().toISOString(),
        buildings,
      },
      null,
      2,
    )
  }

  private emit(): void {
    const b = this.selected ? this.byId.get(this.selected)! : null
    this.events.change(b ? { b, total: this.totalOf(b.id) } : null, this.editedCount)
  }

  private commit(): void {
    if (this.selected) this.moveLabels(this.byId.get(this.selected)!)
    saveEdits(this.allEdits())
    this.refreshHelper()
    this.emit()
  }

  private moveLabels(b: Building): void {
    const p = this.world.buildingPivots.get(b.id)!
    const home = this.home.get(b.id)!
    for (const l of this.world.labels) {
      if (l.landmark.num !== b.num) continue
      const h = this.labelHome.get(l.obj)!
      l.obj.position.set(h.x + p.position.x - home.x, h.y, h.z + p.position.z - home.z)
    }
  }

  private select(id: string | null): void {
    this.selected = id
    this.refreshHelper()
    this.emit()
  }

  private refreshHelper(): void {
    const pivot = this.selected ? this.world.buildingPivots.get(this.selected) : null
    if (!pivot) {
      this.helper.visible = false
      return
    }
    this.helper.setFromObject(pivot)
    this.helper.visible = true
  }

  private pick(e: PointerEvent): { id: string; point: THREE.Vector3 } | null {
    const r = this.canvas.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.camera)
    const meshes = this.world.occluders.filter(m => m.userData.bid)
    const hit = this.ray.intersectObjects(meshes, false)[0]
    if (!hit) return null
    return { id: hit.object.userData.bid as string, point: hit.point }
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return
    const hit = this.pick(e)
    if (!hit) return
    // 點到建築：攔下，不讓俯瞰鏡頭旋轉
    e.stopImmediatePropagation()
    e.preventDefault()
    if (this.selected !== hit.id) this.select(hit.id)
    const pivot = this.world.buildingPivots.get(hit.id)!
    // 在點擊高度的水平面上拖曳，手感與游標一致
    this.plane.constant = -hit.point.y
    this.grab.set(pivot.position.x - hit.point.x, pivot.position.z - hit.point.z)
    this.dragging = true
    document.body.classList.add('is-dragging')
  }

  private onMove(e: PointerEvent): void {
    if (!this.dragging || !this.selected) return
    const r = this.canvas.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.camera)
    if (!this.ray.ray.intersectPlane(this.plane, this.hit)) return
    const p = this.world.buildingPivots.get(this.selected)!
    p.position.x = this.hit.x + this.grab.x
    p.position.z = this.hit.z + this.grab.y
    this.moveLabels(this.byId.get(this.selected)!)
    this.refreshHelper()
    this.emit()
  }

  private onUp(): void {
    if (!this.dragging) return
    this.dragging = false
    document.body.classList.remove('is-dragging')
    this.commit()
  }
}

import * as THREE from 'three'
import type { Vec2 } from './data'
import type { Edit } from './edits'
import type { Obstacle } from './geometry'

export type MovableKind = 'building' | 'neighbor' | 'tree' | 'palm' | 'lamp' | 'object'

export const KIND_LABEL: Record<MovableKind, string> = {
  building: '校舍',
  neighbor: '周邊民宅',
  tree: '樹木',
  palm: '大王椰子',
  lamp: '路燈',
  object: '構造物',
}

/**
 * 編輯模式中可拖曳／旋轉的物件。
 * edit 一律是「相對原始資料」的總調整量；dataLevel 物件（建築、鄰房）的調整會在下次啟動時寫回資料、重建碰撞與地形，
 * 其餘物件於啟動後直接套用到三維物件與碰撞點。
 */
export interface Movable {
  id: string
  kind: MovableKind
  label: string
  /** 對應地標編號（標籤跟著移動） */
  num?: string
  /** 原始（未調整）位置，旋轉樞紐 */
  home: Vec2
  edit: Edit
  dataLevel: boolean
  apply(e: Edit): void
  /** 外框（選取框線用） */
  bounds(target: THREE.Box3): THREE.Box3
}

export class MovableRegistry {
  readonly items = new Map<string, Movable>()
  /** 一般群組：命中後沿 parent 找 userData.mid */
  readonly roots: THREE.Object3D[] = []
  /** 實例化網格：instanceId → 物件 id */
  readonly instanced = new Map<THREE.InstancedMesh, string[]>()

  add(m: Movable, root?: THREE.Object3D): void {
    this.items.set(m.id, m)
    if (root) {
      root.userData.mid = m.id
      this.roots.push(root)
    }
  }

  addInstanced(mesh: THREE.InstancedMesh, ids: string[]): void {
    this.instanced.set(mesh, ids)
  }

  pick(ray: THREE.Raycaster): { id: string; point: THREE.Vector3 } | null {
    const targets: THREE.Object3D[] = [...this.roots, ...this.instanced.keys()]
    const hits = ray.intersectObjects(targets, true)
    for (const h of hits) {
      if (h.object instanceof THREE.InstancedMesh && h.instanceId !== undefined) {
        const ids = this.instanced.get(h.object)
        if (ids?.[h.instanceId]) return { id: ids[h.instanceId], point: h.point }
        continue
      }
      let o: THREE.Object3D | null = h.object
      while (o && !o.userData.mid) o = o.parent
      if (o) return { id: o.userData.mid as string, point: h.point }
    }
    return null
  }
}

/** 繞 c 旋轉 rot 後平移；與 three.js rotation.y 同向（同 edits.transformPoint） */
export function movePoint(p: Vec2, c: Vec2, e: Edit): Vec2 {
  const cos = Math.cos(e.rot)
  const sin = Math.sin(e.rot)
  const x = p.x - c.x
  const z = p.z - c.z
  return { x: c.x + x * cos + z * sin + e.dx, z: c.z - x * sin + z * cos + e.dz }
}

/** 碰撞點跟著物件移動（保存原始位置） */
export function bindObstacles(obs: Obstacle[], c: Vec2): (e: Edit) => void {
  const orig = obs.map(o => ({ x: o.x, z: o.z }))
  return e => {
    obs.forEach((o, i) => {
      const q = movePoint(orig[i], c, e)
      o.x = q.x
      o.z = q.z
    })
  }
}

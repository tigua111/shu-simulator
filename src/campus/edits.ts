/**
 * 使用者在「編輯」模式中拖曳／旋轉物件（校舍、民宅、樹、路燈、構造物）的調整量。保存在瀏覽器 localStorage，
 * 啟動時套用到建築輪廓（相對原始資料：先繞原始質心旋轉，再平移）。
 */
export interface Edit {
  /** 平移（公尺，x 向東、z 向南） */
  dx: number
  dz: number
  /** 繞質心旋轉（弧度，與 three.js rotation.y 同向） */
  rot: number
}
export type Edits = Record<string, Edit>
export const EDIT_KEY = 'shucampus.buildingEdits.v1'

function valid(e: unknown): e is Edit {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return [o.dx, o.dz, o.rot].every(v => typeof v === 'number' && Number.isFinite(v))
}

export function loadEdits(): Edits {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(EDIT_KEY)
    if (!raw) return {}
    return sanitize(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function sanitize(data: unknown): Edits {
  const out: Edits = {}
  if (!data || typeof data !== 'object') return out
  // 接受 { id: edit } 或匯出檔格式 { buildings / neighbors / objects: [{ id, dx, dz, rotDeg }] }
  const d = data as { buildings?: unknown; neighbors?: unknown; objects?: unknown }
  const lists = [d.buildings, d.neighbors, d.objects].filter(Array.isArray) as unknown[][]
  if (lists.length) {
    for (const b of lists.flat()) {
      const o = b as Record<string, unknown>
      if (typeof o.id !== 'string') continue
      const e = { dx: Number(o.dx), dz: Number(o.dz), rot: (Number(o.rotDeg) * Math.PI) / 180 }
      if (valid(e)) out[o.id] = e
    }
    return out
  }
  for (const [id, e] of Object.entries(data as Record<string, unknown>)) if (valid(e)) out[id] = { dx: e.dx, dz: e.dz, rot: e.rot }
  return out
}

export function saveEdits(edits: Edits): void {
  try {
    const clean: Edits = {}
    for (const [id, e] of Object.entries(edits)) if (!isIdentity(e)) clean[id] = e
    if (Object.keys(clean).length) localStorage.setItem(EDIT_KEY, JSON.stringify(clean))
    else localStorage.removeItem(EDIT_KEY)
  } catch {
    /* 無痕模式等無法保存時略過 */
  }
}

export function isIdentity(e: Edit): boolean {
  return Math.abs(e.dx) < 0.01 && Math.abs(e.dz) < 0.01 && Math.abs(e.rot) < 1e-4
}

/** 繞 c 旋轉 rot 後平移 (dx, dz)；旋轉方向與 three.js 的 rotation.y 相同 */
export function transformPoint<T extends { x: number; z: number }>(p: T, c: { x: number; z: number }, e: Edit): { x: number; z: number } {
  const cos = Math.cos(e.rot)
  const sin = Math.sin(e.rot)
  const x = p.x - c.x
  const z = p.z - c.z
  return { x: c.x + x * cos + z * sin + e.dx, z: c.z - x * sin + z * cos + e.dz }
}

/** 啟動時讀到的調整（整個工作階段固定；編輯中的變動另行累加） */
export const LOADED_EDITS: Edits = loadEdits()

import { describe, expect, it } from 'vitest'
import { BUILDINGS, DESTINATION, ORIGIN, ROUTE, START, buildingById, groundHeight } from '../src/campus/data'
import { LANDMARKS } from '../src/campus/landmarks'
import { isWalkable, pointInPolygon, resolveMove, routeLength, samplePath } from '../src/campus/geometry'

/** 場景座標 → 經緯度（與 geo/build_site.py 相同的等距投影） */
function toLatLon(x: number, z: number): { lat: number; lon: number } {
  const lx = x + ORIGIN.ox
  const ly = ORIGIN.oy - z
  const k = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)
  return { lat: ORIGIN.lat + ly / 110574, lon: ORIGIN.lon + lx / k }
}

describe('真實座標', () => {
  it('主要建物質心與 OpenStreetMap 位置一致（誤差 < 約 10 公尺）', () => {
    // 期望值：OSM 建物節點平均（2026-10 下載）
    const expected: Record<string, [number, number]> = {
      C: [24.98948, 121.54891], // 傳播大廈
      A: [24.98958, 121.54737], // 大禮堂
      L: [24.99016, 121.54513], // 圖書館
      M: [24.98731, 121.54794], // 管院大樓
    }
    for (const [id, [lat, lon]] of Object.entries(expected)) {
      const b = buildingById(id)
      const ll = toLatLon(b.c.x, b.c.z)
      expect(Math.abs(ll.lat - lat) * 110574, `${id} 南北誤差`).toBeLessThan(10)
      expect(Math.abs(ll.lon - lon) * 100935, `${id} 東西誤差`).toBeLessThan(10)
    }
  })
  it('前校門到傳播大廈直線距離約 530 公尺', () => {
    const d = Math.hypot(DESTINATION.x - START.pos.x, DESTINATION.z - START.pos.z)
    expect(d).toBeGreaterThan(500)
    expect(d).toBeLessThan(560)
  })
  it('校舍彼此不重疊', () => {
    for (const a of BUILDINGS)
      for (const b of BUILDINGS) {
        if (a === b) continue
        expect(pointInPolygon(a.c, b.pts) && pointInPolygon(b.c, a.pts), `${a.id} / ${b.id}`).toBe(false)
      }
  })
  it('地面高程在合理範圍（海拔 8–32 公尺）', () => {
    for (const p of ROUTE) {
      const h = groundHeight(p.x, p.z)
      expect(h).toBeGreaterThan(8)
      expect(h).toBeLessThan(32)
    }
  })
})

describe('步行動線', () => {
  it('主動線每 1 公尺都可站立（半徑 0.9 公尺）', () => {
    const total = routeLength(ROUTE)
    expect(total).toBeGreaterThan(600)
    for (let s = 0; s <= total; s += 1) {
      const { p } = samplePath(ROUTE, s)
      expect(isWalkable(p, 0.9), `route blocked at s=${s} (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).toBe(true)
    }
  })
  it('依碰撞規則逐步行走可從前校門走到傳播大廈', () => {
    let pos = { ...START.pos }
    const total = routeLength(ROUTE)
    for (let s = 0; s <= total; s += 0.5) {
      const { p } = samplePath(ROUTE, s)
      pos = resolveMove(pos, p, 0.9)
    }
    expect(Math.hypot(pos.x - DESTINATION.x, pos.z - DESTINATION.z)).toBeLessThan(2)
  })
  it('起點、終點與每個地標站點都可以站立', () => {
    expect(isWalkable(START.pos)).toBe(true)
    expect(isWalkable(DESTINATION)).toBe(true)
    expect(LANDMARKS).toHaveLength(21)
    for (const l of LANDMARKS) expect(isWalkable(l.spot), `${l.num} ${l.name}`).toBe(true)
  })
})

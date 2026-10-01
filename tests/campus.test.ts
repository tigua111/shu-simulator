import { describe, expect, it } from 'vitest'
import { BUILDINGS, CAMPUS_POLYGON, DESTINATION, LANDMARKS, ROUTE, START } from '../src/campus/data'
import { insideBuilding, isWalkable, pointInPolygon, resolveMove, routeLength, samplePath } from '../src/campus/geometry'

describe('校園配置', () => {
  it('主動線每 1 公尺都在可步行範圍且不穿過建築', () => {
    const total = routeLength(ROUTE)
    expect(total).toBeGreaterThan(300)
    for (let s = 0; s <= total; s += 1) {
      const { p } = samplePath(ROUTE, s)
      expect(isWalkable(p, 0.9), `route blocked at s=${s} (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).toBe(true)
    }
  })

  it('起點、終點與每個地標站點都可以站立', () => {
    expect(isWalkable(START.pos)).toBe(true)
    expect(isWalkable(DESTINATION)).toBe(true)
    for (const l of LANDMARKS) expect(isWalkable(l.spot), `${l.num} ${l.name}`).toBe(true)
  })

  it('校內建築不互相重疊，且每個導覽編號都有地標', () => {
    const named = BUILDINGS.filter(b => b.num)
    for (const a of named) {
      for (const b of named) {
        if (a === b) continue
        expect(insideBuilding({ x: a.x, z: a.z }, b), `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }
    const nums = new Set(LANDMARKS.map(l => l.num))
    for (const n of ['01', '02', '03', '05', '06', '07', '08', '09', '12', '13', '14', '16', '17', '18', '19', '20', '21']) expect(nums.has(n)).toBe(true)
  })

  it('碰撞會擋住建築與校園邊界', () => {
    const c = BUILDINGS.find(b => b.id === 'C')!
    const from = { x: c.x, z: c.z + c.d / 2 + 3 }
    const to = { x: c.x, z: c.z }
    const end = resolveMove(from, to)
    expect(insideBuilding(end, c)).toBe(false)
    // 校門隧道外側（山壁）不可走
    const blocked = resolveMove({ x: -104, z: 110 }, { x: -96, z: 110 })
    expect(blocked.x).toBeLessThan(-100.5)
    expect(pointInPolygon({ x: 0, z: 0 }, CAMPUS_POLYGON)).toBe(true)
  })
})

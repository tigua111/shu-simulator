import { AREAS, BACK_GATE, FRONT_GATE, PATHS, ROUTE, STAGE, START, TRACK, buildingById, centroid, type Vec2 } from './data'
import { distToPolygonEdge, distToPolyline, isWalkable, pointInPolygon, resample } from './geometry'

export interface Landmark {
  num: string
  name: string
  short: string
  desc: string
  /** 標籤錨點 */
  at: Vec2
  /** 標籤相對地面的高度 */
  labelHeight: number
  /** 快捷跳轉時的站立點與面向目標 */
  spot: Vec2
  look: Vec2
  /** 位於主動線（前校門 → 傳播大廈 C 棟）旁 */
  onRoute: boolean
}

type Target = { kind: 'building'; id: string } | { kind: 'area'; id: string } | { kind: 'point'; at: Vec2; h: number }

interface Def {
  num: string
  name: string
  short: string
  desc: string
  target: Target
}

const DEFS: Def[] = [
  { num: '01', name: '前校門', short: '前校門', desc: '木柵路一段旁的粉色石造拱門，門後就是穿山而過、約 70 公尺長的隧道，出隧道後沿坡道上到校園平台。', target: { kind: 'point', at: { x: FRONT_GATE.x, z: FRONT_GATE.z }, h: 13 } },
  { num: '02', name: '新聞大樓 J', short: '新聞 J', desc: '前校門西側、臨木柵路的新聞大樓。', target: { kind: 'building', id: 'J' } },
  { num: '03', name: '世界大廈 W', short: '世界 W', desc: '前校門東側的粉色大樓，面向木柵路，是在校門口第一眼看到的建築。', target: { kind: 'building', id: 'W' } },
  { num: '04', name: '學生宿舍・翠谷餐廳', short: '宿舍・翠谷', desc: '出隧道後坡道東側，女生第一宿舍、男生第二宿舍與翠谷餐廳沿坡排列。', target: { kind: 'building', id: 'D2' } },
  { num: '05', name: '行政大樓', short: '行政大樓', desc: '坡道頂端、八方廣場西側的行政大樓。', target: { kind: 'building', id: 'ADM' } },
  { num: '06', name: '言論廣場', short: '言論廣場', desc: '圖書館、通識大樓前的開放廣場，與八方廣場相連。', target: { kind: 'area', id: 'speech' } },
  { num: '07', name: '廣電大樓 T', short: '廣電 T', desc: '男生第二宿舍東側、南面山坡上的廣電大樓。', target: { kind: 'building', id: 'T' } },
  { num: '08', name: '圖書館 L', short: '圖書館 L', desc: '校區西北側最大的建築，前方有戶外劇場與階梯。', target: { kind: 'building', id: 'L' } },
  { num: '09', name: '通識大樓 G', short: '通識 G', desc: '圖書館南側、緊鄰言論廣場的通識大樓。', target: { kind: 'building', id: 'G' } },
  { num: '10', name: '廣電大樓 B', short: '廣電 B', desc: '舍我樓西南側的廣播電視教學大樓。', target: { kind: 'building', id: 'B' } },
  { num: '11', name: '管院大樓 M', short: '管院 M', desc: '校區東南側、臨木柵路一段的管理學院大樓，由試院路下坡可到。', target: { kind: 'building', id: 'M' } },
  { num: '12', name: '舍我樓 R', short: '舍我 R', desc: '紅磚色舍我樓的西翼，主動線從它南側經過。', target: { kind: 'building', id: 'R' } },
  { num: '13', name: '舍我樓 S', short: '舍我 S', desc: '舍我樓東側塔樓，一樓有騎樓通道可直接穿過到北側。', target: { kind: 'building', id: 'S' } },
  { num: '14', name: '學校廣場', short: '學校廣場', desc: '舍我樓與大禮堂之間的大廣場，北端是後校門，東南角有八風舞台。', target: { kind: 'area', id: 'school-plaza' } },
  { num: '15', name: '八風舞台', short: '八風舞台', desc: '學校廣場南端的圓形戶外舞台。', target: { kind: 'point', at: { x: STAGE.x, z: STAGE.z }, h: 7 } },
  { num: '16', name: '後校門', short: '後校門', desc: '學校廣場北端，通往試院路。', target: { kind: 'point', at: { x: BACK_GATE.x, z: BACK_GATE.z }, h: 7 } },
  { num: '17', name: '大禮堂 A', short: '大禮堂 A', desc: '白牆紅豎條的大禮堂，北側有階梯步道通往操場。', target: { kind: 'building', id: 'A' } },
  { num: '18', name: '操場', short: '操場', desc: '紅色跑道與綠色球場，西側是網球場；沿北緣步道往東就到傳播大廈。', target: { kind: 'point', at: { x: TRACK.x, z: TRACK.z }, h: 5 } },
  { num: '19', name: '傳播大廈 C', short: '傳播 C', desc: '新聞傳播學院所在地，位於操場東側後方；入口在東側階梯。', target: { kind: 'building', id: 'C' } },
  { num: '20', name: '全媒體大樓', short: '全媒體', desc: '管院大樓北側的全媒體大樓（8 層）。', target: { kind: 'building', id: 'OM' } },
  { num: '21', name: '智能攝製基地', short: '攝製基地', desc: '大禮堂東側、操場南邊的攝影棚建築。', target: { kind: 'building', id: 'V' } },
]

/** 觀看點候選：所有步道與鋪面區的取樣點 */
function candidates(): { p: Vec2; route: boolean }[] {
  const out: { p: Vec2; route: boolean }[] = []
  for (const path of PATHS) {
    if (path.kind === 'tunnel') continue
    for (const p of resample(path.pts, 2)) out.push({ p, route: false })
  }
  for (const a of AREAS) {
    if (a.kind === 'apron') continue
    const xs = a.pts.map(p => p.x)
    const zs = a.pts.map(p => p.z)
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 3)
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 3) if (pointInPolygon({ x, z }, a.pts)) out.push({ p: { x, z }, route: false })
  }
  for (const p of resample(ROUTE, 2)) out.push({ p, route: true })
  return out.filter(c => isWalkable(c.p, 1.2))
}

function build(): Landmark[] {
  const cands = candidates()
  return DEFS.map(d => {
    let at: Vec2
    let labelHeight: number
    let dist: (p: Vec2) => number
    let want: number
    if (d.target.kind === 'building') {
      const b = buildingById(d.target.id)
      at = b.c
      labelHeight = b.h + 3.5
      dist = p => distToPolygonEdge(p, b.pts)
      want = Math.min(42, Math.max(12, b.h * 0.8 + 6))
    } else if (d.target.kind === 'area') {
      const id = d.target.id
      const a = AREAS.find(x => x.id === id)!
      at = centroid(a.pts)
      labelHeight = 5
      dist = p => Math.hypot(p.x - at.x, p.z - at.z)
      want = 14
    } else {
      at = d.target.at
      labelHeight = d.target.h
      dist = p => Math.hypot(p.x - at.x, p.z - at.z)
      want = d.num === '18' ? 34 : 12
    }
    let spot = cands[0].p
    if (d.num === '01') spot = START.pos
    else {
      let best = Infinity
      for (const c of cands) {
        const s = Math.abs(dist(c.p) - want) + (c.route ? 0 : 3)
        if (s < best) {
          best = s
          spot = c.p
        }
      }
    }
    const onRoute = d.target.kind === 'building' ? distToPolyline(at, ROUTE) < 40 : distToPolyline(at, ROUTE) < 30
    return { num: d.num, name: d.name, short: d.short, desc: d.desc, at, labelHeight, spot, look: at, onRoute }
  })
}

export const LANDMARKS: Landmark[] = build()

/**
 * 世新大學概念配置資料。座標單位約為公尺：x 向東、z 向南（三維場景 -z 為北）。
 * 位置依官方校園導覽圖（https://www.shu.edu.tw/SHU-Location.aspx）的相對關係推估，
 * 並非測繪資料；尺寸與樓高為概念值。
 */

export type Vec2 = { x: number; z: number }

export type BuildingStyle =
  | 'pinkTile' // 粉色磁磚（世界大廈、新聞大樓）
  | 'brick' // 紅磚色（舍我樓、廣電大樓）
  | 'auditorium' // 白牆紅豎條（大禮堂）
  | 'whiteTile' // 白色磁磚（傳播大廈、圖書館）
  | 'glass' // 玻璃帷幕（全媒體大樓）
  | 'concrete' // 灰色廠房（智能攝製基地）
  | 'city' // 校外街廓

export interface Building {
  id: string
  /** 導覽圖編號，例如 "19"；校外建物為空字串 */
  num: string
  name: string
  code?: string
  x: number
  z: number
  /** 沿本地 x 的寬度 */
  w: number
  /** 沿本地 z 的深度 */
  d: number
  h: number
  /** 繞 y 軸旋轉（弧度） */
  rot: number
  style: BuildingStyle
  floors: number
}

export interface Landmark {
  num: string
  name: string
  short: string
  desc: string
  /** 標籤錨點 */
  at: Vec2
  labelHeight: number
  /** 快捷跳轉時的站立點與面向目標 */
  spot: Vec2
  look: Vec2
  /** 屬於主動線（校門 → 傳播 C 棟） */
  onRoute: boolean
}

export const BUILDINGS: Building[] = [
  { id: 'J', num: '02', name: '新聞大樓', code: 'J', x: -150, z: 112, w: 36, d: 18, h: 16, rot: 0, style: 'pinkTile', floors: 4 },
  { id: 'W', num: '03', name: '世界大廈', code: 'W', x: -82, z: 104, w: 18, d: 34, h: 23, rot: 0, style: 'pinkTile', floors: 6 },
  { id: 'D', num: '04', name: '翠谷餐廳・學生宿舍', x: -52, z: 50, w: 20, d: 30, h: 18, rot: 0.3, style: 'pinkTile', floors: 5 },
  { id: 'ADM', num: '05', name: '行政大樓', x: -114, z: 0, w: 20, d: 26, h: 18, rot: 0.2, style: 'pinkTile', floors: 5 },
  { id: 'T', num: '07', name: '廣電大樓', code: 'T', x: -28, z: 4, w: 18, d: 22, h: 16, rot: 0.3, style: 'brick', floors: 4 },
  { id: 'L', num: '08', name: '圖書館', code: 'L', x: -130, z: -48, w: 26, d: 30, h: 22, rot: 0.2, style: 'whiteTile', floors: 6 },
  { id: 'G', num: '09', name: '通識大樓', code: 'G', x: -98, z: -58, w: 16, d: 22, h: 26, rot: 0, style: 'whiteTile', floors: 7 },
  { id: 'B', num: '10', name: '廣電大樓（廣播電視教學中心）', code: 'B', x: -12, z: -28, w: 20, d: 16, h: 14, rot: 0.3, style: 'brick', floors: 4 },
  { id: 'M', num: '11', name: '管院大樓', code: 'M', x: 172, z: -8, w: 18, d: 34, h: 48, rot: 0, style: 'pinkTile', floors: 13 },
  { id: 'R', num: '12', name: '舍我樓教學大樓', code: 'R', x: -32, z: -58, w: 24, d: 24, h: 30, rot: 0, style: 'brick', floors: 8 },
  { id: 'S', num: '13', name: '舍我樓研究大樓', code: 'S', x: -38, z: -115, w: 20, d: 20, h: 52, rot: 0, style: 'brick', floors: 14 },
  { id: 'A', num: '17', name: '大禮堂', code: 'A', x: 72, z: -124, w: 40, d: 30, h: 24, rot: 0, style: 'auditorium', floors: 6 },
  { id: 'C', num: '19', name: '傳播大廈', code: 'C', x: 160, z: -193, w: 34, d: 16, h: 26, rot: -0.12, style: 'whiteTile', floors: 7 },
  { id: 'OM', num: '20', name: '全媒體大樓', x: 146, z: 14, w: 20, d: 20, h: 28, rot: 0.1, style: 'glass', floors: 7 },
  { id: 'V', num: '21', name: '智能攝製基地', x: 184, z: -140, w: 18, d: 30, h: 12, rot: 0, style: 'concrete', floors: 2 },
  // 校門對街的一般街廓（純背景）
  { id: 'X1', num: '', name: '', x: -170, z: 176, w: 40, d: 24, h: 14, rot: 0, style: 'city', floors: 4 },
  { id: 'X2', num: '', name: '', x: -110, z: 180, w: 50, d: 26, h: 20, rot: 0, style: 'city', floors: 6 },
  { id: 'X3', num: '', name: '', x: -40, z: 178, w: 44, d: 24, h: 11, rot: 0, style: 'city', floors: 3 },
  { id: 'X4', num: '', name: '', x: 20, z: 182, w: 40, d: 30, h: 17, rot: 0, style: 'city', floors: 5 },
]

/** 前校門（拱門）中心與隧道範圍：x 寬 7m，自 z=128 向北到 z=94。 */
export const GATE = { x: -104, z: 128, width: 7, tunnelEndZ: 94 }

/** 操場（田徑場）概念尺寸：中心、直道長、半徑 */
export const TRACK = { x: 128, z: -152, straight: 34, outerR: 20, laneW: 6 }

/** 籃球場（依操場照片推估位於大禮堂旁） */
export const COURT = { x: 128, z: -112, w: 26, d: 14 }

/** 八風舞台 */
export const STAGE = { x: 82, z: -80, w: 14, d: 10 }

/** 後校門 */
export const BACK_GATE = { x: 5, z: -142 }

/** 鋪面廣場 */
export const PLAZAS: { x: number; z: number; r: number }[] = [
  { x: -62, z: -14, r: 14 }, // 06 言論廣場
  { x: 25, z: -102, r: 17 }, // 14 學校廣場
  { x: -104, z: 140, r: 9 }, // 校門口
  { x: 155, z: -178, r: 8 }, // 傳播大廈入口
]

/** 主動線：前校門 → 傳播大廈 C 棟（自動導覽與小地圖路線） */
export const ROUTE: Vec2[] = [
  { x: -104, z: 146 },
  { x: -104, z: 128 },
  { x: -104, z: 94 },
  { x: -90, z: 70 },
  { x: -82, z: 40 },
  { x: -72, z: 12 },
  { x: -62, z: -14 },
  { x: -62, z: -45 },
  { x: -62, z: -84 },
  { x: -20, z: -88 },
  { x: 25, z: -102 },
  { x: 60, z: -100 },
  { x: 97, z: -102 },
  { x: 100, z: -140 },
  { x: 128, z: -152 },
  { x: 150, z: -174 },
  { x: 156, z: -180 },
]

/** 其他鋪面步道（自由步行用） */
export const LANES: Vec2[][] = [
  [{ x: -200, z: 140 }, { x: 10, z: 140 }], // 校門外道路
  [{ x: -72, z: 12 }, { x: -100, z: 6 }], // 往行政大樓
  [{ x: -62, z: -30 }, { x: -112, z: -36 }], // 往圖書館
  [{ x: -62, z: -14 }, { x: -24, z: -22 }], // 往廣電 B
  [{ x: 25, z: -102 }, { x: 5, z: -140 }], // 往後校門
  [{ x: 60, z: -100 }, { x: 82, z: -86 }, { x: 100, z: -50 }, { x: 140, z: -20 }, { x: 150, z: 0 }], // 往管院／全媒體
  [{ x: 140, z: -20 }, { x: 165, z: -12 }],
  [{ x: 150, z: -174 }, { x: 178, z: -160 }], // 往智能攝製基地
  [{ x: -82, z: 40 }, { x: -64, z: 42 }], // 往翠谷餐廳
]

/** 校園可步行範圍（多邊形，順時針/逆時針皆可） */
export const CAMPUS_POLYGON: Vec2[] = [
  { x: -200, z: 152 },
  { x: 10, z: 152 },
  { x: 10, z: 128 },
  { x: -100.5, z: 128 },
  { x: -100.5, z: 92 },
  { x: -70, z: 85 },
  { x: -40, z: 60 },
  { x: -5, z: 30 },
  { x: 20, z: -5 },
  { x: 60, z: -50 },
  { x: 120, z: -60 },
  { x: 190, z: -40 },
  { x: 200, z: 30 },
  { x: 130, z: 40 },
  { x: 100, z: -20 },
  { x: 70, z: -65 },
  { x: 110, z: -95 },
  { x: 195, z: -110 },
  { x: 205, z: -150 },
  { x: 195, z: -212 },
  { x: 140, z: -217 },
  { x: 95, z: -185 },
  { x: 40, z: -155 },
  { x: -5, z: -146 },
  { x: -50, z: -141 },
  { x: -80, z: -116 },
  { x: -150, z: -86 },
  { x: -162, z: -30 },
  { x: -142, z: 12 },
  { x: -122, z: 45 },
  { x: -107.5, z: 80 },
  { x: -107.5, z: 128 },
  { x: -200, z: 128 },
]

export const START: { pos: Vec2; yaw: number } = { pos: { x: -104, z: 147 }, yaw: 0 }

/** 傳播大廈入口（終點判定） */
export const DESTINATION: Vec2 = { x: 156, z: -181 }

export const LANDMARKS: Landmark[] = [
  { num: '01', name: '前校門', short: '前校門', desc: '粉色石造拱門與山洞隧道，是從木柵路進入校園的主要入口。穿過隧道，路就開始往上坡走。', at: { x: -104, z: 127 }, labelHeight: 13, spot: { x: -104, z: 146 }, look: { x: -104, z: 120 }, onRoute: true },
  { num: '02', name: '新聞大樓 J', short: '新聞 J', desc: '位於校門西側、緊鄰馬路的新聞大樓。', at: { x: -150, z: 112 }, labelHeight: 19, spot: { x: -150, z: 140 }, look: { x: -150, z: 112 }, onRoute: false },
  { num: '03', name: '世界大廈 W', short: '世界 W', desc: '校門旁約六層樓的粉色大樓，頂端是「世新大學」招牌，是走到校門口第一眼會看到的地標。', at: { x: -82, z: 104 }, labelHeight: 29, spot: { x: -70, z: 145 }, look: { x: -82, z: 104 }, onRoute: true },
  { num: '04', name: '翠谷餐廳・學生宿舍', short: '翠谷餐廳', desc: '出隧道後沿坡道右側，包含學生宿舍、諮商中心與翠谷餐廳。', at: { x: -52, z: 50 }, labelHeight: 21, spot: { x: -84, z: 52 }, look: { x: -52, z: 50 }, onRoute: true },
  { num: '05', name: '行政大樓', short: '行政大樓', desc: '坡道西側的行政大樓，多數行政單位在此。', at: { x: -114, z: 0 }, labelHeight: 21, spot: { x: -86, z: 8 }, look: { x: -114, z: 0 }, onRoute: false },
  { num: '06', name: '言論廣場', short: '言論廣場', desc: '校園中段的開放廣場，連接行政區、教學大樓與圖書館。', at: { x: -62, z: -14 }, labelHeight: 5, spot: { x: -62, z: 6 }, look: { x: -62, z: -20 }, onRoute: true },
  { num: '07', name: '廣電大樓 T', short: '廣電 T', desc: '言論廣場東南側的廣電大樓。', at: { x: -28, z: 4 }, labelHeight: 19, spot: { x: -56, z: 6 }, look: { x: -28, z: 4 }, onRoute: false },
  { num: '08', name: '圖書館 L', short: '圖書館 L', desc: '校園西側的圖書館。', at: { x: -130, z: -48 }, labelHeight: 25, spot: { x: -108, z: -36 }, look: { x: -130, z: -48 }, onRoute: false },
  { num: '09', name: '通識大樓 G', short: '通識 G', desc: '圖書館東側的通識（綜合）大樓。', at: { x: -98, z: -58 }, labelHeight: 29, spot: { x: -70, z: -50 }, look: { x: -98, z: -58 }, onRoute: false },
  { num: '10', name: '廣電大樓 B', short: '廣電 B', desc: '廣播電視教學中心。', at: { x: -12, z: -28 }, labelHeight: 17, spot: { x: -34, z: -22 }, look: { x: -12, z: -28 }, onRoute: false },
  { num: '11', name: '管院大樓 M', short: '管院 M', desc: '校園東側的高樓，管理學院所在。', at: { x: 172, z: -8 }, labelHeight: 51, spot: { x: 145, z: -16 }, look: { x: 172, z: -8 }, onRoute: false },
  { num: '12', name: '舍我樓 R', short: '舍我 R', desc: '紅磚色的舍我樓教學大樓，主動線從它西側與北側繞過。', at: { x: -32, z: -58 }, labelHeight: 33, spot: { x: -60, z: -60 }, look: { x: -32, z: -58 }, onRoute: true },
  { num: '13', name: '舍我樓 S', short: '舍我 S', desc: '舍我樓研究大樓，是校園裡最高的紅磚色塔樓。', at: { x: -38, z: -115 }, labelHeight: 55, spot: { x: -40, z: -88 }, look: { x: -38, z: -115 }, onRoute: true },
  { num: '14', name: '學校廣場', short: '學校廣場', desc: '舍我樓北側的大廣場，往東接大禮堂與操場，往北可到後校門。', at: { x: 25, z: -102 }, labelHeight: 5, spot: { x: 8, z: -92 }, look: { x: 40, z: -108 }, onRoute: true },
  { num: '15', name: '八風舞台', short: '八風舞台', desc: '學校廣場東南側的戶外舞台。', at: { x: 82, z: -80 }, labelHeight: 8, spot: { x: 70, z: -95 }, look: { x: 82, z: -80 }, onRoute: false },
  { num: '16', name: '後校門', short: '後校門', desc: '學校廣場北側的後校門，通往試院路一帶。', at: { x: 5, z: -142 }, labelHeight: 8, spot: { x: 14, z: -118 }, look: { x: 5, z: -142 }, onRoute: false },
  { num: '17', name: '大禮堂 A', short: '大禮堂 A', desc: '白牆加紅色豎條的大禮堂，B1／B2 是社團活動空間，體育課也常在這裡。', at: { x: 72, z: -124 }, labelHeight: 27, spot: { x: 70, z: -98 }, look: { x: 72, z: -124 }, onRoute: true },
  { num: '18', name: '操場', short: '操場', desc: '紅色跑道與綠色場地，旁邊有籃球場。從這裡往北就是傳播大廈。', at: { x: 128, z: -152 }, labelHeight: 6, spot: { x: 100, z: -138 }, look: { x: 140, z: -160 }, onRoute: true },
  { num: '19', name: '傳播大廈 C', short: '傳播 C', desc: '新聞傳播學院所在地，位於操場後方。新聞系系辦在 3 樓，院長室在 1 樓 C103。', at: { x: 160, z: -193 }, labelHeight: 31, spot: { x: 152, z: -168 }, look: { x: 160, z: -193 }, onRoute: true },
  { num: '20', name: '全媒體大樓', short: '全媒體', desc: '管院大樓旁的全媒體大樓。', at: { x: 146, z: 14 }, labelHeight: 31, spot: { x: 140, z: -12 }, look: { x: 146, z: 14 }, onRoute: false },
  { num: '21', name: '智能攝製基地', short: '攝製基地', desc: '操場東側的智能攝製基地。', at: { x: 184, z: -140 }, labelHeight: 15, spot: { x: 160, z: -128 }, look: { x: 184, z: -140 }, onRoute: false },
]

/** 地形高度（公尺）：馬路 0m，穿過隧道後沿坡道升到約 10m，北側平台約 14m。 */
export function baseHeight(z: number): number {
  return 10 * smoothstep(128, 40, z) + 4 * smoothstep(40, -100, z)
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 由 geo/build_site.py 產生之場地資料的型別。座標單位公尺，x 向東、z 向南。 */
export type P2 = [number, number]

export type BuildingStyle =
  | 'pinkTile' // 粉色磁磚（世界大廈、新聞大樓、行政大樓、管院）
  | 'brick' // 紅磚色（舍我樓、廣電大樓）
  | 'auditorium' // 白牆紅豎條（大禮堂）
  | 'whiteTile' // 白色磁磚（傳播大廈、圖書館、通識）
  | 'glass' // 玻璃帷幕（全媒體大樓）
  | 'concrete' // 灰色（智能攝製基地）
  | 'city' // 校外建物
  | 'whiteBand' // 白灰色橫向帶窗（新聞大樓）
  | 'whiteOffice' // 白色方窗（行政、圖書館、通識、宿舍）
  | 'orangeLouver' // 白牆橘色直向百葉（女生第一宿舍）
  | 'whiteArch' // 白色拱窗（傳播大廈）
  | 'goldBox' // 金褐色金屬外牆（智能攝製基地）
  | 'glassGreen' // 綠色玻璃帷幕（管院大樓）
  | 'omTower' // 米灰色牆面＋深灰框（全媒體大樓）
  | 'scaffold' // 施工鷹架

export interface SiteBuilding {
  id: string
  /** 官方導覽圖編號；非編號建物為空字串 */
  num: string
  name: string
  code: string
  /** OpenStreetMap way id */
  osm: number
  floors: number
  h: number
  style: BuildingStyle
  poly: P2[]
  /** 一樓有穿越通道時，地面層只由這些多邊形構成（高度 groundH） */
  ground?: P2[][]
  groundH?: number
}

export type PathKind = 'road' | 'lane' | 'footway' | 'steps' | 'covered' | 'tunnel'
export interface SitePath {
  id: string
  kind: PathKind
  w: number
  osm: number
  pts: P2[]
}

export type AreaKind = 'plaza' | 'sports' | 'court' | 'field' | 'grounds' | 'apron'
export interface SiteArea {
  id: string
  kind: AreaKind
  poly: P2[]
}

export interface SiteData {
  note: string
  origin: { lat: number; lon: number; ox: number; oy: number }
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  buildings: SiteBuilding[]
  neighbors: { osm: number; h: number; poly: P2[] }[]
  paths: SitePath[]
  areas: SiteArea[]
  route: P2[]
  /** 高程控制點 [x, z, 海拔公尺] */
  elev: [number, number, number][]
  forest: P2[][]
  track: { center: P2; rot: number; len: number; w: number; lane: number }
  stage: { center: P2; r: number }
  backGate: { center: P2; dir: P2 }
  frontGate: { center: P2; dir: P2 }
}

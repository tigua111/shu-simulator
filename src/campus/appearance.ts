/**
 * 依使用者提供的空拍影片（DJI 0034–0045、0052，2025-12 與 2026-10 拍攝）判讀的外觀設定。
 * 位置與輪廓不變（仍取自 OpenStreetMap／航照），這裡只覆寫外牆、高度、屋頂與附屬構造。
 */
import type { BuildingStyle } from './siteTypes'

export type RoofKind = 'flat' | 'solar' | 'hip' | 'atrium' | 'solarGreen' | 'metal'

export interface Appearance {
  style?: BuildingStyle
  /** 覆寫高度（公尺，相對地面） */
  h?: number
  roof?: RoofKind
  /** 影片判讀說明（顯示於來源面板／除錯） */
  note: string
}

export const APPEARANCE: Record<string, Appearance> = {
  J: { style: 'whiteBand', roof: 'flat', note: '0034：白灰色橫向帶窗，東端有紫色直幅布條的樓梯塔；臨木柵路有白色斜坡狀格柵牆' },
  W: { style: 'pinkTile', roof: 'flat', note: '0034：鮭魚粉色磁磚、橫向帶窗，屋頂立「世新大學」白底紅字大招牌' },
  D1: { style: 'whiteOffice', roof: 'flat', note: '0042：隧道出口旁白色低樓' },
  D2: { style: 'orangeLouver', roof: 'flat', note: '0042：白牆配橘色直向百葉，緊鄰隧道出口坡道，旁有綠色頂棚樓梯' },
  D3: { style: 'whiteOffice', roof: 'flat', note: '依周邊推定白色' },
  ADM: { style: 'whiteOffice', roof: 'solar', note: '0034／0052：白色，屋頂滿鋪太陽能板，牆上「行政」字樣' },
  L: { style: 'whiteOffice', roof: 'atrium', note: '0037：白色，紅字「圖書館」招牌，頂層綠色玻璃天窗' },
  L1: { style: 'whiteOffice', roof: 'solar', note: '0037：白色低樓、大面玻璃窗、屋頂太陽能板' },
  G: { style: 'whiteOffice', roof: 'solar', note: '0037／0042：白色 7 層，「General Studies Building」字樣，屋頂太陽能板，言論廣場側有圓形雨遮' },
  B: { style: 'scaffold', h: 13, roof: 'flat', note: '0042／0052：原址為施工中鷹架（綠色防護網），位於言論廣場南側、舍我樓 R 西側' },
  T: { style: 'concrete', roof: 'flat', note: '0052：深灰色屋頂的低樓' },
  R: { style: 'brick', roof: 'hip', note: '0034／0045：褐色面磚，西端圓柱塔，屋頂灰色金屬斜屋頂' },
  S: { style: 'brick', roof: 'hip', note: '0034／0045：褐色面磚 12 層，大圓柱樓梯塔寫「舍我樓 She-Wo Building」' },
  A: { style: 'auditorium', roof: 'solar', note: '0037：白牆暗紅色壁柱、黃色基座，頂層退縮並鋪太陽能板，正面有「大禮堂」字樣與直幅布條' },
  V: { style: 'goldBox', h: 12, roof: 'solarGreen', note: '0037／0045：金褐色外牆的長形攝影棚，屋頂太陽能板配綠色走道，玻璃底層' },
  C: { style: 'whiteArch', roof: 'flat', note: '0045：白色 7 層、頂層與一樓拱窗，面向操場掛紅色直幅布條' },
  M: { style: 'glassGreen', roof: 'metal', note: '0045：綠色玻璃帷幕、白色柱廊底層、圓弧玻璃端牆，前有廣場（已以學校網站照片「世新大學管理學院」招牌確認）' },
  OM: { style: 'omTower', roof: 'flat', note: '0045：管院東側的米灰色塔樓，深灰框線，西面掛巨幅藍色海報' },
}

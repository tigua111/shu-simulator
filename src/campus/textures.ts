import * as THREE from 'three'
import type { BuildingStyle } from './data'

const FONT = '"PingFang TC","Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei","Noto Sans CJK SC",sans-serif'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

function toTexture(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/** 每種外觀一張「一個開間 × 一層樓」的立面貼圖（重複鋪貼） */
const facadeCache = new Map<BuildingStyle, THREE.CanvasTexture>()

export function facadeTexture(style: BuildingStyle): THREE.CanvasTexture {
  const hit = facadeCache.get(style)
  if (hit) return hit
  const [c, g] = canvas(128, 128)
  const tile = (base: string, joint: string, step = 16) => {
    g.fillStyle = base
    g.fillRect(0, 0, 128, 128)
    g.strokeStyle = joint
    g.lineWidth = 1
    for (let y = 0; y <= 128; y += step) {
      g.beginPath()
      g.moveTo(0, y)
      g.lineTo(128, y)
      g.stroke()
    }
    for (let x = 0; x <= 128; x += step) {
      g.beginPath()
      g.moveTo(x, 0)
      g.lineTo(x, 128)
      g.stroke()
    }
  }
  const windowBand = (x: number, y: number, w: number, h: number, glass: string, frame: string, mullions = 3) => {
    g.fillStyle = frame
    g.fillRect(x - 3, y - 3, w + 6, h + 6)
    const grad = g.createLinearGradient(0, y, 0, y + h)
    grad.addColorStop(0, glass)
    grad.addColorStop(1, '#2d3d52')
    g.fillStyle = grad
    g.fillRect(x, y, w, h)
    g.fillStyle = frame
    for (let i = 1; i < mullions; i++) g.fillRect(x + (w * i) / mullions - 1.5, y, 3, h)
    g.fillStyle = 'rgba(255,255,255,0.25)'
    g.fillRect(x + 4, y + 4, w * 0.25, 4)
  }
  switch (style) {
    case 'pinkTile':
      tile('#e9b8a8', '#d9a291')
      windowBand(6, 34, 116, 54, '#7fa3c4', '#cfd7de', 4)
      g.fillStyle = '#c98c7a'
      g.fillRect(0, 118, 128, 10)
      break
    case 'brick':
      // 舍我樓：偏粉的褐色面磚，橫向帶窗
      tile('#a8705e', '#956250', 8)
      windowBand(10, 44, 108, 40, '#8aa6bf', '#d9cfc4', 4)
      g.fillStyle = '#93604f'
      g.fillRect(0, 112, 128, 16)
      break
    case 'auditorium':
      g.fillStyle = '#f4f2ec'
      g.fillRect(0, 0, 128, 128)
      g.fillStyle = '#9b1f2c'
      g.fillRect(0, 0, 12, 128)
      g.fillRect(116, 0, 12, 128)
      g.fillStyle = '#3f4a57'
      g.fillRect(56, 34, 16, 56)
      g.fillStyle = '#d6d2c8'
      g.fillRect(56, 34, 16, 3)
      break
    case 'whiteTile':
      tile('#efece6', '#dedad2')
      windowBand(10, 30, 108, 58, '#86a9c8', '#bfc5cc', 4)
      g.fillStyle = '#d7d2c8'
      g.fillRect(0, 118, 128, 10)
      break
    case 'glass':
      g.fillStyle = '#5f7f9c'
      g.fillRect(0, 0, 128, 128)
      windowBand(4, 6, 120, 112, '#9cc3df', '#d9e2ea', 4)
      break
    case 'concrete':
      tile('#a9aaa8', '#999a98', 32)
      g.fillStyle = '#6d7275'
      g.fillRect(16, 70, 96, 40)
      break
    case 'whiteBand':
      g.fillStyle = '#e9e9e6'
      g.fillRect(0, 0, 128, 128)
      windowBand(0, 40, 128, 50, '#90a9bd', '#c9ccce', 6)
      g.fillStyle = '#d3d4d2'
      g.fillRect(0, 112, 128, 16)
      break
    case 'whiteOffice':
      tile('#f1f0ec', '#e2e0da', 64)
      windowBand(14, 34, 40, 54, '#86a3bd', '#d0d4d8', 2)
      windowBand(74, 34, 40, 54, '#86a3bd', '#d0d4d8', 2)
      g.fillStyle = '#dcdad4'
      g.fillRect(0, 116, 128, 12)
      break
    case 'orangeLouver':
      g.fillStyle = '#f2efe9'
      g.fillRect(0, 0, 128, 128)
      g.fillStyle = '#d9772f'
      g.fillRect(8, 0, 40, 128)
      g.fillRect(72, 0, 40, 128)
      g.strokeStyle = '#b8601f'
      g.lineWidth = 2
      for (let x = 10; x < 128; x += 6) {
        if ((x > 48 && x < 72) || x > 112) continue
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, 128)
        g.stroke()
      }
      g.fillStyle = 'rgba(60,70,82,0.55)'
      g.fillRect(52, 36, 16, 50)
      g.fillStyle = '#ffffff'
      g.fillRect(0, 116, 128, 6)
      break
    case 'whiteArch': {
      g.fillStyle = '#f3f1ec'
      g.fillRect(0, 0, 128, 128)
      for (const x0 of [16, 72]) {
        g.fillStyle = '#d9d6cf'
        g.fillRect(x0 - 3, 30, 46, 64)
        g.fillStyle = '#7f9cb5'
        g.beginPath()
        g.moveTo(x0, 92)
        g.lineTo(x0, 52)
        g.arc(x0 + 20, 52, 20, Math.PI, 0)
        g.lineTo(x0 + 40, 92)
        g.closePath()
        g.fill()
        g.fillStyle = '#e8e6e0'
        g.fillRect(x0 + 18, 34, 4, 58)
        g.fillRect(x0, 66, 40, 3)
      }
      break
    }
    case 'goldBox':
      g.fillStyle = '#ddb069'
      g.fillRect(0, 0, 128, 128)
      g.strokeStyle = '#c99a52'
      g.lineWidth = 2
      for (let x = 0; x <= 128; x += 16) {
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, 128)
        g.stroke()
      }
      break
    case 'glassGreen': {
      const grad = g.createLinearGradient(0, 0, 128, 128)
      grad.addColorStop(0, '#4f8f7f')
      grad.addColorStop(0.5, '#7fb8a6')
      grad.addColorStop(1, '#3f7a6c')
      g.fillStyle = grad
      g.fillRect(0, 0, 128, 128)
      g.strokeStyle = '#d7e4e0'
      g.lineWidth = 2
      for (let x = 0; x <= 128; x += 21) {
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, 128)
        g.stroke()
      }
      g.lineWidth = 3
      g.beginPath()
      g.moveTo(0, 2)
      g.lineTo(128, 2)
      g.stroke()
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(0, 64)
      g.lineTo(128, 64)
      g.stroke()
      break
    }
    case 'omTower':
      g.fillStyle = '#ddd5c6'
      g.fillRect(0, 0, 128, 128)
      g.fillStyle = '#5b6068'
      g.fillRect(0, 0, 8, 128)
      g.fillRect(0, 0, 128, 8)
      windowBand(28, 36, 72, 50, '#7f97ad', '#6c7077', 3)
      break
    case 'scaffold': {
      g.clearRect(0, 0, 128, 128)
      g.fillStyle = 'rgba(52,160,88,0.55)'
      g.fillRect(0, 70, 128, 58)
      g.strokeStyle = '#c9ced3'
      g.lineWidth = 4
      for (let x = 2; x <= 128; x += 32) {
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, 128)
        g.stroke()
      }
      for (const y of [2, 64]) {
        g.beginPath()
        g.moveTo(0, y)
        g.lineTo(128, y)
        g.stroke()
      }
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(2, 64)
      g.lineTo(34, 2)
      g.moveTo(66, 64)
      g.lineTo(98, 2)
      g.stroke()
      break
    }
    case 'city':
      tile('#ebe7e0', '#d6d1c9', 32)
      windowBand(14, 34, 100, 46, '#7d93a8', '#9a9a9a', 3)
      break
  }
  const t = toTexture(c)
  facadeCache.set(style, t)
  return t
}

export const STYLE_ROOF: Record<BuildingStyle, number> = {
  pinkTile: 0xbfa79e,
  brick: 0x8c5444,
  auditorium: 0xd9d6cf,
  whiteTile: 0xc9c6bf,
  glass: 0x7d8c99,
  concrete: 0x8c8f91,
  city: 0x9d978e,
  whiteBand: 0xc9cbca,
  whiteOffice: 0xd5d3ce,
  orangeLouver: 0xcfc9c0,
  whiteArch: 0xd8d5ce,
  goldBox: 0xb98d4a,
  glassGreen: 0xc8ccce,
  omTower: 0xb9b2a6,
  scaffold: 0x8c8f91,
}

export function stoneTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256)
  g.fillStyle = '#dcae98'
  g.fillRect(0, 0, 256, 256)
  g.strokeStyle = '#c4917b'
  g.lineWidth = 2
  for (let row = 0; row < 8; row++) {
    const y = row * 32
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(256, y)
    g.stroke()
    for (let x = row % 2 ? 32 : 0; x < 256; x += 64) {
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x, y + 32)
      g.stroke()
    }
  }
  return toTexture(c)
}

/** 招牌文字貼圖 */
export function signTexture(text: string, opts: { sub?: string; color?: string; bg?: string; w?: number; h?: number; vertical?: boolean; size?: number } = {}): THREE.CanvasTexture {
  const w = opts.w ?? 1024
  const h = opts.h ?? 256
  const [c, g] = canvas(w, h)
  if (opts.bg) {
    g.fillStyle = opts.bg
    g.fillRect(0, 0, w, h)
  }
  g.fillStyle = opts.color ?? '#b3202f'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const size = opts.size ?? Math.floor(h * (opts.sub ? 0.5 : 0.66))
  g.font = `700 ${size}px ${FONT}`
  const chars = [...text]
  if (opts.vertical) {
    chars.forEach((ch, i) => g.fillText(ch, w / 2, (h / chars.length) * (i + 0.5)))
  } else {
    const spacing = w / (chars.length + 1)
    chars.forEach((ch, i) => g.fillText(ch, spacing * (i + 1), opts.sub ? h * 0.4 : h / 2))
  }
  if (opts.sub) {
    g.font = `600 ${Math.floor(h * 0.16)}px "Sora",sans-serif`
    g.fillText(opts.sub, w / 2, h * 0.82)
  }
  return toTexture(c, false)
}

export function courtTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 280)
  g.fillStyle = '#3f8f6a'
  g.fillRect(0, 0, 512, 280)
  g.fillStyle = '#2f6aa3'
  g.fillRect(24, 24, 464, 232)
  g.strokeStyle = '#ffffff'
  g.lineWidth = 4
  g.strokeRect(24, 24, 464, 232)
  g.beginPath()
  g.moveTo(256, 24)
  g.lineTo(256, 256)
  g.stroke()
  g.beginPath()
  g.arc(256, 140, 36, 0, Math.PI * 2)
  g.stroke()
  for (const x of [24, 488]) {
    g.beginPath()
    g.arc(x, 140, 100, x < 256 ? -Math.PI / 2 : Math.PI / 2, x < 256 ? Math.PI / 2 : (Math.PI * 3) / 2)
    g.stroke()
  }
  return toTexture(c, false)
}

/** 地面路線上的方向箭頭 */
export function arrowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128)
  g.fillStyle = 'rgba(255,255,255,0.85)'
  g.beginPath()
  g.moveTo(64, 10)
  g.lineTo(112, 64)
  g.lineTo(80, 64)
  g.lineTo(80, 118)
  g.lineTo(48, 118)
  g.lineTo(48, 64)
  g.lineTo(16, 64)
  g.closePath()
  g.fill()
  return toTexture(c, false)
}

/** 太陽能板（一張 = 2 × 1 公尺的一片板，重複鋪貼） */
export function solarTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 64)
  g.fillStyle = '#c8ccd2'
  g.fillRect(0, 0, 128, 64)
  const grad = g.createLinearGradient(0, 0, 128, 64)
  grad.addColorStop(0, '#2b3d63')
  grad.addColorStop(1, '#1d2b4a')
  g.fillStyle = grad
  g.fillRect(3, 3, 122, 58)
  g.strokeStyle = 'rgba(170,190,220,0.45)'
  g.lineWidth = 1
  for (let x = 3; x < 125; x += 20) {
    g.beginPath()
    g.moveTo(x, 3)
    g.lineTo(x, 61)
    g.stroke()
  }
  g.beginPath()
  g.moveTo(3, 32)
  g.lineTo(125, 32)
  g.stroke()
  return toTexture(c)
}

/** 鷹架立面（透明背景，綠色防護網） */
export function scaffoldTexture(): THREE.CanvasTexture {
  return facadeTexture('scaffold')
}

/** 操場內場：綠色場地上排列藍色籃球／排球場（依 0037、0045 空拍） */
export function fieldTexture(len: number, w: number): THREE.CanvasTexture {
  const ppm = 12
  const [c, g] = canvas(Math.round(len * ppm), Math.round(w * ppm))
  g.fillStyle = '#4e9b52'
  g.fillRect(0, 0, c.width, c.height)
  const court = (cx: number, cy: number, cw: number, ch: number) => {
    g.fillStyle = '#2f62b3'
    g.fillRect((cx - cw / 2) * ppm, (cy - ch / 2) * ppm, cw * ppm, ch * ppm)
    g.strokeStyle = '#ffffff'
    g.lineWidth = 2
    g.strokeRect((cx - cw / 2) * ppm, (cy - ch / 2) * ppm, cw * ppm, ch * ppm)
  }
  // 兩列各三個半場（米）
  const cols = [-0.3, 0, 0.3].map(f => len / 2 + f * len * 0.85)
  for (const x of cols) {
    court(x, w * 0.3, 7.5, 6)
    court(x, w * 0.7, 7.5, 6)
  }
  g.strokeStyle = '#f2e27a'
  g.lineWidth = 2
  g.strokeRect(len * 0.12 * ppm, w * 0.12 * ppm, len * 0.76 * ppm, w * 0.76 * ppm)
  g.strokeStyle = '#ffffff'
  g.beginPath()
  g.moveTo((len / 2) * ppm, w * 0.12 * ppm)
  g.lineTo((len / 2) * ppm, w * 0.88 * ppm)
  g.stroke()
  g.beginPath()
  g.arc((len / 2) * ppm, (w / 2) * ppm, 3 * ppm, 0, Math.PI * 2)
  g.stroke()
  const t = toTexture(c, false)
  return t
}

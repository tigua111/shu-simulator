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
      tile('#b8644a', '#9c513b', 10)
      windowBand(24, 30, 80, 60, '#6f8fae', '#e8ddd0', 2)
      g.fillStyle = '#a2523c'
      g.fillRect(0, 116, 128, 12)
      break
    case 'auditorium':
      g.fillStyle = '#f2f0ea'
      g.fillRect(0, 0, 128, 128)
      g.fillStyle = '#b3202f'
      g.fillRect(0, 0, 14, 128)
      g.fillRect(114, 0, 14, 128)
      windowBand(44, 40, 40, 50, '#8fa8bf', '#d8d8d8', 2)
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
    case 'city':
      tile('#c9c3ba', '#b7b0a6', 32)
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

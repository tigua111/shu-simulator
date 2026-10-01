import { BUILDINGS, CAMPUS_POLYGON, DESTINATION, LANDMARKS, ROUTE, TRACK, type Vec2 } from '../campus/data'
import { buildingCorners } from '../campus/geometry'

const BOUNDS = { minX: -210, maxX: 215, minZ: -225, maxZ: 160 }

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D
  private readonly base: HTMLCanvasElement
  private scale = 1
  private ox = 0
  private oz = 0

  constructor(readonly canvas: HTMLCanvasElement, onPick: (p: Vec2) => void) {
    this.ctx = canvas.getContext('2d')!
    this.base = document.createElement('canvas')
    this.resize()
    window.addEventListener('resize', () => this.resize())
    canvas.addEventListener('click', e => {
      const r = canvas.getBoundingClientRect()
      const px = ((e.clientX - r.left) / r.width) * canvas.width
      const py = ((e.clientY - r.top) / r.height) * canvas.height
      onPick({ x: (px - this.ox) / this.scale, z: (py - this.oz) / this.scale })
    })
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(120, Math.round((rect.width || 220) * dpr))
    const h = Math.max(100, Math.round((rect.height || 200) * dpr))
    this.canvas.width = this.base.width = w
    this.canvas.height = this.base.height = h
    const sx = w / (BOUNDS.maxX - BOUNDS.minX)
    const sz = h / (BOUNDS.maxZ - BOUNDS.minZ)
    this.scale = Math.min(sx, sz)
    this.ox = (w - (BOUNDS.maxX + BOUNDS.minX) * this.scale) / 2
    this.oz = (h - (BOUNDS.maxZ + BOUNDS.minZ) * this.scale) / 2
    this.drawBase()
  }

  private tx(p: Vec2): [number, number] {
    return [p.x * this.scale + this.ox, p.z * this.scale + this.oz]
  }

  private drawBase(): void {
    const g = this.base.getContext('2d')!
    const { width: w, height: h } = this.base
    g.clearRect(0, 0, w, h)
    g.fillStyle = '#5d8a49'
    g.fillRect(0, 0, w, h)
    g.beginPath()
    CAMPUS_POLYGON.forEach((p, i) => {
      const [x, y] = this.tx(p)
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    })
    g.closePath()
    g.fillStyle = '#a9cf84'
    g.fill()
    // 操場
    const [cx, cy] = this.tx({ x: TRACK.x, z: TRACK.z })
    const s = this.scale
    g.fillStyle = '#b5473a'
    g.beginPath()
    g.roundRect(cx - (TRACK.straight / 2 + TRACK.outerR) * s, cy - TRACK.outerR * s, (TRACK.straight + TRACK.outerR * 2) * s, TRACK.outerR * 2 * s, TRACK.outerR * s)
    g.fill()
    g.fillStyle = '#4f9e4a'
    const ir = TRACK.outerR - TRACK.laneW
    g.beginPath()
    g.roundRect(cx - (TRACK.straight / 2 + ir) * s, cy - ir * s, (TRACK.straight + ir * 2) * s, ir * 2 * s, ir * s)
    g.fill()
    // 建築
    for (const b of BUILDINGS) {
      g.beginPath()
      buildingCorners(b).forEach((p, i) => {
        const [x, y] = this.tx(p)
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      })
      g.closePath()
      g.fillStyle = b.id === 'C' ? '#a3122b' : b.num ? '#efe4d8' : '#c9c3ba'
      g.fill()
      g.strokeStyle = 'rgba(43,32,36,0.6)'
      g.lineWidth = 1
      g.stroke()
    }
    // 路線
    g.setLineDash([5 * Math.max(1, s * 1.5), 4 * Math.max(1, s * 1.5)])
    g.strokeStyle = '#d6336c'
    g.lineWidth = Math.max(2, s * 2.4)
    g.beginPath()
    ROUTE.forEach((p, i) => {
      const [x, y] = this.tx(p)
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    })
    g.stroke()
    g.setLineDash([])
    // 編號
    g.font = `700 ${Math.max(9, Math.round(w / 26))}px Sora, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const l of LANDMARKS) {
      const [x, y] = this.tx(l.at)
      const r = Math.max(6, w / 36)
      g.fillStyle = l.num === '19' ? '#a3122b' : '#d6336c'
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#fff'
      g.fillText(l.num, x, y + 0.5)
    }
    const [dx, dy] = this.tx(DESTINATION)
    g.strokeStyle = '#fff'
    g.lineWidth = 2
    g.beginPath()
    g.arc(dx, dy, Math.max(7, w / 30), 0, Math.PI * 2)
    g.stroke()
  }

  draw(p: Vec2, yaw: number, view?: { x: number; z: number }): void {
    const g = this.ctx
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    g.drawImage(this.base, 0, 0)
    if (view) {
      const [vx, vy] = this.tx(view)
      g.strokeStyle = 'rgba(255,255,255,0.9)'
      g.lineWidth = 1.5
      g.strokeRect(vx - 14, vy - 10, 28, 20)
    }
    const [x, y] = this.tx(p)
    const r = Math.max(7, this.canvas.width / 26)
    g.save()
    g.translate(x, y)
    g.rotate(-yaw)
    g.fillStyle = 'rgba(255,255,255,0.35)'
    g.beginPath()
    g.moveTo(0, 0)
    g.arc(0, 0, r * 2.4, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5)
    g.closePath()
    g.fill()
    g.fillStyle = '#2b2024'
    g.strokeStyle = '#fff'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(0, -r)
    g.lineTo(r * 0.7, r * 0.75)
    g.lineTo(0, r * 0.35)
    g.lineTo(-r * 0.7, r * 0.75)
    g.closePath()
    g.fill()
    g.stroke()
    g.restore()
  }
}

import { AREAS, BUILDINGS, DESTINATION, FOREST, NEIGHBORS, PATHS, ROUTE, TRACK, type Vec2 } from '../campus/data'
import { LANDMARKS } from '../campus/landmarks'
/** 小地圖範圍：前校門至傳播大廈、管院（場景座標） */
const BOUNDS = { minX: -262, maxX: 300, minZ: -92, maxZ: 128 }
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

  private poly(g: CanvasRenderingContext2D, pts: Vec2[]): void {
    g.beginPath()
    pts.forEach((p, i) => {
      const [x, y] = this.tx(p)
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    })
    g.closePath()
  }
  private drawBase(): void {
    const g = this.base.getContext('2d')!
    const { width: w, height: h } = this.base
    const s = this.scale
    g.clearRect(0, 0, w, h)
    g.fillStyle = '#c9c3b9'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#5d8a49'
    for (const f of FOREST) {
      this.poly(g, f)
      g.fill()
    }
    for (const n of NEIGHBORS) {
      this.poly(g, n.pts)
      g.fillStyle = '#e4ded5'
      g.fill()
    }
    const areaFill: Record<string, string> = { plaza: '#e3b7a0', sports: '#b5473a', grounds: '#ded2c4', apron: '#ded2c4', court: '#3d6fa8', field: '#4f9e4a' }
    for (const kind of ['apron', 'grounds', 'plaza', 'sports']) {
      for (const a of AREAS.filter(x => x.kind === kind)) {
        this.poly(g, a.pts)
        g.fillStyle = areaFill[kind]
        g.fill()
      }
    }
    // 跑道（旋轉的田徑場）
    const [cx, cy] = this.tx({ x: TRACK.x, z: TRACK.z })
    g.save()
    g.translate(cx, cy)
    g.rotate(-TRACK.rot)
    g.fillStyle = '#b5473a'
    g.beginPath()
    g.roundRect((-TRACK.len / 2) * s, (-TRACK.w / 2) * s, TRACK.len * s, TRACK.w * s, (TRACK.w / 2) * s)
    g.fill()
    const iw = TRACK.w - TRACK.lane * 2
    g.fillStyle = '#4f9e4a'
    g.beginPath()
    g.roundRect((-TRACK.len / 2 + TRACK.lane) * s, (-iw / 2) * s, (TRACK.len - TRACK.lane * 2) * s, iw * s, (iw / 2) * s)
    g.fill()
    g.restore()
    for (const a of AREAS.filter(x => x.kind === 'court')) {
      this.poly(g, a.pts)
      g.fillStyle = areaFill.court
      g.fill()
    }
    // 道路與步道
    g.lineCap = 'round'
    g.lineJoin = 'round'
    const pathColor: Record<string, string> = { road: '#ffffff', lane: '#d79b86', footway: '#f0d7c8', steps: '#f0d7c8', covered: '#f0d7c8', tunnel: '#7a6a62' }
    for (const p of PATHS) {
      g.strokeStyle = pathColor[p.kind]
      g.lineWidth = Math.max(1, p.w * s)
      if (p.kind === 'tunnel') g.setLineDash([3, 2])
      g.beginPath()
      p.pts.forEach((q, i) => {
        const [x, y] = this.tx(q)
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      })
      g.stroke()
      g.setLineDash([])
    }
    // 建築
    for (const b of BUILDINGS) {
      this.poly(g, b.pts)
      g.fillStyle = b.id === 'C' ? '#a3122b' : b.num ? '#fbf3ea' : '#ece5dc'
      g.fill()
      g.strokeStyle = 'rgba(43,32,36,0.7)'
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
    const r = Math.max(6, w / 48)
    g.font = `700 ${Math.round(r * 1.15)}px Sora, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const l of LANDMARKS) {
      const [x, y] = this.tx(l.at)
      if (x < 0 || y < 0 || x > w || y > h) continue
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
    g.arc(dx, dy, r * 1.3, 0, Math.PI * 2)
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

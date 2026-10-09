// 可步行範圍診斷：輸出正射俯視圖與 1 m 格網的步行分類（需先 pnpm build）。
// 用法：REGION=x0,z0,x1,z1 PPM=2 OUT=shots/walk node scripts/walkmap.mjs
// 產出：OUT/top.png（正射俯視，x 向右、z 向下）、OUT/grid.bin（每格 1 byte）、OUT/meta.json
// 分類：0 可走、1 建物內、2 障礙物（樹幹／路燈／欄杆等）、3 鋪面但貼牆（玩家半徑內）、4 非鋪面（隱形牆外）
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
const port = 4800 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}/`
const out = process.env.OUT ?? 'shots/walk'
const [x0, z0, x1, z1] = (process.env.REGION ?? '-300,-150,310,270').split(',').map(Number)
const ppm = Number(process.env.PPM ?? 2)
const cell = Number(process.env.CELL ?? 1)
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'] })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  page.setDefaultTimeout(300_000)
  await page.goto(url, { timeout: 180_000 })
  await page.waitForSelector('body.is-ready .start.is-open', { timeout: 180_000 })
  await page.click('[data-start="walk"]')
  await page.waitForTimeout(800)
  const res = await page.evaluate(
    ({ x0, z0, x1, z1, ppm, cell }) => {
      const { world, renderer, THREE, geo } = window.__campus
      // 1) 格網分類
      const nx = Math.round((x1 - x0) / cell)
      const nz = Math.round((z1 - z0) / cell)
      const R = 0.9
      const hash = new Map()
      for (const o of world.obstacles) {
        const k = `${Math.floor(o.x / 8)},${Math.floor(o.z / 8)}`
        if (!hash.has(k)) hash.set(k, [])
        hash.get(k).push(o)
      }
      const nearObs = (x, z) => {
        const cx = Math.floor(x / 8)
        const cz = Math.floor(z / 8)
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++) {
            const l = hash.get(`${cx + i},${cz + j}`)
            if (!l) continue
            for (const o of l) if (Math.hypot(o.x - x, o.z - z) < o.r + 0.2) return true
          }
        return false
      }
      const grid = new Uint8Array(nx * nz)
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          const p = { x: x0 + (i + 0.5) * cell, z: z0 + (j + 0.5) * cell }
          let c
          if (geo.insideSolid(p, 0)) c = 1
          else if (nearObs(p.x, p.z)) c = 2
          else {
            const paved = geo.onPaved(p)
            const open = !paved && geo.onOpenGround(p)
            if (!paved && !open) c = 4
            else if (geo.insideSolid(p, R)) c = 3
            else c = paved ? 0 : 5
          }
          grid[j * nx + i] = c
        }
      let bin = ''
      for (let k = 0; k < grid.length; k++) bin += String.fromCharCode(grid[k])
      // 2) 正射俯視渲染
      const W = Math.round((x1 - x0) * ppm)
      const H = Math.round((z1 - z0) * ppm)
      const cam = new THREE.OrthographicCamera(x0, x1, -z0, -z1, 1, 2000)
      // 由上往下看：相機 up = -z，使影像上方為北（z 小）
      cam.position.set(0, 900, 0)
      cam.up.set(0, 0, -1)
      cam.lookAt(0, 0, 0)
      cam.left = x0
      cam.right = x1
      cam.top = -z0
      cam.bottom = -z1
      cam.updateProjectionMatrix()
      const fog = world.scene.fog
      world.scene.fog = null
      const hidden = []
      world.scene.traverse(o => {
        if (o.isSprite && o.visible) {
          o.visible = false
          hidden.push(o)
        }
      })
      renderer.setPixelRatio(1)
      renderer.setSize(W, H, false)
      renderer.render(world.scene, cam)
      const png = renderer.domElement.toDataURL('image/png')
      world.scene.fog = fog
      for (const o of hidden) o.visible = true
      return { nx, nz, W, H, grid: btoa(bin), png }
    },
    { x0, z0, x1, z1, ppm, cell },
  )
  writeFileSync(`${out}/top.png`, Buffer.from(res.png.split(',')[1], 'base64'))
  writeFileSync(`${out}/grid.bin`, Buffer.from(res.grid, 'base64'))
  writeFileSync(`${out}/meta.json`, JSON.stringify({ x0, z0, x1, z1, ppm, cell, nx: res.nx, nz: res.nz, W: res.W, H: res.H }))
  console.log('walkmap ok', res.nx, res.nz, res.W, res.H)
} finally {
  await browser?.close()
  server.kill()
}

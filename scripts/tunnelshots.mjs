// 隧道口步行視角截圖（需先 pnpm build）。用法：SHOTS_DIR=shots/t node scripts/tunnelshots.mjs
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
const port = 5200 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots/t'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break } catch {} ; await new Promise(r => setTimeout(r, 250)) }
  browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'] })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(url)
  await page.waitForSelector('body.is-ready .start.is-open', { timeout: 60_000 })
  await page.click('[data-start="walk"]')
  await page.waitForTimeout(1200)
  await page.addStyleTag({ content: '.hud,.panel,.minimap,.topbar,.brand,.modes,.index,.where,.hint,.caption{opacity:0!important}' })
  // 依隧道折線取樣：s 為沿隧道距離（負值＝門外）
  const shots = JSON.parse(process.env.SHOTS ?? '[[-6,0],[0,0],[3,0],[6,0],[10,0],[16,0],[3,40],[3,-40]]')
  for (const [s, turn] of shots) {
    await page.evaluate(([s, turn]) => {
      const { explorer, world } = window.__campus
      const pts = world.tunnelPts
      let acc = 0, p = pts[0], d = { x: pts[1].x - pts[0].x, z: pts[1].z - pts[0].z }
      let L = Math.hypot(d.x, d.z); d = { x: d.x / L, z: d.z / L }
      if (s < 0) p = { x: pts[0].x + d.x * s, z: pts[0].z + d.z * s }
      else for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
        d = { x: (pts[i].x - pts[i - 1].x) / seg, z: (pts[i].z - pts[i - 1].z) / seg }
        if (acc + seg >= s || i === pts.length - 1) { const u = s - acc; p = { x: pts[i - 1].x + d.x * u, z: pts[i - 1].z + d.z * u }; break }
        acc += seg
      }
      const a = (turn * Math.PI) / 180
      const look = { x: p.x + (d.x * Math.cos(a) - d.z * Math.sin(a)) * 10, z: p.z + (d.x * Math.sin(a) + d.z * Math.cos(a)) * 10 }
      explorer.teleport(p, look)
      for (let i = 0; i < 4; i++) explorer.update(0.016)
    }, [s, turn])
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${out}/t_${s}_${turn}.png` })
    console.log('shot', s, turn)
  }
  if (errors.length) console.log('errors:', errors.slice(0, 5))
} finally { await browser?.close(); server.kill() }

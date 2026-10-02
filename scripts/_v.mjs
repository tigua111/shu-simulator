// 依空拍影片的大致機位截圖，供人工比對（需先 pnpm build）。用法：node scripts/views.mjs
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
const port = 4800 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots/views'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
const VIEWS = {
  'q1-plaza-top': [[78, 190, -27], [78, 10, -28]],
  'q2-from-west-0086': [[-110, 120, 30], [110, 18, -20]],
  'q3-from-south-0096': [[40, 110, 170], [75, 15, -35]],
  'q4-plaza-eye': [[45, 30, 10], [112, 22, -22]],
}
let browser
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  const args = ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader']
  browser = await chromium.launch({ args })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  await page.goto(url)
  await page.waitForSelector('body.is-ready .start.is-open', { timeout: 40_000 })
  await page.click('[data-start="walk"]')
  await page.waitForTimeout(1500)
  
  await page.evaluate(() => window.__campus.explorer.setMode('overview'))
  await page.evaluate(() => {
    const { explorer } = window.__campus
    for (let i = 0; i < 80; i++) explorer.update(0.05)
  })
  await page.waitForTimeout(1500)
  
  await page.addStyleTag({ content: '.hud,.panel,.minimap,.topbar,.brand,.modes,.index,.where,.hint{opacity:0.15!important}' })
  for (const [name, [p, t]] of Object.entries(VIEWS)) {
    await page.evaluate(
      ([p, t]) => {
        const { explorer } = window.__campus
        explorer.fly = null
        explorer.camera.position.set(p[0], p[1], p[2])
        explorer.orbit.target.set(t[0], t[1], t[2])
        explorer.orbit.update()
        explorer.update(0.016)
      },
      [p, t],
    )
    await page.waitForTimeout(1600)
    await page.screenshot({ path: `${out}/${name}.png` })
    console.log('shot', name)
  }
  if (errors.length) console.log('errors:', errors.slice(0, 5))
} finally {
  await browser?.close()
  server.kill()
}

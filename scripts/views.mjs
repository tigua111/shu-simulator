// 依空拍影片的大致機位截圖，供人工比對（需先 pnpm build）。用法：node scripts/views.mjs
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
const port = 4800 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots/views'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
const VIEWS = process.env.VIEWS_JSON ? JSON.parse(process.env.VIEWS_JSON) : {
  'v1-gate-0034_26': [[-235, 80, 160], [-215, 30, 80]],
  'v2-adm-east-0034_72': [[-150, 70, -5], [-40, 28, -20]],
  'v3-construction-0034_95': [[-115, 75, -45], [-45, 22, 8]],
  'v4-auditorium-0037_12': [[45, 55, -25], [118, 32, -12]],
  'v5-track-east-0045_12': [[120, 62, -12], [265, 20, -8]],
  'v6-mgmt-0045_36': [[185, 75, 300], [172, 30, 228]],
  'v7-core-top': [[-70, 260, 20], [-70, 20, -12]],
  'v8-east-top': [[150, 300, 40], [150, 20, -5]],
  'v9-gate-top': [[-232, 150, 100], [-232, 12, 82]],
  'v10-ramp-low': [[-190, 34, 60], [-125, 24, -8]],
  'v11-ramp-side': [[-90, 60, 70], [-150, 20, 10]],
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
  await page.screenshot({ path: `${out}/w0-gate-walk.png` })
  await page.evaluate(() => window.__campus.explorer.setMode('overview'))
  await page.evaluate(() => {
    const { explorer } = window.__campus
    for (let i = 0; i < 80; i++) explorer.update(0.05)
  })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/v0-overview.png` })
  await page.addStyleTag({ content: '.hud,.panel,.minimap,.topbar,.brand,.modes,.index,.where,.hint{opacity:0.15!important}' })
  if (process.env.CLEAN) {
    // 與實景照片並排比對時用：介面全隱藏、地標標籤（Sprite）不顯示
    await page.addStyleTag({ content: 'body > *:not(canvas):not(#app), #app > *:not(canvas){opacity:0!important}' })
    await page.evaluate(() => window.__campus.world.scene.traverse(o => o.isSprite && (o.visible = false)))
  }
  if (process.env.HIDE)
    await page.evaluate(names => {
      const hide = new Set(names.split(','))
      window.__campus.world.scene.traverse(o => {
        if (hide.has(o.name)) o.visible = false
      })
    }, process.env.HIDE)
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

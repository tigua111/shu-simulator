// End-to-end smoke test: builds must already exist in dist/ (`pnpm build`).
// Serves dist/, opens the campus walk in headless Chromium, walks with the keyboard, jumps to
// landmarks, checks overview / tour / panels / mobile, fails on any console error and writes
// screenshots to ./shots/.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', detached: false })
let browser
const guard = setTimeout(() => fail('timed out'), 420_000)
function cleanup() {
  clearTimeout(guard)
  try {
    server.kill('SIGTERM')
  } catch {}
}
async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}
function check(cond, msg) {
  if (!cond) throw new Error(msg)
  console.log(`  ok — ${msg}`)
}
async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('preview server did not start')
}
async function open(context, errors) {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', e => errors.push(String(e)))
  page.on('response', r => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`))
  await page.goto(url)
  await page.waitForSelector('body.is-ready .start.is-open', { timeout: 40_000 })
  await page.waitForTimeout(800)
  return page
}
const state = page =>
  page.evaluate(() => {
    const { explorer } = window.__campus
    return { mode: explorer.mode, x: explorer.pos.x, z: explorer.pos.z, yaw: explorer.yaw }
  })
// 無頭瀏覽器以軟體繪圖、幀率很低：按住按鍵後在頁面內逐格推進，讓檢查與幀率無關
const step = (page, frames, dt = 0.05) =>
  page.evaluate(([n, d]) => {
    const { explorer } = window.__campus
    for (let i = 0; i < n; i++) explorer.update(d)
  }, [frames, dt])
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` })

try {
  await waitForServer()
  const args = ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []

  // ── Desktop ──
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await open(desktop, errors)
  await shot(page, '01-start')
  await page.click('[data-start="walk"]')
  await page.waitForTimeout(1200)
  let s = await state(page)
  check(s.mode === 'walk' && Math.abs(s.x + 104) < 1 && s.z > 140, `starts at the front gate (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`)
  await shot(page, '02-gate')

  // 鍵盤前進：穿過校門隧道
  await page.keyboard.down('KeyW')
  await step(page, 170)
  await page.keyboard.up('KeyW')
  s = await state(page)
  check(s.z < 120, `W walks north through the gate tunnel (z=${s.z.toFixed(1)})`)
  check(s.x > -107.5 && s.x < -100.5, `tunnel walls keep the walker inside (x=${s.x.toFixed(1)})`)
  await shot(page, '03-tunnel')

  // 碰撞：朝東撞隧道牆
  await page.keyboard.down('KeyD')
  await step(page, 60)
  await page.keyboard.up('KeyD')
  await page.waitForTimeout(600)
  s = await state(page)
  check(s.x < -100.5, `tunnel wall blocks sideways movement (x=${s.x.toFixed(1)})`)

  for (const [num, name] of [
    ['04', 'cuigu'],
    ['06', 'plaza'],
    ['12', 'sheo-r'],
    ['14', 'school-square'],
    ['17', 'auditorium'],
    ['18', 'track'],
    ['19', 'communication-c'],
  ]) {
    await page.click(`[data-lm="${num}"]`)
    await page.waitForTimeout(700)
    await shot(page, `04-${num}-${name}`)
  }
  // 走到 C 棟入口觸發抵達提示
  await page.keyboard.down('KeyW')
  await step(page, 40)
  await page.keyboard.up('KeyW')
  await page.waitForTimeout(600)
  const arrived = await page.$eval('.toast', el => el.classList.contains('is-open') && el.textContent)
  check(!!arrived && arrived.includes('傳播大廈'), 'arrival toast at 傳播大廈 C')
  await shot(page, '05-arrive')

  // 俯瞰
  await page.click('[data-mode="overview"]')
  await page.waitForTimeout(1800)
  s = await state(page)
  check(s.mode === 'overview', 'overview mode')
  await shot(page, '06-overview')
  await page.click('[data-lm="01"]')
  await page.waitForTimeout(1700)
  await shot(page, '07-overview-gate')

  // 自動導覽
  await page.click('[data-mode="tour"]')
  await page.click('[data-tour-restart]')
  await step(page, 120)
  await page.waitForTimeout(800)
  s = await state(page)
  check(s.mode === 'tour' && s.z < 140, `tour walks the route (z=${s.z.toFixed(1)})`)
  await shot(page, '08-tour')
  await page.keyboard.press('KeyW')
  s = await state(page)
  check(s.mode === 'walk', 'movement key takes over from the tour')

  // 說明與來源
  await page.click('[data-open="help"]')
  await page.waitForTimeout(400)
  await shot(page, '09-help')
  await page.click('[data-modal="help"] [data-close]')
  await page.click('[data-open="sources"]')
  await page.waitForTimeout(400)
  const src = await page.$eval('[data-modal="sources"]', el => el.textContent)
  check(src.includes('shu.edu.tw') || src.includes('校園導覽地圖'), 'sources panel lists the official campus map')
  await shot(page, '10-sources')
  await page.keyboard.press('Escape')
  await page.close()

  // ── Mobile ──
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const m = await open(mobile, errors)
  await shot(m, '11-mobile-start')
  await m.tap('[data-start="walk"]')
  await m.waitForTimeout(1200)
  await shot(m, '12-mobile-walk')
  await m.tap('[data-toggle-index]')
  await m.waitForTimeout(500)
  await shot(m, '13-mobile-index')
  await m.tap('[data-lm="19"]')
  await m.waitForTimeout(800)
  await shot(m, '14-mobile-c')
  await m.close()

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  console.log('smoke: PASS')
  await browser.close()
  cleanup()
  process.exit(0)
} catch (e) {
  await fail(e?.message ?? String(e))
}

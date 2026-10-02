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
const guard = setTimeout(() => fail('timed out'), 900_000)
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
  check(s.mode === 'walk' && Math.hypot(s.x + 232.9, s.z - 86.5) < 20 && s.z > 90, `starts at the front gate on 木柵路 (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`)
  await shot(page, '02-gate')

  // 鍵盤前進：走到拱門口
  await page.keyboard.down('KeyW')
  await step(page, 60)
  await page.keyboard.up('KeyW')
  s = await state(page)
  check(s.z < 100, `W walks from the street to the gate arch (z=${s.z.toFixed(1)})`)
  // 沿隧道（先垂直校門、再彎向東北）穿過：每隔一小段把視線對準折線前方
  const tunnelState = () =>
    page.evaluate(() => {
      const { explorer, world } = window.__campus
      const P = world.tunnelPts
      const q = explorer.pos ?? explorer.position
      let best = Infinity
      let s = 0
      let acc = 0
      let bestS = 0
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1]
        const b = P[i]
        const vx = b.x - a.x
        const vz = b.z - a.z
        const l = Math.hypot(vx, vz)
        const u = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.z - a.z) * vz) / (l * l)))
        const d = Math.hypot(q.x - a.x - u * vx, q.z - a.z - u * vz)
        if (d < best) {
          best = d
          bestS = acc + u * l
        }
        acc += l
      }
      s = bestS
      return { along: s, across: best, total: acc }
    })
  await page.evaluate(() => window.__campus.explorer.teleport({ x: -232.6, z: 85.5 }))
  for (let k = 0; k < 12; k++) {
    await page.evaluate(() => {
      const { explorer, world } = window.__campus
      const P = world.tunnelPts
      const q = explorer.pos ?? explorer.position
      // 前方 6 m 的折線點
      let bi = 0
      let bd = Infinity
      P.forEach((p, i) => {
        const d = Math.hypot(p.x - q.x, p.z - q.z)
        if (d < bd) {
          bd = d
          bi = i
        }
      })
      const t = P[Math.min(P.length - 1, bi + 2)]
      explorer.yaw = Math.atan2(-(t.x - q.x), -(t.z - q.z))
    })
    await page.keyboard.down('KeyW')
    await step(page, 14)
    await page.keyboard.up('KeyW')
  }
  let ts = await tunnelState()
  check(ts.along > 25, `walks through the tunnel (${ts.along.toFixed(1)} m in of ${ts.total.toFixed(1)})`)
  check(ts.across < 3.5, `stays inside the tunnel (${ts.across.toFixed(2)} m off-axis)`)
  await shot(page, '03-tunnel')
  // 碰撞：朝側面撞隧道牆（回到隧道中段）
  await page.evaluate(() => {
    const { explorer, world } = window.__campus
    const P = world.tunnelPts
    const m = P[Math.floor(P.length / 2)]
    explorer.teleport({ x: m.x, z: m.z })
  })
  await page.keyboard.down('KeyD')
  await step(page, 60)
  await page.keyboard.up('KeyD')
  ts = await tunnelState()
  check(ts.across < 3.5, `tunnel wall blocks sideways movement (${ts.across.toFixed(2)} m off-axis)`)

  for (const [num, name] of [
    ['03', 'world'],
    ['04', 'dorms'],
    ['05', 'admin'],
    ['06', 'speech'],
    ['08', 'library'],
    ['13', 'sheo-s'],
    ['14', 'school-square'],
    ['17', 'auditorium'],
    ['18', 'track'],
    ['19', 'communication-c'],
    ['11', 'management'],
  ]) {
    await page.click(`[data-lm="${num}"]`)
    await page.waitForTimeout(700)
    await shot(page, `04-${num}-${name}`)
  }
  // 從傳播大廈東側階梯走向入口，觸發抵達提示
  await page.evaluate(() => {
    const { explorer } = window.__campus
    explorer.teleport({ x: 276, z: -14 }, { x: 285, z: -7 })
  })
  await page.keyboard.down('KeyW')
  await step(page, 50)
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
  check(s.mode === 'tour' && Math.hypot(s.x + 241, s.z - 109.5) > 20, `tour walks the route (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`)
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

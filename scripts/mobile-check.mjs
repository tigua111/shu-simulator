// 手機兼容 E2E：直向建議橫向 → 旋轉 → 全螢幕 → 橫向版面（不重疊、不超出）→ 警衛對話 → 說明；
// 另測 iPhone（無網頁全螢幕 API）的「加入主畫面」說明，以及桌機不顯示手機提示。
// 用法：pnpm build && node scripts/mobile-check.mjs（截圖輸出 shots/mobile）
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, devices } from 'playwright'

const port = 5600 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots/mobile'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
let failed = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failed++
}
/** 等所有 CSS 動畫／轉場結束（軟體繪圖下影格很慢，固定等待不夠） */
const settle = page => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))
/** 輪詢頁內條件（不推進劇情），最多 ms 毫秒 */
async function poll(page, fn, ms = 20_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true
    await page.waitForTimeout(250)
  }
  return false
}
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
const shot = async (page, name) => {
  await frames(page)
  await page.waitForTimeout(450)
  await frames(page)
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 120_000 })
}
const tick = (page, n, dt = 0.05) =>
  page.evaluate(
    ([n, d]) => {
      const { explorer, story } = window.__campus
      for (let i = 0; i < n; i++) {
        explorer.update(d)
        story.update(d)
      }
    },
    [n, dt],
  )
async function until(page, fn, label, rounds = 120) {
  for (let i = 0; i < rounds; i++) {
    if (await page.evaluate(fn)) return true
    await tick(page, 10)
    await page.waitForTimeout(120)
  }
  check(false, `timeout waiting for ${label}`)
  return false
}
/** 目前看得到的 HUD 元件外框 */
const hudRects = page =>
  page.evaluate(() => {
    const vis = el => {
      if (!el) return false
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const pick = {
      brand: '.brand',
      where: '.where',
      modes: '.modes',
      indexToggle: '.index-toggle',
      caption: '.caption.is-open',
      minimap: '.minimap-wrap',
      hint: '.hint.is-open',
      stick: '.touch-stick',
      index: 'body.index-open .index',
      tourbar: '.tourbar.is-open',
    }
    const res = {}
    for (const [k, sel] of Object.entries(pick)) {
      const el = document.querySelector(sel)
      if (!vis(el)) continue
      const r = el.getBoundingClientRect()
      res[k] = { l: r.left, t: r.top, r: r.right, b: r.bottom }
    }
    return { rects: res, w: innerWidth, h: innerHeight }
  })
function layoutOk(label, { rects, w, h }, allow = []) {
  const names = Object.keys(rects)
  const outside = names.filter(n => {
    const r = rects[n]
    return r.l < -1 || r.t < -1 || r.r > w + 1 || r.b > h + 1
  })
  check(outside.length === 0, `${label}: HUD inside the ${w}×${h} screen${outside.length ? ` (outside: ${outside.join(', ')})` : ''}`)
  const hits = []
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const a = rects[names[i]]
      const b = rects[names[j]]
      const pair = `${names[i]}/${names[j]}`
      if (allow.includes(pair)) continue
      if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) hits.push(pair)
    }
  check(hits.length === 0, `${label}: HUD elements do not overlap (${names.join(', ')})${hits.length ? ` overlaps: ${hits.join(', ')}` : ''}`)
}

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'] })

  // ── A. 手機（Android 類，支援全螢幕 API）：直向開啟 ──
  {
    const errors = []
    const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => m.type() === 'error' && errors.push(m.text()))
    await page.goto(url)
    await page.waitForSelector('body.is-ready .start.is-open', { timeout: 150_000 })
    const rot = await page.evaluate(() => ({ open: document.querySelector('.rotate')?.classList.contains('is-open'), text: document.querySelector('.rotate')?.textContent ?? '' }))
    check(rot.open && rot.text.includes('建議橫向遊玩'), 'portrait phone: suggests playing in landscape')
    await shot(page, 'a1-portrait-rotate')

    // 轉成橫向：提示自動消失、出現全螢幕詢問
    await page.setViewportSize({ width: 750, height: 342 })
    await page.waitForTimeout(500)
    await settle(page)
    let st = await page.evaluate(() => ({ rotate: window.__campus.mobile.rotateOpen, fs: window.__campus.mobile.fsPromptOpen, text: document.querySelector('.fsprompt')?.textContent ?? '' }))
    check(!st.rotate, 'rotating to landscape hides the rotate suggestion')
    check(st.fs && st.text.includes('進入全螢幕'), 'landscape: offers fullscreen')
    await shot(page, 'a2-landscape-fsprompt')
    await page.tap('[data-fs="go"]')
    await poll(page, () => !!document.fullscreenElement && document.body.classList.contains('is-fullscreen'))
    await settle(page)
    st = await page.evaluate(() => ({ el: !!document.fullscreenElement, cls: document.body.classList.contains('is-fullscreen'), btn: document.querySelector('[data-fullscreen]')?.textContent, fs: window.__campus.mobile.fsPromptOpen }))
    check(st.el && st.cls && !st.fs, 'tapping 進入全螢幕 enters fullscreen and closes the prompt')
    check(st.btn === '離開全螢幕', `mode bar button switches to 離開全螢幕 (${st.btn})`)
    const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, cw: document.querySelector('#game').clientWidth, ch: document.querySelector('#game').clientHeight }))
    check(Math.abs(vp.cw - vp.w) <= 1 && Math.abs(vp.ch - vp.h) <= 1, `canvas fills the fullscreen viewport (${vp.cw}×${vp.ch} / ${vp.w}×${vp.h})`)

    // 橫向開始卡片：不需捲動、完整在畫面內
    const card = await page.evaluate(() => {
      const c = document.querySelector('.start-card')
      const r = c.getBoundingClientRect()
      const keys = getComputedStyle(document.querySelector('.keys-touch')).display
      return { t: r.top, b: r.bottom, h: innerHeight, sh: c.scrollHeight, ch: c.clientHeight, keys }
    })
    check(card.t >= 0 && card.b <= card.h && card.sh <= card.ch + 2, `landscape start card fits without scrolling (${Math.round(card.b - card.t)} px tall, scroll ${card.sh}/${card.ch})`)
    check(card.keys !== 'none', 'touch devices see touch controls in the start card')
    await shot(page, 'a3-landscape-start')

    await page.tap('[data-start="walk"]')
    await page.waitForTimeout(900)
    await frames(page)
    layoutOk('landscape walk', await hudRects(page))
    await shot(page, 'a4-landscape-walk')

    await page.tap('[data-toggle-index]')
    await page.waitForTimeout(500)
    await settle(page)
    layoutOk('landscape landmark list', await hudRects(page), ['index/minimap'])
    await shot(page, 'a5-landscape-index')
    await page.tap('[data-toggle-index]')
    await page.waitForTimeout(400)

    // 觸控搖桿走到校門 → 警衛對話：三個選項在同一列、不佔掉大半畫面
    await page.evaluate(() => window.__campus.explorer.setTouchMove(0, 1))
    await tick(page, 80)
    await page.evaluate(() => window.__campus.explorer.setTouchMove(0, 0))
    if (await until(page, () => window.__campus.story.gate === 'choose', 'guard dialog (landscape)')) {
      await page.waitForTimeout(400)
      await settle(page)
      const d = await page.evaluate(() => {
        const r = document.querySelector('.sd').getBoundingClientRect()
        const tops = [...document.querySelectorAll('.sd-choice')].map(b => Math.round(b.getBoundingClientRect().top))
        return { t: r.top, b: r.bottom, l: r.left, r: r.right, h: innerHeight, w: innerWidth, tops }
      })
      check(d.tops.length === 3 && new Set(d.tops).size === 1, `landscape guard choices sit in one row (tops ${d.tops.join(',')})`)
      check(d.b - d.t <= d.h * 0.6 && d.b <= d.h && d.l >= 0 && d.r <= d.w, `guard dialog uses ≤ 60% of the screen height (${Math.round(d.b - d.t)}/${d.h})`)
      await shot(page, 'a6-landscape-dialog')
      await page.tap('.sd-choice[data-choice="1"]')
      await page.waitForTimeout(400)
    }

    // 說明視窗在橫向可捲動且不超出
    await page.evaluate(() => window.__campus.story.skipGate?.())
    await page.tap('[data-open="help"]')
    await page.waitForTimeout(400)
    await settle(page)
    const m = await page.evaluate(() => {
      const r = document.querySelector('[data-modal="help"] .modal-card').getBoundingClientRect()
      return { t: r.top, b: r.bottom, h: innerHeight, txt: document.querySelector('[data-modal="help"]').textContent }
    })
    check(m.t >= 0 && m.b <= m.h, 'help modal fits the landscape screen')
    check(m.txt.includes('加入主畫面'), 'help explains fullscreen / add to home screen')
    await shot(page, 'a7-landscape-help')
    await page.tap('[data-modal="help"] [data-close]')

    // 離開全螢幕、轉回直向
    await page.tap('[data-fullscreen]')
    await poll(page, () => !document.fullscreenElement && document.querySelector('[data-fullscreen]')?.textContent === '全螢幕')
    st = await page.evaluate(() => ({ el: !!document.fullscreenElement, btn: document.querySelector('[data-fullscreen]')?.textContent }))
    check(!st.el && st.btn === '全螢幕', 'mode bar button exits fullscreen')
    await page.setViewportSize({ width: 390, height: 664 })
    await page.waitForTimeout(500)
    st = await page.evaluate(() => ({ rotate: window.__campus.mobile.rotateOpen }))
    check(st.rotate, 'back in portrait without dismissing: rotate suggestion returns')
    await page.tap('[data-portrait-ok]')
    await page.waitForTimeout(300)
    st = await page.evaluate(() => ({ rotate: window.__campus.mobile.rotateOpen, ok: sessionStorage.getItem('shucampus.portraitOk') }))
    check(!st.rotate && st.ok === '1', '「仍要直向遊玩」 dismisses the suggestion for this session')
    await settle(page)
    layoutOk('portrait walk', await hudRects(page))
    await shot(page, 'a8-portrait-walk')
    console.log(`render pixel ratio now ${await page.evaluate(() => window.__campus.quality())}`)
    check(errors.length === 0, `phone: no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
    await ctx.close()
  }

  // ── B. iPhone Safari：沒有網頁全螢幕 API，改說明「加入主畫面」 ──
  {
    const errors = []
    const ctx = await browser.newContext({ ...devices['iPhone 13 landscape'], deviceScaleFactor: 1 })
    await ctx.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true })
      Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false, configurable: true })
      Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined, configurable: true, writable: true })
      Object.defineProperty(Element.prototype, 'webkitRequestFullscreen', { value: undefined, configurable: true, writable: true })
    })
    const page = await ctx.newPage()
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => m.type() === 'error' && errors.push(m.text()))
    await page.goto(url)
    await page.waitForSelector('body.is-ready .start.is-open', { timeout: 150_000 })
    let st = await page.evaluate(() => ({ rotate: window.__campus.mobile.rotateOpen, fs: window.__campus.mobile.fsPromptOpen, text: document.querySelector('.fsprompt')?.textContent ?? '', w: innerWidth, h: innerHeight }))
    check(!st.rotate && st.fs && st.text.includes('加入主畫面'), `iPhone landscape (${st.w}×${st.h}): explains 分享 → 加入主畫面 instead of fullscreen`)
    await shot(page, 'b1-iphone-homescreen')
    await page.tap('[data-fs="ok"]')
    await page.waitForTimeout(300)
    st = await page.evaluate(() => ({ fs: window.__campus.mobile.fsPromptOpen, btn: !document.querySelector('[data-fullscreen]').hidden }))
    check(!st.fs && st.btn, 'iPhone: 知道了 closes it; mode bar still has a 全螢幕 button')
    await page.tap('[data-start="walk"]')
    await page.waitForTimeout(600)
    await page.tap('[data-fullscreen]')
    await page.waitForTimeout(300)
    st = await page.evaluate(() => ({ fs: window.__campus.mobile.fsPromptOpen, text: document.querySelector('.fsprompt')?.textContent ?? '' }))
    check(st.fs && st.text.includes('加入主畫面'), 'iPhone: 全螢幕 button shows the add-to-home-screen steps')
    await page.tap('[data-fs="ok"]')
    layoutOk('iPhone landscape walk', await hudRects(page))
    await shot(page, 'b2-iphone-walk')
    check(errors.length === 0, `iPhone: no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
    await ctx.close()
  }

  // ── C. 桌機：不顯示手機提示，全螢幕按鈕可用 ──
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await ctx.newPage()
    await page.goto(url)
    await page.waitForSelector('body.is-ready .start.is-open', { timeout: 150_000 })
    const st = await page.evaluate(() => ({
      rotate: window.__campus.mobile.rotateOpen,
      fs: window.__campus.mobile.fsPromptOpen,
      btn: !document.querySelector('[data-fullscreen]').hidden,
      desk: getComputedStyle(document.querySelector('.keys-desk')).display,
    }))
    check(!st.rotate && !st.fs, 'desktop: no rotate / fullscreen prompts')
    check(st.btn && st.desk !== 'none', 'desktop: 全螢幕 button available, keyboard hints shown')
    await ctx.close()
  }
} catch (e) {
  console.log('FAIL', e)
  failed++
} finally {
  await browser?.close()
  server.kill()
}
console.log(failed ? `mobile-check: ${failed} FAILED` : 'mobile-check: PASS')
process.exit(failed ? 1 : 0)

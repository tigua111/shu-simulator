// 互動劇情 E2E：校門警衛三個選項（含擊斃與復活）、隧道投影、砸車、言論廣場演講、舍我樓電梯。
// 需先 pnpm build。用法：node scripts/story-check.mjs（截圖輸出到 SHOTS_DIR，預設 shots/story）
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 5200 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots/story'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
const cleanup = () => server.kill('SIGTERM')
const fail = async msg => {
  console.error('story-check: FAIL —', msg)
  await browser?.close().catch(() => undefined)
  cleanup()
  process.exit(1)
}
const check = (ok, msg) => {
  console.log(`${ok ? '  ok ' : '  NG '} ${msg}`)
  if (!ok) throw new Error(msg)
}
/** 截圖前先讓主迴圈實際跑幾格：逐格推進（tick）會佔住主執行緒，UI 淡入淡出要等真正的影格才會開始 */
const shot = async (page, name) => {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await page.waitForTimeout(400)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 120_000 })
}
const step = (page, frames, dt = 0.05) =>
  page.evaluate(
    ([n, d]) => {
      const { explorer } = window.__campus
      for (let i = 0; i < n; i++) explorer.update(d)
    },
    [frames, dt],
  )
/** 逐格推進劇情（與無頭瀏覽器的低幀率無關） */
const tick = (page, frames, dt = 0.05) =>
  page.evaluate(
    ([n, d]) => {
      const { explorer, story } = window.__campus
      for (let i = 0; i < n; i++) {
        explorer.update(d)
        story.update(d)
      }
    },
    [frames, dt],
  )
const gate = page =>
  page.evaluate(() => {
    const { explorer, story, world } = window.__campus
    const A = world.tunnelPts[0]
    const N = { x: 0.21755980464319494, z: -0.9760469924156393 }
    const p = explorer.pos
    return { gate: story.gate, pass: story.pass, talks: story.gateTalks, depth: (p.x - A.x) * N.x + (p.z - A.z) * N.z, locked: explorer.locked, x: p.x, z: p.z }
  })
/** 等兩個實際影格（CSS2D 標籤只在主迴圈繪製時更新） */
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
/** 等待條件成立：每輪推進 10 格，也讓打字機（setInterval）跑完 */
async function until(page, fn, label, rounds = 120) {
  for (let i = 0; i < rounds; i++) {
    if (await page.evaluate(fn)) return
    await tick(page, 10)
    await page.waitForTimeout(120)
  }
  throw new Error(`timeout waiting for ${label}`)
}

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  const args = ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader']
  browser = await chromium.launch({ args })
  const errors = []
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  await page.goto(url)
  await page.waitForSelector('body.is-ready .start.is-open', { timeout: 150_000 })
  await page.click('[data-start="walk"]')
  await page.waitForTimeout(800)

  // ── 1. 校門警衛：未放行前走不進去 ──
  let g = await gate(page)
  check(g.gate === 'idle' && !g.pass && g.depth < -10, `starts outside the gate (depth ${g.depth.toFixed(1)})`)
  await page.keyboard.down('KeyW')
  await step(page, 80)
  await page.keyboard.up('KeyW')
  g = await gate(page)
  check(g.depth <= -0.55 && g.depth > -1.5, `guard line stops the player at the gate (depth ${g.depth.toFixed(2)})`)
  await until(page, () => window.__campus.story.gate === 'choose', 'guard dialog choices')
  g = await gate(page)
  check(g.locked && g.talks === 1, 'walking up to the gate starts the guard dialog and locks movement')
  const dlg = await page.$eval('.sd', el => el.textContent)
  await shot(page, 'g1-guard-dialog')
  const dlgOp = await page.$eval('.sd', el => +getComputedStyle(el).opacity)
  check(dlgOp > 0.95, `dialog box is actually visible (opacity ${dlgOp})`)
  check(dlg.includes('您好，世新大學為封閉校園，請出示學生證') && dlg.includes('提供學生證') && dlg.includes('我沒有學生證') && dlg.includes('神麼破學校還要看學生證'), 'guard line + three choices shown')
  const yawErr = await page.evaluate(() => {
    const { explorer, world } = window.__campus
    const h = world.storyProps.guard.person.head.getWorldPosition(new window.__campus.THREE.Vector3())
    const want = Math.atan2(-(h.x - explorer.pos.x), -(h.z - explorer.pos.z))
    return Math.abs(Math.atan2(Math.sin(want - explorer.yaw), Math.cos(want - explorer.yaw)))
  })
  check(yawErr < 0.12, `camera turns to look at the guard (yaw error ${yawErr.toFixed(3)} rad)`)
  const hintOp = await page.$eval('.hint', el => getComputedStyle(el).opacity)
  check(hintOp === '0', `walking hint hidden during the dialog (opacity ${hintOp})`)
  const capOp = await page.$eval('.caption', el => getComputedStyle(el).opacity)
  check(capOp === '0', `landmark caption hidden during the dialog (opacity ${capOp})`)

  // 選項 2：被請離，退回門外
  await page.keyboard.press('Digit2')
  await until(page, () => window.__campus.story.gate === 'idle', 'option 2 to finish')
  g = await gate(page)
  check(!g.pass && !g.locked && g.depth < -6, `option 2: refused and pushed back (depth ${g.depth.toFixed(1)})`)
  // 重新走近 → 再次對話
  await page.keyboard.down('KeyW')
  await step(page, 50)
  await page.keyboard.up('KeyW')
  await until(page, () => window.__campus.story.gate === 'choose', 'second guard dialog')
  g = await gate(page)
  check(g.talks === 2, 'walking back starts the dialog again')

  // 選項 3：被擊斃 → 死亡畫面 → 復活
  await page.keyboard.press('Digit3')
  await until(page, () => window.__campus.story.gate === 'draw', 'guard drawing the pistol', 200)
  await tick(page, 14)
  await page.waitForTimeout(200)
  const pistol = await page.evaluate(() => window.__campus.world.storyProps.guard.pistol.visible)
  check(pistol, 'option 3: guard draws a pistol')
  const aim = await page.evaluate(() => {
    const { explorer, world, THREE } = window.__campus
    const g = world.storyProps.guard
    const m = g.muzzle.getWorldPosition(new THREE.Vector3())
    const h = g.person.handR.getWorldPosition(new THREE.Vector3())
    const toCam = explorer.camera.position.clone().sub(h).normalize()
    return m.sub(h).normalize().dot(toCam)
  })
  check(aim > 0.9, `pistol points at the player (cos ${aim.toFixed(3)})`)
  await shot(page, 'g2-guard-aims')
  await until(page, () => window.__campus.story.gate === 'dead', 'death screen', 200)
  const dead = await page.$eval('.sdead', el => ({ open: el.classList.contains('is-open'), text: el.textContent }))
  check(dead.open && dead.text.includes('世新大學解決了你。') && dead.text.includes('復活'), 'death screen shows 世新大學解決了你。 with a revive button')
  await page.waitForTimeout(900)
  await shot(page, 'g3-dead')
  await page.click('[data-revive]')
  await tick(page, 4)
  g = await gate(page)
  const fx = await page.evaluate(() => ({ ...window.__campus.explorer.camFx, gun: window.__campus.world.storyProps.guard.pistol.visible }))
  check(g.gate === 'idle' && !g.pass && !g.locked && g.depth < -10 && fx.dy === 0 && fx.roll === 0 && !fx.gun, 'revive restarts at the street with the gate reset')

  // 選項 1：出示學生證 → 放行
  await page.keyboard.down('KeyW')
  await step(page, 80)
  await page.keyboard.up('KeyW')
  await until(page, () => window.__campus.story.gate === 'choose', 'third guard dialog')
  await page.click('.sd-choice[data-choice="1"]')
  await until(page, () => window.__campus.story.pass && window.__campus.story.gate === 'idle' && !window.__campus.explorer.locked, 'option 1 to let the player in')
  await page.keyboard.down('KeyW')
  await step(page, 40)
  await page.keyboard.up('KeyW')
  g = await gate(page)
  check(g.pass && g.depth > 3, `option 1: student ID accepted, player walks in (depth ${g.depth.toFixed(1)})`)
  await page.evaluate(() => {
    const { explorer, world } = window.__campus
    const A = world.tunnelPts[0]
    explorer.teleport({ x: A.x - 0.2176 * 7, z: A.z + 0.976 * 7 }, A)
  })
  await tick(page, 30)
  await shot(page, 'g4-guard-steps-aside')

  // ── 2. 隧道盡頭投影 ──
  await page.evaluate(() => {
    const { explorer, world } = window.__campus
    const P = world.tunnelPts
    let L = 0
    for (let i = 1; i < P.length; i++) L += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z)
    // 投影面在出口前 12 m；從前方 7 m 處抬頭看
    let s = L - 19
    let p = P[0]
    let q = P[1]
    for (let i = 1; i < P.length; i++) {
      const l = Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z)
      if (s <= l) {
        const k = s / l
        p = { x: P[i - 1].x + (P[i].x - P[i - 1].x) * k, z: P[i - 1].z + (P[i].z - P[i - 1].z) * k }
        q = P[Math.min(P.length - 1, i + 1)]
        break
      }
      s -= l
    }
    explorer.teleport(p, q)
    explorer.pitch = 0.62
  })
  await tick(page, 6)
  const proj = await page.evaluate(() => {
    const pj = window.__campus.world.storyProps.projector
    return { ok: !!pj, opacity: pj.screen.material.opacity }
  })
  check(proj.ok && proj.opacity > 0.2, `projection on the tunnel ceiling is visible (opacity ${proj.opacity.toFixed(2)})`)
  await shot(page, 'p1-projection')
  // 換到下一句
  await tick(page, 76)
  await page.waitForTimeout(300)
  await shot(page, 'p2-projection-next')

  // ── 3. 董事會專車 ──
  await page.evaluate(() => {
    const { explorer, world, THREE } = window.__campus
    const r = world.storyProps.car.audi.root
    r.updateMatrixWorld(true)
    const p = new THREE.Vector3(0.6, 0, 2.6).applyMatrix4(r.matrixWorld)
    const c = new THREE.Vector3(0.6, 0, 0).applyMatrix4(r.matrixWorld)
    explorer.teleport({ x: p.x, z: p.z }, { x: c.x, z: c.z })
    explorer.pitch = -0.32
  })
  await tick(page, 4)
  await frames(page)
  const tags = await page.evaluate(() => [...document.querySelectorAll('.stag')].filter(e => e.style.display !== 'none').map(e => e.textContent))
  check(tags.includes('董事會專車') && tags.includes('按下左鍵砸車'), `car shows 董事會專車 on the roof and the smash prompt (${tags.join(' / ')})`)
  await shot(page, 'c1-car-prompt')
  await page.mouse.click(640, 360)
  await tick(page, 8)
  let car = await page.evaluate(() => ({ eq: window.__campus.story.equipped, dmg: window.__campus.world.storyProps.car.audi.damage }))
  check(car.eq && car.dmg === 0, 'left click takes out the hammer')
  // 敲車門（多下）
  const hit = (pitch, yawOff = 0) =>
    page.evaluate(
      ([p, y]) => {
        const { explorer, story } = window.__campus
        explorer.pitch = p
        explorer.yaw += y
        story.action(null)
        for (let i = 0; i < 12; i++) {
          explorer.update(0.05)
          story.update(0.05)
        }
        explorer.yaw -= y
        return { dmg: story.props.car.audi.damage, hits: story.props.car.audi.hits, hud: document.querySelector('.shud').textContent, sub: document.querySelector('.ssub').textContent }
      },
      [pitch, yawOff],
    )
  let r1 = await hit(-0.5)
  check(r1.hits === 1 && r1.dmg > 2 && r1.sub.includes('有錢不買adobe買豪車。'), `hammer hit dents the car and the player says the line (${r1.hud})`)
  const doorDmg = r1.dmg
  await hit(-0.5, 0.12)
  await hit(-0.5, -0.12)
  // 車窗：抬高視線，連敲三下會碎
  let w
  for (let i = 0; i < 3; i++) w = await hit(-0.2)
  const glass = await page.evaluate(() => {
    const a = window.__campus.world.storyProps.car.audi
    return [...a.glass.values()].map(g => ({ zone: g.zone, hits: g.hits, broken: g.broken }))
  })
  check(glass.some(g => g.broken), `window shatters after repeated hits (${JSON.stringify(glass.filter(g => g.hits))})`)
  // 不同部位損壞量不同：車窗第一下（裂）與車門（凹）不一樣
  const zones = await page.evaluate(() => window.__campus.world.storyProps.car.audi.damage)
  check(zones > doorDmg * 3, `damage accumulates (${zones.toFixed(1)}%) — ${w.hud}`)
  await tick(page, 40)
  await page.evaluate(() => {
    const { explorer, world, THREE } = window.__campus
    const r = world.storyProps.car.audi.root
    const p = new THREE.Vector3(-1.2, 0, 2.7).applyMatrix4(r.matrixWorld)
    const c = new THREE.Vector3(0.9, 0, 0).applyMatrix4(r.matrixWorld)
    explorer.teleport({ x: p.x, z: p.z }, { x: c.x, z: c.z })
    explorer.pitch = -0.3
  })
  await tick(page, 4)
  await shot(page, 'c2-car-damaged')
  car = await page.evaluate(() => window.__campus.story.equipped)
  check(car, 'still holding the hammer near the car')

  // ── 4. 言論廣場演講 ──
  await page.evaluate(() => {
    const { explorer } = window.__campus
    const f = { x: Math.sin(0.5), z: Math.cos(0.5) }
    explorer.teleport({ x: -56 + f.x * 11 + 2, z: -47 + f.z * 11 }, { x: -56, z: -47 })
    explorer.pitch = 0.1
  })
  await tick(page, 8)
  await frames(page)
  const sp = await page.evaluate(() => [...document.querySelectorAll('.stag-bubble')].filter(e => e.style.display !== 'none').map(e => e.textContent))
  check(sp.length === 1 && /荒謬世新大學|還我試拍檔期/.test(sp[0]), `speaker shouts (${sp[0]})`)
  check(!(await page.evaluate(() => window.__campus.story.equipped)), 'hammer is put away after leaving the car')
  await shot(page, 'y1-protest')

  // ── 5. 舍我樓電梯 ──
  await page.evaluate(() => {
    const { explorer } = window.__campus
    explorer.teleport({ x: 13.55, z: -35.6 }, { x: 13.55, z: -30 })
    explorer.pitch = 0.05
  })
  await tick(page, 6)
  await frames(page)
  const lt = () => page.evaluate(() => [...document.querySelectorAll('.stag-act')].filter(e => e.style.display !== 'none').map(e => e.textContent))
  let l = await lt()
  check(l.includes('按Ｆ前往各系系辦'), `elevator prompt shown (${l.join('/')})`)
  await shot(page, 'l1-lift')
  await page.keyboard.press('KeyF')
  await tick(page, 26)
  await frames(page)
  l = await lt()
  check(l.includes('噢抱歉，我忘記世新沒系辦'), `F shows the reply (${l.join('/')})`)
  await shot(page, 'l2-lift-reply')

  // ── 手機：靠近車子出現動作鈕 ──
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const m = await mctx.newPage()
  m.on('pageerror', e => errors.push(String(e)))
  m.on('console', x => x.type() === 'error' && errors.push(x.text()))
  await m.goto(url)
  await m.waitForSelector('body.is-ready .start.is-open', { timeout: 150_000 })
  await m.tap('[data-start="walk"]')
  await m.waitForTimeout(600)
  await m.evaluate(() => {
    const { explorer, world, THREE } = window.__campus
    const r = world.storyProps.car.audi.root
    r.updateMatrixWorld(true)
    const p = new THREE.Vector3(0.6, 0, 2.6).applyMatrix4(r.matrixWorld)
    explorer.teleport({ x: p.x, z: p.z }, { x: r.position.x, z: r.position.z })
  })
  await tick(m, 4)
  const act = await m.$eval('.sact', el => ({ open: el.classList.contains('is-open'), text: el.textContent }))
  check(act.open && act.text === '砸車', `mobile action button appears near the car (${act.text})`)
  // 軟體繪圖下手機影格很慢，Playwright 的穩定性等待會逾時：直接送出 pointerdown
  await m.$eval('.sact', el => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })))
  await tick(m, 4)
  check(await m.evaluate(() => window.__campus.story.equipped), 'mobile action button takes out the hammer')
  await shot(m, 'm1-mobile-car')
  await m.close()

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  console.log('story-check: PASS')
  await browser.close()
  cleanup()
  process.exit(0)
} catch (e) {
  await fail(e?.message ?? String(e))
}

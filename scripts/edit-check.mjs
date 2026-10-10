// 編輯模式端對端檢查（需先 pnpm build）：拖曳行政大樓、旋轉、匯出、重新整理後仍保留。
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
const port = 5200 + Math.floor(Math.random() * 300)
const url = `http://127.0.0.1:${port}/`
const out = 'shots/edit'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
const fail = m => {
  console.error('FAIL', m)
  process.exitCode = 1
}
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) break
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'] })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true })
  const page = await ctx.newPage()
  page.setDefaultTimeout(120_000)
  page.setDefaultNavigationTimeout(180_000)
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  await page.goto(url)
  await page.waitForSelector('body.is-ready .start.is-open', { timeout: 40_000 })
  await page.click('[data-start="overview"]')
  await page.click('[data-edit-toggle]')
  const top = async () =>
    page.evaluate(() => {
      const { explorer, world } = window.__campus
      const b = [...world.buildingPivots.entries()].find(([, p]) => p.children[0].children.some(m => m.userData.num === '05'))
      const [id, p] = b
      explorer.orbit.target.set(p.position.x, 20, p.position.z)
      explorer.camera.position.set(p.position.x, 220, p.position.z + 40)
      explorer.orbit.update()
      for (let i = 0; i < 30; i++) explorer.update(0.05)
      explorer.camera.updateMatrixWorld()
      const v = p.position.clone()
      v.y = 30
      v.project(explorer.camera)
      return { id, x: (v.x + 1) * 640, y: (1 - v.y) * 360, px: p.position.x, pz: p.position.z }
    })
  const a = await top()
  console.log('ADM pivot', a)
  await page.waitForTimeout(400)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + i * 8, a.y + i * 3)
  await page.mouse.up()
  const moved = await page.evaluate(id => {
    const p = window.__campus.world.buildingPivots.get(id)
    return { x: p.position.x, z: p.position.z, ls: localStorage.getItem('shucampus.buildingEdits.v1'), name: document.querySelector('[data-edit-name]').textContent, info: document.querySelector('[data-edit-info]').textContent }
  }, a.id)
  console.log('after drag', moved)
  if (Math.hypot(moved.x - a.px, moved.z - a.pz) < 5) fail('building did not move')
  if (!moved.ls) fail('not saved')
  await page.click('[data-edit-rot="15"]')
  await page.screenshot({ path: `${out}/e1-dragged.png`, timeout: 120_000 })
  // 其他物件：樹（學校廣場樹陣）、路燈、前校門、後校門警衛室
  const dragObj = async (pick, shot) => {
    const t = await page.evaluate(pick => {
      const { explorer, world } = window.__campus
      const ids = [...world.movables.items.keys()]
      const id = ids.find(i => i.startsWith(pick)) ?? pick
      const m = world.movables.items.get(id)
      const THREE_Box = world.scene.children.find(o => o.type === 'Box3Helper').box.constructor
      const box = m.bounds(new THREE_Box())
      const c = { x: (box.min.x + box.max.x) / 2, y: box.max.y - 0.3, z: (box.min.z + box.max.z) / 2 }
      explorer.orbit.target.set(c.x, c.y - 10, c.z)
      explorer.camera.position.set(c.x, c.y + 60, c.z + 6)
      explorer.orbit.update()
      for (let i = 0; i < 30; i++) explorer.update(0.05)
      explorer.camera.updateMatrixWorld()
      const v = explorer.camera.position.clone().set(c.x, c.y, c.z).project(explorer.camera)
      return { id, x: (v.x + 1) * 640, y: (1 - v.y) * 360, edit: { ...m.edit } }
    }, pick)
    await page.waitForTimeout(300)
    await page.mouse.move(t.x, t.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(t.x + i * 6, t.y + i * 2)
    await page.mouse.up()
    const r = await page.evaluate(id => {
      const { world } = window.__campus
      const m = world.movables.items.get(id)
      return { edit: m.edit, name: document.querySelector('[data-edit-name]').textContent }
    }, t.id)
    console.log('drag', t.id, JSON.stringify(r))
    if (Math.hypot(r.edit.dx, r.edit.dz) < 1) fail(`${t.id} did not move`)
    await page.screenshot({ path: `${out}/${shot}.png`, timeout: 120_000 })
    return t.id
  }
  const treeId = await dragObj('tree@58.0,-28.0', 'e1b-tree')
  const lampId = await dragObj('lamp@', 'e1c-lamp')
  const gateId = await dragObj('obj:gate', 'e1d-gate')
  const guardId = await dragObj('obj:guard-house', 'e1e-guard')
  // 互動劇情道具也可移動（董事會專車）
  const carId = await dragObj('obj:adm-audi', 'e1f-car')
  const obsFollow = await page.evaluate(id => {
    const { world } = window.__campus
    const m = world.movables.items.get(id)
    const p = { x: m.home.x + m.edit.dx, z: m.home.z + m.edit.dz }
    return world.obstacles.some(o => Math.hypot(o.x - p.x, o.z - p.z) < 0.01)
  }, lampId)
  if (!obsFollow) fail('lamp obstacle did not follow')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-edit-export]')])
  const file = `${out}/export.json`
  await dl.saveAs(file)
  const ex = JSON.parse(readFileSync(file, 'utf8'))
  console.log('export', JSON.stringify(ex.buildings.map(b => ({ id: b.id, name: b.name, dx: b.dx, dz: b.dz, rotDeg: b.rotDeg, ll0: b.lonlat[0] }))))
  if (ex.buildings.length !== 1 || Math.abs(ex.buildings[0].rotDeg - 15) > 0.01) fail('export content')
  console.log('export objects', JSON.stringify(ex.objects.map(o => ({ id: o.id, x: o.x, z: o.z }))))
  if (ex.objects.length !== 5) fail('export objects count ' + ex.objects.length)
  await page.reload()
  await page.waitForSelector('body.is-ready .start.is-open', { timeout: 40_000 })
  const after = await page.evaluate(id => {
    const p = window.__campus.world.buildingPivots.get(id)
    const objs = Object.fromEntries([...window.__campus.world.movables.items.values()].filter(m => m.kind !== 'building' && (m.edit.dx || m.edit.dz)).map(m => [m.id, m.edit]))
    return { x: p.position.x, z: p.position.z, objs }
  }, a.id)
  console.log('after reload', JSON.stringify(after))
  for (const id of [treeId, lampId, gateId, guardId, carId]) if (!after.objs[id]) fail('reload lost ' + id)
  if (Math.hypot(after.x - moved.x, after.z - moved.z) > 0.5) fail('reload did not keep position')
  await page.click('[data-start="overview"]')
  await page.click('[data-edit-toggle]')
  await top()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/e2-reloaded.png`, timeout: 120_000 })
  page.once('dialog', d => d.accept())
  await page.click('[data-edit-reset-all]')
  const reset = await page.evaluate(() => localStorage.getItem('shucampus.buildingEdits.v1'))
  if (reset) fail('reset all did not clear')
  // 手機版面
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  m.setDefaultTimeout(120_000)
  m.setDefaultNavigationTimeout(180_000)
  await m.goto(url)
  await m.waitForSelector('body.is-ready .start.is-open', { timeout: 150_000 })
  await m.click('[data-start="overview"]')
  await m.click('[data-edit-toggle]')
  await m.waitForTimeout(800)
  await m.screenshot({ path: `${out}/e3-mobile.png`, timeout: 120_000 })
  if (errors.length) fail('console errors: ' + errors.join(' | '))
  console.log(process.exitCode ? 'edit-check: FAIL' : 'edit-check: PASS')
} finally {
  await browser?.close()
  server.kill()
}

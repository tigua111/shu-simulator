import './styles/main.css'
import * as THREE from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { START } from './campus/data'
import { LANDMARKS, type Landmark } from './campus/landmarks'
import { Explorer, type Mode } from './campus/explorer'
import { isWalkable } from './campus/geometry'
import { CampusWorld } from './campus/world'
import { BuildingEditor } from './campus/editor'
import { LOADED_EDITS, sanitize } from './campus/edits'
import { Minimap } from './ui/minimap'
import { Ui } from './ui/ui'

function boot(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const uiRoot = document.querySelector<HTMLElement>('#ui')!
  const labelLayer = document.querySelector<HTMLElement>('#labels')!

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  const coarse = matchMedia('(pointer: coarse)').matches
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  const labels = new CSS2DRenderer({ element: labelLayer })

  const world = new CampusWorld()
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  let ui: Ui | undefined
  const explorer = new Explorer(canvas, world.scene, world.obstacles, {
    modeChange: mode => ui?.setMode(mode),
    arrive: () => ui?.toast('<b>19</b> 已抵達<strong>傳播大廈 C 棟</strong>・新聞傳播學院（院長室 C103、新聞系系辦 3 樓）', 6500),
    tourProgress: f => ui?.setTour(f, explorer.tourPaused),
  })
  explorer.reducedMotion = reduced

  let editor: BuildingEditor | undefined
  const setEdit = (on: boolean) => {
    if (!editor || !ui) return
    if (on) {
      explorer.setMode('overview')
      ui.setMode('overview')
      ui.setCaption(null)
      editor.enable()
      ui.setEditing(true)
    } else {
      editor.disable()
      ui.setEditing(false)
      ui.setMode(explorer.mode)
    }
  }
  const setMode = (mode: Mode) => {
    if (ui?.editing) setEdit(false)
    explorer.setMode(mode)
    ui!.setMode(mode)
  }

  const u = new Ui(uiRoot, {
    start: mode => {
      explorer.teleport(START.pos, { x: START.pos.x, z: START.pos.z - 10 })
      setMode(mode)
      if (mode === 'walk') u.setHint(coarse ? '左下拖曳移動・右側拖曳環顧' : '點擊畫面鎖定滑鼠環顧，WASD 前進；沿紅磚步道與白色箭頭走')
      if (mode === 'tour') explorer.restartTour()
    },
    mode: setMode,
    landmark: (l: Landmark) => {
      explorer.goToLandmark(l)
      u.setCaption(l)
    },
    tourToggle: () => {
      if (explorer.mode !== 'tour') setMode('tour')
      else explorer.tourPaused = !explorer.tourPaused
    },
    tourRestart: () => {
      explorer.restartTour()
      u.setMode('tour')
    },
    reset: () => {
      explorer.resetToStart()
      u.setMode('walk')
    },
    touchMove: (x, y) => explorer.setTouchMove(x, y),
    touchLook: (dx, dy) => explorer.addLook(dx, dy),
    edit: on => setEdit(on),
    editRotate: deg => editor?.rotate(deg),
    editResetOne: () => editor?.resetSelected(),
    editResetAll: () => editor?.resetAll(),
    editExport: () => {
      if (!editor) return
      const json = editor.exportJson()
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `shucampus-building-edits-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      navigator.clipboard?.writeText(json).catch(() => {})
      u.toast(`已匯出 ${editor.editedCount} 個物件的新座標（也複製到剪貼簿）`, 3500)
    },
    editImport: text => {
      try {
        const edits = sanitize(JSON.parse(text))
        editor?.importEdits(edits)
        u.toast(`已匯入 ${Object.keys(edits).length} 棟的調整；按「套用並重新整理」讓地形與碰撞跟著更新`, 4500)
      } catch {
        u.toast('無法讀取這個檔案（需為匯出的 JSON）', 3000)
      }
    },
    editApply: () => window.location.reload(),
  })
  ui = u
  u.setMode('walk')
  editor = new BuildingEditor(canvas, explorer.camera, world, {
    change: (sel, count) =>
      u.setEditInfo(sel ? { num: sel.num, name: sel.label, kind: sel.kind, dataLevel: sel.dataLevel, dx: sel.total.dx, dz: sel.total.dz, rotDeg: (sel.total.rot * 180) / Math.PI } : null, count),
  })
  const loadedCount = Object.keys(LOADED_EDITS).length
  if (loadedCount) {
    document.querySelectorAll('[data-start]').forEach(b =>
      b.addEventListener('click', () => setTimeout(() => u.toast(`已套用你在編輯模式調整過的 ${loadedCount} 棟建築位置（編輯 → 全部重設可還原）`, 5000), 400)),
    )
  }

  const minimap = new Minimap(u.minimapCanvas, p => {
    if (!isWalkable(p)) {
      u.toast('那裡無法步行（建築內或校園範圍外）', 2200)
      return
    }
    if (explorer.mode === 'overview') {
      explorer.pos = p
      return
    }
    if (explorer.mode === 'tour') setMode('walk')
    explorer.teleport(p)
  })

  window.addEventListener('keydown', e => {
    if (!u.started || u.modalOpen) return
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
    if (e.code === 'Digit1') setMode('walk')
    else if (e.code === 'Digit2') setMode('overview')
    else if (e.code === 'Digit3') setMode('tour')
    else if (e.code === 'KeyR') {
      explorer.resetToStart()
      u.setMode('walk')
    }
  })

  document.addEventListener('pointerlockchange', () => {
    document.body.classList.toggle('is-locked', explorer.isLocked)
    if (explorer.isLocked) u.setHint('')
  })

  const resize = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h, false)
    labels.setSize(w, h)
    explorer.camera.aspect = w / h
    explorer.camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  const clock = new THREE.Clock()
  let elapsed = 0
  let labelTick = 0
  const camPos = new THREE.Vector3()
  const ray = new THREE.Raycaster()
  const dir = new THREE.Vector3()
  const occluded = new Map<string, boolean>()
  world.scene.updateMatrixWorld(true)

  /** 標籤是否被其他建築或山丘擋住（自身建築不算） */
  const isOccluded = (num: string, pos: THREE.Vector3, dist: number): boolean => {
    dir.copy(pos).sub(camPos).normalize()
    ray.set(camPos, dir)
    ray.far = dist - 2
    for (const hit of ray.intersectObjects(world.occluders, false)) {
      if (hit.object.userData.num !== num) return true
    }
    return false
  }

  const nearest = (onlyRoute: boolean, maxD: number): Landmark | null => {
    let best: Landmark | null = null
    let bestD = maxD
    for (const l of LANDMARKS) {
      if (onlyRoute && !l.onRoute) continue
      const d = Math.min(Math.hypot(l.at.x - explorer.pos.x, l.at.z - explorer.pos.z), Math.hypot(l.spot.x - explorer.pos.x, l.spot.z - explorer.pos.z) + 4)
      if (d < bestD) {
        bestD = d
        best = l
      }
    }
    return best
  }

  const frame = () => {
    const dt = Math.min(0.05, clock.getDelta())
    elapsed += dt
    if (!u.modalOpen) explorer.update(dt)
    world.update(elapsed)
    const mode = explorer.mode
    if (mode === 'overview') world.setShadowFocus(explorer.orbit.target.x, explorer.orbit.target.z, true)
    else world.setShadowFocus(explorer.pos.x, explorer.pos.z, false)

    // 標籤：步行時依距離淡出，俯瞰時全部顯示
    if (++labelTick % 3 === 0) {
      camPos.copy(explorer.camera.position)
      const doRays = labelTick % 6 === 0
      for (const e of world.labels) {
        const d = camPos.distanceTo(e.pos)
        const el = e.obj.element
        const num = e.landmark.num
        if (mode === 'overview') {
          el.style.opacity = '1'
          el.classList.remove('is-far')
        } else {
          if (doRays) occluded.set(num, d < 260 && isOccluded(num, e.pos, d))
          const hidden = occluded.get(num) ?? false
          let o = d < 150 ? 1 : d > 260 ? 0 : 1 - (d - 150) / 110
          // 終點傳播 C 被擋住時仍以淡色提示方向
          if (hidden) o = num === '19' ? Math.min(o, 0.55) : 0
          el.style.opacity = o.toFixed(2)
          el.classList.toggle('is-far', d > 90)
        }
      }
      const here = nearest(false, 45)
      u.setWhere(here ? `目前位置：靠近 ${here.num} ${here.name}` : '目前位置：校園步道')
      u.setActiveLandmark(here?.num ?? null)
      if (mode === 'tour') u.setCaption(nearest(true, 40))
      else if (mode === 'walk') u.setCaption(nearest(false, 22))
    }

    const v = explorer.viewState()
    minimap.draw({ x: v.x, z: v.z }, v.yaw, mode === 'overview' ? { x: explorer.orbit.target.x, z: explorer.orbit.target.z } : undefined)
    renderer.render(world.scene, explorer.camera)
    labels.render(world.scene, explorer.camera)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // 測試用唯讀掛鉤
  ;(window as unknown as { __campus: unknown }).__campus = { explorer, world, ui: u, editor }
  document.body.classList.add('is-ready')
}

try {
  boot()
} catch (err) {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">無法啟動 3D 場景：${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
}

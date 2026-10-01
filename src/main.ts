import './styles/main.css'
import * as THREE from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { LANDMARKS, START, type Landmark } from './campus/data'
import { Explorer, type Mode } from './campus/explorer'
import { isWalkable } from './campus/geometry'
import { CampusWorld } from './campus/world'
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

  const setMode = (mode: Mode) => {
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
  })
  ui = u
  u.setMode('walk')

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
  ;(window as unknown as { __campus: unknown }).__campus = { explorer, world, ui: u }
  document.body.classList.add('is-ready')
}

try {
  boot()
} catch (err) {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">無法啟動 3D 場景：${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
}

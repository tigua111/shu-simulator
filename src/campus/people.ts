import * as THREE from 'three'

/**
 * 低多邊形人物（腳底為原點、面向本地 +z）。
 * 肩、肘、髖都是樞紐群組，可直接改 rotation 做動畫：
 * 手臂預設下垂（沿 -y），shoulder.rotation.x = -π/2 為向前平舉、-π 為高舉過頭。
 */
export interface Person {
  root: THREE.Group
  body: THREE.Group
  torso: THREE.Mesh
  head: THREE.Group
  shoulderL: THREE.Group
  shoulderR: THREE.Group
  elbowL: THREE.Group
  elbowR: THREE.Group
  handL: THREE.Group
  handR: THREE.Group
  hipL: THREE.Group
  hipR: THREE.Group
  height: number
}
export interface PersonStyle {
  skin?: number
  shirt: number
  sleeve?: number
  pants: number
  shoes?: number
  hair?: number
  /** 頭頂帽子（警衛帽） */
  cap?: number
  belt?: number
  scale?: number
}

const matCache = new Map<number, THREE.MeshLambertMaterial>()
function mat(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color)
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color })
    matCache.set(color, m)
  }
  return m
}
function mesh(g: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(g, mat(color))
  m.castShadow = true
  return m
}

export function makePerson(st: PersonStyle): Person {
  const skin = st.skin ?? 0xe3b896
  const sleeve = st.sleeve ?? st.shirt
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)
  const HIP = 0.93
  // 腿：髖樞紐 → 褲管 → 鞋
  const leg = (sx: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx * 0.105, HIP, 0)
    const thigh = mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.86, 7), st.pants)
    thigh.position.y = -0.43
    const shoe = mesh(new THREE.BoxGeometry(0.13, 0.08, 0.27), st.shoes ?? 0x2a2a2c)
    shoe.position.set(0, -0.89, 0.04)
    hip.add(thigh, shoe)
    body.add(hip)
    return hip
  }
  const hipL = leg(-1)
  const hipR = leg(1)
  // 骨盆＋腰帶
  const pelvis = mesh(new THREE.BoxGeometry(0.34, 0.16, 0.21), st.pants)
  pelvis.position.y = HIP + 0.02
  body.add(pelvis)
  if (st.belt !== undefined) {
    const belt = mesh(new THREE.BoxGeometry(0.355, 0.05, 0.225), st.belt)
    belt.position.y = HIP + 0.1
    body.add(belt)
  }
  // 軀幹：上寬下窄
  const tg = new THREE.CylinderGeometry(0.2, 0.17, 0.56, 8, 1)
  tg.scale(1, 1, 0.62)
  const torso = mesh(tg, st.shirt)
  torso.position.y = HIP + 0.38
  body.add(torso)
  // 頭：脖子＋頭＋頭髮（或帽子）
  const head = new THREE.Group()
  head.position.y = HIP + 0.69
  const neck = mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6), skin)
  neck.position.y = -0.02
  const skull = mesh(new THREE.SphereGeometry(0.115, 12, 10), skin)
  skull.position.y = 0.12
  skull.scale.set(0.95, 1.08, 1)
  head.add(neck, skull)
  if (st.cap !== undefined) {
    const crown = mesh(new THREE.CylinderGeometry(0.125, 0.12, 0.09, 12), st.cap)
    crown.position.y = 0.22
    const visor = mesh(new THREE.BoxGeometry(0.2, 0.015, 0.11), 0x15181f)
    visor.position.set(0, 0.185, 0.12)
    visor.rotation.x = 0.18
    const badge = mesh(new THREE.BoxGeometry(0.05, 0.04, 0.01), 0xd8b23a)
    badge.position.set(0, 0.225, 0.124)
    head.add(crown, visor, badge)
  } else {
    const hair = mesh(new THREE.SphereGeometry(0.122, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), st.hair ?? 0x1d1a18)
    hair.position.set(0, 0.135, -0.012)
    head.add(hair)
  }
  // 眼睛：兩個小黑點，讓面向一目了然
  for (const sx of [-0.04, 0.04]) {
    const e = mesh(new THREE.SphereGeometry(0.014, 6, 4), 0x161616)
    e.position.set(sx, 0.135, 0.105)
    head.add(e)
  }
  body.add(head)
  // 手臂：肩樞紐 → 上臂 → 肘樞紐 → 前臂 → 手
  const arm = (sx: number) => {
    const sh = new THREE.Group()
    sh.position.set(sx * 0.235, HIP + 0.6, 0)
    const up = mesh(new THREE.CylinderGeometry(0.058, 0.05, 0.3, 6), sleeve)
    up.position.y = -0.15
    const el = new THREE.Group()
    el.position.y = -0.3
    const fore = mesh(new THREE.CylinderGeometry(0.048, 0.042, 0.27, 6), st.sleeve !== undefined ? sleeve : skin)
    fore.position.y = -0.135
    const hand = new THREE.Group()
    hand.position.y = -0.29
    const palm = mesh(new THREE.SphereGeometry(0.05, 8, 6), skin)
    hand.add(palm)
    el.add(fore, hand)
    sh.add(up, el)
    body.add(sh)
    return { sh, el, hand }
  }
  const L = arm(-1)
  const R = arm(1)
  const s = st.scale ?? 1
  root.scale.setScalar(s)
  return { root, body, torso, head, shoulderL: L.sh, shoulderR: R.sh, elbowL: L.el, elbowR: R.el, handL: L.hand, handR: R.hand, hipL, hipR, height: 1.76 * s }
}

/** 小木凳（高 0.45 m） */
export function makeStool(): THREE.Group {
  const g = new THREE.Group()
  const wood = 0x8b5e3c
  const seat = mesh(new THREE.BoxGeometry(0.42, 0.05, 0.36), wood)
  seat.position.y = 0.425
  g.add(seat)
  for (const [x, z] of [
    [-0.17, -0.14],
    [0.17, -0.14],
    [-0.17, 0.14],
    [0.17, 0.14],
  ]) {
    const l = mesh(new THREE.BoxGeometry(0.04, 0.42, 0.04), 0x6e4a2f)
    l.position.set(x, 0.21, z)
    g.add(l)
  }
  return g
}

/** 黑色手槍（握把朝 -y、槍口朝 +z），掛在手上時用 */
export function makePistol(): THREE.Group {
  const g = new THREE.Group()
  const black = 0x17181b
  const slide = mesh(new THREE.BoxGeometry(0.035, 0.045, 0.19), black)
  slide.position.set(0, 0.03, 0.06)
  const grip = mesh(new THREE.BoxGeometry(0.032, 0.11, 0.05), 0x222326)
  grip.position.set(0, -0.03, -0.01)
  grip.rotation.x = -0.25
  g.add(slide, grip)
  return g
}

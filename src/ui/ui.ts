import { LANDMARKS, type Landmark } from '../campus/data'
import type { Mode } from '../campus/explorer'

export const LOGO_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" fill="#a3122b"/><path d="M8 40V16h32v24H30V27a6 6 0 0 0-12 0v13Z" fill="#e7b9a6"/><rect x="6" y="11" width="36" height="5" fill="#fbf6ee"/></svg>`

export interface UiActions {
  start: (mode: Mode) => void
  mode: (mode: Mode) => void
  landmark: (l: Landmark) => void
  tourToggle: () => void
  tourRestart: () => void
  reset: () => void
  touchMove: (x: number, y: number) => void
  touchLook: (dx: number, dy: number) => void
}

const SOURCES = [
  { title: '世新大學官方「校園導覽地圖」（建築編號 01–21 與相對位置）', url: 'https://www.shu.edu.tw/SHU-Location.aspx' },
  { title: '世新大學「傳播大廈（C）」樓層資訊（新聞傳播學院、各系辦）', url: 'https://www.shu.edu.tw/SHU-Building-C.aspx' },
  { title: '世新大學新聞稿：校門與世界大廈外觀照片（粉色石造拱門）', url: 'https://www.shu.edu.tw/' },
  { title: '新聞人電子報：操場跑道、大禮堂與步道照片', url: 'https://www.newspeople.com.tw/' },
  { title: '中央社訊息平台：舍我樓、校園廣場與設施照片', url: 'https://www.cna.com.tw/postwrite/chi/381537' },
]

export class Ui {
  readonly root: HTMLElement
  private readonly caption: HTMLElement
  private readonly where: HTMLElement
  private readonly toastEl: HTMLElement
  private readonly tourBar: HTMLElement
  private readonly tourFill: HTMLElement
  private readonly tourBtn: HTMLButtonElement
  private readonly hint: HTMLElement
  private toastTimer = 0
  readonly minimapCanvas: HTMLCanvasElement

  constructor(root: HTMLElement, private readonly actions: UiActions) {
    this.root = root
    const route = LANDMARKS.filter(l => l.onRoute)
    const others = LANDMARKS.filter(l => !l.onRoute)
    const item = (l: Landmark) => `<li><button type="button" data-lm="${l.num}" class="${l.num === '19' ? 'is-goal' : ''}"><b>${l.num}</b><span>${l.name}</span></button></li>`
    root.innerHTML = `
      <section class="start is-open" data-screen="start">
        <div class="start-card">
          <div class="start-logo">${LOGO_SVG}</div>
          <p class="eyebrow">SHIH HSIN UNIVERSITY · 3D CAMPUS WALK</p>
          <h1>世新大學・漫遊校園</h1>
          <p class="lede">從木柵路上的粉色石造拱門出發，穿過山洞隧道、言論廣場與舍我樓，經過大禮堂與操場，一路走到新聞傳播學院所在的<strong>傳播大廈 C 棟</strong>。</p>
          <p class="disclaimer">概念模型｜非精密測繪或正式路線指引</p>
          <div class="start-actions">
            <button type="button" class="btn primary" data-start="walk">從前校門開始步行</button>
            <button type="button" class="btn" data-start="tour">自動導覽</button>
            <button type="button" class="btn" data-start="overview">俯瞰全校</button>
          </div>
          <p class="keys-hint"><kbd>W A S D</kbd> 或方向鍵移動・拖曳或點擊畫面後移動滑鼠環顧・<kbd>Shift</kbd> 快走・手機用左下搖桿與右側拖曳</p>
        </div>
      </section>
      <header class="brand">
        <span class="brand-logo">${LOGO_SVG}</span>
        <div><strong>世新大學・漫遊校園</strong><em>概念模型｜非精密測繪或正式路線指引</em></div>
      </header>
      <nav class="modes" aria-label="模式">
        <button type="button" data-mode="walk" class="is-active">步行</button>
        <button type="button" data-mode="overview">俯瞰</button>
        <button type="button" data-mode="tour">自動導覽</button>
        <span class="sep"></span>
        <button type="button" data-open="help">說明</button>
        <button type="button" data-open="sources">來源</button>
      </nav>
      <button type="button" class="index-toggle" data-toggle-index>地標</button>
      <aside class="index" aria-label="地標索引">
        <h2>主動線<small>前校門 → 傳播 C</small></h2>
        <ol>${route.map(item).join('')}</ol>
        <h2>其他建築</h2>
        <ol>${others.map(item).join('')}</ol>
        <button type="button" class="btn small" data-reset>回到前校門</button>
      </aside>
      <div class="where" aria-live="polite"></div>
      <div class="caption" aria-live="polite"></div>
      <div class="tourbar">
        <button type="button" class="btn small" data-tour-toggle>暫停</button>
        <div class="tour-track"><i></i></div>
        <button type="button" class="btn small" data-tour-restart>從頭</button>
      </div>
      <div class="minimap-wrap"><canvas class="minimap" aria-label="小地圖，點擊可移動到該處"></canvas><span>小地圖・點擊可移動</span></div>
      <div class="crosshair"></div>
      <div class="hint"></div>
      <div class="touch"><div class="touch-stick"><i></i></div></div>
      <div class="toast" role="status"></div>
      <section class="modal" data-modal="help" role="dialog" aria-label="操作說明">
        <div class="modal-card">
          <h2>操作說明</h2>
          <table>
            <tr><th>移動</th><td><kbd>W A S D</kbd> 或方向鍵；按住 <kbd>Shift</kbd> 快走</td></tr>
            <tr><th>環顧</th><td>點擊畫面鎖定滑鼠後移動，或按住滑鼠拖曳；<kbd>Esc</kbd> 釋放滑鼠</td></tr>
            <tr><th>手機</th><td>左下拖曳搖桿移動（推到底快走），右側拖曳畫面環顧</td></tr>
            <tr><th>模式</th><td><kbd>1</kbd> 步行・<kbd>2</kbd> 俯瞰・<kbd>3</kbd> 自動導覽・<kbd>R</kbd> 回到前校門</td></tr>
            <tr><th>俯瞰</th><td>拖曳旋轉、右鍵或雙指平移、滾輪或雙指縮放</td></tr>
            <tr><th>跳轉</th><td>點選左側地標索引，或點擊右下小地圖上的位置</td></tr>
          </table>
          <p class="note">地面上的<span class="swatch route"></span>紅磚色步道與白色箭頭是主動線，粉紅光柱是終點傳播大廈 C 棟入口。</p>
          <button type="button" class="btn primary" data-close>知道了</button>
        </div>
      </section>
      <section class="modal" data-modal="sources" role="dialog" aria-label="參考來源與範圍">
        <div class="modal-card">
          <h2>參考來源與作品範圍</h2>
          <p>本作是依公開資料製作的<strong>概念模型</strong>：建築位置依官方校園導覽圖的相對關係推估，量體、樓高與坡度皆為示意，<strong>非精密測繪，也不是正式路線指引</strong>。</p>
          <p>範圍：前校門（01）經隧道、言論廣場（06）、舍我樓（12・13）、學校廣場（14）、大禮堂（17）與操場（18），到新聞傳播學院所在的傳播大廈 C 棟（19）；周邊建築以簡化量體呈現。</p>
          <ul>${SOURCES.map(s => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.title}</a></li>`).join('')}</ul>
          <p class="note">照片僅作為造型與配色參考，場景中沒有使用任何照片貼圖；所有建築、材質與招牌皆以程式化幾何繪製。</p>
          <button type="button" class="btn primary" data-close>關閉</button>
        </div>
      </section>`
    this.caption = root.querySelector('.caption')!
    this.where = root.querySelector('.where')!
    this.toastEl = root.querySelector('.toast')!
    this.tourBar = root.querySelector('.tourbar')!
    this.tourFill = root.querySelector('.tour-track i')!
    this.tourBtn = root.querySelector('[data-tour-toggle]')!
    this.hint = root.querySelector('.hint')!
    this.minimapCanvas = root.querySelector('.minimap')!

    root.querySelectorAll<HTMLButtonElement>('[data-start]').forEach(b =>
      b.addEventListener('click', () => {
        root.querySelector('.start')!.classList.remove('is-open')
        document.body.classList.add('is-running')
        actions.start(b.dataset.start as Mode)
      }),
    )
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.addEventListener('click', () => actions.mode(b.dataset.mode as Mode)))
    root.querySelectorAll<HTMLButtonElement>('[data-lm]').forEach(b =>
      b.addEventListener('click', () => {
        const l = LANDMARKS.find(x => x.num === b.dataset.lm)!
        actions.landmark(l)
        if (window.innerWidth < 760) document.body.classList.remove('index-open')
      }),
    )
    root.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(b => b.addEventListener('click', () => this.openModal(b.dataset.open!)))
    root.querySelectorAll<HTMLElement>('.modal').forEach(m => {
      m.addEventListener('click', e => {
        if (e.target === m || (e.target as HTMLElement).closest('[data-close]')) m.classList.remove('is-open')
      })
    })
    root.querySelector('[data-toggle-index]')!.addEventListener('click', () => document.body.classList.toggle('index-open'))
    root.querySelector('[data-reset]')!.addEventListener('click', () => actions.reset())
    this.tourBtn.addEventListener('click', () => actions.tourToggle())
    root.querySelector('[data-tour-restart]')!.addEventListener('click', () => actions.tourRestart())
    window.addEventListener('keydown', e => {
      if (e.code === 'Escape') root.querySelectorAll('.modal.is-open').forEach(m => m.classList.remove('is-open'))
    })
    if (window.innerWidth >= 760) document.body.classList.add('index-open')
    this.setupTouch()
  }

  get modalOpen(): boolean {
    return !!this.root.querySelector('.modal.is-open')
  }

  get started(): boolean {
    return document.body.classList.contains('is-running')
  }

  openModal(name: string): void {
    if (document.pointerLockElement) document.exitPointerLock()
    this.root.querySelector(`[data-modal="${name}"]`)?.classList.add('is-open')
  }

  setMode(mode: Mode): void {
    document.body.dataset.mode = mode
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.classList.toggle('is-active', b.dataset.mode === mode))
    this.tourBar.classList.toggle('is-open', mode === 'tour')
    if (mode === 'overview') {
      this.setHint('拖曳旋轉・滾輪縮放・點選地標可飛過去')
      this.setCaption(null)
    } else if (mode === 'tour') this.setHint('按任一方向鍵或拖曳畫面即可接手自由步行')
    else this.setHint('')
  }

  setHint(text: string): void {
    this.hint.textContent = text
    this.hint.classList.toggle('is-open', !!text)
  }

  setWhere(text: string): void {
    if (this.where.textContent !== text) this.where.textContent = text
  }

  setCaption(l: Landmark | null): void {
    const key = l ? l.num : ''
    if (this.caption.dataset.key === key) return
    this.caption.dataset.key = key
    if (!l) {
      this.caption.classList.remove('is-open')
      return
    }
    this.caption.innerHTML = `<b>${l.num}</b><div><strong>${l.name}</strong><p>${l.desc}</p></div>`
    this.caption.classList.add('is-open')
  }

  setTour(fraction: number, paused: boolean): void {
    this.tourFill.style.width = `${(fraction * 100).toFixed(1)}%`
    this.tourBtn.textContent = fraction >= 1 ? '已抵達' : paused ? '繼續' : '暫停'
  }

  setActiveLandmark(num: string | null): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-lm]').forEach(b => b.classList.toggle('is-here', b.dataset.lm === num))
  }

  toast(text: string, ms = 4200): void {
    this.toastEl.innerHTML = text
    this.toastEl.classList.add('is-open')
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('is-open'), ms)
  }

  private setupTouch(): void {
    const layer = this.root.querySelector<HTMLElement>('.touch')!
    const stick = layer.querySelector<HTMLElement>('.touch-stick')!
    const knob = stick.querySelector<HTMLElement>('i')!
    const radius = 54
    if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('has-touch')
    window.addEventListener('touchstart', () => document.body.classList.add('has-touch'), { once: true, passive: true })
    let stickId: number | null = null
    let lookId: number | null = null
    let origin = { x: 0, y: 0 }
    let last = { x: 0, y: 0 }
    const canvas = document.querySelector<HTMLCanvasElement>('#game')!
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || document.body.dataset.mode === 'overview') return
      if (e.clientX < window.innerWidth * 0.45 && stickId === null) {
        stickId = e.pointerId
        origin = { x: e.clientX, y: e.clientY }
        stick.style.left = `${e.clientX}px`
        stick.style.top = `${e.clientY}px`
        stick.classList.add('is-active')
      } else if (lookId === null) {
        lookId = e.pointerId
        last = { x: e.clientX, y: e.clientY }
      }
    })
    window.addEventListener('pointermove', e => {
      if (e.pointerId === stickId) {
        let dx = e.clientX - origin.x
        let dy = e.clientY - origin.y
        const len = Math.hypot(dx, dy)
        if (len > radius) {
          dx = (dx / len) * radius
          dy = (dy / len) * radius
        }
        knob.style.transform = `translate(${dx}px, ${dy}px)`
        this.actions.touchMove(dx / radius, -dy / radius)
      } else if (e.pointerId === lookId) {
        this.actions.touchLook((e.clientX - last.x) * 0.005, (e.clientY - last.y) * 0.005)
        last = { x: e.clientX, y: e.clientY }
      }
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId === stickId) {
        stickId = null
        knob.style.transform = ''
        stick.classList.remove('is-active')
        this.actions.touchMove(0, 0)
      }
      if (e.pointerId === lookId) lookId = null
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
}

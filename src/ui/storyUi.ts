import { sfx } from '../campus/sfx'

/**
 * 劇情互動的 DOM 介面：底部對話框（打字效果、三選一）、死亡畫面（復活鈕）、
 * 字幕、敲車時的損壞程度與準星、手機用的動作鈕，以及 3D 場景中的提示標籤。
 */
export class StoryUI {
  onChoice: (i: number) => void = () => undefined
  onAdvance: () => void = () => undefined
  onRevive: () => void = () => undefined
  onAction: () => void = () => undefined
  private readonly dlg: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly textEl: HTMLElement
  private readonly choicesEl: HTMLElement
  private readonly nextEl: HTMLElement
  private readonly death: HTMLElement
  private readonly flash: HTMLElement
  private readonly sub: HTMLElement
  private readonly hud: HTMLElement
  private readonly cross: HTMLElement
  private readonly act: HTMLButtonElement
  private typing: { text: string; i: number; timer: number; done: () => void } | null = null
  private subTimer = 0
  choicesOpen = false

  constructor(host: HTMLElement) {
    const el = (cls: string, tag = 'div') => {
      const e = document.createElement(tag)
      e.className = cls
      return e
    }
    this.dlg = el('sd')
    this.dlg.setAttribute('role', 'dialog')
    this.dlg.setAttribute('aria-live', 'polite')
    this.nameEl = el('sd-name')
    this.textEl = el('sd-text')
    this.choicesEl = el('sd-choices')
    this.nextEl = el('sd-next')
    this.nextEl.textContent = '點一下或按空白鍵繼續'
    this.dlg.append(this.nameEl, this.textEl, this.choicesEl, this.nextEl)
    this.dlg.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('button')) return
      this.advance()
    })
    this.flash = el('sflash')
    this.death = el('sdead')
    this.death.innerHTML = '<div class="sdead-in"><h2 data-death-title></h2><button type="button" class="btn primary" data-revive>復活</button></div>'
    this.death.querySelector('[data-revive]')!.addEventListener('click', () => this.onRevive())
    this.sub = el('ssub')
    this.hud = el('shud')
    this.cross = el('scross')
    this.act = el('sact', 'button') as HTMLButtonElement
    this.act.type = 'button'
    this.act.addEventListener('pointerdown', e => {
      e.preventDefault()
      e.stopPropagation()
      this.onAction()
    })
    host.append(this.flash, this.dlg, this.sub, this.hud, this.cross, this.act, this.death)
  }

  get dialogOpen(): boolean {
    return this.dlg.classList.contains('is-open')
  }
  get deathOpen(): boolean {
    return this.death.classList.contains('is-open')
  }
  get isTyping(): boolean {
    return !!this.typing
  }

  /** 顯示一句台詞（逐字打出）；回傳打完時的 Promise */
  say(name: string, text: string): Promise<void> {
    this.finishTyping(false)
    this.dlg.classList.add('is-open')
    document.body.classList.add('is-story')
    this.nameEl.textContent = name
    this.textEl.textContent = ''
    this.choicesEl.innerHTML = ''
    this.choicesOpen = false
    this.nextEl.hidden = true
    return new Promise(resolve => {
      const t = { text, i: 0, timer: 0, done: resolve }
      this.typing = t
      t.timer = window.setInterval(() => {
        t.i++
        this.textEl.textContent = text.slice(0, t.i)
        if (t.i % 2 === 0) sfx.blip()
        if (t.i >= text.length) this.finishTyping(true)
      }, 38)
    })
  }
  private finishTyping(resolve: boolean): void {
    const t = this.typing
    if (!t) return
    clearInterval(t.timer)
    this.textEl.textContent = t.text
    this.typing = null
    // 被新台詞打斷時也要結束舊的 Promise（劇情以序號判斷是否已過期）
    void resolve
    t.done()
  }
  /** 點擊／空白鍵：打字中則直接顯示全文，否則交給劇情決定下一步 */
  advance(): void {
    if (this.typing) this.finishTyping(true)
    else if (!this.choicesOpen) this.onAdvance()
  }
  showNext(on: boolean): void {
    this.nextEl.hidden = !on
  }
  choices(list: string[]): void {
    this.choicesEl.innerHTML = ''
    this.choicesOpen = true
    this.nextEl.hidden = true
    list.forEach((text, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sd-choice'
      b.dataset.choice = String(i + 1)
      b.innerHTML = `<b>${i + 1}</b><span></span>`
      b.querySelector('span')!.textContent = text
      b.addEventListener('click', e => {
        e.stopPropagation()
        this.onChoice(i + 1)
      })
      this.choicesEl.append(b)
    })
    ;(this.choicesEl.firstElementChild as HTMLButtonElement | null)?.focus({ preventScroll: true })
  }
  hideDialog(): void {
    this.finishTyping(false)
    this.dlg.classList.remove('is-open')
    document.body.classList.remove('is-story')
    this.choicesOpen = false
    this.choicesEl.innerHTML = ''
  }
  /** 槍口閃光後的整片紅白閃 */
  flashScreen(): void {
    this.flash.classList.remove('is-on')
    void this.flash.offsetWidth
    this.flash.classList.add('is-on')
  }
  showDeath(title: string): void {
    this.death.querySelector('[data-death-title]')!.textContent = title
    this.death.classList.add('is-open')
    ;(this.death.querySelector('[data-revive]') as HTMLButtonElement).focus({ preventScroll: true })
  }
  setDying(k: number): void {
    this.death.style.setProperty('--dying', String(k))
    this.death.classList.toggle('is-dying', k > 0)
  }
  hideDeath(): void {
    this.death.classList.remove('is-open', 'is-dying')
    this.death.style.setProperty('--dying', '0')
  }
  subtitle(html: string, ms = 2600): void {
    this.sub.innerHTML = html
    this.sub.classList.add('is-open')
    clearTimeout(this.subTimer)
    this.subTimer = window.setTimeout(() => this.sub.classList.remove('is-open'), ms)
  }
  setHud(text: string | null): void {
    this.hud.classList.toggle('is-open', !!text)
    if (text) this.hud.textContent = text
  }
  setCrosshair(on: boolean): void {
    this.cross.classList.toggle('is-open', on)
  }
  /** 手機動作鈕（靠近可互動物件時出現） */
  setAction(label: string | null): void {
    this.act.classList.toggle('is-open', !!label)
    if (label && this.act.textContent !== label) this.act.textContent = label
  }
}

/** 3D 場景提示標籤的 DOM 元素 */
export function storyTag(text: string, cls = ''): HTMLElement {
  const e = document.createElement('div')
  e.className = 'stag ' + cls
  e.textContent = text
  return e
}

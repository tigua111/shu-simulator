/**
 * 手機兼容外殼：
 * - 手機直向時建議改橫向遊玩（可選擇仍用直向）
 * - 轉成橫向後提供「進入全螢幕」（全螢幕後順便鎖定橫向）
 * - iPhone Safari 沒有網頁全螢幕 API：改說明「分享 → 加入主畫面」
 * - 右上模式列的「全螢幕」按鈕（桌機簡報也可用）
 */

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void
}
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>
  unlock?: () => void
}

const PORTRAIT_OK = 'shucampus.portraitOk'
const FS_ASKED = 'shucampus.fsAsked'

const PHONE_SVG = `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x="30" y="10" width="36" height="76" rx="8" fill="none" stroke="currentColor" stroke-width="5"/><rect x="42" y="16" width="12" height="3" rx="1.5" fill="currentColor"/><circle cx="48" cy="77" r="3.5" fill="currentColor"/></svg>`
const FS_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 18V8h10M30 8h10v10M40 30v10H30M18 40H8V30" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const SHARE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" class="share-ico"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const store = {
  get(key: string): boolean {
    try {
      return sessionStorage.getItem(key) === '1'
    } catch {
      return false
    }
  },
  set(key: string): void {
    try {
      sessionStorage.setItem(key, '1')
    } catch {
      /* 無痕模式等情況：只在本次頁面有效 */
    }
  },
}

export function fullscreenSupported(): boolean {
  const d = document as FsDocument
  const el = document.documentElement as FsElement
  return !!(d.fullscreenEnabled && el.requestFullscreen) || !!(d.webkitFullscreenEnabled && el.webkitRequestFullscreen)
}

export function isFullscreen(): boolean {
  const d = document as FsDocument
  return !!(d.fullscreenElement || d.webkitFullscreenElement)
}

/** 從主畫面圖示開啟（已經沒有網址列） */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return !!nav.standalone || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches
}

export async function enterFullscreen(lockLandscape: boolean): Promise<boolean> {
  const el = document.documentElement as FsElement
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
    else return false
  } catch {
    return false
  }
  if (lockLandscape) {
    // Android Chrome 在全螢幕時可鎖定橫向；其他瀏覽器不支援就略過
    const o = screen.orientation as LockableOrientation | undefined
    try {
      await o?.lock?.('landscape')
    } catch {
      /* 不支援鎖定方向 */
    }
  }
  return true
}

export async function exitFullscreen(): Promise<void> {
  const d = document as FsDocument
  try {
    ;(screen.orientation as LockableOrientation | undefined)?.unlock?.()
  } catch {
    /* ignore */
  }
  try {
    if (d.exitFullscreen && d.fullscreenElement) await d.exitFullscreen()
    else if (d.webkitExitFullscreen && d.webkitFullscreenElement) await d.webkitExitFullscreen()
  } catch {
    /* ignore */
  }
}

export class MobileShell {
  private readonly touch = matchMedia('(pointer: coarse)').matches
  /** 手機（短邊 ≤ 600 px）才建議轉橫向；平板直向也很好操作 */
  private readonly phone = this.touch && Math.min(screen.width, screen.height) <= 600
  private readonly portraitMq = matchMedia('(orientation: portrait)')
  private readonly rotateEl: HTMLElement
  private readonly fsEl: HTMLElement
  private readonly fsBtn: HTMLButtonElement | null
  private resizeTimer = 0

  constructor(
    root: HTMLElement,
    private readonly onResize: () => void,
  ) {
    this.rotateEl = document.createElement('section')
    this.rotateEl.className = 'rotate'
    this.rotateEl.setAttribute('role', 'dialog')
    this.rotateEl.setAttribute('aria-label', '建議橫向遊玩')
    this.rotateEl.innerHTML = `
      <div class="rotate-card">
        <div class="rotate-phone">${PHONE_SVG}</div>
        <h2>建議橫向遊玩</h2>
        <p>把手機轉成橫向，畫面更寬，左手搖桿、右手環顧也比較好操作。轉過來之後可以一鍵全螢幕。</p>
        <button type="button" class="btn" data-portrait-ok>仍要直向遊玩</button>
      </div>`
    this.fsEl = document.createElement('section')
    this.fsEl.className = 'fsprompt'
    this.fsEl.setAttribute('role', 'dialog')
    this.fsEl.setAttribute('aria-label', '全螢幕')
    root.append(this.rotateEl, this.fsEl)

    this.rotateEl.querySelector('[data-portrait-ok]')!.addEventListener('click', () => {
      store.set(PORTRAIT_OK)
      this.refresh()
    })
    this.fsEl.addEventListener('click', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-fs]')
      if (!t && e.target !== this.fsEl) return
      store.set(FS_ASKED)
      this.fsEl.classList.remove('is-open')
      if (t?.dataset.fs === 'go') void enterFullscreen(this.touch)
    })

    // 模式列的全螢幕按鈕：支援 API 的裝置都顯示；iPhone 觸控也顯示，按下改看「加入主畫面」說明
    this.fsBtn = root.querySelector<HTMLButtonElement>('[data-fullscreen]')
    if (this.fsBtn) {
      this.fsBtn.hidden = !(fullscreenSupported() || (this.touch && !isStandalone()))
      this.fsBtn.addEventListener('click', () => {
        if (isFullscreen()) void exitFullscreen()
        else if (fullscreenSupported()) void enterFullscreen(this.touch)
        else this.showFsPrompt(true)
      })
    }

    const onChange = () => {
      document.body.classList.toggle('is-fullscreen', isFullscreen())
      if (this.fsBtn) this.fsBtn.textContent = isFullscreen() ? '離開全螢幕' : '全螢幕'
      this.refresh()
      this.kickResize()
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    this.portraitMq.addEventListener?.('change', () => {
      this.refresh()
      this.kickResize()
    })
    window.addEventListener('orientationchange', () => this.kickResize())
    window.visualViewport?.addEventListener('resize', () => this.kickResize())
    window.addEventListener('resize', () => this.refresh())
    this.refresh()
  }

  get rotateOpen(): boolean {
    return this.rotateEl.classList.contains('is-open')
  }

  get fsPromptOpen(): boolean {
    return this.fsEl.classList.contains('is-open')
  }

  /** 依目前方向決定要顯示哪個提示 */
  private refresh(): void {
    const portrait = this.portraitMq.matches
    const rotate = this.phone && portrait && !store.get(PORTRAIT_OK)
    this.rotateEl.classList.toggle('is-open', rotate)
    document.body.classList.toggle('is-portrait-blocked', rotate)
    if (rotate) {
      this.fsEl.classList.remove('is-open')
      return
    }
    if (this.touch && !portrait && !isFullscreen() && !isStandalone() && !store.get(FS_ASKED)) this.showFsPrompt(false)
    if (isFullscreen()) this.fsEl.classList.remove('is-open')
  }

  private showFsPrompt(fromButton: boolean): void {
    if (this.fsPromptOpen) return
    if (fullscreenSupported()) {
      this.fsEl.innerHTML = `
        <div class="fs-card">
          <span class="fs-icon">${FS_SVG}</span>
          <h2>${fromButton ? '進入全螢幕' : '已切換為橫向'}</h2>
          <p>進入全螢幕可隱藏網址列與工具列，整個螢幕都是校園。隨時可按右上「離開全螢幕」或系統返回鍵退出。</p>
          <div class="fs-actions">
            <button type="button" class="btn primary" data-fs="go">進入全螢幕</button>
            <button type="button" class="btn" data-fs="later">先不要</button>
          </div>
        </div>`
    } else {
      this.fsEl.innerHTML = `
        <div class="fs-card">
          <span class="fs-icon">${FS_SVG}</span>
          <h2>想要全螢幕？</h2>
          <p>iPhone 的 Safari 不支援網頁全螢幕。點 Safari 的分享鈕 ${SHARE_SVG} →「加入主畫面」，之後從主畫面的「世新漫遊」圖示開啟，就會隱藏網址列、以整個螢幕橫向遊玩。</p>
          <div class="fs-actions">
            <button type="button" class="btn primary" data-fs="ok">知道了</button>
          </div>
        </div>`
    }
    this.fsEl.classList.add('is-open')
  }

  /** 轉向後部分瀏覽器（尤其 iOS）的視窗尺寸晚一點才更新：分次重算 */
  private kickResize(): void {
    this.onResize()
    window.clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      this.onResize()
      this.resizeTimer = window.setTimeout(() => this.onResize(), 400)
    }, 180)
  }
}

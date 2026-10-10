/**
 * 互動音效：全部以 WebAudio 即時合成（不使用外部音檔）。
 * 只在使用者操作（點擊、按鍵）時建立 AudioContext，避免自動播放限制。
 *
 * 訊號鏈：各音效 → bus →（乾聲）＋（合成殘響）→ 壓縮限幅器 → master → 喇叭。
 * 限幅器讓重擊可以做得很大聲、連打疊加也不會爆音。
 */
let ctx: AudioContext | null = null
let master: GainNode | null = null
let bus: GainNode | null = null
let grit: WaveShaperNode | null = null
let noise: AudioBuffer | null = null
export let muted = false
export function setMuted(m: boolean): void {
  muted = m
  if (master) master.gain.value = m ? 0 : 0.9
}

function ac(): AudioContext | null {
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!C) return null
    try {
      ctx = new C()
    } catch {
      return null
    }
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 0.9
    master.connect(ctx.destination)
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 8
    comp.ratio.value = 8
    comp.attack.value = 0.002
    comp.release.value = 0.18
    comp.connect(master)
    bus = ctx.createGain()
    bus.gain.value = 1
    bus.connect(comp)
    // 合成殘響：衰減噪音脈衝響應（約 1.1 秒，像停車場的空間感）
    try {
      const len = Math.floor(ctx.sampleRate * 1.1)
      const ir = ctx.createBuffer(2, len, ctx.sampleRate)
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch)
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2)
      }
      const verb = ctx.createConvolver()
      verb.buffer = ir
      const wet = ctx.createGain()
      wet.gain.value = 0.22
      bus.connect(verb).connect(wet).connect(comp)
    } catch {
      /* 舊瀏覽器沒有 ConvolverNode：只用乾聲 */
    }
    // 金屬擠壓的顆粒感：tanh 失真
    grit = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(x * 3.5)
    }
    grit.curve = curve
    grit.connect(bus)
    const nlen = ctx.sampleRate * 2
    noise = ctx.createBuffer(1, nlen, ctx.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < nlen; i++) d[i] = Math.random() * 2 - 1
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}
export function unlockAudio(): void {
  ac()
}

function burst(c: AudioContext, t: number, dur: number, gain: number, filter: BiquadFilterType, freq: number, q = 1, offset = 0, dest: AudioNode = bus!): void {
  const src = c.createBufferSource()
  src.buffer = noise
  const f = c.createBiquadFilter()
  f.type = filter
  f.frequency.value = freq
  f.Q.value = q
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur)
  src.connect(f).connect(g).connect(dest)
  // 每次從噪音緩衝的隨機位置取樣，連打時聽起來不會一模一樣
  src.start(t, offset || Math.random() * Math.max(0, 1.9 - dur), dur + 0.05)
}
function tone(c: AudioContext, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, dest: AudioNode = bus!): void {
  const o = c.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + dur + 0.05)
}
/** 玻璃碎片叮噹聲 */
function tinkles(c: AudioContext, t: number, n: number, spread: number, gain: number): void {
  for (let i = 0; i < n; i++) {
    const dt = Math.pow(Math.random(), 1.6) * spread
    const f = 2600 + Math.random() * 5200
    tone(c, t + dt, 'sine', f, f * 0.94, 0.05 + Math.random() * 0.12, gain * (1 - (dt / spread) * 0.6))
  }
}

export interface Loop {
  stop(): void
}

export const sfx = {
  /** 槍聲：爆裂噪音＋低頻衝擊＋殘響 */
  gunshot(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    burst(c, t, 0.09, 1.0, 'highpass', 900, 0.7)
    burst(c, t, 0.5, 0.55, 'lowpass', 1800, 0.8)
    tone(c, t, 'sine', 140, 38, 0.32, 0.9)
    burst(c, t + 0.06, 0.9, 0.12, 'bandpass', 700, 0.6, 0.3)
  },
  /**
   * 錘子砸車身：次低頻重擊＋失真擠壓聲＋金屬泛音＋鈑金皺摺的細碎爆裂。
   * power 0.5–1.8；heavy 再疊一層更低的轟聲。
   */
  smash(power = 1, heavy = false): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    const p = Math.min(1.8, Math.max(0.4, power))
    // 1. 次低頻重擊（胸口感）
    tone(c, t, 'sine', 165, 42, 0.32 + 0.1 * p, 0.95 * Math.min(1.2, p))
    // 2. 撞擊瞬間的寬頻爆裂
    burst(c, t, 0.06, 1.0 * p, 'bandpass', 2600, 0.9)
    burst(c, t, 0.12, 0.8 * p, 'lowpass', 1400, 0.7)
    // 3. 失真的鈑金擠壓
    burst(c, t, 0.22, 0.55 * p, 'bandpass', 900, 1.1, 0, grit!)
    // 4. 金屬泛音（不協和、短衰減）
    const base = 380 + Math.random() * 120
    for (const [m, g, d] of [
      [1, 0.16, 0.55],
      [2.76, 0.09, 0.4],
      [5.4, 0.05, 0.28],
    ] as const) {
      tone(c, t, 'triangle', base * m, base * m * 0.97, d, g * p)
    }
    // 5. 鈑金皺摺：一連串細碎爆裂
    for (let i = 0; i < 6; i++) burst(c, t + 0.012 + Math.random() * 0.11, 0.03, 0.35 * p, 'bandpass', 1400 + Math.random() * 2600, 2)
    if (heavy) {
      tone(c, t, 'sine', 90, 28, 0.6, 0.9)
      burst(c, t, 0.45, 0.5, 'lowpass', 500, 0.7)
    }
  },
  /** 舊名稱保留：一般金屬敲擊 */
  metal(power = 1): void {
    sfx.smash(power, false)
  },
  /** 敲到已破的燈、掉落後的位置：輕的金屬聲 */
  clang(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    burst(c, t, 0.06, 0.6, 'bandpass', 2400, 1.2)
    tone(c, t, 'triangle', 760 + Math.random() * 120, 700, 0.4, 0.14)
    tone(c, t, 'sine', 110, 60, 0.15, 0.4)
  },
  /** 玻璃出現裂痕 */
  crack(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    tone(c, t, 'sine', 140, 45, 0.22, 0.8)
    burst(c, t, 0.06, 0.95, 'highpass', 3000, 0.8)
    burst(c, t + 0.01, 0.16, 0.4, 'bandpass', 5200, 1.5)
    tinkles(c, t + 0.02, 8, 0.18, 0.07)
  },
  /** 玻璃碎裂：重擊＋嘩啦一大片＋碎片落地叮噹 */
  shatter(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    tone(c, t, 'sine', 150, 38, 0.4, 1.0)
    burst(c, t, 0.08, 1.0, 'bandpass', 2400, 0.8)
    burst(c, t, 0.75, 0.9, 'highpass', 2200, 0.6)
    burst(c, t + 0.05, 0.5, 0.35, 'bandpass', 6000, 1.2)
    tinkles(c, t, 26, 0.9, 0.09)
    // 碎片落地（0.35–1.1 秒）
    tinkles(c, t + 0.35, 18, 0.8, 0.05)
  },
  /** 燈殼破裂 */
  pop(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    tone(c, t, 'sine', 160, 50, 0.2, 0.7)
    burst(c, t, 0.14, 0.9, 'bandpass', 1900, 0.9)
    tone(c, t, 'square', 900, 300, 0.07, 0.08)
    tinkles(c, t + 0.02, 10, 0.4, 0.06)
  },
  /** 敲輪胎：悶悶的橡膠彈回 */
  thud(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    tone(c, t, 'sine', 120, 48, 0.25, 0.95)
    burst(c, t, 0.14, 0.7, 'lowpass', 420, 0.8)
    tone(c, t + 0.02, 'triangle', 300, 180, 0.12, 0.08)
  },
  /** 爆胎：碰！＋長長的漏氣嘶聲 */
  deflate(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    tone(c, t, 'sine', 120, 30, 0.45, 1.0)
    burst(c, t, 0.12, 1.0, 'lowpass', 2200, 0.7)
    const src = c.createBufferSource()
    src.buffer = noise
    const f = c.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 0.8
    f.frequency.setValueAtTime(5200, t + 0.05)
    f.frequency.exponentialRampToValueAtTime(1800, t + 1.8)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.08)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.9)
    src.connect(f).connect(g).connect(bus!)
    src.start(t, 0.3, 2)
  },
  /** 零件掉到地上：鏗鏘彈跳 */
  clatter(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime + 0.32
    for (let i = 0; i < 4; i++) {
      const dt = i * (0.13 - i * 0.02)
      const g = 0.5 * Math.pow(0.6, i)
      burst(c, t + dt, 0.04, g, 'bandpass', 3000 + Math.random() * 1500, 1.5)
      tone(c, t + dt, 'triangle', 1500 + Math.random() * 600, 1400, 0.12, g * 0.25)
    }
  },
  /** 揮動：strong＝揮空（較大聲） */
  whoosh(strong = false): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    const src = c.createBufferSource()
    src.buffer = noise
    const f = c.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 1.2
    f.frequency.setValueAtTime(320, t)
    f.frequency.exponentialRampToValueAtTime(1900, t + 0.12)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(strong ? 0.5 : 0.28, t + 0.06)
    g.gain.exponentialRampToValueAtTime(0.0008, t + (strong ? 0.26 : 0.16))
    src.connect(f).connect(g).connect(bus!)
    src.start(t, 0.2, 0.3)
  },
  /** 汽車防盜警報：方波「喔咿喔咿」＋喇叭短促嗶聲，回傳可停止的控制 */
  alarm(): Loop | null {
    const c = ac()
    if (!c) return null
    const t = c.currentTime
    const out = c.createGain()
    out.gain.setValueAtTime(0.0001, t)
    out.gain.exponentialRampToValueAtTime(0.14, t + 0.05)
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3200
    lp.connect(out).connect(bus!)
    const o = c.createOscillator()
    o.type = 'square'
    o.frequency.value = 1150
    // LFO：每秒兩次在 820–1480 Hz 之間滑動
    const lfo = c.createOscillator()
    lfo.type = 'triangle'
    lfo.frequency.value = 2.2
    const depth = c.createGain()
    depth.gain.value = 330
    lfo.connect(depth).connect(o.frequency)
    // 斷續（嗶—嗶—）：低頻方波調制音量
    const gate = c.createGain()
    gate.gain.value = 0.5
    const chop = c.createOscillator()
    chop.type = 'square'
    chop.frequency.value = 4.4
    const chopDepth = c.createGain()
    chopDepth.gain.value = 0.5
    chop.connect(chopDepth).connect(gate.gain)
    o.connect(gate).connect(lp)
    o.start(t)
    lfo.start(t)
    chop.start(t)
    let stopped = false
    return {
      stop(): void {
        if (stopped) return
        stopped = true
        const n = c.currentTime
        out.gain.cancelScheduledValues(n)
        out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), n)
        out.gain.exponentialRampToValueAtTime(0.0001, n + 0.12)
        for (const x of [o, lfo, chop]) x.stop(n + 0.15)
      },
    }
  },
  /** 全毀：轟一聲、警報像斷氣一樣往下滑 */
  totaled(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    tone(c, t, 'sine', 110, 24, 1.2, 1.0)
    burst(c, t, 1.0, 0.9, 'lowpass', 700, 0.6)
    burst(c, t, 0.5, 0.6, 'highpass', 2000, 0.6)
    tinkles(c, t + 0.05, 30, 1.2, 0.07)
    tone(c, t + 0.15, 'square', 1300, 160, 1.6, 0.07)
  },
  /** 起火：低沉的「呼」聲 */
  ignite(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    const src = c.createBufferSource()
    src.buffer = noise
    const f = c.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(200, t)
    f.frequency.exponentialRampToValueAtTime(1400, t + 0.35)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.12)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.1)
    src.connect(f).connect(g).connect(bus!)
    src.start(t, 0.1, 1.2)
  },
  /** 電梯到站「叮」 */
  ding(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    tone(c, t, 'sine', 1318, 1310, 1.2, 0.22)
    tone(c, t, 'sine', 2636, 2630, 0.6, 0.05)
  },
  /** 對話框打字的輕點聲 */
  blip(): void {
    const c = ac()
    if (!c) return
    tone(c, c.currentTime, 'square', 520, 500, 0.03, 0.025)
  },
}

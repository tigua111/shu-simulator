/**
 * 互動音效：全部以 WebAudio 即時合成（不使用外部音檔）。
 * 只在使用者操作（點擊、按鍵）時建立 AudioContext，避免自動播放限制。
 */
let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null
export let muted = false
export function setMuted(m: boolean): void {
  muted = m
  if (master) master.gain.value = m ? 0 : 0.8
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
    master.gain.value = muted ? 0 : 0.8
    master.connect(ctx.destination)
    const len = ctx.sampleRate * 1.5
    noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}
export function unlockAudio(): void {
  ac()
}

function burst(c: AudioContext, t: number, dur: number, gain: number, filter: BiquadFilterType, freq: number, q = 1, offset = 0): void {
  const src = c.createBufferSource()
  src.buffer = noise
  const f = c.createBiquadFilter()
  f.type = filter
  f.frequency.value = freq
  f.Q.value = q
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur)
  src.connect(f).connect(g).connect(master!)
  src.start(t, offset, dur + 0.05)
}
function tone(c: AudioContext, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number): void {
  const o = c.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur)
  o.connect(g).connect(master!)
  o.start(t)
  o.stop(t + dur + 0.05)
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
  /** 錘子敲金屬：撞擊噪音＋兩個不協和泛音 */
  metal(power = 1): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    burst(c, t, 0.08, 0.6 * power, 'bandpass', 2400, 1.2)
    tone(c, t, 'triangle', 620 + Math.random() * 120, 540, 0.35, 0.18 * power)
    tone(c, t, 'sine', 1730 + Math.random() * 200, 1600, 0.25, 0.08 * power)
    tone(c, t, 'sine', 95, 55, 0.18, 0.5 * power)
  },
  /** 玻璃出現裂痕 */
  crack(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    burst(c, t, 0.05, 0.6, 'highpass', 3500, 0.8)
    for (let i = 0; i < 4; i++) tone(c, t + i * 0.02, 'sine', 3000 + Math.random() * 2500, 2500, 0.08, 0.05)
    tone(c, t, 'sine', 110, 60, 0.12, 0.4)
  },
  /** 玻璃碎裂：多段高頻碎片聲 */
  shatter(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    burst(c, t, 0.4, 0.7, 'highpass', 2600, 0.6)
    for (let i = 0; i < 16; i++) {
      const dt = Math.random() * 0.55
      tone(c, t + dt, 'sine', 2500 + Math.random() * 4500, 2000, 0.06 + Math.random() * 0.08, 0.06)
    }
  },
  /** 燈殼破裂 */
  pop(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    burst(c, t, 0.12, 0.6, 'bandpass', 1800, 0.9)
    tone(c, t, 'square', 900, 300, 0.06, 0.06)
  },
  /** 揮空 */
  whoosh(): void {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    const src = c.createBufferSource()
    src.buffer = noise
    const f = c.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 1.4
    f.frequency.setValueAtTime(400, t)
    f.frequency.exponentialRampToValueAtTime(1600, t + 0.18)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.08)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.22)
    src.connect(f).connect(g).connect(master!)
    src.start(t, 0.2, 0.3)
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

import { scrambleAt } from '../core/scramble'
import { MARK_PATHS, MARK_VIEWBOX } from './mark'
import { BRAND } from '../content'
import { mountRotateGate } from './rotate'

/*
 * Boot screen: the Hark mark traced as a stroked outline inside an orbit ring,
 * a 000→100 counter, decoding status lines and a thin signal bar. On finish()
 * the mark ignites, a seam of light cuts across the screen and the two halves
 * split open onto the live scene.
 *
 * API: createLoader(root, { skip }) -> { progress(0..1), finish(): Promise<void> }
 * finish() resolves as the halves open (the scene is revealed), and the node
 * removes itself once the animation is done. Never blocks: progress is only
 * cosmetic; finish() is the authority.
 */

const MIN_DISPLAY = 1.6 // seconds before the counter may reach 100 (lets the mark finish tracing)
const STATUS_HOLD = 0.36 // seconds each status line holds before the next decodes
const STATUS_DECODE = 0.3 // seconds for a status line to type + resolve
const SLOW_AFTER = 9 // seconds without finish() before the status admits a slow link
const STATUS: [number, string][] = [
  [0, 'Initializing renderer'],
  [0.16, 'Calibrating optics'],
  [0.38, 'Mapping star field'],
  [0.6, 'Syncing orbit'],
  [0.82, 'Establishing signal'],
]

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  // phones held sideways get the rotate card from the very first frame
  mountRotateGate()
  if (skip) {
    root.remove()
    return { progress() {}, finish: () => Promise.resolve() }
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const markPaths = [...MARK_PATHS.loops.map(d => ['ld-loop', d]), ['ld-diamond', MARK_PATHS.diamond]]
    .map(([cls, d]) => `<path class="${cls}" d="${d}" pathLength="1"/>`)
    .join('')

  root.innerHTML = `
  <div class="ld" data-phase="boot">
    <div class="ld-half ld-half--top"></div>
    <div class="ld-half ld-half--bot"></div>
    <div class="ld-seam" aria-hidden="true"></div>
    <p class="sr-only" role="status">Loading ${BRAND.name}</p>
    <div class="ld-core" aria-hidden="true">
      <div class="ld-center"><div class="ld-emblem">
        <svg class="ld-orbit" viewBox="0 0 200 200">
          <circle class="ld-orbit-dash" cx="100" cy="100" r="96"/>
          <circle class="ld-orbit-track" cx="100" cy="100" r="84"/>
          <circle class="ld-orbit-arc" cx="100" cy="100" r="84" pathLength="1"/>
          <g class="ld-sat-rot"><circle class="ld-sat" cx="100" cy="16" r="2.4"/></g>
          <g class="ld-ticks">${Array.from({ length: 24 }, (_, i) => `<line x1="100" y1="2" x2="100" y2="${i % 6 ? 5 : 9}" transform="rotate(${i * 15} 100 100)"/>`).join('')}</g>
        </svg>
        <svg class="ld-mark" viewBox="${MARK_VIEWBOX}">${markPaths}</svg>
      </div></div>
      <div class="ld-readout">
      <div class="ld-count"><span class="ld-num">000</span><span class="ld-pct">%</span></div>
      <div class="ld-bar"><i></i></div>
      <p class="ld-status"><span class="ld-caret">&gt;</span> <span class="ld-status-txt"></span></p>
      </div>
    </div>
    <div class="ld-corner ld-corner--tl" aria-hidden="true">${BRAND.short.toUpperCase()} <b>//</b> BOOT SEQUENCE</div>
    <div class="ld-corner ld-corner--tr" aria-hidden="true">ORBIT·OS <b>v26.09</b></div>
    <div class="ld-corner ld-corner--bl" aria-hidden="true">39.9526° N <b>·</b> 75.1652° W</div>
    <div class="ld-corner ld-corner--br" aria-hidden="true">SIGNAL <b class="ld-sig">ACQUIRING</b></div>
  </div>`

  const wrap = root.querySelector<HTMLElement>('.ld')!
  const num = root.querySelector<HTMLElement>('.ld-num')!
  const arc = root.querySelector<SVGCircleElement>('.ld-orbit-arc')!
  const sat = root.querySelector<SVGGElement>('.ld-sat-rot')!
  const bar = root.querySelector<HTMLElement>('.ld-bar i')!
  const sig = root.querySelector<HTMLElement>('.ld-sig')!
  const statusEl = root.querySelector<HTMLElement>('.ld-status-txt')!
  // terminal-style status: types left to right, caret rides the last glyph
  let statusText = ''
  let statusT0 = 0
  const setStatus = (text: string) => {
    statusText = text.toUpperCase()
    statusT0 = performance.now() / 1000
  }
  const renderStatus = (now: number) => {
    const t = reduced ? 1 : (now - statusT0) / STATUS_DECODE
    const s = scrambleAt(statusText, t).replace(/\s+$/, '')
    if (statusEl.textContent !== s) statusEl.textContent = s
  }

  const t0 = performance.now()
  let target = 0
  let shown = 0
  let statusIx = -1
  let statusAt = -1
  let finishing = false
  let slow = false
  let raf = 0
  let last = t0

  const render = () => {
    const pct = Math.min(100, Math.floor(shown * 100 + 1e-4))
    const s = String(pct).padStart(3, '0')
    if (num.textContent !== s) num.textContent = s
    arc.style.strokeDashoffset = String(1 - shown)
    sat.setAttribute('transform', `rotate(${(shown * 360).toFixed(2)} 100 100)`)
    bar.style.transform = `scaleX(${shown.toFixed(4)})`
    let ix = 0
    for (let i = 0; i < STATUS.length; i++) if (shown >= STATUS[i][0]) ix = i
    // step through the lines one at a time so each one resolves before the next
    const now = performance.now() / 1000
    if (!finishing && !slow && ix > statusIx && now - statusAt > STATUS_HOLD) {
      statusIx++
      statusAt = now
      setStatus(STATUS[statusIx][1])
    }
    if (!finishing && !slow && now - t0 / 1000 > SLOW_AFTER) {
      // never look frozen on a slow link: say so, keep the creep going
      slow = true
      setStatus('Weak signal · holding')
      sig.textContent = 'WEAK'
    }
    renderStatus(now)
  }

  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const elapsed = (now - t0) / 1000
    // time cap keeps the count readable even when loading is instant
    const cap = finishing ? 1 : Math.min(0.97, elapsed / MIN_DISPLAY)
    // if loading stalls, keep a slow creep so the screen never looks frozen
    const creep = Math.min(0.9, shown + dt * 0.02)
    const goal = Math.min(cap, Math.max(target, finishing ? 1 : creep))
    const k = 1 - Math.exp(-(finishing ? 9 : 4.5) * dt)
    shown += (goal - shown) * k
    if (finishing && goal - shown < 0.004) shown = 1
    render()
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  render()

  let done: Promise<void> | null = null

  return {
    progress(p: number) {
      if (Number.isFinite(p)) target = Math.max(target, Math.min(1, Math.max(0, p)))
    },
    finish(): Promise<void> {
      if (done) return done
      done = (async () => {
        const elapsed = (performance.now() - t0) / 1000
        if (elapsed < MIN_DISPLAY) await wait((MIN_DISPLAY - elapsed) * 1000)
        finishing = true
        target = 1
        // let the counter land on 100
        const land = performance.now()
        while (shown < 1 && performance.now() - land < 900) await wait(30)
        shown = 1
        render()
        setStatus('Signal locked')
        sig.textContent = 'LOCKED'
        wrap.dataset.phase = 'lock'
        await wait(reduced ? 120 : 380)
        // ignite: mark fills + flashes, seam of light cuts across
        wrap.dataset.phase = 'ignite'
        await wait(reduced ? 80 : 300)
        // split open onto the scene
        wrap.dataset.phase = 'open'
        await wait(reduced ? 250 : 620)
        // resolve while the halves are still travelling so the reveal overlaps
        setTimeout(() => {
          cancelAnimationFrame(raf)
          root.remove()
        }, reduced ? 200 : 700)
      })()
      return done
    },
  }
}

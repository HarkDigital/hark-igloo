import { BRAND } from '../content'
import { markSvg } from './mark'
import { holdInert, releaseInert } from './inert'

/*
 * Phone-landscape gate. The story is composed for portrait on phones, so a
 * short, touch-first landscape viewport gets a full-screen, on-brand card
 * asking for portrait instead of a cramped scene. Tablets and laptops in
 * landscape are taller than 500px and never see it.
 *
 * Visibility is pure CSS (the same query as below, in ui.css) so it is right
 * on the very first paint; JS only makes the rest of the page inert while it
 * shows and announces it to screen readers.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

let gate: { el: HTMLElement; mq: MediaQueryList; sync: () => void } | null = null

export function mountRotateGate() {
  if (gate || typeof matchMedia === 'undefined') return
  const [wordA, wordB = ''] = BRAND.short.toUpperCase().split('.')
  const el = document.createElement('div')
  el.className = 'rot'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <span class="rot-corner rot-corner--tl" aria-hidden="true"></span><span class="rot-corner rot-corner--tr" aria-hidden="true"></span>
    <span class="rot-corner rot-corner--bl" aria-hidden="true"></span><span class="rot-corner rot-corner--br" aria-hidden="true"></span>
    <p class="rot-brand" aria-hidden="true"><span class="rot-brand-mark">${markSvg('rot-brand-svg')}</span><span class="rot-word">${wordA}<i>.</i>${wordB}</span></p>
    <div class="rot-body">
      <div class="rot-icon" aria-hidden="true">
        <svg class="rot-arrow" viewBox="0 0 120 120"><path class="rot-arc" d="M 96 36 A 44 44 0 0 1 104 64" pathLength="1"/><path class="rot-head" d="M 98.5 57.5 L 104 64 L 108.8 56.6"/><path class="rot-arc" d="M 24 84 A 44 44 0 0 1 16 56" pathLength="1"/><path class="rot-head" d="M 21.5 62.5 L 16 56 L 11.2 63.4"/></svg>
        <span class="rot-phone"><span class="rot-screen">${markSvg('rot-mark')}</span></span>
      </div>
      <h2 class="rot-title" id="rot-title">Turn your phone upright</h2>
      <p class="rot-sub" id="rot-sub"><span aria-hidden="true">// </span>Best experienced in portrait</p>
    </div>
    <p class="rot-foot" aria-hidden="true">ORIENTATION <b>·</b> <span>LANDSCAPE</span> <b>→</b> PORTRAIT</p>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  document.body.appendChild(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const mq = matchMedia(ROTATE_QUERY)
  let on = false
  const sync = () => {
    if (mq.matches === on) return
    on = mq.matches
    el.classList.toggle('is-on', on)
    if (on) {
      holdInert('rotate', ['chrome', 'stages', 'track', 'loader'].map(id => document.getElementById(id)))
      holdInert('rotate', [document.querySelector<HTMLElement>('.skip-link')])
      // focus is now stranded in an inert layer (or on <body>): bring it in
      el.focus({ preventScroll: true })
      // a live region only speaks when its text changes after it is shown
      requestAnimationFrame(() => (live.textContent = 'Turn your phone upright. Best experienced in portrait.'))
    } else {
      releaseInert('rotate')
      live.textContent = ''
    }
  }
  mq.addEventListener?.('change', sync)
  sync()
  gate = { el, mq, sync }
}

/** The plain HTML fallback reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  gate.mq.removeEventListener?.('change', gate.sync)
  gate.el.remove()
  releaseInert('rotate')
  gate = null
}

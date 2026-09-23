import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND, MICROCOPY } from '../content'
import { Scramble, scrambleAt } from '../core/scramble'
import { markSvg } from './mark'
import { holdInert, releaseInert } from './inert'
import { mountRotateGate } from './rotate'

/*
 * Persistent HUD chrome — an igloo.inc-style instrument frame.
 *
 *   top-left      mark + HARK.DIGITAL wordmark + locale sub-line (→ back to start)
 *   top-right     Work · Services · Contact + "Start a project" pill (→ contact)
 *                 (≤ 900px: MENU button → full-screen overlay menu)
 *   bottom-left   AUDIO toggle with a tiny equalizer
 *   bottom-right  chapter index "02 / 07 — ARTIFACTS · WORK" (decodes on
 *                 change), progress rail with one evenly spaced tick per
 *                 chapter, live telemetry line
 *   corners       faint viewfinder brackets that flash on every cut
 *
 * All bands respect env(safe-area-inset-*). Visitor jumps go through
 * engine.land(), which lands on settled copy and cuts on long jumps.
 *
 * API: createChrome(root, engine, sound) -> { update(frame, state) }
 */

const NAV = [
  { id: 'work', label: 'Work' },
  { id: 'services', label: 'Services' },
  { id: 'contact', label: 'Contact' },
]

/** Plain business names shown next to each chapter's poetic label. */
const PLAIN: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  shield: 'Security',
  voices: 'Clients',
  portal: 'Process',
  contact: 'Contact',
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const MINUS = '−'

export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  const slots = engine.slots
  const total = slots.length
  const indexOf = (id: string) => slots.findIndex(s => s.def.id === id)
  const [wordA, wordB = ''] = BRAND.short.toUpperCase().split('.')
  const plainOf = (id: string, fallback: string) => PLAIN[id] ?? fallback
  const nav = NAV.filter(n => indexOf(n.id) >= 0)

  mountRotateGate()

  const navLinks = nav
    .map(
      n =>
        `<a class="ch-link" href="#${n.id}" data-goto="${n.id}" aria-label="${n.label}"><span class="ch-link-txt" data-text="${n.label.toUpperCase()}">${n.label}</span></a>`,
    )
    .join('')

  // evenly spaced (one segment per chapter) so every tick keeps a ≥ 24px target
  const ticks = slots
    .map((s, i) => {
      const plain = plainOf(s.def.id, s.def.label)
      const tag = `${pad2(i + 1)} ${s.def.label.toUpperCase()} · ${plain.toUpperCase()}`
      return `<button class="ch-tick" type="button" data-goto="${s.def.id}" data-label="${tag}" style="left:${((i / total) * 100).toFixed(3)}%" aria-label="${s.def.label} · ${plain}, chapter ${i + 1} of ${total}"><span></span></button>`
    })
    .join('')

  const menuLinks = nav
    .map((n, i) => {
      const slot = slots[indexOf(n.id)]
      return `<li style="--i:${i}"><a class="ch-menu-link" href="#${n.id}" data-goto="${n.id}"><span class="ch-menu-txt">${n.label}</span><span class="ch-menu-tag" aria-hidden="true">// ${slot.def.label}</span></a></li>`
    })
    .join('')

  root.innerHTML = `
  <div class="chrome">
    <div class="ch-frame" aria-hidden="true">
      <span class="ch-corner ch-corner--tl"></span><span class="ch-corner ch-corner--tr"></span>
      <span class="ch-corner ch-corner--bl"></span><span class="ch-corner ch-corner--br"></span>
      <span class="ch-edge ch-edge--l"></span><span class="ch-edge ch-edge--r"></span>
    </div>

    <header class="ch-top">
      <a class="ch-brand" href="#hero" data-goto="hero" aria-label="${BRAND.name}, back to start">
        <span class="ch-mark">${markSvg('ch-mark-svg')}</span>
        <span class="ch-brand-text" aria-hidden="true">
          <span class="ch-word">${wordA}<i>.</i>${wordB}</span>
          <span class="ch-sub" data-text="// ${BRAND.locale.toUpperCase()}"></span>
        </span>
      </a>
      <nav class="ch-nav" aria-label="Primary">
        ${navLinks}
        <a class="ch-cta" href="#contact" data-goto="contact" data-focus><span class="ch-cta-dot" aria-hidden="true"></span><span>Start a project</span><span class="ch-cta-arrow" aria-hidden="true">→</span></a>
      </nav>
      <button class="ch-menu-btn" type="button" aria-expanded="false" aria-controls="ch-menu" aria-haspopup="dialog">
        <span class="ch-menu-btn-txt">Menu</span><span class="ch-menu-icon" aria-hidden="true"><i></i><i></i></span>
      </button>
    </header>

    <div class="ch-menu" id="ch-menu" role="dialog" aria-modal="true" aria-label="Menu" data-lenis-prevent hidden>
      <button class="ch-menu-btn ch-menu-close" type="button" aria-label="Close menu">
        <span class="ch-menu-btn-txt" aria-hidden="true">Close</span><span class="ch-menu-icon" aria-hidden="true"><i></i><i></i></span>
      </button>
      <div class="ch-menu-inner">
        <p class="ch-menu-eyebrow" aria-hidden="true">// Navigation</p>
        <ul class="ch-menu-list">${menuLinks}</ul>
        <div class="ch-menu-foot">
          <a class="hud-btn ch-menu-cta" href="#contact" data-goto="contact">Start a project <span aria-hidden="true">→</span></a>
          <a class="ch-menu-mail" href="mailto:${BRAND.email}">${BRAND.email}</a>
          <p class="ch-menu-locale">${BRAND.locale}</p>
        </div>
      </div>
    </div>

    <div class="ch-bottom">
      <button class="ch-sound" type="button" data-sound-toggle aria-pressed="false">
        <span class="ch-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="ch-sound-label">${MICROCOPY.audio}<span aria-hidden="true">:</span></span>
        <span class="ch-sound-state" aria-hidden="true">${MICROCOPY.audioOff}</span>
      </button>

      <div class="ch-index">
        <p class="ch-index-line" aria-hidden="true">
          <span class="ch-ix-num">01</span><span class="ch-ix-of">/ ${pad2(total)}</span><span class="ch-ix-dash">—</span><span class="ch-ix-label"></span><span class="ch-ix-plain"></span>
        </p>
        <nav class="ch-rail" aria-label="Chapters">
          <span class="ch-rail-track" aria-hidden="true"></span>
          <span class="ch-rail-fill" aria-hidden="true"></span>
          <span class="ch-rail-head" aria-hidden="true"></span>
          ${ticks}
        </nav>
        <p class="ch-telemetry" aria-hidden="true"></p>
      </div>
    </div>
  </div>`

  // header-first tab order: the chrome (brand, nav, sound, chapter rail) comes
  // before the active chapter's content. Stacking is set by z-index, not order.
  const stagesEl = document.getElementById('stages')
  if (stagesEl && stagesEl.parentNode === root.parentNode && root.compareDocumentPosition(stagesEl) & Node.DOCUMENT_POSITION_PRECEDING) {
    stagesEl.parentNode!.insertBefore(root, stagesEl)
  }

  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!
  const chrome = $('.chrome')
  const ixNum = $('.ch-ix-num')
  const ixLabel = new Scramble($('.ch-ix-label'))
  const ixPlain = new Scramble($('.ch-ix-plain'))
  const rail = $('.ch-rail')
  const telemetry = $('.ch-telemetry')
  const soundBtn = $<HTMLButtonElement>('.ch-sound')
  const soundState = $('.ch-sound-state')
  const menuBtn = $<HTMLButtonElement>('.ch-top .ch-menu-btn')
  const menuClose = $<HTMLButtonElement>('.ch-menu-close')
  const menu = $('.ch-menu')
  const sub = $('.ch-sub')
  const tickEls = [...root.querySelectorAll<HTMLButtonElement>('.ch-tick')]
  const navEls = [...root.querySelectorAll<HTMLAnchorElement>('.ch-link')]

  // ---------------------------------------------------------------- navigation

  const go = (id: string) => {
    if (indexOf(id) < 0) return
    engine.land(id)
  }

  /**
   * Move keyboard / screen-reader focus to the destination chapter's heading
   * in the linear copy layer, so the next Tab continues from there (the way a
   * route change should behave). Without preventScroll the page would jump.
   */
  const focusChapter = (id: string) => {
    const section = document.getElementById(id)
    const heading = section?.querySelector<HTMLElement>('h1, h2')
    if (!heading) return
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }

  root.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLElement>('[data-goto]')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const id = a.dataset.goto!
    const fromMenu = menuOpen && menu.contains(a)
    if (menuOpen) closeMenu(false)
    go(id)
    // menu links always hand focus on (the menu they lived in is gone); the
    // top nav + CTA do it for keyboard activation (click.detail 0)
    if (fromMenu || (e.detail === 0 && (a.matches('.ch-link') || a.hasAttribute('data-focus')))) focusChapter(id)
  })

  // hover blips + decode the nav label on hover
  const blipTargets = root.querySelectorAll<HTMLElement>('.ch-link, .ch-cta, .ch-tick, .ch-brand, .ch-sound, .ch-top .ch-menu-btn')
  blipTargets.forEach((node, i) => {
    node.addEventListener('pointerenter', () => {
      sound.blip(i)
      const txt = node.querySelector<HTMLElement>('.ch-link-txt')
      if (txt?.dataset.text) new Scramble(txt).play(txt.dataset.text, { duration: 0.35 })
    })
  })

  // --------------------------------------------------------------------- sound

  const syncSound = (on: boolean) => {
    soundBtn.setAttribute('aria-pressed', String(on))
    soundState.textContent = on ? MICROCOPY.audioOn : MICROCOPY.audioOff
    chrome.classList.toggle('is-sound', on)
  }
  soundBtn.addEventListener('click', () => sound.toggle())
  sound.onChange.push(syncSound)
  syncSound(sound.enabled)

  // ---------------------------------------------------------------- mobile menu

  // A real modal: its own Close button lives inside the dialog (drawn exactly
  // where MENU sits), focus moves in on open and back on close, Escape closes,
  // and everything behind it (scene, copy layer, the rest of the chrome) is
  // inert while it is open.
  let menuOpen = false
  let hideTimer = 0
  const focusables = () =>
    [...menu.querySelectorAll<HTMLElement>('a[href], button')].filter(el => !el.hidden && el.getClientRects().length > 0)
  const openMenu = () => {
    if (menuOpen) return
    menuOpen = true
    clearTimeout(hideTimer)
    menu.hidden = false
    // next frame so the transition runs from the hidden state
    requestAnimationFrame(() => {
      if (menuOpen) chrome.classList.add('is-menu')
    })
    menuBtn.setAttribute('aria-expanded', 'true')
    holdInert('menu', [
      document.getElementById('stages'),
      document.getElementById('track'),
      document.querySelector<HTMLElement>('.skip-link'),
      $('.ch-top'),
      $('.ch-bottom'),
    ])
    engine.lenis.stop()
    menu.scrollTop = 0
    menu.querySelector<HTMLElement>('.ch-menu-link')?.focus({ preventScroll: true })
  }
  const closeMenu = (restoreFocus = true) => {
    if (!menuOpen) return
    menuOpen = false
    chrome.classList.remove('is-menu')
    menuBtn.setAttribute('aria-expanded', 'false')
    releaseInert('menu')
    engine.lenis.start()
    hideTimer = window.setTimeout(() => {
      if (!menuOpen) menu.hidden = true
    }, 420)
    if (restoreFocus) menuBtn.focus({ preventScroll: true })
  }
  menuBtn.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()))
  menuClose.addEventListener('click', () => closeMenu())
  window.addEventListener('keydown', e => {
    if (!menuOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
    } else if (e.key === 'Tab') {
      const f = focusables()
      if (!f.length) return
      const i = f.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i < 0 || i === f.length - 1 ? 0 : i + 1
      e.preventDefault()
      f[next].focus()
    }
  })
  matchMedia('(min-width: 901px)').addEventListener('change', e => {
    if (e.matches) closeMenu(false)
  })

  // -------------------------------------------------------------------- reveal

  let currentLabel = ''
  let currentPlain = ''
  const revealChrome = () => {
    if (chrome.classList.contains('is-in')) return
    chrome.classList.add('is-in')
    // the first chapter label decoded under the loader; decode it again in view
    if (currentLabel) {
      ixLabel.clear()
      ixPlain.clear()
      ixLabel.play(currentLabel, { duration: 0.8, delay: 0.55 })
      ixPlain.play(currentPlain, { duration: 0.7, delay: 0.75 })
    }
    const subText = sub.dataset.text ?? ''
    new Scramble(sub).play(subText, { duration: 1.1, delay: 0.35 })
    navEls.forEach((a, i) => {
      const t = a.querySelector<HTMLElement>('.ch-link-txt')!
      new Scramble(t).play(t.dataset.text ?? '', { duration: 0.6, delay: 0.25 + i * 0.08 })
    })
  }
  if (document.documentElement.dataset.ready) revealChrome()
  else window.addEventListener('hark:reveal', revealChrome, { once: true })
  // safety net: never leave the chrome hidden
  window.setTimeout(revealChrome, 9000)

  // -------------------------------------------------------------------- update

  let lastIndex = -1
  let lastTelemetry = 0
  let cutTimer = 0
  let lastP = -1
  let flashy = false

  const flashCut = () => {
    chrome.classList.remove('is-cut')
    void chrome.offsetWidth
    chrome.classList.add('is-cut')
    clearTimeout(cutTimer)
    cutTimer = window.setTimeout(() => chrome.classList.remove('is-cut'), 650)
  }

  return {
    update(frame: Frame, state: EngineState) {
      const slot = state.slots[state.index]
      if (!slot) return

      if (state.index !== lastIndex) {
        const first = lastIndex < 0
        lastIndex = state.index
        ixNum.textContent = pad2(state.index + 1)
        currentLabel = slot.def.label.toUpperCase()
        currentPlain = `· ${plainOf(slot.def.id, slot.def.label).toUpperCase()}`
        ixLabel.play(currentLabel, { duration: first ? 0.9 : 0.55, delay: first ? 0.6 : 0 })
        ixPlain.play(currentPlain, { duration: first ? 0.7 : 0.45, delay: first ? 0.8 : 0.12 })
        tickEls.forEach((t, i) => {
          t.classList.toggle('is-active', i === state.index)
          t.classList.toggle('is-past', i < state.index)
          if (i === state.index) t.setAttribute('aria-current', 'step')
          else t.removeAttribute('aria-current')
        })
        navEls.forEach(a => {
          const on = a.dataset.goto === slot.def.id
          a.classList.toggle('is-active', on)
          if (on) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        chrome.dataset.chapter = slot.def.id
        if (!first) flashCut()
      }

      // around a cut peak (or a chapter's own flash) the frame goes white: drop the
      // scrims + text halos so they don't read as grey bands
      const flash = engine.post.transition > 0.35 || engine.post.params.flash > 0.25
      if (flash !== flashy) {
        flashy = flash
        chrome.classList.toggle('is-flash', flash)
      }

      // one equal segment per chapter, filled by the chapter's own progress,
      // so the head crosses a tick exactly at that chapter's cut
      const p = Math.min(1, (state.index + Math.min(1, Math.max(0, state.local))) / total)
      if (Math.abs(p - lastP) > 0.0002) {
        lastP = p
        rail.style.setProperty('--p', p.toFixed(4))
      }

      // telemetry at ~12 Hz so the digits read as a live readout, not noise
      if (frame.time - lastTelemetry > 0.085) {
        lastTelemetry = frame.time
        const vel = Math.min(0.99, Math.abs(frame.velocity) / 5)
        const g = frame.progress
        const ra = 4 + g * 16 + Math.sin(frame.time * 0.05) * 0.004
        const h = Math.floor(ra)
        const m = Math.floor((ra - h) * 60)
        const dec = -62.4 + g * 96 + Math.sin(frame.time * 0.21) * 0.08
        const dd = Math.floor(Math.abs(dec))
        const dm = Math.floor((Math.abs(dec) - dd) * 60)
        const sign = dec < 0 ? MINUS : '+'
        let txt = `VEL ${vel.toFixed(2)}c · RA ${pad2(h)}h ${pad2(m)}m · DEC ${sign}${pad2(dd)}°${pad2(dm)}′`
        // a moving scroll briefly scrambles a few trailing glyphs
        if (vel > 0.12 && !frame.reducedMotion) txt = txt.slice(0, 10) + scrambleAt(txt.slice(10), 0.92)
        if (telemetry.textContent !== txt) telemetry.textContent = txt
      }
    },
  }
}

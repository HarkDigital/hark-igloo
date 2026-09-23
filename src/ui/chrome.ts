import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND, CONTACT } from '../content'
import { Scramble, scrambleAt } from '../core/scramble'
import { markSvg } from './mark'

/*
 * Persistent HUD chrome — an igloo.inc-style instrument frame.
 *
 *   top-left      mark + HARK.DIGITAL wordmark + locale sub-line (→ back to start)
 *   top-right     Services · Work · Contact + "Start a project" pill
 *                 (≤ 900px: MENU button → full-screen overlay menu)
 *   bottom-left   SOUND toggle with a tiny equalizer
 *   bottom-right  chapter index (decodes on change), progress rail with one
 *                 clickable tick per chapter, live telemetry line
 *   corners       faint viewfinder brackets that flash on every cut
 *
 * API: createChrome(root, engine, sound) -> { update(frame, state) }
 */

const NAV = [
  { id: 'services', label: 'Services' },
  { id: 'work', label: 'Work' },
  { id: 'contact', label: 'Contact' },
]

/**
 * Where a nav jump lands inside each chapter (local progress): the first
 * point where the chapter's headline has fully resolved. Local 0 sits exactly
 * on the glitch-cut peak, so anything unlisted lands just past the cut window.
 */
const LANDING: Record<string, number> = { hero: 0, services: 0.08, work: 0.13, contact: 0.3 }
const landingFor = (id: string, lengthVh: number) => LANDING[id] ?? Math.min(0.2, Math.max(0.06, 0.34 / lengthVh))

const pad2 = (n: number) => String(n).padStart(2, '0')
const MINUS = '−'

export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  const slots = engine.slots
  const total = slots.length
  const indexOf = (id: string) => slots.findIndex(s => s.def.id === id)
  const [wordA, wordB = ''] = BRAND.short.toUpperCase().split('.')

  const navLinks = NAV.filter(n => indexOf(n.id) >= 0)
    .map(
      n =>
        `<a class="ch-link" href="#${n.id}" data-goto="${n.id}" aria-label="${n.label}"><span class="ch-link-ix" aria-hidden="true">${pad2(indexOf(n.id) + 1)}</span><span class="ch-link-txt" data-text="${n.label.toUpperCase()}">${n.label}</span></a>`,
    )
    .join('')

  const ticks = slots
    .map(
      (s, i) =>
        `<button class="ch-tick" type="button" data-goto="${s.def.id}" data-label="${pad2(i + 1)} ${s.def.label.toUpperCase()}" style="left:${((s.start / engine.state.total) * 100).toFixed(3)}%" aria-label="Chapter ${i + 1} of ${total}: ${s.def.label}"><span></span></button>`,
    )
    .join('')

  const menuLinks = NAV.filter(n => indexOf(n.id) >= 0)
    .map(
      (n, i) =>
        `<li style="--i:${i}"><a class="ch-menu-link" href="#${n.id}" data-goto="${n.id}"><span class="ch-menu-ix" aria-hidden="true">${pad2(indexOf(n.id) + 1)}</span><span class="ch-menu-txt">${n.label}</span></a></li>`,
    )
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
        <a class="ch-cta" href="${CONTACT.href}"><span class="ch-cta-dot" aria-hidden="true"></span><span>Start a project</span><span class="ch-cta-arrow" aria-hidden="true">↗</span></a>
      </nav>
      <button class="ch-menu-btn" type="button" aria-expanded="false" aria-controls="ch-menu">
        <span class="ch-menu-btn-txt">Menu</span><span class="ch-menu-icon" aria-hidden="true"><i></i><i></i></span>
      </button>
    </header>

    <div class="ch-menu" id="ch-menu" role="dialog" aria-modal="true" aria-label="Menu" hidden>
      <div class="ch-menu-inner">
        <p class="ch-menu-eyebrow" aria-hidden="true">// Navigation</p>
        <ol class="ch-menu-list">${menuLinks}</ol>
        <div class="ch-menu-foot">
          <a class="hud-btn ch-menu-cta" href="${CONTACT.href}">Start a project <span aria-hidden="true">↗</span></a>
          <a class="ch-menu-mail" href="mailto:${BRAND.email}">${BRAND.email}</a>
          <p class="ch-menu-locale">${BRAND.locale}</p>
        </div>
      </div>
    </div>

    <div class="ch-bottom">
      <button class="ch-sound" type="button" data-sound-toggle aria-pressed="false">
        <span class="ch-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="ch-sound-label">Sound<span aria-hidden="true">:</span></span>
        <span class="ch-sound-state" aria-hidden="true">Off</span>
      </button>

      <div class="ch-index">
        <p class="ch-index-line" aria-hidden="true">
          <span class="ch-ix-num">01</span><span class="ch-ix-of">/ ${pad2(total)}</span><span class="ch-ix-dash">—</span><span class="ch-ix-label"></span>
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
  const rail = $('.ch-rail')
  const telemetry = $('.ch-telemetry')
  const soundBtn = $<HTMLButtonElement>('.ch-sound')
  const soundState = $('.ch-sound-state')
  const menuBtn = $<HTMLButtonElement>('.ch-menu-btn')
  const menuBtnTxt = $('.ch-menu-btn-txt')
  const menu = $('.ch-menu')
  const sub = $('.ch-sub')
  const tickEls = [...root.querySelectorAll<HTMLButtonElement>('.ch-tick')]
  const navEls = [...root.querySelectorAll<HTMLAnchorElement>('.ch-link')]

  // ---------------------------------------------------------------- navigation

  const go = (id: string) => {
    const slot = slots.find(s => s.def.id === id)
    if (!slot) return
    engine.land(id)
  }

  root.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLElement>('[data-goto]')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const id = a.dataset.goto!
    if (menuOpen) closeMenu(false)
    go(id)
  })

  // hover blips + decode the nav label on hover
  const blipTargets = root.querySelectorAll<HTMLElement>('.ch-link, .ch-cta, .ch-tick, .ch-brand, .ch-sound, .ch-menu-btn')
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
    soundState.textContent = on ? 'On' : 'Off'
    chrome.classList.toggle('is-sound', on)
  }
  soundBtn.addEventListener('click', () => sound.toggle())
  sound.onChange.push(syncSound)
  syncSound(sound.enabled)

  // ---------------------------------------------------------------- mobile menu

  let menuOpen = false
  const focusables = () => [menuBtn, ...menu.querySelectorAll<HTMLElement>('a, button')]
  const openMenu = () => {
    if (menuOpen) return
    menuOpen = true
    menu.hidden = false
    // next frame so the transition runs from the hidden state
    requestAnimationFrame(() => chrome.classList.add('is-menu'))
    menuBtn.setAttribute('aria-expanded', 'true')
    menuBtnTxt.textContent = 'Close'
    engine.lenis.stop()
    menu.querySelector<HTMLElement>('.ch-menu-link')?.focus({ preventScroll: true })
  }
  const closeMenu = (restoreFocus = true) => {
    if (!menuOpen) return
    menuOpen = false
    chrome.classList.remove('is-menu')
    menuBtn.setAttribute('aria-expanded', 'false')
    menuBtnTxt.textContent = 'Menu'
    engine.lenis.start()
    window.setTimeout(() => {
      if (!menuOpen) menu.hidden = true
    }, 420)
    if (restoreFocus) menuBtn.focus({ preventScroll: true })
  }
  menuBtn.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()))
  window.addEventListener('keydown', e => {
    if (!menuOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
    } else if (e.key === 'Tab') {
      const f = focusables()
      const i = f.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1
      e.preventDefault()
      f[next]?.focus()
    }
  })
  matchMedia('(min-width: 901px)').addEventListener('change', e => {
    if (e.matches) closeMenu(false)
  })

  // -------------------------------------------------------------------- reveal

  let currentLabel = ''
  const revealChrome = () => {
    if (chrome.classList.contains('is-in')) return
    chrome.classList.add('is-in')
    // the first chapter label decoded under the loader; decode it again in view
    if (currentLabel) {
      ixLabel.clear()
      ixLabel.play(currentLabel, { duration: 0.8, delay: 0.55 })
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
        ixLabel.play(currentLabel, { duration: first ? 0.9 : 0.55, delay: first ? 0.6 : 0 })
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

      const p = frame.progress
      if (Math.abs(p - lastP) > 0.0002) {
        lastP = p
        rail.style.setProperty('--p', p.toFixed(4))
      }

      // telemetry at ~12 Hz so the digits read as a live readout, not noise
      if (frame.time - lastTelemetry > 0.085) {
        lastTelemetry = frame.time
        const vel = Math.min(0.99, Math.abs(frame.velocity) / 5)
        const ra = 4 + p * 16 + Math.sin(frame.time * 0.05) * 0.004
        const h = Math.floor(ra)
        const m = Math.floor((ra - h) * 60)
        const dec = -62.4 + p * 96 + Math.sin(frame.time * 0.21) * 0.08
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

import { BRAND, CONTACT, PROCESS, SECTIONS, SECURITY, SERVICES, STATS, TESTIMONIALS, WORK, workImage } from '../content'
import { markSvg } from './mark'
import { unmountRotateGate } from './rotate'

/**
 * Plain HTML version of the story for browsers without WebGL2 (and the
 * last-resort view if boot fails). Same copy, same HUD vocabulary, no scene.
 * Styled by the .fb-* rules in ui.css.
 */
export function renderFallback(root: HTMLElement) {
  document.documentElement.classList.add('no-webgl')
  unmountRotateGate()
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const [wordA, wordB = ''] = BRAND.short.toUpperCase().split('.')
  const newTab = '<span class="sr-only"> (opens in a new tab)</span>'
  root.style.pointerEvents = 'auto'
  root.innerHTML = `
  <div class="fb">
    <header class="fb-top">
      <a class="fb-brand" href="#fb-top" aria-label="${esc(BRAND.name)}, top of page">
        <span class="fb-mark">${markSvg('fb-mark-svg')}</span>
        <span class="fb-word" aria-hidden="true">${wordA}<i>.</i>${wordB}</span>
      </a>
      <nav class="fb-nav" aria-label="Primary">
        <a class="fb-link" href="#fb-work">Work</a>
        <a class="fb-link" href="#fb-services">Services</a>
        <a class="fb-link" href="#fb-contact">Contact</a>
        <a class="fb-cta" href="${CONTACT.href}">Start a project <span aria-hidden="true">→</span></a>
      </nav>
    </header>

    <section class="fb-hero" id="fb-top" aria-labelledby="fb-h1">
      <p class="hud-eyebrow">${esc(BRAND.locale)}</p>
      <h1 class="hud-title" id="fb-h1">${esc(BRAND.tagline)}</h1>
      <p class="hud-body fb-lede">${esc(BRAND.manifesto)}</p>
    </section>

    <section class="fb-sec" id="fb-work" aria-labelledby="fb-work-h">
      <p class="hud-eyebrow">${esc(SECTIONS.work.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-work-h">${esc(SECTIONS.work.title)}</h2>
      <ul class="fb-work">
        ${WORK.map(
          w => `<li><a class="fb-card" href="${w.url}" target="_blank" rel="noopener">
            <img src="${workImage(w.id)}" alt="" loading="lazy" width="1280" height="800">
            <span class="fb-card-name">${esc(w.name)}${newTab}</span>
            <span class="hud-label">${esc(w.industry)}</span>
          </a></li>`,
        ).join('')}
      </ul>
    </section>

    <section class="fb-sec" id="fb-services" aria-labelledby="fb-services-h">
      <p class="hud-eyebrow">${esc(SECTIONS.services.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-services-h">${esc(SECTIONS.services.title)}</h2>
      <ul class="fb-grid">
        ${SERVICES.map(
          s => `<li class="fb-cell"><p class="fb-num" aria-hidden="true">${s.num}</p><h3 class="fb-h3">${esc(s.title)}</h3><p class="hud-body">${esc(s.blurb)}</p></li>`,
        ).join('')}
      </ul>
    </section>

    <section class="fb-sec" id="fb-security" aria-labelledby="fb-security-h">
      <p class="hud-eyebrow">${esc(SECURITY.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-security-h">${esc(SECURITY.title)}</h2>
      <p class="hud-body fb-lede">${esc(SECURITY.body)}</p>
      <p class="fb-actions"><a class="hud-btn hud-btn--ghost" href="${SECURITY.href}">${esc(SECURITY.cta)}</a></p>
    </section>

    <section class="fb-sec" id="fb-process" aria-labelledby="fb-process-h">
      <p class="hud-eyebrow">Process</p>
      <h2 class="hud-h2" id="fb-process-h">How we work</h2>
      <ol class="fb-grid fb-grid--4">
        ${PROCESS.map(
          (p, i) => `<li class="fb-cell"><p class="fb-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</p><h3 class="fb-h3">${esc(p.title)}</h3><p class="hud-body">${esc(p.text)}</p></li>`,
        ).join('')}
      </ol>
      <ul class="fb-stats">
        ${STATS.map(st => `<li><span class="fb-stat">${esc(st.value)}</span><span class="fb-stat-l">${esc(st.label)}</span></li>`).join('')}
      </ul>
    </section>

    <section class="fb-sec" id="fb-voices" aria-labelledby="fb-voices-h">
      <p class="hud-eyebrow">${esc(SECTIONS.voices.eyebrow)}</p>
      <h2 class="hud-h2" id="fb-voices-h">${esc(SECTIONS.voices.title)}</h2>
      <ul class="fb-quotes">
        ${TESTIMONIALS.map(
          t => `<li><figure class="fb-quote"><blockquote><p>“${esc(t.quote)}”</p></blockquote><figcaption class="hud-label">${esc(t.name)} · ${esc(t.company)}</figcaption></figure></li>`,
        ).join('')}
      </ul>
    </section>

    <section class="fb-sec fb-contact" id="fb-contact" aria-labelledby="fb-contact-h">
      <p class="hud-eyebrow">${esc(CONTACT.eyebrow)}</p>
      <h2 class="hud-title" id="fb-contact-h">${esc(CONTACT.title)}</h2>
      <p class="hud-body fb-lede">${esc(CONTACT.body)}</p>
      <p class="fb-actions"><a class="hud-btn" href="${CONTACT.href}">${esc(BRAND.email)} <span aria-hidden="true">→</span></a></p>
    </section>

    <footer class="fb-foot">
      <p>© ${new Date().getFullYear()} ${esc(BRAND.name)} · ${esc(BRAND.locale)}</p>
      <p><a href="${BRAND.classicSite}">Classic site</a></p>
    </footer>
  </div>`
}

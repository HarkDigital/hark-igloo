import { BRAND, CONTACT, PROCESS, SECTIONS, SECURITY, SERVICES, STATS, TESTIMONIALS, WORK } from '../content'

/*
 * The accessible layer. Each chapter's copy, as plain linear semantic HTML,
 * lives inside that chapter's scroll <section> in #track. It is visually
 * hidden (the canvas + stages are the visual layer and are aria-hidden), but
 * screen readers, crawlers and keyboard users get the whole story in order.
 * Focusing a link here moves the visuals to its chapter (Engine.land), and
 * the focused link itself becomes visible (.sr-copy :focus-visible in base.css).
 *
 * renderFallback() reuses the same builders, visibly, when WebGL2 is missing.
 */

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const ext = (href: string, label: string) =>
  `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}<span class="sr-note"> (opens in a new tab)</span></a>`

const COPY: Record<string, () => string> = {
  hero: () => `
    <p class="sr-kicker">${esc(BRAND.name)} · ${esc(BRAND.locale)}</p>
    <h1>${esc(BRAND.tagline)}</h1>
    <p>${esc(BRAND.manifesto)}</p>
    <p><a href="#work" data-land="work">See the work</a> · <a href="${esc(CONTACT.href)}">Start a project</a></p>`,

  work: () => `
    <h2>${esc(SECTIONS.work.title)}</h2>
    <p>${esc(SECTIONS.work.eyebrow)} — ${WORK.length} live sites.</p>
    <ul>${WORK.map(
      w => `<li><h3>${esc(w.name)}</h3><p>${esc(w.industry)}. ${esc(w.blurb)}</p><p>${ext(w.url, `Visit ${w.name}`)}</p></li>`,
    ).join('')}</ul>`,

  services: () => `
    <h2>${esc(SECTIONS.services.title)}</h2>
    <p>${esc(SECTIONS.services.eyebrow)}.</p>
    <ol>${SERVICES.map(
      s => `<li><h3>${esc(s.title)}</h3><p>${esc(s.blurb)}</p><p>${s.tags.map(esc).join(' · ')}</p></li>`,
    ).join('')}</ol>`,

  shield: () => `
    <h2>${esc(SECURITY.title)}</h2>
    <p>${esc(SECURITY.eyebrow)}.</p>
    <p>${esc(SECURITY.body)}</p>
    <p><a href="${esc(SECURITY.href)}">${esc(SECURITY.cta.replace(/\s*→\s*$/, ''))}</a></p>`,

  voices: () => `
    <h2>${esc(SECTIONS.voices.title)}</h2>
    <p>${esc(SECTIONS.voices.eyebrow)}.</p>
    ${TESTIMONIALS.map(
      t => `<figure><blockquote><p>${esc(t.quote)}</p></blockquote><figcaption>${esc(t.name)}, ${esc(t.company)}</figcaption></figure>`,
    ).join('')}`,

  portal: () => `
    <h2>How we work</h2>
    <ol>${PROCESS.map(p => `<li><h3>${esc(p.title)}</h3><p>${esc(p.text)}</p></li>`).join('')}</ol>
    <ul>${STATS.slice(0, 3).map(s => `<li>${esc(s.value)}: ${esc(s.label)}</li>`).join('')}</ul>`,

  contact: () => `
    <h2>${esc(CONTACT.title)}</h2>
    <p>${esc(CONTACT.body)}</p>
    <p><a href="${esc(CONTACT.href)}">Email ${esc(BRAND.email)}</a></p>
    <p>${ext(BRAND.classicSite, 'See the classic 2026 site')}</p>
    <p><a href="#hero" data-land="hero">Back to top</a></p>
    <p>© ${new Date().getFullYear()} ${esc(BRAND.name)} · ${esc(BRAND.locale)}</p>`,
}

/** Visually hidden, linear copy for one chapter (null for unknown ids). */
export function buildChapterCopy(id: string, visible = false): HTMLElement | null {
  const html = COPY[id]
  if (!html) return null
  const div = document.createElement('div')
  div.className = visible ? 'fallback-copy' : 'sr-copy'
  div.innerHTML = html()
  // in-page links drive the story instead of jumping to an empty section
  div.querySelectorAll<HTMLAnchorElement>('a[data-land]').forEach(a =>
    a.addEventListener('click', e => {
      const target = a.dataset.land!
      const hark = window.__hark
      if (!hark) return
      e.preventDefault()
      if (target === 'hero') hark.goto(0)
      else hark.land(target)
    }),
  )
  return div
}

export const CHAPTER_COPY_IDS = Object.keys(COPY)

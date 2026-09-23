import { BRAND, CONTACT, SECTIONS, SECURITY, SERVICES, TESTIMONIALS, WORK, workImage } from '../content'
import { markSvg } from './mark'

/** Plain HTML version of the story for browsers without WebGL2. */
export function renderFallback(root: HTMLElement) {
  document.documentElement.classList.add('no-webgl')
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  root.style.pointerEvents = 'auto'
  root.innerHTML = `
  <div style="max-width:1100px;margin:0 auto;padding:40px 24px 64px">
    <p style="display:flex;align-items:center;gap:12px;margin:0 0 72px"><span style="width:34px;height:34px;display:inline-block;color:var(--paper)">${markSvg('')}</span><span style="font:700 15px/1 var(--font-display);letter-spacing:.18em;text-transform:uppercase">Hark<span style="color:var(--signal)">.</span>Digital</span></p>
    <p class="hud-eyebrow">${esc(BRAND.locale)}</p>
    <h1 class="hud-title" style="margin:16px 0 20px">${esc(BRAND.tagline)}</h1>
    <p class="hud-body">${esc(BRAND.manifesto)}</p>
    <h2 class="hud-h2" style="margin:72px 0 24px">${esc(SECTIONS.work.title)}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px">
      ${WORK.map(w => `<a href="${w.url}" target="_blank" rel="noopener" style="text-decoration:none"><img src="${workImage(w.id)}" alt="${esc(w.name)} website" loading="lazy" style="width:100%;border:1px solid var(--line)"><p style="font-family:var(--font-display);font-weight:700;margin:10px 0 4px">${esc(w.name)}</p><p class="hud-label">${esc(w.industry)}</p></a>`).join('')}
    </div>
    <h2 class="hud-h2" style="margin:72px 0 24px">${esc(SECTIONS.services.title)}</h2>
    ${SERVICES.map(s => `<div style="margin:0 0 28px"><p class="hud-label">${s.num}</p><h3 style="font-family:var(--font-display);margin:4px 0 8px">${esc(s.title)}</h3><p class="hud-body">${esc(s.blurb)}</p></div>`).join('')}
    <h2 class="hud-h2" style="margin:72px 0 24px">${esc(SECURITY.title)}</h2>
    <p class="hud-body">${esc(SECURITY.body)}</p>
    <h2 class="hud-h2" style="margin:72px 0 24px">${esc(SECTIONS.voices.title)}</h2>
    ${TESTIMONIALS.map(t => `<blockquote style="margin:0 0 28px"><p class="hud-body" style="max-width:60ch">“${esc(t.quote)}”</p><p class="hud-label">${esc(t.name)} · ${esc(t.company)}</p></blockquote>`).join('')}
    <h2 class="hud-h2" style="margin:72px 0 24px">${esc(CONTACT.title)}</h2>
    <p class="hud-body">${esc(CONTACT.body)}</p>
    <p style="margin-top:24px"><a class="hud-btn" href="${CONTACT.href}">${esc(BRAND.email)}</a></p>
  </div>`
}

/**
 * Boot screen. STUB — the UI agent replaces the internals.
 * API: createLoader(root, { skip }) -> { progress(0..1), finish(): Promise<void> }
 * finish() resolves once the loader has fully faded out.
 */
export function createLoader(root: HTMLElement, { skip = false } = {}) {
  root.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;background:#020304;font:11px var(--font-mono);letter-spacing:.2em;color:#00ff85;transition:opacity .8s">LOADING <span data-pct>000</span>%</div>`
  const wrap = root.firstElementChild as HTMLElement
  const pct = root.querySelector<HTMLElement>('[data-pct]')!
  return {
    progress(p: number) {
      pct.textContent = String(Math.round(p * 100)).padStart(3, '0')
    },
    finish(): Promise<void> {
      if (skip) {
        root.remove()
        return Promise.resolve()
      }
      wrap.style.opacity = '0'
      return new Promise(r =>
        setTimeout(() => {
          root.remove()
          r()
        }, 800),
      )
    },
  }
}

import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND } from '../content'

/**
 * Persistent HUD chrome (wordmark, nav, sound toggle, chapter index).
 * STUB — the UI agent replaces the internals.
 * API: createChrome(root, engine, sound) -> { update(frame, state) }
 */
export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  root.innerHTML = `
    <div style="position:absolute;top:24px;left:var(--gutter)" class="hud-label">${BRAND.short}</div>
    <div style="position:absolute;bottom:24px;right:var(--gutter)" class="hud-label" data-idx></div>`
  const idx = root.querySelector<HTMLElement>('[data-idx]')!
  return {
    update(_frame: Frame, state: EngineState) {
      const slot = state.slots[state.index]
      const txt = `${String(state.index + 1).padStart(2, '0')} / ${String(state.slots.length).padStart(2, '0')} — ${slot?.def.label ?? ''}`
      if (idx.textContent !== txt) idx.textContent = txt
    },
  }
}

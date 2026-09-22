import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'

/**
 * Generative ambient soundtrack (WebAudio, no files). Off by default;
 * browsers need a user gesture before audio can start.
 * STUB — the UI agent replaces the internals. Keep the public API.
 */
export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  toggle() {
    this.enabled = !this.enabled
    for (const fn of this.onChange) fn(this.enabled)
  }

  /** called every frame */
  update(_frame: Frame, _state: EngineState) {}

  /** called when the story cuts from chapter `from` to `to` */
  cut(_from: number, _to: number) {}
}

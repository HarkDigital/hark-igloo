import '@fontsource-variable/syne'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/base.css'
import './ui/ui.css'

import { Engine } from './core/Engine'
import { CHAPTERS } from './chapters/index'
import { createLoader } from './ui/loader'
import { createChrome } from './ui/chrome'
import { Sound } from './ui/sound'
import { renderFallback } from './ui/fallback'
import { mountDebug } from './core/debug'

/*
 * URL params (handy for review + screenshots):
 *   ?nointro            skip the loader animation
 *   ?c=work&l=0.5       jump to a chapter at local progress
 *   ?p=0.42             jump to global progress
 *   ?only=work          init only that chapter (fast dev loop)
 *   ?debug              fps / chapter / progress readout
 */
const params = new URLSearchParams(location.search)

declare global {
  interface Window {
    __hark?: {
      ready: boolean
      engine: Engine
      goto: (p: number) => void
      gotoChapter: (id: string, local?: number) => void
    }
  }
}

async function boot() {
  const canvas = document.getElementById('gl') as HTMLCanvasElement
  const track = document.getElementById('track')!
  let stages = document.getElementById('stages')
  if (!stages) {
    stages = document.createElement('div')
    stages.id = 'stages'
    document.body.insertBefore(stages, document.getElementById('chrome'))
  }
  const loader = createLoader(document.getElementById('loader')!, { skip: params.has('nointro') })

  if (!Engine.supported()) {
    canvas.remove()
    renderFallback(track)
    await loader.finish()
    return
  }

  const engine = new Engine(canvas, track, stages)
  engine.assets.onProgress = (done, total) => loader.progress(total ? done / total : 0)
  if (document.fonts?.ready) engine.assets.track(document.fonts.ready)
  await engine.load(CHAPTERS, params.get('only'))

  const sound = new Sound()
  const chrome = createChrome(document.getElementById('chrome')!, engine, sound)
  engine.onFrame.push((f, s) => {
    chrome.update(f, s)
    sound.update(f, s)
  })
  engine.onCut.push((a, b) => sound.cut(a, b))

  const p = params.get('p')
  const c = params.get('c')
  const hash = location.hash.slice(1)
  if (p) engine.goto(parseFloat(p))
  else if (c) engine.gotoChapter(c, parseFloat(params.get('l') ?? '0'))
  else if (hash && CHAPTERS.some(ch => ch.id === hash)) engine.gotoChapter(hash, 0)
  else engine.goto(0)

  engine.start()
  window.__hark = {
    ready: false,
    engine,
    goto: p => engine.goto(p),
    gotoChapter: (id, l = 0) => engine.gotoChapter(id, l),
  }
  if (params.has('debug')) mountDebug(engine)

  await loader.finish()
  document.documentElement.dataset.ready = '1'
  window.dispatchEvent(new Event('hark:reveal'))
  window.__hark.ready = true
}

boot().catch(err => {
  console.error('[hark] boot failed', err)
  const track = document.getElementById('track')
  if (track) renderFallback(track)
  document.getElementById('loader')?.remove()
})

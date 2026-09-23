import type { ChapterDef } from '../core/types'

/**
 * The scroll story, in order. `length` is scroll distance in viewport
 * heights. Each chapter lives in src/chapters/<id>/ and default-exports a
 * factory returning a Chapter (see src/core/types.ts).
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Signal', length: 2.8, landing: 0, load: () => import('./hero/index') },
  // proof first, like the original home page: work right after the hero
  { id: 'work', label: 'Artifacts', length: 3.8, landing: 0.13, load: () => import('./work/index') },
  { id: 'services', label: 'Orbit', length: 4.6, landing: 0.08, load: () => import('./services/index') },
  { id: 'shield', label: 'Shield', length: 1.5, load: () => import('./shield/index') },
  { id: 'voices', label: 'Transmissions', length: 3.4, landing: 0.05, load: () => import('./voices/index') },
  { id: 'portal', label: 'Gate', length: 1.8, load: () => import('./portal/index') },
  { id: 'contact', label: 'Arrival', length: 1.4, landing: 0.3, load: () => import('./contact/index') },
]

// Dev-only: ?only=lab-world previews the shared world pieces (sky, planets)
// in isolation. Never part of the story.
if (new URLSearchParams(location.search).get('only') === 'lab-world') {
  CHAPTERS.push({ id: 'lab-world', label: 'Lab', length: 3, load: () => import('../world/lab') })
}

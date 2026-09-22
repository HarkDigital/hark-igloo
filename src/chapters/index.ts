import type { ChapterDef } from '../core/types'

/**
 * The scroll story, in order. `length` is scroll distance in viewport
 * heights. Each chapter lives in src/chapters/<id>/ and default-exports a
 * factory returning a Chapter (see src/core/types.ts).
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Signal', length: 2.8, load: () => import('./hero/index') },
  { id: 'services', label: 'Orbit', length: 4.2, load: () => import('./services/index') },
  { id: 'shield', label: 'Shield', length: 1.5, load: () => import('./shield/index') },
  { id: 'work', label: 'Artifacts', length: 3.8, load: () => import('./work/index') },
  { id: 'voices', label: 'Transmissions', length: 2.2, load: () => import('./voices/index') },
  { id: 'portal', label: 'Gate', length: 1.5, load: () => import('./portal/index') },
  { id: 'contact', label: 'Arrival', length: 1.8, load: () => import('./contact/index') },
]

// Dev-only: ?only=lab-world previews the shared world pieces (sky, planets)
// in isolation. Never part of the story.
if (new URLSearchParams(location.search).get('only') === 'lab-world') {
  CHAPTERS.push({ id: 'lab-world', label: 'Lab', length: 3, load: () => import('../world/lab') })
}

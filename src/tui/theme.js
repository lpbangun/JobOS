/**
 * Locked Classic red IA tokens (spikes/visualizer/classic.html :root block).
 * Background #111, accent #ff6b6b, JetBrains Mono / Menlo / ui-monospace.
 */
import { defaultTheme, extendTheme } from '@inkjs/ui';

export const CLASSIC_THEME = Object.freeze({
  name: 'classic-red',
  // Surfaces
  bg: '#111111',
  panel: '#161616',
  line: '#3a3a3a',
  selected: '#241616',
  // Ink (text on accent / on bg)
  ink: '#111111',
  text: '#f5f5f5',
  muted: '#c8c8c8',
  accent: '#ff6b6b',
  tool: '#e8c07a',
  // Wordmark: Job white + OS accent, no space, same family
  wordmark: Object.freeze({ job: '#f5f5f5', os: '#ff6b6b' }),
  // Mono family metadata (CSS value + ordered list)
  mono: 'JetBrains Mono, Menlo, ui-monospace, monospace',
  fontFamily: Object.freeze(['JetBrains Mono', 'Menlo', 'ui-monospace', 'monospace'])
});

/** Overlay dim backdrop approximating the visualizer's rgba(0,0,0,.75). */
export const OVERLAY_BACKDROP = '#000000';

/**
 * @inkjs/ui theme derived from defaultTheme with the locked Classic red
 * chrome. Every @inkjs/ui component in the product tree resolves to the
 * Classic tokens — never the library defaults (magenta badges, blue spinner
 * frames, green/red/yellow/blue status icons).
 */
export const INKUI_THEME = Object.freeze(extendTheme(defaultTheme, {
  components: {
    Badge: {
      styles: {
        container: () => ({ backgroundColor: CLASSIC_THEME.accent }),
        label: () => ({ color: CLASSIC_THEME.ink })
      }
    },
    Spinner: {
      styles: {
        frame: () => ({ color: CLASSIC_THEME.accent }),
        label: () => ({ color: CLASSIC_THEME.accent, bold: true })
      }
    },
    StatusMessage: {
      styles: {
        icon: () => ({ color: CLASSIC_THEME.accent }),
        message: () => ({ color: CLASSIC_THEME.text })
      }
    }
  }
}));

/**
 * dsh-restart — browser half.
 *
 * Three visible surfaces, all fed by the same store:
 *   1. `settings.section` 「重启」 card in the web settings page.
 *   2. A sidebar entry (see ./floating.tsx) opening the same panel in a popover.
 *   3. A full-screen overlay (see ./overlay.tsx) shown while a restart is in
 *      flight, so the tab never looks dead and a failed boot is readable.
 *
 * Failure policy: registration problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external plugin
 * must not take the GUI down. That matters double here: this plugin exists to
 * make broken plugins recoverable.
 */
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { mountRestartEntry } from './floating.tsx'
import { mountRestartOverlay } from './overlay.tsx'
import { RestartPanel } from './RestartPanel.tsx'
import * as restartState from './state.ts'

/**
 * Test seam: `tests/selfheal.mjs` loads the built browser bundle with stubbed
 * globals and drives this real state machine — a regression for "failed state →
 * host recovers → the page heals itself". Nothing in the browser imports it.
 */
export { restartState as __test }

/** Required services. */
export const inject = ['slots']

/**
 * Register the settings card, mount the sidebar entry and the overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'restart',
          order: 338,
          label: () => '重启',
        },
        RestartPanel,
      ),
    )
  } catch (error) {
    console.warn('[dsh-restart] settings panel registration failed:', error)
  }
  try {
    mountRestartOverlay()
  } catch (error) {
    console.warn('[dsh-restart] overlay mount failed:', error)
  }
  try {
    void mountRestartEntry().catch((error: unknown) => {
      console.warn('[dsh-restart] sidebar entry mount failed:', error)
    })
  } catch (error) {
    console.warn('[dsh-restart] sidebar entry mount failed:', error)
  }
}

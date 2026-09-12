/**
 * dsh-restart build config: node-half lib bundle plus the browser client bundle
 * (lib/client.js — the closure-factory artifact for the GUI's
 * __ModuleLoader__, served at /plugins/@zhengjunyao/dsh-restart/client.js).
 *
 * The detached helper (helper/restart-helper.mjs) is hand-written plain ESM and
 * ships as-is: it has to be runnable by bare `node` even when the profile that
 * loads this plugin is broken.
 */
import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('@zhengjunyao/dsh-restart', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ],
})

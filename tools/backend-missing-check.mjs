/**
 * Verify the claims that matter for a phone install:
 *   1. the plugin loads and registers its tools even when no rasterizer is present;
 *   2. a render request then fails with the exact install commands, not a crash.
 * Run it with the optional rasterizers hidden to exercise path 2.
 */

import { apply } from '../lib/index.js'
import { createFakeHost, execFor, tempWorkspace } from '../tests/harness.mjs'

const host = createFakeHost()
apply(host.ctx)
console.log('registered tools:', [...host.tools.keys()].join(', '))

const tool = host.tools.get('svg_render')
const dir = tempWorkspace('dsh-svg-nobackend-')
try {
  const value = await tool.execute({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#eee"/></svg>' }, execFor(dir))
  console.log('rendered with:', value.backend, `${value.width}x${value.height}`)
} catch (error) {
  console.log('render refused as designed:')
  console.log(error.message)
}

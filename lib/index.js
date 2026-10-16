/**
 * dsh-svg — see what you drew.
 *
 * A Host-half DSH plugin in two tools:
 *   - `svg_render` rasterizes an SVG document inside the Harness and returns
 *     the picture to the model as a native image block (the verification step
 *     every hand-written SVG needs);
 *   - `svg_check` lints a document for the defects generated diagrams actually
 *     contain, and mechanically fixes the portable-subset violations.
 *
 * It imports nothing outside Node built-ins and its own relative modules; the
 * rasterizer is an optional dependency resolved at call time, so the plugin
 * always loads and always explains what to install.
 */

import { registerSvgCheck } from './check.js'
import { registerSvgRender } from './render.js'

export const name = 'dsh-svg'

/** The official tool registry and the official filesystem service. */
export const inject = ['tools', 'fs']

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      registerSvgRender(ctx),
      registerSvgCheck(ctx),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

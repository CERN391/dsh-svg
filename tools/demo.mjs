/**
 * Demo / smoke test: render the bundled example SVG through the plugin's real
 * backend chain and report what happened. Run it after installing, or with
 * `DSH_SVG_BACKEND=@resvg/resvg-wasm` to exercise the fallback.
 *
 *   node tools/demo.mjs [input.svg] [output.png] [scale]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { INSTALL_HINTS, describeBackends, renderSvg } from '../lib/backends.js'
import { lintSvg } from '../lib/lint.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = process.argv[2] ?? path.join(here, '..', 'skill', 'examples', 'opamp.svg')
const output = process.argv[3] ?? path.join(here, 'demo.png')
const scale = Number(process.argv[4] ?? 2)

const source = fs.readFileSync(input, 'utf8')
const { problems, notes, stats } = lintSvg(source)
console.log(`lint: ${problems.length} problem(s), ${notes.length} note(s); ${stats.textNodes} <text> nodes, canvas ${stats.canvas}`)
for (const problem of problems) console.log(`  [${problem.code}] line ${problem.line}: ${problem.message}`)
for (const note of notes) console.log(`  note: ${note}`)

console.log('backends present:', (await describeBackends()).join(', ') || '(none)')
try {
  const rendered = await renderSvg(source, { scale })
  fs.writeFileSync(output, Buffer.from(rendered.png))
  console.log(`rendered with ${rendered.backend}: ${rendered.width}x${rendered.height} px, ${rendered.png.length} bytes → ${output}`)
} catch (error) {
  console.error(String(error.message))
  console.error(INSTALL_HINTS.join('\n'))
  process.exitCode = 1
}

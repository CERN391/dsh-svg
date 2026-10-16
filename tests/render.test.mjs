import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { assertValueMatchesSchema, createFakeHost, execFor, tempWorkspace } from './harness.mjs'

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" font-family="Noto Sans CJK SC, sans-serif">
  <rect width="600" height="400" fill="#ffffff"/>
  <polygon points="80,80 80,320 280,200" fill="none" stroke="#111" stroke-width="3"/>
  <text x="110" y="150" font-size="26">−</text>
  <text x="110" y="270" font-size="26">+</text>
  <text x="330" y="120" font-size="26">u<tspan dy="7" font-size="70%">o</tspan> = 4u<tspan dy="7" font-size="70%">I</tspan>　同相比例</text>
</svg>`

function boot(options) {
  const host = createFakeHost(options)
  apply(host.ctx)
  return host
}

test('svg_render renders a PNG, attaches the image and writes it to the workspace', async () => {
  const dir = tempWorkspace()
  fs.writeFileSync(path.join(dir, 'fig.svg'), SVG)
  const host = boot()
  const tool = host.tools.get('svg_render')
  assert.ok(tool, 'svg_render registered')

  const args = { path: 'fig.svg', scale: 2 }
  const value = await tool.execute(args, execFor(dir))
  assertValueMatchesSchema('svg_render', tool.output.schema, value)

  assert.equal(value.savedPath, 'fig.png')
  assert.equal(value.imageAttached, true)
  assert.equal(value.width, 1200)
  assert.equal(value.height, 800)
  const png = fs.readFileSync(path.join(dir, 'fig.png'))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  assert.equal(host.savedImages.length, 1, 'the PNG went into the attachment store')

  const blocks = tool.output.render(args, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /Rendered fig\.svg with /)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att-1')
  assert.equal(blocks[1].attachment.mediaType, 'image/png')
})

test('svg_render works on inline markup without saving, and degrades gracefully without attachments', async () => {
  const dir = tempWorkspace()
  const host = boot({ withoutAttachments: true })
  const tool = host.tools.get('svg_render')
  const args = { svg: SVG, scale: 1 }
  const value = await tool.execute(args, execFor(dir))
  assertValueMatchesSchema('svg_render', tool.output.schema, value)
  assert.equal(value.savedPath, '', 'inline markup saves nothing by default')
  assert.equal(value.imageAttached, false)
  assert.ok(value.notes.some((note) => /attachment/i.test(note)), 'the note explains why no image was attached')
  const blocks = tool.output.render(args, value)
  assert.equal(blocks.length, 1, 'text-only when no image could be attached')
  assert.equal(value.width, 600)
})

test('svg_render refuses a path outside the workspace', async () => {
  const dir = tempWorkspace()
  const host = boot()
  const tool = host.tools.get('svg_render')
  await assert.rejects(() => tool.execute({ svg: SVG, out: '../escape.png' }, execFor(dir)), /outside the session workspace/)
})

test('svg_check lints and writes a fixed copy', async () => {
  const dir = tempWorkspace()
  const bad = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
  <text x="20" y="40" font-size="24">u_o = 2u_+ 中文</text>
</svg>`
  fs.writeFileSync(path.join(dir, 'bad.svg'), bad)
  const host = boot()
  const tool = host.tools.get('svg_check')
  const checkValue = await tool.execute({ path: 'bad.svg' }, execFor(dir))
  assertValueMatchesSchema('svg_check', tool.output.schema, checkValue)
  assert.ok(checkValue.problems.some((problem) => problem.code === 'LATEX_RESIDUE'))
  assert.equal(checkValue.fixedPath, '')

  const fixValue = await tool.execute({ path: 'bad.svg', fix: true }, execFor(dir))
  assertValueMatchesSchema('svg_check', tool.output.schema, fixValue)
  assert.equal(fixValue.fixedPath, 'bad.fixed.svg')
  const fixed = fs.readFileSync(path.join(dir, 'bad.fixed.svg'), 'utf8')
  assert.match(fixed, /Noto Sans CJK SC/)
  const blocks = tool.output.render({ path: 'bad.svg' }, fixValue)
  assert.match(blocks[0].text, /fixes applied/)
})

test('the no-backend error names the exact install commands', async () => {
  const { INSTALL_HINTS } = await import('../lib/backends.js')
  assert.ok(INSTALL_HINTS.some((line) => line.includes('@resvg/resvg-js')))
  assert.ok(INSTALL_HINTS.some((line) => line.includes('librsvg2-bin')))
})

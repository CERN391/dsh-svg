import assert from 'node:assert/strict'
import test from 'node:test'

import { fixSvg, lintSvg } from '../lib/lint.js'

const BAD = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono&amp;display=swap');
  text { font-family: 'JetBrains Mono', monospace; letter-spacing: 2px; }</style>
  <rect x="10" y="10" width="100" height="40" stroke-width="0" stroke="#000"/>
  <text x="20" y="40" font-size="24">u_o = 2u_+ − u_I　中文标签</text>
  <text x="20" y="80" font-size="24">x<tspan baseline-shift="sub" font-size="70%">1</tspan> = 1</text>
  <text x="20" y="500" font-size="24">跑出画布</text>
  <foreignObject x="0" y="0" width="10" height="10"></foreignObject>
  <rect id="dup" x="NaN" y="0" width="10" height="10"/>
  <rect id="dup" x="0" y="0" width="10" height="10"/>
</svg>`

test('lintSvg reports the classic generated-SVG defects', () => {
  const { problems, notes, stats } = lintSvg(BAD)
  const codes = problems.map((p) => p.code)
  for (const expected of ['LATEX_RESIDUE', 'BASELINE_SHIFT', 'LETTER_SPACING', 'EXTERNAL_FONT', 'FOREIGN_OBJECT', 'BAD_VALUE', 'DUPLICATE_ID', 'ZERO_STROKE', 'TEXT_OFF_CANVAS', 'NO_CJK_FONT']) {
    assert.ok(codes.includes(expected), `expected ${expected} in ${codes.join(', ')}`)
  }
  assert.equal(stats.textNodes, 3)
  assert.ok(notes.length >= 0)
  const residue = problems.find((p) => p.code === 'LATEX_RESIDUE')
  assert.ok(residue.line >= 1, 'line number is reported')
})

test('fixSvg converts baseline-shift to a portable dy and drops drifting styles', () => {
  const { fixed, changes } = fixSvg(BAD)
  assert.ok(!/baseline-shift/i.test(fixed), 'baseline-shift removed')
  assert.match(fixed, /<tspan[^>]*dy="6"/, 'a numeric dy derived from font-size 24 was inserted')
  assert.ok(!/letter-spacing/i.test(fixed), 'letter-spacing removed')
  assert.ok(!/@import/i.test(fixed), 'remote font import removed')
  assert.match(fixed, /font-family[^;"']*Noto Sans CJK SC/, 'a CJK fallback was prepended')
  assert.ok(changes.length >= 4)
})

test('a correct document reports no blocking problems', () => {
  const good = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300" font-family="Noto Sans CJK SC, sans-serif">
  <rect x="100" y="100" width="100" height="40" stroke-width="2" stroke="#000" fill="none"/>
  <text x="120" y="150" font-size="24">u<tspan dy="6" font-size="70%">o</tspan> = 4u<tspan dy="6" font-size="70%">I</tspan></text>
</svg>`
  const { problems } = lintSvg(good)
  assert.deepEqual(problems, [], `unexpected problems: ${JSON.stringify(problems)}`)
})

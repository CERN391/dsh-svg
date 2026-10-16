/**
 * `svg_check` — static inspection of an SVG document before it is shipped, with
 * mechanical fixes for the mistakes generated diagrams actually contain.
 *
 * The checks exist because the usual failure is invisible in source form: a
 * label that runs off the canvas, a `baseline-shift` a rasterizer silently
 * ignores, LaTeX syntax that reaches the viewer as literal underscores, or a
 * remote font that never loads so every hand-placed glyph shifts.
 */

import { fixSvg, lintSvg } from './lint.js'
import { confineHostPath, loadSvgSource, withExtension, writeFileBytes } from './shared.js'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    path: { type: 'string', description: 'Workspace path of the .svg file to inspect. Pass exactly one of path / svg.' },
    svg: { type: 'string', description: 'Inline SVG markup to inspect. Pass exactly one of path / svg.' },
    fix: { type: 'boolean', description: 'Also apply the mechanical fixes (baseline-shift → dy, drop letter-spacing and remote font imports, add a CJK fallback font).' },
    out: { type: 'string', description: 'Where to write the fixed SVG. Defaults to the input path with ".fixed.svg"; ignored when fix is false.' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'problems', 'notes', 'textNodes', 'elements', 'canvas', 'fixedPath', 'changes'],
  properties: {
    source: { type: 'string', description: 'The SVG that was inspected.' },
    problems: {
      type: 'array',
      description: 'Defects that will show up in the rendered picture.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'line'],
        properties: {
          code: { type: 'string', description: 'Stable rule code, such as LATEX_RESIDUE or BASELINE_SHIFT.' },
          message: { type: 'string', description: 'What is wrong and how to fix it.' },
          line: { type: 'integer', description: '1-based line number, or 0 when unknown.' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Non-fatal advice (grid drift, margin pressure, per-character text).' },
    textNodes: { type: 'integer', description: 'Number of <text> elements.' },
    elements: { type: 'integer', description: 'Number of drawing elements.' },
    canvas: { type: 'string', description: 'Canvas size, or "unknown".' },
    fixedPath: { type: 'string', description: 'Workspace path of the fixed SVG, or an empty string when no fix was written.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'Mechanical fixes that were applied.' },
  },
}

const DESCRIPTION = [
  'Inspect an SVG document for the defects that make generated diagrams look broken, and optionally fix the mechanical ones.',
  'Catches: LaTeX syntax leaking into text (u_o, 2^3), baseline-shift that resvg/librsvg ignore, letter-spacing, foreignObject, fonts pulled from the network, missing CJK font for Chinese labels, NaN/undefined attribute values, duplicate ids, zero stroke-width, text placed outside the canvas, hand-placed coordinates off a grid.',
  'Pass fix:true to rewrite those into portable forms and write <name>.fixed.svg; re-render with svg_render afterwards to confirm.',
].join(' ')

function reportText(value) {
  const lines = [`Inspected ${value.source}: ${value.textNodes} <text> nodes, ${value.elements} elements, canvas ${value.canvas}.`]
  if (value.problems.length === 0) lines.push('No blocking defects found.')
  else {
    lines.push(`${value.problems.length} problem(s):`)
    for (const problem of value.problems) lines.push(`  [${problem.code}] line ${problem.line}: ${problem.message}`)
  }
  for (const note of value.notes) lines.push(`note: ${note}`)
  if (value.changes.length > 0) lines.push(`fixes applied → ${value.fixedPath}: ${value.changes.join('; ')}`)
  else if (value.fixedPath !== '') lines.push(`fix requested, but nothing needed changing; wrote ${value.fixedPath}`)
  return lines.join('\n')
}

export function registerSvgCheck(ctx) {
  return ctx.tools.register({
    name: 'svg_check',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: reportText(value) }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Check ${args.path ?? 'inline svg'}`,
      kind: 'read',
      ...(typeof args.path === 'string' && args.path !== '' ? { locations: [{ path: args.path }] } : {}),
    }),
    async execute(args, exec) {
      const loaded = await loadSvgSource(ctx, exec, args)
      const result = lintSvg(loaded.source)
      let fixedPath = ''
      let changes = []
      if (args.fix === true) {
        const fixed = fixSvg(loaded.source)
        changes = fixed.changes
        const relative = args.out ?? (loaded.relativePath === undefined ? undefined : withExtension(loaded.relativePath, '.fixed.svg'))
        if (relative === undefined) {
          throw new Error('fix:true needs a destination — pass path (a workspace .svg) or out:"<workspace path>.svg"')
        }
        writeFileBytes(confineHostPath(loaded.cwd, relative, 'the fixed SVG'), Buffer.from(fixed.fixed, 'utf8'))
        fixedPath = relative
      }
      return {
        source: loaded.display,
        problems: result.problems.map((problem) => ({ code: problem.code, message: problem.message, line: problem.line ?? 0 })),
        notes: result.notes,
        textNodes: result.stats.textNodes,
        elements: result.stats.elements,
        canvas: result.stats.canvas ?? 'unknown',
        fixedPath,
        changes,
      }
    },
  })
}

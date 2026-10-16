/**
 * Static SVG checks for the mistakes LLM-authored diagrams actually make.
 *
 * This is deliberately a *linter*, not a validator: it looks for the failure
 * modes observed in generated schematics (LaTeX syntax leaking into text, SVG
 * features a rasterizer ignores, fonts that will not resolve, labels drifting
 * off canvas, obviously missing geometry) and it applies only mechanical,
 * reversible fixes.
 *
 * Two rules encode hard-won facts:
 *   - `baseline-shift="sub"` is ignored by resvg/usvg (`Failed to parse
 *     baseline-shift value`), although browsers honour it. Use `dy`.
 *   - inline LaTeX (`u_o`, `2^3`) is plain text in an SVG viewer unless a math
 *     renderer is present; in practice it just leaks underscores.
 */

const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const CJK_FONT_RE = /(CJK|YaHei|SimHei|SimSun|PingFang|Hiragino|Source Han|Noto Sans SC|Noto Serif SC|WenQuanYi|Heiti|Songti|KaiTi|FangSong|Microsoft JhengHei|sans-serif|system-ui)/i

/** 1-based line number of a byte offset. */
function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

function eachText(source) {
  const out = []
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/gi
  let match
  while ((match = re.exec(source)) !== null) {
    out.push({
      index: match.index,
      open: match[0].slice(0, match[0].indexOf('>') + 1),
      inner: match[1],
      full: match[0],
    })
  }
  return out
}

function textOf(inner) {
  return inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]
}

/**
 * Inspect an SVG document.
 * @param {string} source SVG markup
 * @returns {{problems: Array<{code: string, message: string, line?: number}>, notes: string[], stats: object}}
 */
export function lintSvg(source) {
  const problems = []
  const notes = []
  const textNodes = eachText(source)
  const canvas = canvasSize(source)

  const report = (code, message, index) => problems.push({ code, message, line: index === undefined ? undefined : lineOf(source, index) })

  // --- text layer -----------------------------------------------------------
  for (const node of textNodes) {
    const plain = textOf(node.inner)
    if (plain === '') report('EMPTY_TEXT', '<text> has no visible content', node.index)
    if (/(^|[^\\])[_^]\s*\{?[0-9A-Za-z+\-]/.test(plain)) {
      report('LATEX_RESIDUE', `LaTeX syntax leaked into text ("${plain.slice(0, 48)}") — write the real characters and use <tspan dy> for subscripts`, node.index)
    }
    if (/baseline-shift/i.test(node.full)) {
      report('BASELINE_SHIFT', `baseline-shift is ignored by resvg/usvg rasterizers ("${plain.slice(0, 40)}") — use <tspan dy="…" font-size="70%">`, node.index)
    }
  }

  // --- compatibility --------------------------------------------------------
  if (/<foreignObject/i.test(source)) {
    report('FOREIGN_OBJECT', 'foreignObject is not supported by resvg/librsvg/most image viewers', source.search(/<foreignObject/i))
  }
  if (/letter-spacing/i.test(source)) {
    report('LETTER_SPACING', 'letter-spacing makes text drift when the font changes — drop it', source.search(/letter-spacing/i))
  }
  if (/@import|fonts\.googleapis|fonts\.gstatic|https?:\/\/[^"')\s]+\.(?:woff2?|ttf|otf)/i.test(source)) {
    report('EXTERNAL_FONT', 'the SVG pulls a font from the network: offline or inside a WebView it falls back and every hand-placed label shifts', source.search(/@import|fonts\.googleapis|https?:\/\//i))
  }
  if (/dominant-baseline/i.test(source)) {
    notes.push('dominant-baseline is honoured by browsers but only partially by resvg — prefer explicit dy offsets')
  }

  // --- broken values --------------------------------------------------------
  const badValue = source.search(/=\s*"(?:NaN|undefined|null|Infinity)"/i)
  if (badValue !== -1) report('BAD_VALUE', 'an attribute value is NaN/undefined/null — a template was filled with a broken computation', badValue)
  const strokeZero = [...source.matchAll(/stroke-width\s*=\s*"(-?[\d.]+)"/gi)].find((m) => Number(m[1]) <= 0)
  if (strokeZero) report('ZERO_STROKE', `stroke-width="${strokeZero[1]}" draws nothing`, strokeZero.index)

  const ids = [...source.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1])
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (duplicates.length > 0) report('DUPLICATE_ID', `duplicate id(s): ${duplicates.join(', ')} — marker/clipPath references resolve to the wrong node`, source.search(/\bid\s*=/))

  // --- geometry -------------------------------------------------------------
  if (canvas.width === undefined || canvas.height === undefined) {
    report('NO_CANVAS_SIZE', 'no width/height or viewBox: rasterizers fall back to an arbitrary canvas', 0)
  }
  if (!/\bviewBox\s*=/i.test(source)) {
    notes.push('no viewBox — the image cannot scale; add viewBox="0 0 W H" matching width/height')
  }
  if (canvas.width !== undefined && canvas.height !== undefined) {
    for (const node of textNodes) {
      const x = Number(attribute(node.open, 'x'))
      const y = Number(attribute(node.open, 'y'))
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const ax = x + (canvas.minX ?? 0)
      const ay = y + (canvas.minY ?? 0)
      if (ax < 0 || ay < 0 || ax > canvas.width || ay > canvas.height) {
        report('TEXT_OFF_CANVAS', `text at x=${x} y=${y} falls outside the ${canvas.width}x${canvas.height} canvas — it will be clipped`, node.index)
      } else if (ax < 24 || ay < 24 || ax > canvas.width - 24 || ay > canvas.height - 24) {
        notes.push(`text at x=${x} y=${y} sits within 24px of the edge — check margins, it may look clipped`)
      }
    }
  }

  // --- style smells ---------------------------------------------------------
  const latinFonts = [...source.matchAll(/font-family\s*[:=]\s*["']([^"']+)["']/gi)].map((m) => m[1])
  const hasChinese = CJK_RE.test(source.replace(/<[^>]*>/g, ' '))
  if (hasChinese && latinFonts.length > 0 && !latinFonts.some((family) => CJK_FONT_RE.test(family))) {
    report('NO_CJK_FONT', `the document contains Chinese but every font-family (${latinFonts.slice(0, 3).join(' / ')}) is Latin-only — the renderer falls back or shows tofu`, source.search(/font-family/i))
  }
  if (textNodes.length > 40) {
    notes.push(`${textNodes.length} <text> nodes — that usually means per-character positioning; merge each line into ONE <text> with <tspan> runs`)
  }

  // --- hand-written coordinate drift ---------------------------------------
  const coords = [...source.matchAll(/\b(x|y|x1|y1|x2|y2|cx|cy)\s*=\s*"(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[2]))
  if (coords.length > 20) {
    const off = coords.filter((value) => Math.abs(value - Math.round(value / 5) * 5) > 0.01).length
    if (off / coords.length > 0.5) {
      notes.push(`${off}/${coords.length} coordinates are off a 5px grid — hand-placed geometry drifts; snap coordinates (grid 5 or 10) so wires meet nodes`)
    }
  }

  return {
    problems,
    notes,
    stats: {
      textNodes: textNodes.length,
      elements: (source.match(/<(path|line|polyline|polygon|rect|circle|ellipse|text)\b/gi) ?? []).length,
      bytes: Buffer.byteLength(source, 'utf8'),
      canvas: canvas.width === undefined ? undefined : `${canvas.width}x${canvas.height}`,
    },
  }
}

function canvasSize(source) {
  const open = source.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const num = (name) => {
    const raw = attribute(open, name)
    if (raw === undefined) return undefined
    const value = Number.parseFloat(raw)
    return Number.isFinite(value) ? value : undefined
  }
  const viewBox = attribute(open, 'viewBox')?.trim().split(/[\s,]+/).map(Number)
  const box = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox : undefined
  return {
    width: num('width') ?? box?.[2],
    height: num('height') ?? box?.[3],
    minX: box?.[0],
    minY: box?.[1],
  }
}

/** Nearest font-size in effect at a <text> node. */
function fontSizeFor(source, index) {
  const before = source.slice(0, index)
  const lastText = before.lastIndexOf('<text')
  if (lastText === -1) return 16
  const tag = source.slice(lastText, source.indexOf('>', lastText) + 1)
  const size = Number.parseFloat(attribute(tag, 'font-size') ?? '')
  return Number.isFinite(size) && size > 0 ? size : 16
}

/**
 * Apply the mechanical fixes: baseline-shift → dy, drop letter-spacing and
 * remote font imports, make sure a CJK-capable family is in the fallback list.
 * @param {string} source SVG markup
 * @returns {{fixed: string, changes: string[]}}
 */
export function fixSvg(source) {
  const changes = []
  let fixed = source

  // baseline-shift="sub|super" -> dy + font-size
  fixed = fixed.replace(/<tspan\b([^>]*?)baseline-shift\s*=\s*"(sub|super)"([^>]*?)>/gi, (match, before, kind, after) => {
    const head = match.slice(0, match.indexOf('baseline-shift'))
    const size = fontSizeFor(source, source.indexOf(match))
    const dy = kind.toLowerCase() === 'sub' ? Math.max(2, Math.round(size * 0.25)) : -Math.max(3, Math.round(size * 0.35))
    const rest = match.slice(match.indexOf('baseline-shift'))
      .replace(/baseline-shift\s*=\s*"(?:sub|super)"/i, '')
      .replace(/\s{2,}/g, ' ')
    const hasSize = /font-size\s*=/i.test(match)
    changes.push(`tspan baseline-shift="${kind}" → dy="${dy}"${hasSize ? '' : ' font-size="70%"'}`)
    void before; void after; void head
    return `<tspan${rest.replace(/>$/, '')} dy="${dy}"${hasSize ? '' : ' font-size="70%"'}>`
  })

  // letter-spacing attributes and CSS declarations
  const hadAttribute = /letter-spacing\s*=\s*"[^"]*"/i.test(fixed)
  fixed = fixed.replace(/\s*letter-spacing\s*=\s*"[^"]*"/gi, '')
  const hadCss = /letter-spacing\s*:/i.test(fixed)
  fixed = fixed.replace(/\s*letter-spacing\s*:\s*[^;"}]+;?/gi, '')
  if (hadAttribute || hadCss) changes.push('removed letter-spacing (attribute and/or CSS)')

  // remote font imports inside <style>
  const hadImport = /@import[^;]*;/i.test(fixed)
  fixed = fixed.replace(/@import\s+url\([^)]*\)\s*;?/gi, '')
  if (hadImport) changes.push('dropped the remote @import font (it fails offline and changes every text metric)')

  // a CJK-capable fallback in every font-family list — attribute form and CSS form
  const hasChinese = CJK_RE.test(fixed.replace(/<[^>]*>/g, ' '))
  if (hasChinese) {
    let touched = false
    fixed = fixed.replace(/font-family\s*=\s*"([^"]*)"/gi, (match, list) => {
      if (CJK_FONT_RE.test(list)) return match
      touched = true
      return `font-family="Noto Sans CJK SC, Microsoft YaHei, ${list}"`
    })
    let touchedCss = false
    fixed = fixed.replace(/font-family\s*:\s*([^;}]+)/gi, (match, list) => {
      if (CJK_FONT_RE.test(list)) return match
      touchedCss = true
      return `font-family: Noto Sans CJK SC, Microsoft YaHei, ${list.trim()}`
    })
    let touchedRoot = false
    if (!/font-family\s*[:=]/i.test(fixed)) {
      fixed = fixed.replace(/<svg\b/i, () => '<svg font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"')
      touchedRoot = true
    }
    if (touched || touchedCss || touchedRoot) changes.push('prepended a CJK-capable font to font-family so Chinese cannot turn into tofu')
  }

  return { fixed, changes }
}

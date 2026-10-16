/**
 * Rasterizer resolution: turn SVG text into PNG bytes with whatever is
 * available, without ever making the plugin unloadable.
 *
 * Order of preference:
 *   1. `@resvg/resvg-js`   — prebuilt native binding (win32-x64, linux-arm64-gnu,
 *                            darwin-arm64 …), loads system fonts itself. Best.
 *   2. `@resvg/resvg-wasm` — pure WASM, no native binary at all; needs explicit
 *                            font buffers, so we feed it the system CJK font.
 *   3. `rsvg-convert`      — `apt-get install librsvg2-bin`, needs a file.
 *   4. `sharp`             — prebuilt libvips; SVG support varies with the build.
 *
 * Every failure is remembered so the tool can tell the user *exactly* what to
 * install instead of "rendering failed".
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existingDirs, existingFiles, importPackage, parseSvgSize, resolvePackage } from './shared.js'

/** Font directories worth searching, per platform. */
export function fontDirs() {
  const fromEnv = (process.env.DSH_SVG_FONT_DIRS ?? '').split(path.delimiter).filter(Boolean)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const candidates = [
    ...fromEnv,
    '/system/fonts', // Android (the phone container sees it)
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    '/Library/Fonts',
    '/System/Library/Fonts',
    home === '' ? '' : path.join(home, '.fonts'),
    home === '' ? '' : path.join(home, '.local/share/fonts'),
    process.env.WINDIR === undefined ? '' : path.join(process.env.WINDIR, 'Fonts'),
  ]
  return existingDirs(candidates)
}

/** Font files used when a backend cannot read system fonts (resvg-wasm). */
export function fontFiles() {
  const fromEnv = (process.env.DSH_SVG_FONT_FILES ?? '').split(path.delimiter).filter(Boolean)
  const win = process.env.WINDIR === undefined ? '' : path.join(process.env.WINDIR, 'Fonts')
  const candidates = [
    ...fromEnv,
    // Android: one CJK collection + a Latin face
    '/system/fonts/NotoSansCJK-Regular.ttc',
    '/system/fonts/NotoSansSC-Regular.otf',
    '/system/fonts/NotoSans-Regular.ttf',
    '/system/fonts/Roboto-Regular.ttf',
    // Linux
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    // Windows
    win === '' ? '' : path.join(win, 'msyh.ttc'),
    win === '' ? '' : path.join(win, 'simhei.ttf'),
    win === '' ? '' : path.join(win, 'arial.ttf'),
    // macOS
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Helvetica.ttc',
  ]
  return existingFiles(candidates)
}

function defaultFontFamily() {
  return process.env.DSH_SVG_FONT_FAMILY ?? 'Noto Sans CJK SC'
}

function fitOption({ scale, width }) {
  return width === undefined || !Number.isFinite(width)
    ? { mode: 'zoom', value: Number.isFinite(scale) && scale > 0 ? scale : 2 }
    : { mode: 'width', value: Math.round(width) }
}

/** Font bytes, cached per path — the WASM build has no filesystem of its own. */
const fontBufferCache = new Map()
function fontBuffers() {
  const buffers = []
  for (const file of fontFiles()) {
    try {
      const stats = fs.statSync(file)
      const cached = fontBufferCache.get(file)
      if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) {
        buffers.push(cached.data)
        continue
      }
      const data = new Uint8Array(fs.readFileSync(file))
      fontBufferCache.set(file, { mtimeMs: stats.mtimeMs, data })
      buffers.push(data)
    } catch {
      /* an unreadable font is simply skipped */
    }
  }
  return buffers
}

/**
 * The resvg option object.
 *
 * The native build reads system fonts from disk; the WASM build cannot, so it
 * receives font bytes instead — without them every glyph disappears and the
 * PNG comes back as bare geometry.
 * @param {{width?: number, scale?: number, background?: string}} options
 * @param {'native'|'wasm'} mode
 */
function resvgOptions(options, mode) {
  const { width, scale, background } = options
  const font = mode === 'wasm'
    ? {
        loadSystemFonts: false,
        fontBuffers: fontBuffers(),
        defaultFontFamily: defaultFontFamily(),
      }
    : {
        loadSystemFonts: true,
        fontDirs: fontDirs(),
        fontFiles: fontFiles(),
        defaultFontFamily: defaultFontFamily(),
      }
  const config = {
    fitTo: fitOption({ scale, width }),
    font,
    logLevel: 'error',
  }
  if (typeof background === 'string' && background !== '') config.background = background
  return config
}

async function renderWithResvgNative(source, options) {
  const mod = await importPackage('@resvg/resvg-js')
  if (mod === undefined) throw new Error('@resvg/resvg-js is not installed')
  const { Resvg } = mod
  const rendered = new Resvg(source, resvgOptions(options, 'native')).render()
  return {
    png: rendered.asPng(),
    width: rendered.width,
    height: rendered.height,
    backend: '@resvg/resvg-js',
  }
}

async function renderWithResvgWasm(source, options) {
  const mod = await importPackage('@resvg/resvg-wasm')
  if (mod === undefined) throw new Error('@resvg/resvg-wasm is not installed')
  const wasmPath = resolvePackage('@resvg/resvg-wasm/index_bg.wasm')
  if (wasmPath === undefined) throw new Error('@resvg/resvg-wasm wasm payload not found')
  await mod.initWasm(fs.readFileSync(wasmPath))
  const { Resvg } = mod
  const config = resvgOptions(options, 'wasm')
  if (config.font.fontBuffers.length === 0) {
    throw new Error('no font files were found for the WASM rasterizer (set DSH_SVG_FONT_FILES=/path/to/font.ttf), so every label would render blank')
  }
  const rendered = new Resvg(source, config).render()
  return {
    png: rendered.asPng(),
    width: rendered.width,
    height: rendered.height,
    backend: '@resvg/resvg-wasm',
  }
}

function which(command) {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  return probe.error === undefined
}

function renderWithRsvgConvert(source, options) {
  if (!which('rsvg-convert')) throw new Error('rsvg-convert is not on PATH')
  const { width, scale } = options
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-svg-'))
  const inFile = path.join(tmpDir, 'in.svg')
  const outFile = path.join(tmpDir, 'out.png')
  fs.writeFileSync(inFile, source)
  const args = width === undefined || !Number.isFinite(width)
    ? ['-z', String(Number.isFinite(scale) && scale > 0 ? scale : 2), '-o', outFile, inFile]
    : ['-w', String(Math.round(width)), '-o', outFile, inFile]
  const result = spawnSync('rsvg-convert', args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`rsvg-convert exited ${result.status}: ${(result.stderr ?? '').trim()}`)
  const png = fs.readFileSync(outFile)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  const size = parseSvgSize(source)
  const zoom = Number.isFinite(scale) && scale > 0 ? scale : 2
  return {
    png,
    width: Math.round(size.width * zoom),
    height: Math.round(size.height * zoom),
    backend: 'rsvg-convert',
  }
}

async function renderWithSharp(source, options) {
  const mod = await importPackage('sharp')
  if (mod === undefined) throw new Error('sharp is not installed')
  const sharp = mod.default ?? mod
  const zoom = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 2
  const png = await sharp(Buffer.from(source), { density: 72 * zoom }).png().toBuffer()
  const size = parseSvgSize(source)
  return {
    png,
    width: Math.round(size.width * zoom),
    height: Math.round(size.height * zoom),
    backend: 'sharp',
  }
}

/** The install hints shown when no backend works. */
export const INSTALL_HINTS = [
  'pnpm add @resvg/resvg-js        # 推荐：预编译二进制，无需编译器/root（linux-arm64 / win32-x64 都有）',
  'apt-get install -y --no-install-recommends librsvg2-bin fonts-noto-cjk   # 纯命令行 rsvg-convert',
  'pnpm add @resvg/resvg-wasm      # 没有本机二进制可用时的 WASM 版本（需要 /system/fonts 里的字体）',
]

const BACKENDS = [
  ['@resvg/resvg-js', renderWithResvgNative],
  ['@resvg/resvg-wasm', renderWithResvgWasm],
  ['rsvg-convert', renderWithRsvgConvert],
  ['sharp', renderWithSharp],
]

/**
 * Render SVG text to PNG bytes with the first backend that works.
 *
 * `DSH_SVG_BACKEND` forces one backend by name (`@resvg/resvg-js`,
 * `@resvg/resvg-wasm`, `rsvg-convert`, `sharp`), which is how the fallback
 * paths get tested on a machine where the preferred one is installed.
 * @param {string} source SVG markup
 * @param {{scale?: number, width?: number, background?: string}} options
 * @returns {Promise<{png: Uint8Array, width: number, height: number, backend: string, attempts: string[]}>}
 */
export async function renderSvg(source, options = {}) {
  const forced = process.env.DSH_SVG_BACKEND
  const candidates = forced === undefined || forced === '' ? BACKENDS : BACKENDS.filter(([name]) => name === forced)
  if (candidates.length === 0) {
    throw new Error(`DSH_SVG_BACKEND="${forced}" is not one of: ${BACKENDS.map(([name]) => name).join(', ')}`)
  }
  const attempts = []
  for (const [name, render] of candidates) {
    try {
      const out = await render(source, options)
      if (out.png === undefined || out.png.length === 0) throw new Error('produced an empty image')
      return { ...out, attempts }
    } catch (error) {
      attempts.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const detail = attempts.map((line) => `  - ${line}`).join('\n')
  throw new Error(
    'no SVG rasterizer is available in this deployment.\n'
    + `Tried:\n${detail}\n`
    + `Install one of:\n${INSTALL_HINTS.map((line) => `  ${line}`).join('\n')}`,
  )
}

/** Report which backends are usable right now (for diagnostics). */
export async function describeBackends() {
  const available = []
  for (const [name] of BACKENDS) {
    if (name === 'rsvg-convert') {
      if (which('rsvg-convert')) available.push(name)
      continue
    }
    if (resolvePackage(name) !== undefined) available.push(name)
  }
  return available
}

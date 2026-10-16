/**
 * Shared plumbing for the `svg_render` / `svg_check` tools.
 *
 * The plugin imports **nothing outside Node built-ins and its own relative
 * modules**, so a `link:` install needs no build step. The only optional
 * runtime dependency is a rasterizer, resolved lazily in backends.js.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Read the calling agent's workspace and cancellation signal. */
export function executionContext(exec) {
  return {
    cwd: exec?.agent?.session?.header?.cwd,
    signal: exec?.signal,
  }
}

/**
 * Resolve a path, confine it to the session workspace and stat it.
 * Mirrors the official tool suite's rules: relative paths resolve against the
 * session workspace, absolute paths must stay inside it.
 */
export async function resolveWorkspaceTarget(ctx, exec, rawPath, options = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('path must be a non-empty string')
  }
  if (options.extension !== undefined && !rawPath.toLowerCase().endsWith(options.extension)) {
    throw new Error(`path must end with "${options.extension}"`)
  }
  const { cwd, signal } = executionContext(exec)
  const resolveOptions = cwd === undefined ? { signal } : { cwd, signal }
  const target = await ctx.fs.resolve(rawPath, resolveOptions)
  let workspace
  if (cwd !== undefined) {
    workspace = await ctx.fs.resolve(cwd, resolveOptions)
    if (!ctx.fs.contains(workspace, target)) {
      throw new Error(`refusing to touch a path outside the session workspace: ${rawPath}`)
    }
  }
  const info = await ctx.fs.stat(target, signal)
  if (options.mustExist === true && info === undefined) {
    throw new Error(`${rawPath} does not exist`)
  }
  return { target, info, display: rawPath, cwd, signal }
}

/**
 * Absolute host path for a workspace-relative path, confined to the workspace.
 *
 * `ctx.fs` mutations are text-only by contract (binary writes are explicitly
 * deferred upstream), so a rendered PNG is written through `node:fs`. The
 * confinement check below is therefore ours to make: the resolved path must
 * live inside the session workspace.
 */
export function confineHostPath(cwd, rawPath, what = 'path') {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error(`cannot write ${what}: this session has no workspace directory (pass a workspace-relative path)`)
  }
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, rawPath)
  const relative = path.relative(root, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write ${what} outside the session workspace: ${rawPath}`)
  }
  return absolute
}

/** Write bytes (or a string) to an absolute host path, creating directories. */
export function writeFileBytes(absolutePath, data) {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, Buffer.isBuffer(data) ? data : Buffer.from(data))
  return fs.statSync(absolutePath).size
}

/** Decode SVG bytes as UTF-8, tolerating a BOM. */
export function decodeSvg(bytes) {
  const text = Buffer.from(bytes).toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Resolve a package name from every plausible root: the plugin's own
 * node_modules (a normal install), the profile's, $DSH_PROFILE_DIR, and the
 * current working directory.
 */
export function resolvePackage(name) {
  const roots = [import.meta.url]
  const push = (dir) => {
    if (typeof dir === 'string' && dir !== '') roots.push(pathToFileURL(path.join(dir, 'package.json')).href)
  }
  push(process.env.DSH_PROFILE_DIR)
  push(process.env.DSH_HOME)
  push(process.cwd())
  for (const root of roots) {
    try {
      return createRequire(root).resolve(name)
    } catch {
      /* try the next root */
    }
  }
  return undefined
}

/**
 * Resolve a package to the entry file an ESM `import()` should use.
 *
 * `createRequire(...).resolve()` returns the CommonJS `main`, and importing
 * that CJS file loses named exports that a bundler-oriented package only
 * declares in its ESM build (resvg-wasm's `initWasm` is one of those). So the
 * package root is located and its `exports['.'].import` / `module` entry is
 * preferred when it exists.
 */
export function resolvePackageEntry(name) {
  const resolved = resolvePackage(name)
  if (resolved === undefined) return undefined
  try {
    let dir = path.dirname(resolved)
    let manifest
    while (true) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (parsed.name === name) {
          manifest = parsed
          break
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (manifest !== undefined) {
      const dot = manifest.exports?.['.']
      const fromExports = typeof dot === 'string'
        ? dot
        : dot?.import ?? dot?.default ?? (typeof dot?.import === 'object' ? dot.import.default : undefined)
      const relative = fromExports ?? manifest.module ?? manifest.main
      if (typeof relative === 'string') {
        const candidate = path.resolve(dir, relative)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  } catch {
    /* fall back to the require-resolved path */
  }
  return resolved
}

/** Import an optional package, returning undefined when it is not installed. */
export async function importPackage(name) {
  const resolved = resolvePackageEntry(name)
  if (resolved === undefined) return undefined
  try {
    return await import(pathToFileURL(resolved).href)
  } catch {
    return undefined
  }
}

/** Keep only directories that exist. */
export function existingDirs(dirs) {
  return dirs.filter((dir) => typeof dir === 'string' && dir !== '' && fs.existsSync(dir))
}

/** Keep only files that exist. */
export function existingFiles(files) {
  return files.filter((file) => typeof file === 'string' && file !== '' && fs.existsSync(file))
}

/** Read the intrinsic size of an SVG document. */
export function parseSvgSize(source) {
  const open = source.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const attr = (name) => {
    const raw = open.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, 'i'))?.[1]
    const value = raw === undefined ? undefined : Number.parseFloat(raw)
    return Number.isFinite(value) ? value : undefined
  }
  const viewBox = open.match(/\bviewBox\s*=\s*"([^"]+)"/i)?.[1]?.trim().split(/[\s,]+/).map(Number)
  const width = attr('width') ?? (viewBox?.length === 4 ? viewBox[2] : undefined)
  const height = attr('height') ?? (viewBox?.length === 4 ? viewBox[3] : undefined)
  return {
    width: width ?? 1000,
    height: height ?? 700,
    viewBox: viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox : undefined,
  }
}

/** Human-readable byte count. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/**
 * Replace a path's extension.
 * @param {string} filePath source path
 * @param {string} extension target extension, dot included
 */
export function withExtension(filePath, extension) {
  const base = filePath.replace(/\.svg$/i, '')
  return base === filePath ? `${filePath}${extension}` : `${base}${extension}`
}

/**
 * Load the SVG document a tool call refers to: either inline markup or a
 * workspace file. Exactly one of `path` / `svg` must be given.
 * @returns {Promise<{source: string, display: string, relativePath?: string, cwd?: string, signal?: AbortSignal}>}
 */
export async function loadSvgSource(ctx, exec, args, options = {}) {
  const hasPath = typeof args.path === 'string' && args.path.trim() !== ''
  const hasInline = typeof args.svg === 'string' && args.svg.trim() !== ''
  if (hasPath && hasInline) throw new Error('pass exactly one of "path" (a workspace .svg file) or "svg" (inline markup)')
  if (!hasPath && !hasInline) {
    if (options.optional === true) return undefined
    throw new Error('pass "path" (a workspace .svg file) or "svg" (inline markup)')
  }
  if (hasInline) {
    return {
      source: args.svg,
      display: options.displayName ?? '(inline svg)',
      cwd: executionContext(exec).cwd,
      signal: executionContext(exec).signal,
    }
  }
  const resolved = await resolveWorkspaceTarget(ctx, exec, args.path, { mustExist: true })
  const bytes = await ctx.fs.readBytes(resolved.target, resolved.signal, 32 * 1024 * 1024)
  return {
    source: decodeSvg(bytes),
    display: resolved.display,
    relativePath: args.path,
    cwd: resolved.cwd,
    signal: resolved.signal,
  }
}

/**
 * Whether the calling route can receive an image block at all.
 *
 * Mirrors the built-in `read_image` gate: the latest routed provider/model must
 * resolve through the `llm` service and declare `image` input. Anything we
 * cannot prove is treated as not capable, so a text-only model never receives
 * an image block it would reject.
 * @returns {Promise<{capable: boolean, reason?: string}>}
 */
export async function imageCapableRoute(ctx, exec) {
  const session = exec?.agent?.session
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
  const routed = header?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  let llm
  try {
    llm = ctx.get('llm')
  } catch {
    llm = undefined
  }
  if (provider === undefined || model === undefined || llm === undefined) {
    return { capable: false, reason: 'the current model route could not be resolved' }
  }
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal)
    if (Array.isArray(active?.inputModalities) && active.inputModalities.includes('image')) return { capable: true }
    return { capable: false, reason: `model "${model}" does not declare image input` }
  } catch (error) {
    return { capable: false, reason: `could not resolve model "${model}": ${error instanceof Error ? error.message : String(error)}` }
  }
}

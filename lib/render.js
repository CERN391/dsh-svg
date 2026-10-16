/**
 * `svg_render` — rasterize an SVG document and hand the picture back to the
 * model as a native image block.
 *
 * This is the missing half of every "draw me a diagram" loop: without a
 * rasterizer the author never sees its own output, so mis-placed labels,
 * clipped text and stray wires ship unreviewed. Rendering inside the Harness
 * costs one tool call and closes that loop on any platform, including a phone.
 */

import { INSTALL_HINTS, describeBackends, renderSvg } from './backends.js'
import {
  confineHostPath,
  formatBytes,
  imageCapableRoute,
  loadSvgSource,
  withExtension,
  writeFileBytes,
} from './shared.js'

const MAX_SCALE = 6
const VIEW_WIDTH = 1400
const SIZE_REFUSAL = /TOO_LARGE|TOO_MANY_PIXELS|DIMENSION_TOO_LARGE|too large|exceeds?|limit/i

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    path: {
      type: 'string',
      description: 'Workspace path of the .svg file to render. Pass exactly one of path / svg.',
    },
    svg: {
      type: 'string',
      description: 'Inline SVG markup to render, for a quick look before saving anything. Pass exactly one of path / svg.',
    },
    out: {
      type: 'string',
      description: 'Workspace path for the PNG. Defaults to the SVG path with a .png extension; inline markup saves nothing unless out is given.',
    },
    save: {
      type: 'boolean',
      description: 'Write the PNG to the workspace. Defaults to true when path is given, false for inline markup.',
    },
    scale: {
      type: 'number',
      description: `Zoom factor for the raster (default 2, max ${MAX_SCALE}). Ignored when width is given.`,
    },
    width: {
      type: 'integer',
      description: 'Target raster width in pixels; overrides scale.',
    },
    background: {
      type: 'string',
      description: 'Optional background colour (for example "white") painted behind the drawing; useful when the SVG has no background rect.',
    },
  },
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string', description: 'Durable attachment identifier.' },
    mediaType: { type: 'string', description: 'Always image/png here.' },
    bytes: { type: 'integer', description: 'Stored PNG size in bytes.' },
    width: { type: 'integer', description: 'Attached image width in pixels.' },
    height: { type: 'integer', description: 'Attached image height in pixels.' },
    name: { type: 'string', description: 'Display name of the attachment.' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'backend', 'width', 'height', 'pngBytes', 'savedPath', 'imageAttached', 'notes'],
  properties: {
    source: { type: 'string', description: 'The SVG that was rendered.' },
    backend: { type: 'string', description: 'Which rasterizer produced the PNG.' },
    width: { type: 'integer', description: 'PNG width in pixels.' },
    height: { type: 'integer', description: 'PNG height in pixels.' },
    pngBytes: { type: 'integer', description: 'PNG size in bytes.' },
    savedPath: { type: 'string', description: 'Workspace path of the written PNG, or an empty string when nothing was saved.' },
    imageAttached: { type: 'boolean', description: 'True when the rendered image rides this result as an image block.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Backend fallbacks, save notes, and why an image could not be attached.' },
    image: IMAGE_SCHEMA,
  },
}

const DESCRIPTION = [
  'Rasterize an SVG document to PNG inside the Harness and return the image itself, so you can SEE what you drew.',
  'Use it after writing or editing any SVG/diagram: the returned image is the verification step — check for overlapping or clipped labels, symbols outside their container, tofu boxes instead of Chinese, dangling wires, text running off the canvas.',
  'Backends, in order: @resvg/resvg-js (prebuilt native), @resvg/resvg-wasm, the rsvg-convert command, sharp. When none is available the error names the exact install command.',
  'The PNG is also written into the workspace (pass save:false to skip, out to choose the path); inline svg markup can be rendered without touching the disk.',
].join(' ')

function renderText(value) {
  const lines = [
    `Rendered ${value.source} with ${value.backend}: ${value.width}x${value.height} px, ${formatBytes(value.pngBytes)}.`,
  ]
  if (value.savedPath !== '') lines.push(`PNG: ${value.savedPath}`)
  if (value.imageAttached === true) {
    lines.push('The image is attached below — look at it before calling the drawing finished, and re-render after every fix.')
  }
  for (const note of value.notes) lines.push(`note: ${note}`)
  return lines.join('\n')
}

function imageBlock(image) {
  return {
    type: 'image',
    attachment: {
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      ...(image.name === undefined ? {} : { name: image.name }),
    },
  }
}

/** Store the PNG as a durable attachment so it can ride the tool result. */
async function attachImage(ctx, exec, png, name) {
  let attachments
  try {
    attachments = ctx.get('attachments')
  } catch {
    attachments = undefined
  }
  if (attachments === undefined) {
    return { note: 'the image was not attached: no attachment service is mounted; read the saved PNG with read_image instead' }
  }
  const route = await imageCapableRoute(ctx, exec)
  if (!route.capable) {
    return { note: `the image was not attached: ${route.reason}; read the saved PNG with read_image, or switch to an image-capable model` }
  }
  try {
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name })
    return {
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
    }
  } catch (error) {
    return { note: `the image was not attached: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function registerSvgRender(ctx) {
  return ctx.tools.register({
    name: 'svg_render',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: renderText(value) }]
        if (value.image !== undefined) blocks.push(imageBlock(value.image))
        return blocks
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Render ${args.path ?? 'inline svg'}`,
      kind: 'edit',
      ...(typeof args.path === 'string' && args.path !== '' ? { locations: [{ path: args.path }] } : {}),
    }),
    async execute(args, exec) {
      const loaded = await loadSvgSource(ctx, exec, args)
      loaded.signal?.throwIfAborted()

      const notes = []
      const scale = Math.min(Math.max(Number(args.scale ?? 2) || 2, 0.1), MAX_SCALE)
      const wantWidth = Number.isInteger(args.width) && args.width > 0 ? args.width : undefined

      let rendered = await renderSvg(loaded.source, { scale, width: wantWidth, background: args.background })
      if (rendered.attempts.length > 0) notes.push(...rendered.attempts)

      const pngName = `${(loaded.relativePath ?? 'diagram').replace(/\.svg$/i, '').split(/[\\/]/).pop() || 'diagram'}.png`
      let attachment = await attachImage(ctx, exec, rendered.png, pngName)

      // A raster that is too large for the attachment limits is re-rendered at a
      // viewing-friendly width instead of failing the call.
      if (attachment.image === undefined && rendered.width > VIEW_WIDTH && SIZE_REFUSAL.test(attachment.note ?? '')) {
        const retry = await renderSvg(loaded.source, { scale: 1, width: VIEW_WIDTH, background: args.background })
        const retried = await attachImage(ctx, exec, retry.png, pngName)
        if (retried.image !== undefined) {
          rendered = retry
          attachment = retried
          notes.push(`attached a ${VIEW_WIDTH}px-wide copy for viewing; render again with width:${VIEW_WIDTH} when the drawing itself must stay that size`)
        }
      }
      if (attachment.note !== undefined) notes.push(attachment.note)

      // Persist the PNG. ctx.fs mutations are text-only by contract (binary
      // writes are deferred upstream), so the binary write happens here, after
      // an explicit workspace-confinement check.
      const shouldSave = args.save === undefined
        ? (loaded.relativePath !== undefined || args.out !== undefined)
        : args.save === true
      let savedPath = ''
      if (shouldSave) {
        const relative = args.out ?? (loaded.relativePath === undefined ? undefined : withExtension(loaded.relativePath, '.png'))
        if (relative === undefined) {
          notes.push('nothing was saved: pass out:"<workspace path>.png" to write an inline SVG to disk')
        } else {
          writeFileBytes(confineHostPath(loaded.cwd, relative, 'the PNG'), rendered.png)
          savedPath = relative
        }
      }

      const value = {
        source: loaded.display,
        backend: rendered.backend,
        width: rendered.width,
        height: rendered.height,
        pngBytes: rendered.png.length,
        savedPath,
        imageAttached: attachment.image !== undefined,
        notes,
      }
      if (attachment.image !== undefined) value.image = attachment.image
      return value
    },
  })
}

/** Diagnostics used by the README and by support questions. */
export async function svgRenderDiagnostics() {
  return { backends: await describeBackends(), hints: INSTALL_HINTS }
}

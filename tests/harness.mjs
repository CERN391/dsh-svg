/**
 * Minimal stand-in for the DSH host: a tool registry that enforces the real
 * parameter/value contracts, a Cordis-style effect scope, a filesystem service
 * over node:fs, and stubs for the optional `attachments` / `llm` services.
 *
 * The registry checks matter: `definition.parameters` is a compiled JSON Schema
 * that the provider reads verbatim, and the value returned by `execute` must
 * satisfy `output.schema` exactly (an undeclared key is a real failure in the
 * shipped Harness, not a lint nit).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const JSON_SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'oneOf', 'description', 'title', 'default', 'examples',
])

function assertParameters(toolName, parameters) {
  assert.ok(parameters !== null && typeof parameters === 'object', `${toolName}: parameters must be an object`)
  assert.equal(parameters.type, 'object', `${toolName}: parameters must be the compiled JSON Schema`)
  assert.ok(parameters.properties !== null && typeof parameters.properties === 'object', `${toolName}: properties required`)
  assert.ok(Array.isArray(parameters.required), `${toolName}: required must be an array of names`)
  for (const key of Object.keys(parameters)) {
    assert.ok(JSON_SCHEMA_KEYWORDS.has(key), `${toolName}: top-level "${key}" is not a JSON Schema keyword`)
  }
  for (const name of parameters.required) {
    assert.ok(Object.hasOwn(parameters.properties, name), `${toolName}: required "${name}" is not declared`)
  }
  for (const [name, spec] of Object.entries(parameters.properties)) {
    assert.equal(typeof spec.type, 'string', `${toolName}.${name}: property schema needs a type`)
    assert.notEqual(spec.required, true, `${toolName}.${name}: "required: true" is defineTool spec syntax, not JSON Schema`)
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/** Shallow value-vs-schema check: required keys, no extra keys, primitive types. */
export function assertValueMatchesSchema(toolName, schema, value) {
  assert.ok(value !== null && typeof value === 'object', `${toolName}: value must be an object`)
  for (const key of schema.required ?? []) {
    assert.ok(Object.hasOwn(value, key), `${toolName}: value is missing required key "${key}"`)
    assert.notEqual(value[key], undefined, `${toolName}: value key "${key}" is undefined`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${toolName}: value key "${key}" is not declared in output.schema`)
    }
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(value, key)) continue
    const actual = typeOf(value[key])
    if (spec.type === 'integer') assert.ok(Number.isInteger(value[key]), `${toolName}.${key}: expected integer, got ${actual}`)
    else if (spec.type === 'number') assert.ok(typeof value[key] === 'number', `${toolName}.${key}: expected number, got ${actual}`)
    else assert.equal(actual, spec.type, `${toolName}.${key}: expected ${spec.type}, got ${actual}`)
    if (spec.type === 'object' && spec.additionalProperties === false) assertValueMatchesSchema(`${toolName}.${key}`, spec, value[key])
  }
  // lossless JSON, exactly as the registry snapshots it
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${toolName}: value must be lossless JSON`)
}

export function createFakeHost(options = {}) {
  const tools = new Map()
  const fsService = {
    async resolve(target, opts) {
      const base = opts?.cwd
      const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base ?? process.cwd(), target)
      return { key: absolute, displayPath: target }
    },
    contains(parent, child) {
      const relative = path.relative(parent.key, child.key)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    },
    async stat(target) {
      try {
        const stats = fs.statSync(target.key)
        return { size: stats.size }
      } catch {
        return undefined
      }
    },
    async readBytes(target, _signal, maxBytes) {
      const buffer = fs.readFileSync(target.key)
      if (maxBytes !== undefined && buffer.length > maxBytes) throw new Error('file exceeds the read cap')
      return new Uint8Array(buffer)
    },
  }

  const savedImages = []
  const services = {
    attachments: {
      imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024, maxImagePixels: 40e6, maxImageDimension: 8000 },
      async saveImage(input) {
        savedImages.push(input)
        return {
          attachmentId: `att-${savedImages.length}`,
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: options.imageWidth ?? 800,
          height: options.imageHeight ?? 600,
          ...(input.name === undefined ? {} : { name: input.name }),
        }
      },
    },
    llm: {
      async resolveModelInfo() {
        return { inputModalities: options.imageModalities ?? ['text', 'image'] }
      },
    },
  }

  const ctx = {
    fs: fsService,
    tools: {
      register(definition) {
        assertParameters(definition.name, definition.parameters)
        assert.equal(typeof definition.output?.render, 'function', `${definition.name}: output.render must be a function`)
        assert.ok(definition.output?.schema !== undefined, `${definition.name}: output.schema is required`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name) {
      return options.withoutAttachments === true && name === 'attachments' ? undefined : services[name]
    },
    effect(callback) {
      return callback()
    },
    emit() {},
  }
  return { ctx, tools, services, savedImages }
}

export function execFor(cwd) {
  return {
    signal: undefined,
    agent: {
      options: { provider: 'test-provider', model: 'test-model' },
      session: { header: { cwd } },
    },
  }
}

export function tempWorkspace(prefix = 'dsh-svg-test-') {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', prefix))
  return dir
}

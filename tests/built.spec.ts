/**
 * The published artifacts: `lib/index.js` as the Host Loader would import it,
 * and `lib/client.js` evaluated the way the page's module loader evaluates a
 * plugin bundle. Run after `pnpm run build`.
 */

import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { createFixture, png, seedSession, snapshotTree, storeFile, storeImage, trashSessions } from './fixture.ts'

// The official reveal helper would open Finder; the built artifact's call is recorded instead.
const native = vi.hoisted(() => ({
  revealNativePath: vi.fn(async (_path: string, _signal: AbortSignal) => {}),
  canOpenNativePath: () => true,
  nativeFileManager: () => 'finder' as const,
  nativeFileApplications: vi.fn(async (_path: string, _signal: AbortSignal) => [{ id: '/System/Applications/Preview.app', name: 'Preview', default: true, icon: null }]),
  openNativeFileApplication: vi.fn(async (_path: string, _application: string, _signal: AbortSignal) => {}),
}))
vi.mock('@deepseek-ai/dsh-native-command', () => native)

const LIB = new URL('../lib/', import.meta.url)
const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!existsSync(new URL('index.js', LIB)))('built artifacts', () => {
  it('lib/index.js scans, reveals, and opens Preview copies through the Typert gateway without changing DSH data', async () => {
    const f = await createFixture('dsh-attachment-library-built-')
    dirs.push(f.base)
    const image = await storeImage(f, png(3, 2, 'built'), 'image/png', 3, 2, 1_700_000_000_000, 'built.png')
    const file = await storeFile(f, Buffer.from('built file'), ['built.txt'], 1_700_000_001_000)
    await seedSession(f, 'live', { title: 'Live', content: [{ type: 'image', attachment: image }] })
    await seedSession(f, 'gone', { title: 'Gone', content: [{ type: 'file', attachment: file }] })
    await trashSessions(f, 'Gone chat', 1_700_000_002_000, ['gone'])

    // The artifact exports the same class the source does; the source type stands in for its declarations.
    const built = await import(new URL('index.js', LIB).href) as typeof import('../src/index.ts')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: f.data })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(JsonlSessionPersistence, { root: f.sessions, compression: 'none' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService, {})
    await ctx.plugin(built.default, {
      attachmentDirectory: f.attachments, trashDirectory: f.trash, requestCacheDirectory: f.cache, previewDirectory: join(f.base, 'preview-tmp'),
    }).await()

    const before = [await snapshotTree(join(f.base, 'home')), await snapshotTree(f.sessions), await snapshotTree(f.trash)]
    const result = await ctx.typertGateway.invoke({ namespace: 'attachmentLibrary', method: 'scan', args: {} }) as import('../src/protocol.ts').LibraryResult
    expect(await ctx.typertGateway.invoke({ namespace: 'attachmentLibrary', method: 'reveal', args: { request: { kind: 'file', attachmentId: file.attachmentId } } }))
      .toEqual({ revealed: true })
    expect([await snapshotTree(join(f.base, 'home')), await snapshotTree(f.sessions), await snapshotTree(f.trash)]).toEqual(before)
    expect(await ctx.typertGateway.invoke({ namespace: 'attachmentLibrary', method: 'openInPreview', args: { request: { attachmentId: image.attachmentId } } }))
      .toEqual({ opened: true })
    expect(native.openNativeFileApplication.mock.calls[0]?.slice(0, 2)).toEqual([
      expect.stringMatching(/\/dsh-attachment-preview-[^/]+\/[0-9a-f]{16}\.png$/), '/System/Applications/Preview.app',
    ])
    expect(native.revealNativePath.mock.calls[0]?.[0]).toMatch(/\/files\/[0-9a-f]{2}\/[0-9a-f]{64}\/built\.txt$/)
    expect([await snapshotTree(join(f.base, 'home')), await snapshotTree(f.sessions), await snapshotTree(f.trash)]).toEqual(before)
    expect(result.attachments.map(row => [row.names[0], row.usage, row.references.map(ref => `${ref.title ?? ''}:${ref.status}`)])).toEqual([
      ['built.txt', 'trash-only', ['Gone chat:trash']],
      ['built.png', 'active', ['Live:normal']],
    ])
  })

  it('lib/client.js registers through the page module loader and requires only page modules', async () => {
    const source = await readFile(new URL('client.js', LIB), 'utf8')
    const pageModules = new Set([
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    ])
    const requested: string[] = []
    const nodeRequire = createRequire(import.meta.url)
    let registered: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
    runInNewContext(source, { window: { __ModuleLoader__: { load: (row: typeof registered) => { registered = row } } } })
    expect(registered?.id).toBe('dsh-plugin-attachment-library')
    const exports = registered!.factory((id) => {
      requested.push(id)
      if (!pageModules.has(id)) throw new Error(`not a page module: ${id}`)
      return id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : nodeRequire(id)
    })
    expect(exports.name).toBe('dsh-plugin-attachment-library/client')
    expect(exports.inject).toEqual(['slots', 'locale', 'remote'])
    expect(typeof exports.apply).toBe('function')
    expect(requested.every(id => pageModules.has(id))).toBe(true)
  })
})

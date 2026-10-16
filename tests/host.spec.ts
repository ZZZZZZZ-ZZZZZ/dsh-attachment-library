/**
 * The library service over the published DSH packages: real JSONL session
 * storage, real Workspace registry over JSON storage, and the real Typert
 * gateway dispatching the plugin's strict descriptor. Attachments and trash
 * entries are laid out as their owning packages write them. Every scenario
 * checks that the attachment store, session root, trash, and cache are left
 * byte-for-byte and inode-for-inode unchanged.
 */

import { existsSync } from 'node:fs'
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { SessionId } from '@deepseek-ai/dsh-session'
import AttachmentLibrary from '../src/index.ts'
import { parseLibraryResult, type AttachmentView, type LibraryResult } from '../src/protocol.ts'
import { currentGeneration, probeImage, scanEvents } from '../src/library.ts'
import {
  addPendingMove, createFixture, imageRef, jpeg, locateSession, png, promptTurn, seedSession, snapshotTree,
  storeFile, storeImage, trashSessions, webp, type Fixture,
} from './fixture.ts'

/** What the macOS handler query reports for an image: Preview first, as LaunchServices does. */
const PREVIEW_APP = '/System/Applications/Preview.app'
const IMAGE_HANDLERS = [
  { id: PREVIEW_APP, name: 'Preview', default: true, icon: null, bundle: 'com.apple.Preview', version: '11.0' },
  { id: '/Applications/Other.app', name: 'Other', default: false, icon: null, bundle: 'com.example.other', version: '1.0' },
]

// The official reveal helper runs `open -R` / Explorer; tests record the call instead of opening a window.
// The official file-application helpers run for real on the macOS path; only their no-shell command
// runner is replaced, so the exact argv they would hand to execFile is recorded.
const native = vi.hoisted(() => ({
  revealNativePath: vi.fn(async (_path: string, _signal: AbortSignal) => {}),
  canOpenNativePath: vi.fn(() => true),
  nativeFileManager: vi.fn((): 'finder' | 'explorer' | 'directory' | null => 'finder'),
  run: vi.fn(async (_command: string, _args: readonly string[], _signal: AbortSignal, _window: 'hidden' | 'visible') => ({ stdout: '', stderr: '' })),
}))
vi.mock('@deepseek-ai/dsh-native-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-native-command')>()
  const internals = { platform: 'darwin' as const, run: native.run }
  return {
    ...actual,
    revealNativePath: native.revealNativePath,
    canOpenNativePath: native.canOpenNativePath,
    nativeFileManager: native.nativeFileManager,
    nativeFileApplications: (path: string, signal: AbortSignal) => actual.nativeFileApplications(path, signal, internals),
    openNativeFileApplication: (path: string, application: string, signal: AbortSignal) =>
      actual.openNativeFileApplication(path, application, signal, internals),
  }
})

function answerHandlers(handlers: readonly object[]): void {
  native.run.mockImplementation(async (command: string) => ({ stdout: command === 'osascript' ? JSON.stringify(handlers) : '', stderr: '' }))
}

beforeEach(() => {
  native.revealNativePath.mockReset().mockResolvedValue(undefined)
  native.canOpenNativePath.mockReset().mockReturnValue(true)
  native.nativeFileManager.mockReset().mockReturnValue('finder')
  native.run.mockReset()
  answerHandlers(IMAGE_HANDLERS)
})

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<Fixture> {
  const f = await createFixture()
  dirs.push(f.base)
  return f
}

/** One application start: storage, JSONL sessions, Workspace registry, Typert, and the plugin. */
async function boot(f: Fixture) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: f.data })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(JsonlSessionPersistence, { root: f.sessions, compression: 'none' })
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin(AttachmentLibrary, {
    attachmentDirectory: f.attachments, trashDirectory: f.trash, requestCacheDirectory: f.cache, previewDirectory: join(f.base, 'preview-tmp'),
  }).await()
  const invoke = (method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace: 'attachmentLibrary', method, args })
  const scan = async (): Promise<LibraryResult> => parseLibraryResult(await invoke('scan', {}))
  const reveal = (kind: unknown, attachmentId: unknown) => invoke('reveal', { request: { kind, attachmentId } })
  const openInPreview = (attachmentId: unknown) => invoke('openInPreview', { request: { attachmentId } })
  return { ctx, registry: ctx.workspaceRegistry, persistence: ctx.sessionPersistence, invoke, scan, reveal, openInPreview }
}

async function restart(f: Fixture, app: Awaited<ReturnType<typeof boot>>) {
  await app.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(app.ctx), 1)
  return boot(f)
}

/** Everything the plugin must never change. */
async function untouchable(f: Fixture): Promise<Record<string, string>> {
  return {
    ...prefixed('attachments', await snapshotTree(join(f.base, 'home'))),
    ...prefixed('sessions', await snapshotTree(f.sessions)),
    ...prefixed('trash', await snapshotTree(f.trash)),
  }
}

function prefixed(prefix: string, tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([key, value]) => [`${prefix}/${key}`, value]))
}

function byId(result: LibraryResult, ref: { attachmentId: string }, kind: 'image' | 'file'): AttachmentView {
  const found = result.attachments.find(item => item.attachmentId === ref.attachmentId && item.kind === kind)
  if (found === undefined) throw new Error(`no ${kind} ${ref.attachmentId}`)
  return found
}

function refs(item: AttachmentView): string[] {
  return item.references.map(reference => `${reference.title ?? reference.sessionId}:${reference.status}`)
}

/** A home with live, archived, subagent, pending, trashed (zstd and raw), unreferenced, and missing attachments. */
async function populate(f: Fixture) {
  const imgA = await storeImage(f, png(4, 3, 'a'), 'image/png', 4, 3, 1_700_000_001_000, 'screenshot.png')
  const imgB = await storeImage(f, jpeg(640, 480, 'b'), 'image/jpeg', 640, 480, 1_700_000_002_000, 'photo.jpg')
  const imgC = await storeImage(f, webp(300, 200, 'c'), 'image/webp', 300, 200, 1_700_000_003_000, 'diagram.webp')
  const imgD = await storeImage(f, png(16, 9, 'd'), 'image/png', 16, 9, 1_700_000_004_000)
  const imgE = await storeImage(f, png(2, 2, 'e'), 'image/png', 2, 2, 1_700_000_004_500, 'old.png')
  const imgMissing = imageRef(png(5, 5, 'missing'), 'image/png', 5, 5, 'gone.png')
  const fileX = await storeFile(f, Buffer.from('notes for alpha'), ['notes.txt'], 1_700_000_005_000)
  const fileY = await storeFile(f, Buffer.from('subagent output'), ['report.md'], 1_700_000_006_000)
  const fileZ = await storeFile(f, Buffer.from('pending data'), ['data.csv'], 1_700_000_007_000)
  const fileW = await storeFile(f, Buffer.from('same bytes, two names'), ['a.txt', 'b.txt'], 1_700_000_008_000)
  const fileV = await storeFile(f, Buffer.from('raw trash file'), ['raw.log'], 1_700_000_009_000)

  await seedSession(f, 'alpha', {
    title: 'Alpha chat',
    content: [{ type: 'text', text: 'see' }, { type: 'image', attachment: imgA }, { type: 'file', attachment: fileX }],
    more: [{ type: 'image', attachment: imgMissing }],
  })
  await seedSession(f, 'beta', { title: 'Beta chat', content: [{ type: 'image', attachment: imgA }, { type: 'image', attachment: imgB }] })
  await seedSession(f, 'beta-sub', {
    content: [{ type: 'file', attachment: fileY }],
    lineage: { parentSession: SessionId('beta'), origin: 'subagent' },
  })
  await seedSession(f, 'beta-sub-2', {
    content: [{ type: 'file', attachment: fileY }],
    lineage: { parentSession: SessionId('beta-sub'), origin: 'subagent' },
  })
  await seedSession(f, 'delta', { title: 'Delta chat', content: [{ type: 'file', attachment: fileZ }] })
  await seedSession(f, 'untitled', { content: [{ type: 'text', text: 'no attachments here' }] })
  // Trashed: one compressed conversation with two frames, one raw conversation with a subagent.
  await seedSession(f, 'gamma', {
    title: 'Gamma (log title)', compression: 'zstd',
    content: [{ type: 'image', attachment: imgB }],
    more: [{ type: 'image', attachment: imgC }],
  })
  await seedSession(f, 'epsilon', { title: 'Epsilon', content: [{ type: 'image', attachment: imgE }] })
  await seedSession(f, 'epsilon-sub', {
    content: [{ type: 'file', attachment: fileV }],
    lineage: { parentSession: SessionId('epsilon'), origin: 'subagent' },
  })
  const gammaEntry = await trashSessions(f, 'Gamma chat', 1_700_000_100_000, ['gamma'])
  await trashSessions(f, 'Epsilon chat', 1_700_000_200_000, ['epsilon-sub', 'epsilon'])
  await mkdir(f.cache, { recursive: true })
  await writeFile(join(f.cache, 'variant.jpg'), Buffer.alloc(1234))
  return { imgA, imgB, imgC, imgD, imgE, imgMissing, fileX, fileY, fileZ, fileW, fileV, gammaEntry }
}

describe('attachment library: reference statistics', () => {
  it('attributes every attachment to the conversations that use it and changes nothing on disk', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const app = await boot(f)
    await app.registry.archiveSession(SessionId('beta'))
    await app.registry.archiveSession(SessionId('delta'))
    await addPendingMove(f, 'delta', 'Delta (pending)')

    const before = await untouchable(f)
    const result = await app.scan()
    expect(await untouchable(f)).toEqual(before)

    expect(refs(byId(result, seeded.imgA, 'image'))).toEqual(['Alpha chat:normal', 'Beta chat:archived'])
    expect(refs(byId(result, seeded.imgB, 'image'))).toEqual(['Beta chat:archived', 'Gamma chat:trash'])
    expect(refs(byId(result, seeded.imgC, 'image'))).toEqual(['Gamma chat:trash'])
    expect(refs(byId(result, seeded.imgE, 'image'))).toEqual(['Epsilon chat:trash'])
    expect(refs(byId(result, seeded.fileX, 'file'))).toEqual(['Alpha chat:normal'])
    // Two subagent generations below Beta: one conversation, listed once.
    expect(refs(byId(result, seeded.fileY, 'file'))).toEqual(['Beta chat:archived'])
    expect(refs(byId(result, seeded.fileZ, 'file'))).toEqual(['Delta chat:pending-trash'])
    expect(refs(byId(result, seeded.fileV, 'file'))).toEqual(['Epsilon chat:trash'])
    expect(byId(result, seeded.fileZ, 'file').usage).toBe('active')
    expect(byId(result, seeded.imgB, 'image').usage).toBe('active')
    expect(byId(result, seeded.imgC, 'image').usage).toBe('trash-only')
    expect(byId(result, seeded.fileV, 'file').usage).toBe('trash-only')
    expect(byId(result, seeded.imgD, 'image')).toMatchObject({
      usage: 'unreferenced', references: [], names: [], mediaType: 'image/png', width: 16, height: 9, storedAt: 1_700_000_004_000,
    })
    expect(byId(result, seeded.fileW, 'file')).toMatchObject({ usage: 'unreferenced', names: ['a.txt', 'b.txt'], sizeBytes: 21 })
    expect(byId(result, seeded.imgB, 'image')).toMatchObject({ names: ['photo.jpg'], mediaType: 'image/jpeg', width: 640, height: 480, missing: false })
    expect(byId(result, seeded.imgMissing, 'image')).toMatchObject({ missing: true, usage: 'active', names: ['gone.png'] })
    expect(result.attachments.find(item => item.attachmentId === seeded.imgMissing.attachmentId)?.storedAt).toBeUndefined()

    const size = (...items: { bytes: number }[]) => items.reduce((sum, item) => sum + item.bytes, 0)
    const { imgA, imgB, imgC, imgD, imgE, fileX, fileY, fileZ, fileW, fileV } = seeded
    expect(result.summary).toEqual({
      total: { count: 10, bytes: size(imgA, imgB, imgC, imgD, imgE, fileX, fileY, fileZ, fileW, fileV) },
      images: { count: 5, bytes: size(imgA, imgB, imgC, imgD, imgE) },
      files: { count: 5, bytes: size(fileX, fileY, fileZ, fileW, fileV) },
      active: { count: 5, bytes: size(imgA, imgB, fileX, fileY, fileZ) },
      trashOnly: { count: 3, bytes: size(imgC, imgE, fileV) },
      unreferenced: { count: 2, bytes: size(imgD, fileW) },
      missing: 1,
      requestCacheBytes: 1234,
      liveSessions: 6,
      trashSessions: 3,
    })
    expect(result.problems).toEqual([])
    expect(result.reread).toEqual({ live: 6, trash: 3 })
    // Newest stored first; the missing image (no store time) last.
    expect(result.attachments[0]?.attachmentId).toBe(seeded.fileV.attachmentId)
    expect(result.attachments.at(-1)?.attachmentId).toBe(seeded.imgMissing.attachmentId)
  })

  it('reads only changed logs on the next scan, and everything again after a restart', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    let app = await boot(f)
    expect((await app.scan()).reread).toEqual({ live: 6, trash: 3 })

    const before = await untouchable(f)
    const again = await app.scan()
    expect(again.reread).toEqual({ live: 0, trash: 0 })
    expect(byId(again, seeded.imgD, 'image').usage).toBe('unreferenced')
    expect(await untouchable(f)).toEqual(before)

    // A new prompt in Alpha now uses imgD: only Alpha is read again.
    const writer = await app.persistence.open(SessionId('alpha'), 'write')
    const { events } = await writer.read()
    await writer.append(promptTurn(events.length, 3, [{ type: 'image', attachment: seeded.imgD }]))
    await writer.close()
    const changed = await app.scan()
    expect(changed.reread).toEqual({ live: 1, trash: 0 })
    expect(refs(byId(changed, seeded.imgD, 'image'))).toEqual(['Alpha chat:normal'])

    // A session that disappears from the backend drops its references.
    await rm((await locateSession(f, 'delta')).dir, { recursive: true })
    const removed = await app.scan()
    expect(byId(removed, seeded.fileZ, 'file').usage).toBe('unreferenced')
    expect(removed.summary.liveSessions).toBe(5)

    app = await restart(f, app)
    expect((await app.scan()).reread).toEqual({ live: 5, trash: 3 })
  })

  it('joins a scan already running instead of starting another', async () => {
    const f = await fixture()
    await populate(f)
    const app = await boot(f)
    const [first, second] = await Promise.all([app.scan(), app.scan()])
    expect(second).toEqual(first)
    expect(first.reread).toEqual({ live: 6, trash: 3 })
  })

  it('reports incomplete trash logs and still counts the readable part', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    // Cut the second Zstandard frame of Gamma's log (an interrupted append), and add a torn line to Epsilon's raw log.
    const gamma = await trashLog(f, 'gamma')
    expect(gamma).toMatch(/\.zstd$/)
    expect(gamma.startsWith(join(f.trash, seeded.gammaEntry))).toBe(true)
    await truncate(gamma, (await readFile(gamma)).length - 5)
    const epsilon = await trashLog(f, 'epsilon')
    await appendFile(epsilon, '{"type":"user/mess')
    const app = await boot(f)

    const before = await untouchable(f)
    const result = await app.scan()
    expect(await untouchable(f)).toEqual(before)
    expect(result.problems.map(problem => [problem.id, problem.where]).sort()).toEqual([['epsilon', 'trash'], ['gamma', 'trash']])
    expect(result.problems.find(problem => problem.id === 'gamma')?.reason).toContain('damaged compressed frame')
    // The first frame still names imgB; imgC sat in the cut frame.
    expect(refs(byId(result, seeded.imgB, 'image'))).toEqual(['Beta chat:normal', 'Gamma chat:trash'])
    expect(byId(result, seeded.imgC, 'image').usage).toBe('unreferenced')
    expect(byId(result, seeded.imgE, 'image').usage).toBe('trash-only')
  })

  it('reports an unreadable trash entry without failing the scan', async () => {
    const f = await fixture()
    await populate(f)
    const broken = join(f.trash, '00000000-0000-4000-8000-000000000000')
    await mkdir(broken)
    await writeFile(join(broken, 'entry.json'), '{ not json')
    const app = await boot(f)
    const result = await app.scan()
    expect(result.problems).toEqual([expect.objectContaining({ id: '00000000-0000-4000-8000-000000000000', where: 'trash' })])
    expect(result.summary.total.count).toBe(10)
  })

  it('reports a live log the backend refuses and keeps the other references', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const alpha = await currentGeneration((await locateSession(f, 'alpha')).dir)
    // A damaged row between committed rows is corruption, not a torn tail.
    const lines = (await readFile(alpha as string, 'utf8')).split('\n')
    lines.splice(2, 0, '{"damaged"')
    await writeFile(alpha as string, lines.join('\n'))
    const app = await boot(f)
    const before = await untouchable(f)
    const result = await app.scan()
    expect(await untouchable(f)).toEqual(before)
    expect(result.problems).toEqual([expect.objectContaining({ id: 'alpha', where: 'live' })])
    expect(refs(byId(result, seeded.imgA, 'image'))).toEqual(['Beta chat:normal'])
    expect(byId(result, seeded.fileX, 'file').usage).toBe('unreferenced')
  })

  it('fails the Remote call with a coded error when the backend cannot list sessions', async () => {
    const f = await fixture()
    const app = await boot(f)
    vi.spyOn(app.persistence, 'list').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(app.scan()).rejects.toMatchObject({ code: 'attachment-library/scan-failed', details: { reason: 'disk unavailable' } })
    expect((await app.scan()).problems).toEqual([])
  })

  it('returns an empty library for a home without attachments, trash, or cache', async () => {
    const f = await fixture()
    await seedSession(f, 'plain', { title: 'Plain' })
    const app = await boot(f)
    const result = await app.scan()
    expect(result.attachments).toEqual([])
    expect(result.summary).toMatchObject({ total: { count: 0, bytes: 0 }, missing: 0, requestCacheBytes: 0, liveSessions: 1, trashSessions: 0 })
    expect(result.problems).toEqual([])
  })
})

async function listProjects(f: Fixture, entryId: string): Promise<string[]> {
  return (await readdir(join(f.trash, entryId), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

async function trashLog(f: Fixture, sessionId: string): Promise<string> {
  for (const entry of await readdir(f.trash, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const project of await listProjects(f, entry.name)) {
      const log = await currentGeneration(join(f.trash, entry.name, project, sessionId))
      if (log !== undefined) return log
    }
  }
  throw new Error(`no trash log for ${sessionId}`)
}

describe('attachment library: show in Finder', () => {
  it('reveals an image object and a file under its display name through the official helper, changing nothing', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const bare = await storeFile(f, Buffer.from('no display name'), [], 1_700_000_010_000)
    const app = await boot(f)
    const before = await untouchable(f)
    const root = await realpath(f.attachments)
    const hex = (ref: { attachmentId: string }) => ref.attachmentId.slice('sha256:'.length)

    expect(await app.invoke('revealAvailability', {})).toEqual({ available: true, preview: true })
    expect(await app.reveal('image', seeded.imgD.attachmentId)).toEqual({ revealed: true })
    expect(await app.reveal('file', seeded.fileW.attachmentId)).toEqual({ revealed: true })
    expect(await app.reveal('file', seeded.fileV.attachmentId)).toEqual({ revealed: true })
    expect(await app.reveal('file', bare.attachmentId)).toEqual({ revealed: true })
    const revealed = await Promise.all(native.revealNativePath.mock.calls.map(async call => realpath(call[0])))
    expect(revealed).toEqual([
      join(root, 'objects', hex(seeded.imgD).slice(0, 2), hex(seeded.imgD)),
      join(root, 'files', hex(seeded.fileW).slice(0, 2), hex(seeded.fileW), 'a.txt'),
      join(root, 'files', hex(seeded.fileV).slice(0, 2), hex(seeded.fileV), 'raw.log'),
      join(root, 'file-objects', hex(bare).slice(0, 2), hex(bare)),
    ])
    expect(native.revealNativePath.mock.calls.every(call => call[1] instanceof AbortSignal)).toBe(true)
    expect(await untouchable(f)).toEqual(before)
  })

  it('refuses ids that are not a stored attachment of that kind, and links', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const target = await storeImage(f, png(4, 4, 'link target'), 'image/png', 4, 4, 1_700_000_000_000)
    const linked = imageRef(png(6, 6, 'linked'), 'image/png', 6, 6)
    const linkedHex = linked.attachmentId.slice('sha256:'.length)
    const targetHex = target.attachmentId.slice('sha256:'.length)
    await mkdir(join(f.attachments, 'objects', linkedHex.slice(0, 2)), { recursive: true })
    await symlink(join(f.attachments, 'objects', targetHex.slice(0, 2), targetHex), join(f.attachments, 'objects', linkedHex.slice(0, 2), linkedHex))
    // A file whose only display name is a link to something outside the store falls back to its object.
    const fileHex = seeded.fileX.attachmentId.slice('sha256:'.length)
    const alias = join(f.attachments, 'files', fileHex.slice(0, 2), fileHex, 'notes.txt')
    await unlink(alias)
    await symlink(join(f.project), alias)
    const app = await boot(f)
    const before = await untouchable(f)

    await expect(app.reveal('image', `sha256:${'0'.repeat(64)}`)).rejects.toMatchObject({ code: 'attachment-library/not-found' })
    await expect(app.reveal('image', seeded.fileW.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/not-found', details: { attachmentId: seeded.fileW.attachmentId } })
    await expect(app.reveal('file', seeded.imgD.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/not-found' })
    await expect(app.reveal('image', seeded.imgMissing.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/not-found' })
    await expect(app.reveal('image', linked.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/not-found' })
    expect(native.revealNativePath).not.toHaveBeenCalled()
    await app.reveal('file', seeded.fileX.attachmentId)
    expect(await realpath(native.revealNativePath.mock.calls[0]![0])).toBe(join(await realpath(f.attachments), 'file-objects', fileHex.slice(0, 2), fileHex))
    expect(await untouchable(f)).toEqual(before)
  })

  it('rejects malformed ids, unknown kinds, and any path argument at the wire', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const app = await boot(f)
    const method = vi.spyOn(app.ctx.attachmentLibrary, 'reveal')
    const good = seeded.imgD.attachmentId
    const bad: [unknown, unknown][] = [
      ['image', 'sha256:XYZ'], ['image', `sha256:${'A'.repeat(64)}`], ['image', `../../${'a'.repeat(64)}`], ['image', '/etc/passwd'],
      ['image', `sha256:${'a'.repeat(63)}`], ['image', 42], ['image', null], ['folder', good], [undefined, good],
    ]
    for (const [kind, attachmentId] of bad) {
      await expect(app.reveal(kind, attachmentId), `${String(kind)} ${String(attachmentId)}`).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    }
    await expect(app.invoke('reveal', { request: { kind: 'image', attachmentId: good, path: '/etc/passwd' } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    await expect(app.invoke('reveal', { request: { path: '/etc/passwd' } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    expect(method).not.toHaveBeenCalled()
    expect(native.revealNativePath).not.toHaveBeenCalled()
  })

  it('reports a Host without a file manager, and a file manager that fails', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const app = await boot(f)
    native.nativeFileManager.mockReturnValue(null)
    expect(await app.invoke('revealAvailability', {})).toEqual({ available: false, preview: false })
    await expect(app.reveal('image', seeded.imgD.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/unavailable' })
    native.nativeFileManager.mockReturnValue('directory')
    native.canOpenNativePath.mockReturnValue(false)
    expect(await app.invoke('revealAvailability', {})).toEqual({ available: false, preview: false })
    native.canOpenNativePath.mockReturnValue(true)
    native.revealNativePath.mockRejectedValueOnce(new Error('open exited with 1'))
    await expect(app.reveal('image', seeded.imgD.attachmentId)).rejects.toMatchObject({
      code: 'attachment-library/reveal-failed', details: { attachmentId: seeded.imgD.attachmentId, reason: 'open exited with 1' },
    })
  })
})

describe('attachment library: open in Preview', () => {
  const opened = () => native.run.mock.calls.filter(call => call[0] === 'open')

  it('opens a read-only copy with its extension through the official helper and a fixed argv; DSH data is unchanged', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const app = await boot(f)
    const before = await untouchable(f)

    for (const [ref, extension] of [[seeded.imgA, 'png'], [seeded.imgB, 'jpg'], [seeded.imgC, 'webp']] as const) {
      expect(await app.openInPreview(ref.attachmentId)).toEqual({ opened: true })
      const call = opened().at(-1)!
      const hex = ref.attachmentId.slice('sha256:'.length)
      expect(call[0]).toBe('open')
      expect(call[1]).toHaveLength(3)
      expect(call[1].slice(0, 2)).toEqual(['-a', PREVIEW_APP])
      expect(call[1][2]).toMatch(new RegExp(`/preview-tmp/dsh-attachment-preview-[^/]+/${hex.slice(0, 16)}\\.${extension}$`))
      expect(call[2]).toBeInstanceOf(AbortSignal)
      const copy = call[1][2] as string
      expect(await readFile(copy)).toEqual(await readFile(join(f.attachments, 'objects', hex.slice(0, 2), hex)))
      expect((await lstat(copy)).mode & 0o777).toBe(0o400)
      expect((await lstat(dirname(copy))).mode & 0o777).toBe(0o700)
    }
    // Every native command is an executable with an argv array: osascript asks LaunchServices, open launches Preview.
    expect(native.run.mock.calls.map(call => call[0])).toEqual(['osascript', 'osascript', 'open', 'osascript', 'osascript', 'open', 'osascript', 'osascript', 'open'])
    expect(native.run.mock.calls.every(call => Array.isArray(call[1]))).toBe(true)

    // A second open reuses the copy.
    const firstCopy = opened()[0]![1][2] as string
    const copyInode = (await lstat(firstCopy)).ino
    await app.openInPreview(seeded.imgA.attachmentId)
    expect(opened().at(-1)![1][2]).toBe(firstCopy)
    expect((await lstat(firstCopy)).ino).toBe(copyInode)
    expect(native.revealNativePath).not.toHaveBeenCalled()
    expect(await untouchable(f)).toEqual(before)

    // Stopping the plugin removes the private directory and its copies.
    await app.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(app.ctx), 1)
    await vi.waitFor(() => { expect(existsSync(dirname(firstCopy))).toBe(false) })
    expect(await untouchable(f)).toEqual(before)
  })

  it('refuses ids that are not a stored image, links, and unreadable images, without launching anything', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const odd = await storeImage(f, Buffer.from('no image header'), 'image/png', 1, 1, 1_700_000_000_000)
    const target = seeded.imgA.attachmentId.slice('sha256:'.length)
    const linked = imageRef(png(6, 6, 'linked'), 'image/png', 6, 6)
    const linkedHex = linked.attachmentId.slice('sha256:'.length)
    await mkdir(join(f.attachments, 'objects', linkedHex.slice(0, 2)), { recursive: true })
    await symlink(join(f.attachments, 'objects', target.slice(0, 2), target), join(f.attachments, 'objects', linkedHex.slice(0, 2), linkedHex))
    const app = await boot(f)
    const before = await untouchable(f)

    await expect(app.openInPreview(seeded.fileX.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/not-found', details: { attachmentId: seeded.fileX.attachmentId } })
    await expect(app.openInPreview(`sha256:${'0'.repeat(64)}`)).rejects.toMatchObject({ code: 'attachment-library/not-found' })
    await expect(app.openInPreview(seeded.imgMissing.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/not-found' })
    await expect(app.openInPreview(linked.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/not-found' })
    await expect(app.openInPreview(odd.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/open-failed', details: { reason: 'unrecognized image format' } })
    answerHandlers(IMAGE_HANDLERS.slice(1))
    await expect(app.openInPreview(seeded.imgA.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/open-failed', details: { reason: 'Preview is not registered for this image' } })
    expect(opened()).toEqual([])
    expect(await untouchable(f)).toEqual(before)
  })

  it('rejects malformed ids and any path argument at the wire', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const app = await boot(f)
    const method = vi.spyOn(app.ctx.attachmentLibrary, 'openInPreview')
    for (const bad of ['sha256:XYZ', `sha256:${'A'.repeat(64)}`, `../../${'a'.repeat(64)}`, '/etc/passwd', `sha256:${'a'.repeat(65)}`, 42, null]) {
      await expect(app.openInPreview(bad), String(bad)).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    }
    await expect(app.invoke('openInPreview', { request: { attachmentId: seeded.imgA.attachmentId, path: '/etc/passwd' } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    await expect(app.invoke('openInPreview', { request: { path: '/etc/passwd' } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    await expect(app.invoke('openInPreview', { request: { kind: 'image', attachmentId: seeded.imgA.attachmentId } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    expect(method).not.toHaveBeenCalled()
    expect(native.run).not.toHaveBeenCalled()
  })

  it('is offered and allowed only on a macOS Host with Finder', async () => {
    const f = await fixture()
    const seeded = await populate(f)
    const app = await boot(f)
    for (const manager of ['explorer', 'directory', null] as const) {
      native.nativeFileManager.mockReturnValue(manager)
      expect((await app.invoke('revealAvailability', {}) as { preview: boolean }).preview).toBe(false)
      await expect(app.openInPreview(seeded.imgA.attachmentId)).rejects.toMatchObject({ code: 'attachment-library/unavailable' })
    }
    expect(native.run).not.toHaveBeenCalled()
  })
})

describe('attachment library: parsing', () => {
  it('reads PNG, JPEG, WebP, and GIF dimensions from headers', () => {
    expect(probeImage(png(7, 5, 'x'))).toEqual({ mediaType: 'image/png', width: 7, height: 5 })
    expect(probeImage(jpeg(1920, 1080, 'x'))).toEqual({ mediaType: 'image/jpeg', width: 1920, height: 1080 })
    expect(probeImage(webp(4000, 3000, 'x'))).toEqual({ mediaType: 'image/webp', width: 4000, height: 3000 })
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00, 0, 0])
    expect(probeImage(gif)).toEqual({ mediaType: 'image/gif', width: 32, height: 16 })
    const lossless = Buffer.alloc(30)
    lossless.write('RIFF', 0, 'latin1')
    lossless.write('WEBPVP8L', 8, 'latin1')
    lossless[20] = 0x2f
    lossless.writeUInt32LE((99) | (49 << 14), 21)
    expect(probeImage(lossless)).toEqual({ mediaType: 'image/webp', width: 100, height: 50 })
    expect(probeImage(Buffer.from('plain text'))).toBeUndefined()
  })

  it('finds references nested in tool results and ignores malformed ids', () => {
    const id = `sha256:${'a'.repeat(64)}`
    const facts = scanEvents([
      { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] }] } } },
      { type: 'user/message', data: { content: [{ type: 'file', attachment: { attachmentId: 'sha256:short', name: 'x', bytes: 1 } }, { type: 'image', attachment: { attachmentId: id } }] } },
      { type: 'session/title', data: { title: 'First' } },
      { type: 'session/title', data: { title: 'Latest' } },
    ])
    expect(facts).toEqual({ refs: [{ kind: 'image', sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, bytes: 3 }], title: 'Latest' })
  })
})

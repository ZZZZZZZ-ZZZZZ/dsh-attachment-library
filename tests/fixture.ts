/**
 * Test fixtures over the published DSH packages: sessions are written by the
 * real JSONL backend, attachments are laid out exactly as
 * `@deepseek-ai/dsh-attachment-local` stores them (v1), and trash entries
 * exactly as `dsh-plugin-session-trash` writes them (manifest version 1).
 * Everything lives under one temporary directory inside the project sandbox.
 */

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Directories of one fixture. */
export interface Fixture {
  readonly base: string
  readonly sessions: string
  readonly data: string
  readonly trash: string
  readonly attachments: string
  readonly cache: string
  readonly project: string
}

/**
 * Create the fixture directories under the sandbox temporary directory.
 * @param prefix - directory name prefix.
 * @returns the fixture.
 */
export async function createFixture(prefix = 'dsh-attachment-library-'): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const project = join(base, 'project')
  await mkdir(project)
  return {
    base, project,
    sessions: join(base, 'sessions'),
    data: join(base, 'data'),
    trash: join(base, 'session-trash'),
    attachments: join(base, 'home', 'attachments', 'v1'),
    cache: join(base, 'home', 'cache', 'attachments', 'request-images'),
  }
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/**
 * A valid RGBA PNG.
 * @param width - pixels.
 * @param height - pixels.
 * @param label - text stored in a tEXt chunk so equal sizes still differ in bytes.
 * @returns the encoded image.
 */
export function png(width: number, height: number, label: string): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0${label}`, 'latin1')),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 4)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A baseline JPEG header (APP0, COM, SOF0) followed by end-of-image; enough for header parsing.
 * @param width - pixels.
 * @param height - pixels.
 * @param label - comment text.
 * @returns the bytes.
 */
export function jpeg(width: number, height: number, label: string): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const text = Buffer.from(label, 'latin1')
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, text.length + 2]), text])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, com, sof, Buffer.from([0xff, 0xd9])])
}

/**
 * An extended-format WebP header (VP8X).
 * @param width - pixels.
 * @param height - pixels.
 * @param label - trailing bytes so equal sizes still differ.
 * @returns the bytes.
 */
export function webp(width: number, height: number, label: string): Buffer {
  const body = Buffer.alloc(10)
  body.writeUIntLE(width - 1, 4, 3)
  body.writeUIntLE(height - 1, 7, 3)
  const payload = Buffer.concat([Buffer.from('WEBP', 'latin1'), Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0]), body, Buffer.from(label, 'latin1')])
  const size = Buffer.alloc(4)
  size.writeUInt32LE(payload.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, payload])
}

/** A durable image reference as admission records it. */
export interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** A durable file reference as admission records it. */
export interface FileRef {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Describe image bytes without storing them.
 * @returns the reference a session would log.
 */
export function imageRef(data: Buffer, mediaType: ImageRef['mediaType'], width: number, height: number, name?: string): ImageRef {
  return { attachmentId: `sha256:${sha256(data)}`, mediaType, bytes: data.length, width, height, ...name === undefined ? {} : { name } }
}

/**
 * Store an image object as the local attachment store does: read-only, under its digest.
 * @returns the reference a session would log.
 */
export async function storeImage(
  f: Fixture, data: Buffer, mediaType: ImageRef['mediaType'], width: number, height: number, storedAt: number, name?: string,
): Promise<ImageRef> {
  const hex = sha256(data)
  const dir = join(f.attachments, 'objects', hex.slice(0, 2))
  await mkdir(dir, { recursive: true })
  const path = join(dir, hex)
  await writeFile(path, data, { mode: 0o400 })
  await utimes(path, storedAt / 1000, storedAt / 1000)
  return imageRef(data, mediaType, width, height, name)
}

/**
 * Store a file as the local attachment store does: one canonical object plus a
 * read-only hard link per display name.
 * @returns the reference of the first name.
 */
export async function storeFile(f: Fixture, data: Buffer, names: readonly string[], storedAt: number): Promise<FileRef> {
  const hex = sha256(data)
  const objectDir = join(f.attachments, 'file-objects', hex.slice(0, 2))
  await mkdir(objectDir, { recursive: true })
  const object = join(objectDir, hex)
  await writeFile(object, data, { mode: 0o400 })
  await utimes(object, storedAt / 1000, storedAt / 1000)
  const aliasDir = join(f.attachments, 'files', hex.slice(0, 2), hex)
  await mkdir(aliasDir, { recursive: true })
  for (const name of names) await link(object, join(aliasDir, name))
  return { attachmentId: `sha256:${hex}`, name: names[0] as string, bytes: data.length }
}

/** Content of one human prompt. */
export type Part =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageRef }
  | { readonly type: 'file'; readonly attachment: FileRef }

let messageCounter = 0

/**
 * One completed turn whose prompt carries `content`.
 * @param start - seq of the first event.
 * @param turn - turn number.
 * @returns the events.
 */
export function promptTurn(start: number, turn: number, content: readonly Part[]): SessionEvent[] {
  messageCounter += 1
  const events = [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: { id: `m${String(messageCounter)}`, role: 'user', source: { kind: 'user' }, content } },
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
  return events.map((event, index) => ({ ...event, seq: SessionSeq(start + index), time: 1_000 + start + index })) as never
}

/**
 * A user-sourced title event.
 * @param seq - its seq.
 * @returns the event.
 */
export function titleEvent(seq: number, title: string): SessionEvent {
  return { type: 'session/title', seq: SessionSeq(seq), time: 1_000 + seq, data: { title, messageSeqs: [], source: { kind: 'user' } } } as never
}

/** What one seeded session holds. */
export interface SeedOptions {
  readonly title?: string
  readonly content?: readonly Part[]
  /** A second prompt written as a second append (a second Zstandard frame). */
  readonly more?: readonly Part[]
  readonly lineage?: Partial<SessionHeader>
  readonly compression?: 'none' | 'zstd'
}

/**
 * Write one session through a short-lived JSONL backend instance.
 * @param f - fixture.
 * @param id - session id.
 * @param options - prompts, title, lineage, and compression.
 */
export async function seedSession(f: Fixture, id: string, options: SeedOptions = {}): Promise<void> {
  const ctx = new Context()
  // A backend root holds one encoding; compressed sessions are written beside it and only ever moved into the trash.
  const compression = options.compression ?? 'none'
  await ctx.plugin(JsonlSessionPersistence, { root: compression === 'zstd' ? zstdRoot(f) : f.sessions, compression })
  const handle = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd: f.project, isSeeded: false, ...options.lineage,
  })
  const first = promptTurn(0, 1, options.content ?? [{ type: 'text', text: 'hello' }])
  await handle.append(options.title === undefined ? first : [...first, titleEvent(first.length, options.title)])
  if (options.more !== undefined) {
    const offset = first.length + (options.title === undefined ? 0 : 1)
    await handle.append(promptTurn(offset, 2, options.more))
  }
  await handle.close()
  await ctx.fiber.dispose()
}

/** Root of sessions written compressed. */
export function zstdRoot(f: Fixture): string {
  return `${f.sessions}-zstd`
}

/**
 * The directory the JSONL backend stores a session in.
 * @returns project segment and absolute directory.
 */
export async function locateSession(f: Fixture, id: string): Promise<{ project: string; dir: string }> {
  for (const root of [f.sessions, zstdRoot(f)]) {
    let projects: string[]
    try {
      projects = await readdir(root)
    } catch {
      continue
    }
    for (const project of projects) {
      const dir = join(root, project, id)
      try {
        if ((await lstat(dir)).isDirectory()) return { project, dir }
      } catch {
        // Not in this project directory.
      }
    }
  }
  throw new Error(`session "${id}" not found`)
}

/**
 * Move sessions into a trash entry the way `dsh-plugin-session-trash` does.
 * @param ids - subagent sessions first, the conversation last.
 * @returns the entry id.
 */
export async function trashSessions(f: Fixture, title: string, deletedAt: number, ids: readonly string[]): Promise<string> {
  const entryId = randomUUID()
  const entryDir = join(f.trash, entryId)
  await mkdir(entryDir, { recursive: true, mode: 0o700 })
  const sessions: { sessionId: string; project: string; dirName: string }[] = []
  for (const id of ids) {
    const { project, dir } = await locateSession(f, id)
    await mkdir(join(entryDir, project), { recursive: true })
    await rename(dir, join(entryDir, project, id))
    sessions.push({ sessionId: id, project, dirName: id })
  }
  const manifest = { version: 1, entryId, sessionId: ids[ids.length - 1], title, deletedAt, wasArchived: false, wasPinned: false, sessions }
  await writeFile(join(entryDir, 'entry.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return entryId
}

/**
 * Record a pending move the way `dsh-plugin-session-trash` does.
 */
export async function addPendingMove(f: Fixture, sessionId: string, title: string): Promise<void> {
  await mkdir(f.trash, { recursive: true })
  const pendingId = randomUUID()
  const record = { version: 1, pendingId, sessionId, title, requestedAt: 5, wasArchived: false, wasPinned: false }
  await writeFile(join(f.trash, `.pending-${pendingId}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Every entry below a directory with its type, mode, size, times, inode, link
 * count, and content digest. Equal snapshots mean nothing was created,
 * removed, renamed, written, or re-permissioned.
 * @param root - directory to record; a missing one records as empty.
 * @returns path → description.
 */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      const path = join(dir, name)
      const info = await lstat(path, { bigint: true })
      const rel = relative(root, path)
      const common = `mode=${info.mode.toString(8)} ino=${String(info.ino)} nlink=${String(info.nlink)} mtime=${String(info.mtimeNs)} ctime=${String(info.ctimeNs)}`
      if (info.isDirectory()) {
        out[rel] = `dir ${common}`
        await walk(path)
      } else if (info.isSymbolicLink()) {
        out[rel] = `link ${common} -> ${await readlink(path)}`
      } else {
        out[rel] = `file ${common} size=${String(info.size)} sha=${createHash('sha256').update(await readFile(path)).digest('hex')}`
      }
    }
  }
  await walk(root)
  return out
}

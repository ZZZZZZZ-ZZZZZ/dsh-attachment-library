/**
 * Filesystem side of the attachment library, independent of Cordis. Every
 * function here only lists, stats, and reads; nothing creates, writes,
 * renames, or deletes a file.
 *
 * Stored attachments (`@deepseek-ai/dsh-attachment-local`, layout v1):
 * - images: `<root>/objects/<sha256[0..2]>/<sha256>`;
 * - files: one canonical object `<root>/file-objects/<sha256[0..2]>/<sha256>`
 *   plus read-only hard links `<root>/files/<sha256[0..2]>/<sha256>/<name>`
 *   that carry the display names (hard links take no extra space).
 *
 * Session logs reference an attachment as `{ type: 'image' | 'file',
 * attachment: { attachmentId: 'sha256:<hex>', … } }` anywhere in an event
 * (user prompts, tool results, system messages), in every released format.
 * The reference scan therefore walks every value instead of naming event
 * types, so it keeps working when DSH adds events that carry attachments.
 *
 * Trash entries (`dsh-plugin-session-trash`): `<trash>/<entryId>/entry.json`
 * plus the moved session directories at `<project>/<encoded-id>/`; pending
 * moves are `<trash>/.pending-<uuid>.json`. Logs there are read directly
 * (raw JSONL or concatenated Zstandard frames), since the session backend no
 * longer lists them.
 */

import type { Dirent } from 'node:fs'
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Kind of stored attachment. Images and files live in separate object stores. */
export type AttachmentKind = 'image' | 'file'

const ATTACHMENT_ID = /^sha256:([0-9a-f]{64})$/
const HEX64 = /^[0-9a-f]{64}$/
const PREFIX = /^[0-9a-f]{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PENDING_FILE = /^\.pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/
const GENERATION = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/
/** Bytes read from an image object to find its dimensions. */
const PROBE_BYTES = 64 * 1024
/** Nesting depth the reference scan descends into one event. */
const MAX_DEPTH = 64

/** Identity of one stored attachment: its kind and content digest. */
export function attachmentKey(kind: AttachmentKind, sha256: string): string {
  return `${kind}:${sha256}`
}

/** What one session reference states about an attachment. */
export interface ReferenceFact {
  readonly kind: AttachmentKind
  readonly sha256: string
  readonly name?: string
  readonly mediaType?: string
  readonly width?: number
  readonly height?: number
  readonly bytes?: number
}

/** References and the latest title found in one session log. */
export interface LogFacts {
  /** One fact per distinct attachment, first occurrence wins. */
  readonly refs: readonly ReferenceFact[]
  /** Latest `session/title` text, when the log has one. */
  readonly title?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function referenceOf(value: Record<string, unknown>): ReferenceFact | undefined {
  const kind = value.type
  if (kind !== 'image' && kind !== 'file') return undefined
  const attachment = value.attachment
  if (!isRecord(attachment) || typeof attachment.attachmentId !== 'string') return undefined
  const sha256 = ATTACHMENT_ID.exec(attachment.attachmentId)?.[1]
  if (sha256 === undefined) return undefined
  const name = typeof attachment.name === 'string' && attachment.name !== '' ? attachment.name : undefined
  const mediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined
  const width = positiveInteger(attachment.width)
  const height = positiveInteger(attachment.height)
  const bytes = count(attachment.bytes)
  return {
    kind, sha256,
    ...name === undefined ? {} : { name },
    ...kind === 'image' && mediaType !== undefined ? { mediaType } : {},
    ...kind === 'image' && width !== undefined && height !== undefined ? { width, height } : {},
    ...bytes === undefined ? {} : { bytes },
  }
}

/** Accumulates references and the latest title over a log's events in order. */
export class LogScanner {
  private readonly refs = new Map<string, ReferenceFact>()
  private title: string | undefined

  /**
   * Scan one event (or physical row) for attachment references and titles.
   * @param event - a parsed event value.
   */
  add(event: unknown): void {
    if (isRecord(event) && event.type === 'session/title' && isRecord(event.data) && typeof event.data.title === 'string' && event.data.title !== '') {
      this.title = event.data.title
    }
    const stack: { value: unknown; depth: number }[] = [{ value: event, depth: 0 }]
    while (stack.length > 0) {
      const { value, depth } = stack.pop() as { value: unknown; depth: number }
      if (depth > MAX_DEPTH || typeof value !== 'object' || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) stack.push({ value: item, depth: depth + 1 })
        continue
      }
      const record = value as Record<string, unknown>
      const ref = referenceOf(record)
      if (ref !== undefined) {
        const key = attachmentKey(ref.kind, ref.sha256)
        if (!this.refs.has(key)) this.refs.set(key, ref)
        continue
      }
      for (const child of Object.values(record)) stack.push({ value: child, depth: depth + 1 })
    }
  }

  /** @returns the facts gathered so far. */
  result(): LogFacts {
    return { refs: [...this.refs.values()], ...this.title === undefined ? {} : { title: this.title } }
  }
}

/**
 * Scan a complete event list.
 * @param events - events in log order.
 * @returns references and the latest title.
 */
export function scanEvents(events: Iterable<unknown>): LogFacts {
  const scanner = new LogScanner()
  for (const event of events) scanner.add(event)
  return scanner.result()
}

function isErrno(error: unknown, ...codes: string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException | null)?.code ?? '')
}

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return []
    throw error
  }
}

const ZSTD_MAGIC = 0xfd2fb528

/**
 * End offset of the Zstandard frame starting at `start`, found from the frame
 * and block headers without decompressing; `undefined` when the buffer ends
 * inside the frame or the header is not a frame.
 */
function zstdFrameEnd(buffer: Buffer, start: number): number | undefined {
  let offset = start
  if (offset + 4 > buffer.length) return undefined
  const magic = buffer.readUInt32LE(offset)
  offset += 4
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    // Skippable frame: a 4-byte size and that many bytes.
    if (offset + 4 > buffer.length) return undefined
    const end = offset + 4 + buffer.readUInt32LE(offset)
    return end <= buffer.length ? end : undefined
  }
  if (magic !== ZSTD_MAGIC || offset >= buffer.length) return undefined
  const descriptor = buffer[offset] as number
  offset += 1
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03] as number
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6] as number
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  for (;;) {
    if (offset + 3 > buffer.length) return undefined
    const header = buffer.readUIntLE(offset, 3)
    offset += 3
    const type = (header >> 1) & 0x03
    if (type === 3) return undefined
    offset += type === 1 ? 1 : header >> 3
    if (offset > buffer.length) return undefined
    if ((header & 0x01) !== 0) break
  }
  offset += checksum ? 4 : 0
  return offset <= buffer.length ? offset : undefined
}

/**
 * Decode a concatenated-frame Zstandard log frame by frame. A final frame cut
 * short (an interrupted append) or a frame that fails its checksum ends the
 * readable part.
 */
function decodeZstd(buffer: Buffer): { text: Buffer; complete: boolean } {
  const parts: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const end = zstdFrameEnd(buffer, offset)
    if (end === undefined) return { text: Buffer.concat(parts), complete: false }
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset, end)))
    } catch {
      return { text: Buffer.concat(parts), complete: false }
    }
    offset = end
  }
  return { text: Buffer.concat(parts), complete: true }
}

/** A session log file read outside the session backend. */
export interface RawLogFacts extends LogFacts {
  /** Lines that were not JSON (a torn tail or damage); their references are unknown. */
  readonly skippedLines: number
  /** Whether a compressed log ended in a frame that could not be decoded. */
  readonly truncated: boolean
}

/**
 * Read one raw or Zstandard-compressed JSONL session log and scan its rows.
 * @param path - the log file.
 * @returns references, title, and how much could not be read.
 */
export async function scanLogFile(path: string): Promise<RawLogFacts> {
  const bytes = await readFile(path)
  const decoded = path.endsWith('.zstd') ? decodeZstd(bytes) : { text: bytes, complete: true }
  const scanner = new LogScanner()
  let skippedLines = 0
  const lines = decoded.text.toString('utf8').split('\n')
  // A last line without its newline is an unfinished append, as the backend treats it.
  const last = lines.pop()
  if (last !== undefined && last.trim() !== '') skippedLines += 1
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      scanner.add(JSON.parse(line))
    } catch {
      skippedLines += 1
    }
  }
  return { ...scanner.result(), skippedLines, truncated: !decoded.complete }
}

/**
 * Pick the log the session backend would read: the highest canonical generation.
 * @param dir - a session directory.
 * @returns the log path, or `undefined` when the directory holds none.
 */
export async function currentGeneration(dir: string): Promise<string | undefined> {
  let best: { version: number; compressed: boolean; name: string } | undefined
  for (const entry of await listDir(dir)) {
    if (!entry.isFile()) continue
    const match = GENERATION.exec(entry.name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    const compressed = match[2] !== undefined
    if (best === undefined || version > best.version || (version === best.version && compressed && !best.compressed)) {
      best = { version, compressed, name: entry.name }
    }
  }
  return best === undefined ? undefined : join(dir, best.name)
}

/** Change token for a file: equal tokens mean an unchanged file. */
export async function fileToken(path: string): Promise<string> {
  const info = await stat(path, { bigint: true })
  return `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`
}

/** Dimensions and format read from an image object's header. */
export interface ImageProbe {
  readonly mediaType: string
  readonly width: number
  readonly height: number
}

/**
 * Read PNG, JPEG, WebP, or GIF dimensions from the first bytes of an image.
 * @param header - leading bytes of the image.
 * @returns the format and size, or `undefined` when the header is not recognized.
 */
export function probeImage(header: Buffer): ImageProbe | undefined {
  const sized = (mediaType: string, width: number, height: number): ImageProbe | undefined =>
    width > 0 && height > 0 ? { mediaType, width, height } : undefined
  if (header.length >= 24 && header.readUInt32BE(0) === 0x89504e47 && header.readUInt32BE(4) === 0x0d0a1a0a) {
    return sized('image/png', header.readUInt32BE(16), header.readUInt32BE(20))
  }
  if (header.length >= 10 && header.toString('latin1', 0, 4) === 'GIF8') {
    return sized('image/gif', header.readUInt16LE(6), header.readUInt16LE(8))
  }
  if (header.length >= 30 && header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = header.toString('latin1', 12, 16)
    if (chunk === 'VP8 ') return sized('image/webp', header.readUInt16LE(26) & 0x3fff, header.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L' && header[20] === 0x2f) {
      const bits = header.readUInt32LE(21)
      return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return sized('image/webp', header.readUIntLE(24, 3) + 1, header.readUIntLE(27, 3) + 1)
    return undefined
  }
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8) {
    let offset = 2
    while (offset + 9 <= header.length) {
      if (header[offset] !== 0xff) return undefined
      const marker = header[offset + 1] as number
      if (marker === 0xff) { offset += 1; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return sized('image/jpeg', header.readUInt16BE(offset + 7), header.readUInt16BE(offset + 5))
      offset += 2 + header.readUInt16BE(offset + 2)
    }
  }
  return undefined
}

/**
 * Read an image file's header and recognize its format and size.
 * @param path - the image file.
 * @returns the probe, or `undefined` when the header is not a supported format.
 */
export async function imageHeader(path: string): Promise<ImageProbe | undefined> {
  return probeImage(await readHead(path))
}

async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, PROBE_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** One object found in the attachment store. */
export interface StoredObject {
  readonly kind: AttachmentKind
  readonly sha256: string
  readonly sizeBytes: number
  /** Modification time of the object, epoch milliseconds: when it was stored. */
  readonly storedAt: number
  /** Display names of a file object's hard links; empty for images. */
  readonly names: readonly string[]
  /** Header facts of an image object, when readable. */
  readonly probe?: ImageProbe
}

/** Cache of image header probes keyed by object path and change token. */
export type ProbeCache = Map<string, { token: string; probe: ImageProbe | undefined }>

async function objectsIn(storeDir: string): Promise<{ sha256: string; path: string }[]> {
  const found: { sha256: string; path: string }[] = []
  for (const prefix of await listDir(storeDir)) {
    if (!prefix.isDirectory() || !PREFIX.test(prefix.name)) continue
    for (const entry of await listDir(join(storeDir, prefix.name))) {
      if (!entry.isFile() || !HEX64.test(entry.name) || !entry.name.startsWith(prefix.name)) continue
      found.push({ sha256: entry.name, path: join(storeDir, prefix.name, entry.name) })
    }
  }
  return found
}

/** Size, store time, and header facts of one image object. */
export interface ImageObjectFacts {
  readonly sizeBytes: number
  readonly storedAt: number
  readonly probe?: ImageProbe
}

/**
 * Stat an image object and read its header, reusing a cached probe while the
 * file is unchanged.
 * @param path - the object path.
 * @param probes - header-probe cache.
 * @returns the facts, or `undefined` when the path is absent or not a plain file.
 */
async function inspectImage(path: string, probes: ProbeCache): Promise<ImageObjectFacts | undefined> {
  let info
  try {
    info = await lstat(path, { bigint: true })
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return undefined
    throw error
  }
  if (!info.isFile()) return undefined
  const token = `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`
  let cached = probes.get(path)
  if (cached?.token !== token) {
    let probe: ImageProbe | undefined
    try {
      probe = probeImage(await readHead(path))
    } catch (error: unknown) {
      if (!isErrno(error, 'ENOENT', 'EACCES', 'EPERM')) throw error
    }
    cached = { token, probe }
    probes.set(path, cached)
  }
  return { sizeBytes: Number(info.size), storedAt: Number(info.mtimeMs), ...cached.probe === undefined ? {} : { probe: cached.probe } }
}

/** Whether `child` is strictly inside `parent` (both absolute). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** A path that exists as a plain file (not a link), below plain directories (not links), inside `root`. */
async function plainFileInside(root: string, path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) return false
    for (let dir = dirname(path); isInside(root, dir); dir = dirname(dir)) {
      if (!(await lstat(dir)).isDirectory()) return false
    }
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)])
    return isInside(realRoot, realPath)
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return false
    throw error
  }
}

/**
 * The file to show in a file manager for one stored attachment, derived from
 * its kind and digest only. An image is its object; a file is its first
 * display-name link (so the file manager shows the real name), or the
 * canonical object when no link exists.
 * @param root - `<DSH_HOME>/attachments/v1`.
 * @param kind - image or file store.
 * @param sha256 - 64 lowercase hex digits.
 * @returns the absolute path of a plain file inside `root`, or `undefined` when none is stored.
 */
export async function revealTarget(root: string, kind: AttachmentKind, sha256: string): Promise<string | undefined> {
  if (!HEX64.test(sha256)) return undefined
  const prefix = sha256.slice(0, 2)
  const candidates: string[] = []
  if (kind === 'image') {
    candidates.push(join(root, 'objects', prefix, sha256))
  } else {
    const aliases = join(root, 'files', prefix, sha256)
    for (const entry of (await listDir(aliases)).filter(item => item.isFile()).map(item => item.name).sort()) candidates.push(join(aliases, entry))
    candidates.push(join(root, 'file-objects', prefix, sha256))
  }
  for (const candidate of candidates) if (await plainFileInside(root, candidate)) return candidate
  return undefined
}

/**
 * List every image and file object under an attachment root. Missing
 * directories count as empty; entries that are not plain files are skipped.
 * @param root - `<DSH_HOME>/attachments/v1`.
 * @param probes - header-probe cache reused across scans.
 * @returns the stored objects.
 */
export async function listStoredObjects(root: string, probes: ProbeCache = new Map()): Promise<StoredObject[]> {
  const objects: StoredObject[] = []
  const seen = new Set<string>()
  for (const { sha256, path } of await objectsIn(join(root, 'objects'))) {
    const image = await inspectImage(path, probes)
    if (image === undefined) continue
    seen.add(path)
    objects.push({
      kind: 'image', sha256, sizeBytes: image.sizeBytes, storedAt: image.storedAt, names: [],
      ...image.probe === undefined ? {} : { probe: image.probe },
    })
  }
  for (const path of [...probes.keys()]) if (!seen.has(path)) probes.delete(path)

  for (const { sha256, path } of await objectsIn(join(root, 'file-objects'))) {
    let info
    try {
      info = await lstat(path)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) continue
      throw error
    }
    if (!info.isFile()) continue
    const names = (await listDir(join(root, 'files', sha256.slice(0, 2), sha256)))
      .filter(entry => entry.isFile()).map(entry => entry.name).sort()
    objects.push({ kind: 'file', sha256, sizeBytes: info.size, storedAt: info.mtimeMs, names })
  }
  return objects
}

/**
 * Total bytes of plain files below a directory (symbolic links are not followed).
 * @param dir - the directory; a missing one counts as 0.
 * @returns byte total.
 */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const entry of await listDir(current)) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        try {
          total += (await lstat(path)).size
        } catch (error: unknown) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
      }
    }
  }
  return total
}

function isSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0')
}

/** One session log held by a trash entry. */
export interface TrashSession {
  readonly sessionId: string
  readonly dir: string
}

/** One readable trash entry. */
export interface TrashEntryFacts {
  readonly entryId: string
  /** The conversation the user moved. */
  readonly sessionId: string
  readonly title: string
  readonly deletedAt: number
  /** The conversation and its subagent sessions. */
  readonly sessions: readonly TrashSession[]
}

/** A conversation archived now and moved into the trash at the next DSH start. */
export interface PendingFacts {
  readonly sessionId: string
  readonly title: string
}

/** Everything read from a trash directory. */
export interface TrashFacts {
  readonly entries: readonly TrashEntryFacts[]
  readonly pending: readonly PendingFacts[]
  /** Entries or records that could not be read, with the reason. */
  readonly problems: readonly { readonly id: string; readonly reason: string }[]
}

function parseManifest(value: unknown, entryId: string, entryDir: string): TrashEntryFacts {
  if (!isRecord(value) || value.version !== 1 || value.entryId !== entryId) throw new Error('unrecognized manifest')
  if (typeof value.sessionId !== 'string' || value.sessionId === '' || typeof value.title !== 'string') throw new Error('manifest lacks the conversation')
  const deletedAt = count(value.deletedAt)
  if (deletedAt === undefined || !Array.isArray(value.sessions)) throw new Error('manifest lacks its sessions')
  const sessions = value.sessions.map((item: unknown): TrashSession => {
    if (!isRecord(item) || typeof item.sessionId !== 'string' || !isSegment(item.project) || !isSegment(item.dirName)) {
      throw new Error('manifest has an invalid session record')
    }
    return { sessionId: item.sessionId, dir: join(entryDir, item.project, item.dirName) }
  })
  return { entryId, sessionId: value.sessionId, title: value.title, deletedAt, sessions }
}

/**
 * Read the trash entries and pending moves of `dsh-plugin-session-trash`.
 * A missing directory is an empty trash.
 * @param trashRoot - the trash directory.
 * @returns entries, pending moves, and unreadable items.
 */
export async function readTrash(trashRoot: string): Promise<TrashFacts> {
  const entries: TrashEntryFacts[] = []
  const pending: PendingFacts[] = []
  const problems: { id: string; reason: string }[] = []
  for (const item of await listDir(trashRoot)) {
    const pendingId = PENDING_FILE.exec(item.name)?.[1]
    try {
      if (pendingId !== undefined && item.isFile()) {
        const record: unknown = JSON.parse(await readFile(join(trashRoot, item.name), 'utf8'))
        if (!isRecord(record) || typeof record.sessionId !== 'string' || typeof record.title !== 'string') throw new Error('unrecognized pending move')
        pending.push({ sessionId: record.sessionId, title: record.title })
      } else if (UUID.test(item.name) && item.isDirectory()) {
        const dir = join(trashRoot, item.name)
        entries.push(parseManifest(JSON.parse(await readFile(join(dir, 'entry.json'), 'utf8')), item.name, dir))
      }
    } catch (error: unknown) {
      problems.push({ id: pendingId ?? item.name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { entries, pending, problems }
}

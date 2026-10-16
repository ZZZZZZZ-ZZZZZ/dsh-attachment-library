/**
 * Wire protocol shared by the Host service and the browser half: result
 * types, the `attachmentLibrary` Typert invocation descriptor with a strict
 * codec, and the Remote failure codes. Everything here is plain data and
 * validation; it imports no Node or browser API, so both builds include it.
 * Calls travel the Connection's authenticated `/api` route.
 */

import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

/** Typert namespace and Cordis service key of the library service. */
export const ATTACHMENT_LIBRARY_NAMESPACE = 'attachmentLibrary'

/** npm package that owns the Remote methods. */
export const ATTACHMENT_LIBRARY_PACKAGE = 'dsh-plugin-attachment-library'

/** Where a referencing conversation is. */
export type ConversationStatus =
  /** Listed in the sidebar. */
  | 'normal'
  /** Archived (hidden from the sidebar, files in place). */
  | 'archived'
  /** Archived and waiting for the next DSH start to move into the trash. */
  | 'pending-trash'
  /** In the session trash. */
  | 'trash'

/** Which conversations reference an attachment. */
export type AttachmentUsage =
  /** At least one conversation outside the trash (including archived and pending moves). */
  | 'active'
  /** Only conversations in the trash. */
  | 'trash-only'
  /** No conversation. */
  | 'unreferenced'

/** One conversation that references an attachment. Subagent sessions count as their conversation. */
export interface ReferenceView {
  readonly sessionId: string
  /** Display title; absent when the conversation has none yet. */
  readonly title?: string
  readonly status: ConversationStatus
  /** Move time of a conversation in the trash, epoch milliseconds. */
  readonly deletedAt?: number
}

/** One stored (or referenced but missing) attachment. */
export interface AttachmentView {
  readonly kind: 'image' | 'file'
  /** `sha256:<hex>`, the content digest. */
  readonly attachmentId: string
  /** Display names from references and stored file links, sorted. */
  readonly names: readonly string[]
  /** Stored bytes; for a missing object, the bytes its references state (0 when unknown). */
  readonly sizeBytes: number
  /** When the object was stored, epoch milliseconds; absent for a missing object. */
  readonly storedAt?: number
  readonly mediaType?: string
  readonly width?: number
  readonly height?: number
  /** Referenced by a session log but absent from the attachment store. */
  readonly missing: boolean
  readonly usage: AttachmentUsage
  readonly references: readonly ReferenceView[]
}

/** A count of stored objects and their bytes. */
export interface Bucket {
  readonly count: number
  readonly bytes: number
}

/** Totals over stored objects. Missing objects are counted only in `missing`. */
export interface LibrarySummary {
  readonly total: Bucket
  readonly images: Bucket
  readonly files: Bucket
  readonly active: Bucket
  readonly trashOnly: Bucket
  readonly unreferenced: Bucket
  /** Attachments referenced by a log but absent from the store. */
  readonly missing: number
  /** Bytes of the regenerable request-image cache. */
  readonly requestCacheBytes: number
  /** Session logs scanned: listed by the session backend, and held in the trash. */
  readonly liveSessions: number
  readonly trashSessions: number
}

/** A session or trash item whose references could not be read in full. */
export interface ScanProblem {
  /** Session id or trash item id. */
  readonly id: string
  readonly where: 'live' | 'trash'
  readonly reason: string
}

/** One library scan. */
export interface LibraryResult {
  readonly summary: LibrarySummary
  readonly attachments: readonly AttachmentView[]
  /**
   * Logs that could not be read in full. While any exist, an attachment shown
   * as unreferenced may still be referenced by one of them.
   */
  readonly problems: readonly ScanProblem[]
  /** Scan completion time, epoch milliseconds. */
  readonly scannedAt: number
  /** Logs read in this scan; the rest came from the cache because they had not changed. */
  readonly reread: { readonly live: number; readonly trash: number }
}

/** Show one stored attachment in the Host's file manager. The Host derives the path; none is sent. */
export interface RevealRequest {
  /** Images and files are separate stores, so the same digest may name one of each. */
  readonly kind: 'image' | 'file'
  /** `sha256:<hex>` of the stored attachment. */
  readonly attachmentId: string
}

/** Acknowledgement after the file manager accepted the reveal. */
export interface RevealResult {
  readonly revealed: true
}

/** Open one stored image in Preview (macOS). The Host derives the image; no path is sent. */
export interface PreviewRequest {
  /** `sha256:<hex>` of a stored image. */
  readonly attachmentId: string
}

/** Acknowledgement after Preview accepted the image. */
export interface PreviewResult {
  readonly opened: true
}

/** Desktop actions this Host offers. */
export interface RevealAvailability {
  /** Show files in a desktop file manager. */
  readonly available: boolean
  /** Open images in Preview: a macOS Host with Finder. */
  readonly preview: boolean
}

/** Remote failure codes thrown by the service. */
export type AttachmentLibraryErrorCode =
  | 'attachment-library/scan-failed'
  | 'attachment-library/not-found'
  | 'attachment-library/unavailable'
  | 'attachment-library/reveal-failed'
  | 'attachment-library/open-failed'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The scan stopped on an unexpected filesystem or backend error; nothing was changed. */
    'attachment-library/scan-failed': { readonly reason: string }
    /** No stored attachment of that kind has this id as a plain file inside the attachment store. */
    'attachment-library/not-found': { readonly attachmentId: string }
    /** This Host has no desktop file manager to show files in. */
    'attachment-library/unavailable': { readonly reason: string }
    /** The file manager refused or failed; nothing was changed. */
    'attachment-library/reveal-failed': { readonly attachmentId: string; readonly reason: string }
    /** Preview could not open the image; the stored object was not touched. */
    'attachment-library/open-failed': { readonly attachmentId: string; readonly reason: string }
  }
}

function strict<T>(typeSymbol: string, parse: (value: unknown) => T): TypertCodec {
  const schema: TypertSchema<T> = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], what: string): void {
  for (const key of required) if (!(key in value)) throw new TypeError(`${what}.${key} is required`)
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`${what}.${key} is not allowed`)
  }
}

function text(value: unknown, what: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new TypeError(`${what} must be a string of at most ${String(maxLength)} characters`)
  }
  return value
}

function integer(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${what} must be a non-negative integer`)
  return value
}

function time(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${what} must be a non-negative number`)
  return value
}

function array<T>(value: unknown, what: string, parse: (item: unknown, label: string) => T): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`)
  return value.map((item, index) => parse(item, `${what}[${String(index)}]`))
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new TypeError(`${what} must be one of ${allowed.join(', ')}`)
  return value as T
}

const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/
const STATUSES: readonly ConversationStatus[] = ['normal', 'archived', 'pending-trash', 'trash']
const USAGES: readonly AttachmentUsage[] = ['active', 'trash-only', 'unreferenced']

function parseReference(value: unknown, what: string): ReferenceView {
  const body = record(value, what)
  exactKeys(body, ['sessionId', 'status'], ['title', 'deletedAt'], what)
  return {
    sessionId: text(body.sessionId, `${what}.sessionId`, 512),
    ...body.title === undefined ? {} : { title: text(body.title, `${what}.title`, 1000) },
    status: oneOf(body.status, STATUSES, `${what}.status`),
    ...body.deletedAt === undefined ? {} : { deletedAt: time(body.deletedAt, `${what}.deletedAt`) },
  }
}

function parseAttachment(value: unknown, what: string): AttachmentView {
  const body = record(value, what)
  exactKeys(body, ['kind', 'attachmentId', 'names', 'sizeBytes', 'missing', 'usage', 'references'], ['storedAt', 'mediaType', 'width', 'height'], what)
  if (typeof body.attachmentId !== 'string' || !ATTACHMENT_ID.test(body.attachmentId)) throw new TypeError(`${what}.attachmentId must be a sha256 id`)
  if (typeof body.missing !== 'boolean') throw new TypeError(`${what}.missing must be a boolean`)
  return {
    kind: oneOf(body.kind, ['image', 'file'] as const, `${what}.kind`),
    attachmentId: body.attachmentId,
    names: array(body.names, `${what}.names`, (item, label) => text(item, label, 1000)),
    sizeBytes: integer(body.sizeBytes, `${what}.sizeBytes`),
    ...body.storedAt === undefined ? {} : { storedAt: time(body.storedAt, `${what}.storedAt`) },
    ...body.mediaType === undefined ? {} : { mediaType: text(body.mediaType, `${what}.mediaType`, 100) },
    ...body.width === undefined ? {} : { width: integer(body.width, `${what}.width`) },
    ...body.height === undefined ? {} : { height: integer(body.height, `${what}.height`) },
    missing: body.missing,
    usage: oneOf(body.usage, USAGES, `${what}.usage`),
    references: array(body.references, `${what}.references`, parseReference),
  }
}

function parseBucket(value: unknown, what: string): Bucket {
  const body = record(value, what)
  exactKeys(body, ['count', 'bytes'], [], what)
  return { count: integer(body.count, `${what}.count`), bytes: integer(body.bytes, `${what}.bytes`) }
}

function parseSummary(value: unknown): LibrarySummary {
  const body = record(value, 'summary')
  const buckets = ['total', 'images', 'files', 'active', 'trashOnly', 'unreferenced'] as const
  const numbers = ['missing', 'requestCacheBytes', 'liveSessions', 'trashSessions'] as const
  exactKeys(body, [...buckets, ...numbers], [], 'summary')
  return {
    total: parseBucket(body.total, 'summary.total'),
    images: parseBucket(body.images, 'summary.images'),
    files: parseBucket(body.files, 'summary.files'),
    active: parseBucket(body.active, 'summary.active'),
    trashOnly: parseBucket(body.trashOnly, 'summary.trashOnly'),
    unreferenced: parseBucket(body.unreferenced, 'summary.unreferenced'),
    missing: integer(body.missing, 'summary.missing'),
    requestCacheBytes: integer(body.requestCacheBytes, 'summary.requestCacheBytes'),
    liveSessions: integer(body.liveSessions, 'summary.liveSessions'),
    trashSessions: integer(body.trashSessions, 'summary.trashSessions'),
  }
}

function parseProblem(value: unknown, what: string): ScanProblem {
  const body = record(value, what)
  exactKeys(body, ['id', 'where', 'reason'], [], what)
  return {
    id: text(body.id, `${what}.id`, 512),
    where: oneOf(body.where, ['live', 'trash'] as const, `${what}.where`),
    reason: text(body.reason, `${what}.reason`, 4000, true),
  }
}

/**
 * Validate a scan result from the wire.
 * @param value - untrusted value.
 * @returns the result.
 */
export function parseLibraryResult(value: unknown): LibraryResult {
  const body = record(value, 'result')
  exactKeys(body, ['summary', 'attachments', 'problems', 'scannedAt', 'reread'], [], 'result')
  const reread = record(body.reread, 'result.reread')
  exactKeys(reread, ['live', 'trash'], [], 'result.reread')
  return {
    summary: parseSummary(body.summary),
    attachments: array(body.attachments, 'result.attachments', parseAttachment),
    problems: array(body.problems, 'result.problems', parseProblem),
    scannedAt: time(body.scannedAt, 'result.scannedAt'),
    reread: { live: integer(reread.live, 'result.reread.live'), trash: integer(reread.trash, 'result.reread.trash') },
  }
}

/**
 * Validate an attachment id: exactly `sha256:` and 64 lowercase hex digits,
 * so it can never name a path.
 * @param value - untrusted value.
 * @returns the id.
 */
export function parseAttachmentId(value: unknown): string {
  if (typeof value !== 'string' || !ATTACHMENT_ID.test(value)) throw new TypeError('attachmentId must be "sha256:" followed by 64 lowercase hex digits')
  return value
}

function parseRevealRequest(value: unknown): RevealRequest {
  const body = record(value, 'request')
  exactKeys(body, ['kind', 'attachmentId'], [], 'request')
  return { kind: oneOf(body.kind, ['image', 'file'] as const, 'request.kind'), attachmentId: parseAttachmentId(body.attachmentId) }
}

function parseRevealResult(value: unknown): RevealResult {
  const body = record(value, 'result')
  exactKeys(body, ['revealed'], [], 'result')
  if (body.revealed !== true) throw new TypeError('result.revealed must be true')
  return { revealed: true }
}

function parseRevealAvailability(value: unknown): RevealAvailability {
  const body = record(value, 'result')
  exactKeys(body, ['available', 'preview'], [], 'result')
  if (typeof body.available !== 'boolean' || typeof body.preview !== 'boolean') throw new TypeError('result.available and result.preview must be booleans')
  return { available: body.available, preview: body.preview }
}

function parsePreviewRequest(value: unknown): PreviewRequest {
  const body = record(value, 'request')
  exactKeys(body, ['attachmentId'], [], 'request')
  return { attachmentId: parseAttachmentId(body.attachmentId) }
}

function parsePreviewResult(value: unknown): PreviewResult {
  const body = record(value, 'result')
  exactKeys(body, ['opened'], [], 'result')
  if (body.opened !== true) throw new TypeError('result.opened must be true')
  return { opened: true }
}

const T = `${ATTACHMENT_LIBRARY_PACKAGE}/types`

function descriptor(
  method: string, parameters: readonly { name: string; codec: TypertCodec }[], result: TypertCodec, cancellable = false,
): InvocationDescriptor {
  return {
    id: `${ATTACHMENT_LIBRARY_PACKAGE}#${ATTACHMENT_LIBRARY_NAMESPACE}/${method}`,
    service: ATTACHMENT_LIBRARY_NAMESPACE,
    namespace: ATTACHMENT_LIBRARY_NAMESPACE,
    method,
    invocation: { kind: 'direct' as const },
    parameters: parameters.map(parameter => ({
      name: parameter.name, wire: parameter.name, source: 'json' as const, codec: parameter.codec,
    })),
    ...cancellable ? { cancellation: { parameter: 'signal' as const } } : {},
    result,
    sourceLocation: { file: `${ATTACHMENT_LIBRARY_PACKAGE}/lib/index.js`, line: 1, column: 1 },
  }
}

/** The Remote methods, in one list shared by the Host registration and the Client mount. */
export const ATTACHMENT_LIBRARY_DESCRIPTORS: readonly InvocationDescriptor[] = [
  descriptor('scan', [], strict(`${T}#LibraryResult`, parseLibraryResult)),
  descriptor('revealAvailability', [], strict(`${T}#RevealAvailability`, parseRevealAvailability)),
  descriptor(
    'reveal',
    [{ name: 'request', codec: strict(`${T}#RevealRequest`, parseRevealRequest) }],
    strict(`${T}#RevealResult`, parseRevealResult),
    true,
  ),
  descriptor(
    'openInPreview',
    [{ name: 'request', codec: strict(`${T}#PreviewRequest`, parsePreviewRequest) }],
    strict(`${T}#PreviewResult`, parsePreviewResult),
    true,
  ),
]

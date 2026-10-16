/**
 * Host half of `dsh-plugin-attachment-library`: the read-only
 * `attachmentLibrary` service and its `scan` Remote method. A scan lists the
 * attachment store, reads every session log the session backend lists (through
 * read handles) and every log held by the session trash (directly from disk),
 * and reports which conversations reference each stored attachment. Logs whose
 * revision or file is unchanged since the previous scan are not read again.
 * `reveal` shows one stored attachment in the Host's file manager through
 * DSH's own `revealNativePath` (Finder `open -R`, Explorer `/select`), with
 * the path derived from the attachment id on the Host. `openInPreview` opens
 * a read-only copy of a stored image in macOS Preview (see `preview.ts`;
 * that private temporary copy is the plugin's only write). DSH data is never
 * written, moved, opened, or deleted. See `library.ts` for the on-disk layouts.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshCachePath, dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { canOpenNativePath, nativeFileApplications, nativeFileManager, openNativeFileApplication, revealNativePath } from '@deepseek-ai/dsh-native-command'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { buildCatalog, type ConversationRef, type ScannedLog } from './catalog.ts'
import { PreviewCopies } from './preview.ts'
import {
  currentGeneration, directoryBytes, fileToken, imageHeader, listStoredObjects, revealTarget, readTrash, scanEvents, scanLogFile,
  type LogFacts, type ProbeCache,
} from './library.ts'
import {
  ATTACHMENT_LIBRARY_DESCRIPTORS, ATTACHMENT_LIBRARY_NAMESPACE, ATTACHMENT_LIBRARY_PACKAGE,
  parseAttachmentId, type ConversationStatus, type LibraryResult, type PreviewRequest, type PreviewResult,
  type RevealAvailability, type RevealRequest, type RevealResult,
  type ScanProblem,
} from './protocol.ts'

export type * from './protocol.ts'
export { buildCatalog } from './catalog.ts'
export { listStoredObjects, probeImage, readTrash, scanEvents, scanLogFile } from './library.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachmentLibrary: AttachmentLibrary
  }
}

/** Plugin configuration. Every DSH directory is only read. */
export interface Config {
  /** Attachment store root. Defaults to `<DSH home>/attachments/v1`. */
  attachmentDirectory?: string
  /** Session trash of `dsh-plugin-session-trash`. Defaults to `<DSH home>/session-trash`. */
  trashDirectory?: string
  /** Regenerable request-image cache, measured for the summary. Defaults to `<DSH home>/cache/attachments/request-images`. */
  requestCacheDirectory?: string
  /** Where the private temporary directory for Preview copies is created. Defaults to the system temporary directory. */
  previewDirectory?: string
}

/** Session logs read at the same time. */
const READ_CONCURRENCY = 4
/** Problems reported per scan; the rest are counted in the last one. */
const MAX_PROBLEMS = 100
/** Longest wait for the file manager to accept a reveal when the caller passes no signal. */
const REVEAL_TIMEOUT_MS = 15_000

interface LiveCacheEntry {
  readonly revision: SessionPersistenceRevision
  readonly facts: LogFacts
}

interface TrashCacheEntry {
  readonly token: string
  readonly facts: LogFacts
  readonly problem?: string
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * The conversation each session belongs to: subagent sessions climb their
 * `parentSession` chain to the conversation that started them. Forks are
 * conversations of their own.
 * @param headers - every listed session header.
 * @returns conversation id per session id.
 */
export function conversationRoots(headers: readonly SessionHeader[]): Map<string, string> {
  const byId = new Map(headers.map(header => [String(header.id), header]))
  const roots = new Map<string, string>()
  for (const header of headers) {
    let current = header
    const visited = new Set<string>([String(current.id)])
    while (current.origin === 'subagent' && current.parentSession !== undefined) {
      const parent = byId.get(String(current.parentSession))
      if (parent === undefined || visited.has(String(parent.id))) break
      visited.add(String(parent.id))
      current = parent
    }
    roots.set(String(header.id), String(current.id))
  }
  return roots
}

/**
 * The attachment library service (`ctx.attachmentLibrary`). Scans run one at a
 * time; a call made while a scan runs receives that scan's result.
 */
export class AttachmentLibrary extends TypertRemoteService {
  static inject = ['sessionPersistence', 'workspaceRegistry', 'typert']

  static Config: z<Config> = z.object({
    attachmentDirectory: z.string().description('Attachment store root; default `<DSH home>/attachments/v1`.'),
    trashDirectory: z.string().description('Session trash directory; default `<DSH home>/session-trash`.'),
    requestCacheDirectory: z.string().description('Request-image cache; default `<DSH home>/cache/attachments/request-images`.'),
    previewDirectory: z.string().description('Parent of the private temporary directory holding Preview copies; default the system temporary directory.'),
  })

  private readonly attachmentDirectory: string
  private readonly trashDirectory: string
  private readonly requestCacheDirectory: string
  private readonly liveCache = new Map<string, LiveCacheEntry>()
  private liveCacheOwner: symbol | undefined
  private readonly trashCache = new Map<string, TrashCacheEntry>()
  private readonly probes: ProbeCache = new Map()
  private running: Promise<LibraryResult> | undefined
  private readonly previews: PreviewCopies

  /**
   * @param ctx - Host context with session persistence, the Workspace registry, and the Typert registry.
   * @param config - plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, ATTACHMENT_LIBRARY_NAMESPACE)
    this.attachmentDirectory = config.attachmentDirectory ?? dshHomePath('attachments', 'v1')
    this.trashDirectory = config.trashDirectory ?? dshHomePath('session-trash')
    this.requestCacheDirectory = config.requestCacheDirectory ?? dshCachePath('attachments', 'request-images')
    this.previews = new PreviewCopies(config.previewDirectory ?? tmpdir())
  }

  protected [Service.init](): void {
    const dispose = this.ctx.typert.register({
      package: ATTACHMENT_LIBRARY_PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: ATTACHMENT_LIBRARY_DESCRIPTORS,
    })
    this.ctx.effect(() => dispose, 'attachment-library: Remote methods')
    this.ctx.effect(() => () => {
      this.previews.dispose().catch((error: unknown) => {
        this.ctx.logger.warn(`attachment-library: removing Preview copies failed: ${String(error)}`)
      })
    }, 'attachment-library: Preview copies')
  }

  /**
   * Scan the attachment store and every session log, reusing the facts of
   * logs that have not changed since the previous scan.
   * @returns the library rows, totals, and logs that could not be read.
   */
  scan(): Promise<LibraryResult> {
    this.running ??= this.runScan().finally(() => { this.running = undefined })
    return this.running
  }

  /**
   * Whether this Host can show files in a desktop file manager (Finder,
   * Explorer, or a Linux desktop's default file manager), by the same checks
   * DSH uses for its own "reveal" actions.
   * @returns availability.
   */
  revealAvailability(): RevealAvailability {
    const available = nativeFileManager() !== null && canOpenNativePath()
    return { available, preview: available && nativeFileManager() === 'finder' }
  }

  /**
   * Open one stored image in macOS Preview. The image is derived from the id
   * only and must be a plain file in the image store; Preview receives a
   * read-only copy with the right extension (DSH's object has none), opened
   * through DSH's `openNativeFileApplication` (`open -a <Preview.app> <copy>`,
   * no shell) after DSH confirms Preview is registered for the copy.
   * @param request - the image id.
   * @param signal - caller lifetime; abort stops the native commands.
   * @returns acknowledgement once Preview accepted the image.
   */
  async openInPreview(request: PreviewRequest, signal: AbortSignal = AbortSignal.timeout(REVEAL_TIMEOUT_MS)): Promise<PreviewResult> {
    const attachmentId = parseAttachmentId(request.attachmentId)
    const sha256 = attachmentId.slice('sha256:'.length)
    if (!this.revealAvailability().preview) {
      throw new RemoteError('attachment-library/unavailable', 'Preview is available only on a macOS Host', { reason: 'Preview is available only on a macOS Host' })
    }
    const failed = (error: unknown): RemoteError =>
      new RemoteError('attachment-library/open-failed', message(error), { attachmentId, reason: message(error) }, { cause: error })
    let source: string | undefined
    try {
      source = await revealTarget(this.attachmentDirectory, 'image', sha256)
    } catch (error: unknown) {
      throw failed(error)
    }
    if (source === undefined) throw new RemoteError('attachment-library/not-found', `no stored image "${attachmentId}"`, { attachmentId })
    try {
      const probe = await imageHeader(source)
      if (probe === undefined) throw new Error('unrecognized image format')
      const copy = await this.previews.copy(source, sha256, probe.mediaType)
      const preview = (await nativeFileApplications(copy, signal)).find(app => /\/Preview\.app\/?$/.test(app.id))
      if (preview === undefined) throw new Error('Preview is not registered for this image')
      await openNativeFileApplication(copy, preview.id, signal)
    } catch (error: unknown) {
      throw failed(error)
    }
    return { opened: true }
  }

  /**
   * Show one stored attachment in the Host's file manager. The path is derived
   * from the kind and digest only: an image's object, or a file's first
   * display-name link. It must be a plain file (not a link) inside the
   * attachment store. The file is selected, never opened or executed.
   * @param request - kind and attachment id.
   * @param signal - caller lifetime; abort stops the file-manager command.
   * @returns acknowledgement once the file manager accepted the request.
   */
  async reveal(request: RevealRequest, signal: AbortSignal = AbortSignal.timeout(REVEAL_TIMEOUT_MS)): Promise<RevealResult> {
    const attachmentId = parseAttachmentId(request.attachmentId)
    if (!this.revealAvailability().available) {
      throw new RemoteError('attachment-library/unavailable', 'this Host has no desktop file manager', { reason: 'this Host has no desktop file manager' })
    }
    let path: string | undefined
    try {
      path = await revealTarget(this.attachmentDirectory, request.kind, attachmentId.slice('sha256:'.length))
    } catch (error: unknown) {
      throw new RemoteError('attachment-library/reveal-failed', message(error), { attachmentId, reason: message(error) }, { cause: error })
    }
    if (path === undefined) throw new RemoteError('attachment-library/not-found', `no stored ${request.kind} "${attachmentId}"`, { attachmentId })
    try {
      await revealNativePath(path, signal)
    } catch (error: unknown) {
      throw new RemoteError('attachment-library/reveal-failed', message(error), { attachmentId, reason: message(error) }, { cause: error })
    }
    return { revealed: true }
  }

  private async runScan(): Promise<LibraryResult> {
    try {
      return await this.collect()
    } catch (error: unknown) {
      throw new RemoteError('attachment-library/scan-failed', message(error), { reason: message(error) }, { cause: error })
    }
  }

  private async collect(): Promise<LibraryResult> {
    const problems: ScanProblem[] = []
    const logs: ScannedLog[] = []
    const reread = { live: 0, trash: 0 }

    const trash = await readTrash(this.trashDirectory)
    for (const problem of trash.problems) problems.push({ id: problem.id, where: 'trash', reason: problem.reason })
    const pendingTitles = new Map(trash.pending.map(record => [record.sessionId, record.title]))

    // Live sessions: the backend's revision says whether the cached facts still hold.
    const persistence = this.ctx.sessionPersistence
    if (this.liveCacheOwner !== persistence.identity) {
      this.liveCache.clear()
      this.liveCacheOwner = persistence.identity
    }
    const snapshots = await persistence.list()
    const listed = new Set(snapshots.map(snapshot => String(snapshot.header.id)))
    for (const id of [...this.liveCache.keys()]) if (!listed.has(id)) this.liveCache.delete(id)
    const facts = new Map<string, LogFacts>()
    await eachLimited(snapshots, READ_CONCURRENCY, async (snapshot) => {
      const id = String(snapshot.header.id)
      const cached = this.liveCache.get(id)
      if (cached?.revision === snapshot.revision) {
        facts.set(id, cached.facts)
        return
      }
      reread.live += 1
      try {
        const read = await this.readLive(snapshot.header.id)
        this.liveCache.set(id, { revision: snapshot.revision, facts: read })
        facts.set(id, read)
      } catch (error: unknown) {
        this.liveCache.delete(id)
        problems.push({ id, where: 'live', reason: message(error) })
      }
    })
    const roots = conversationRoots(snapshots.map(snapshot => snapshot.header))
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(String))
    const liveConversation = (rootId: string): ConversationRef => {
      const pendingTitle = pendingTitles.get(rootId)
      const status: ConversationStatus = pendingTitle !== undefined ? 'pending-trash' : archived.has(rootId) ? 'archived' : 'normal'
      const title = facts.get(rootId)?.title ?? pendingTitle
      return { key: `live:${rootId}`, view: { sessionId: rootId, ...title === undefined ? {} : { title }, status } }
    }
    for (const [id, read] of facts) {
      logs.push({ conversation: liveConversation(roots.get(id) ?? id), refs: read.refs })
    }

    // Trash: logs are read from disk; an unchanged file keeps its cached facts.
    const trashLogs: { conversation: ConversationRef; sessionId: string; dir: string }[] = []
    for (const entry of trash.entries) {
      const conversation: ConversationRef = {
        key: `trash:${entry.entryId}`,
        view: { sessionId: entry.sessionId, ...entry.title === '' ? {} : { title: entry.title }, status: 'trash', deletedAt: entry.deletedAt },
      }
      for (const session of entry.sessions) trashLogs.push({ conversation, sessionId: session.sessionId, dir: session.dir })
    }
    const seenFiles = new Set<string>()
    await eachLimited(trashLogs, READ_CONCURRENCY, async ({ conversation, sessionId, dir }) => {
      try {
        const info = await lstat(dir)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`"${dir}" is not a plain directory`)
        const path = await currentGeneration(dir)
        if (path === undefined) throw new Error(`no session log in "${dir}"`)
        seenFiles.add(path)
        const token = await fileToken(path)
        let cached = this.trashCache.get(path)
        if (cached?.token !== token) {
          reread.trash += 1
          const read = await scanLogFile(path)
          const incomplete = read.truncated || read.skippedLines > 0
          cached = {
            token, facts: read,
            ...incomplete ? { problem: `log is incomplete (${read.truncated ? 'damaged compressed frame' : `${String(read.skippedLines)} unreadable line(s)`})` } : {},
          }
          this.trashCache.set(path, cached)
        }
        if (cached.problem !== undefined) problems.push({ id: sessionId, where: 'trash', reason: cached.problem })
        logs.push({ conversation, refs: cached.facts.refs })
      } catch (error: unknown) {
        problems.push({ id: sessionId, where: 'trash', reason: message(error) })
      }
    })
    for (const path of [...this.trashCache.keys()]) if (!seenFiles.has(path)) this.trashCache.delete(path)

    const objects = await listStoredObjects(this.attachmentDirectory, this.probes)
    const catalog = buildCatalog(objects, logs)
    const requestCacheBytes = await directoryBytes(this.requestCacheDirectory)
    const reported = problems.length > MAX_PROBLEMS
      ? [...problems.slice(0, MAX_PROBLEMS - 1), { id: 'more', where: 'live' as const, reason: `${String(problems.length - MAX_PROBLEMS + 1)} more` }]
      : problems
    return {
      summary: {
        total: catalog.total,
        images: catalog.images,
        files: catalog.files,
        active: catalog.active,
        trashOnly: catalog.trashOnly,
        unreferenced: catalog.unreferenced,
        missing: catalog.missing,
        requestCacheBytes,
        liveSessions: snapshots.length,
        trashSessions: trashLogs.length,
      },
      attachments: catalog.attachments,
      problems: reported,
      scannedAt: Date.now(),
      reread,
    }
  }

  private async readLive(id: SessionId): Promise<LogFacts> {
    const handle = await this.ctx.sessionPersistence.open(id, 'read')
    try {
      return scanEvents((await handle.read()).events)
    } finally {
      await handle.close()
    }
  }
}

export default AttachmentLibrary

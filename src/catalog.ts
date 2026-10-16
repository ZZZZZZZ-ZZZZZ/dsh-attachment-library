/**
 * Joins the stored objects with the references found in session logs. Pure:
 * no filesystem access.
 */

import type { AttachmentUsage, AttachmentView, Bucket, ReferenceView } from './protocol.ts'
import { attachmentKey, type ReferenceFact, type StoredObject } from './library.ts'

/** The conversation a scanned session log belongs to. */
export interface ConversationRef {
  /** Distinguishes a conversation in the trash from a live one with the same id. */
  readonly key: string
  readonly view: ReferenceView
}

/** References of one scanned session log, attributed to its conversation. */
export interface ScannedLog {
  readonly conversation: ConversationRef
  readonly refs: readonly ReferenceFact[]
}

/** Library rows and totals over stored objects. */
export interface Catalog {
  readonly attachments: AttachmentView[]
  readonly total: Bucket
  readonly images: Bucket
  readonly files: Bucket
  readonly active: Bucket
  readonly trashOnly: Bucket
  readonly unreferenced: Bucket
  readonly missing: number
}

interface Row {
  readonly kind: 'image' | 'file'
  readonly sha256: string
  stored?: StoredObject
  readonly names: Set<string>
  readonly refs: Map<string, ReferenceView>
  first?: ReferenceFact
}

const STATUS_ORDER: Record<ReferenceView['status'], number> = { normal: 0, archived: 1, 'pending-trash': 2, trash: 3 }

function usageOf(references: readonly ReferenceView[]): AttachmentUsage {
  if (references.length === 0) return 'unreferenced'
  return references.some(reference => reference.status !== 'trash') ? 'active' : 'trash-only'
}

function add(bucket: { count: number; bytes: number }, bytes: number): void {
  bucket.count += 1
  bucket.bytes += bytes
}

/**
 * Build the library rows: every stored object, plus every referenced
 * attachment the store lacks. A conversation appears once per attachment
 * even when several of its sessions (subagents, forks) reference it.
 * @param objects - stored image and file objects.
 * @param logs - references of each scanned session log.
 * @returns rows (newest first) and totals.
 */
export function buildCatalog(objects: readonly StoredObject[], logs: readonly ScannedLog[]): Catalog {
  const rows = new Map<string, Row>()
  const row = (kind: 'image' | 'file', sha256: string): Row => {
    const key = attachmentKey(kind, sha256)
    let found = rows.get(key)
    if (found === undefined) {
      found = { kind, sha256, names: new Set(), refs: new Map() }
      rows.set(key, found)
    }
    return found
  }
  for (const object of objects) {
    const target = row(object.kind, object.sha256)
    target.stored = object
    for (const name of object.names) target.names.add(name)
  }
  for (const log of logs) {
    for (const ref of log.refs) {
      const target = row(ref.kind, ref.sha256)
      target.first ??= ref
      if (ref.name !== undefined) target.names.add(ref.name)
      if (!target.refs.has(log.conversation.key)) target.refs.set(log.conversation.key, log.conversation.view)
    }
  }

  const totals = {
    total: { count: 0, bytes: 0 }, images: { count: 0, bytes: 0 }, files: { count: 0, bytes: 0 },
    active: { count: 0, bytes: 0 }, trashOnly: { count: 0, bytes: 0 }, unreferenced: { count: 0, bytes: 0 },
  }
  let missing = 0
  const attachments: AttachmentView[] = []
  for (const item of rows.values()) {
    const references = [...item.refs.values()].sort((left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || (left.title ?? '').localeCompare(right.title ?? ''))
    const usage = usageOf(references)
    const stored = item.stored
    const size = stored?.sizeBytes ?? item.first?.bytes ?? 0
    if (stored === undefined) {
      missing += 1
    } else {
      add(totals.total, size)
      add(item.kind === 'image' ? totals.images : totals.files, size)
      add(usage === 'active' ? totals.active : usage === 'trash-only' ? totals.trashOnly : totals.unreferenced, size)
    }
    const mediaType = item.first?.mediaType ?? stored?.probe?.mediaType
    const width = item.first?.width ?? stored?.probe?.width
    const height = item.first?.height ?? stored?.probe?.height
    attachments.push({
      kind: item.kind,
      attachmentId: `sha256:${item.sha256}`,
      names: [...item.names].sort(),
      sizeBytes: size,
      ...stored === undefined ? {} : { storedAt: Math.floor(stored.storedAt) },
      ...item.kind === 'image' && mediaType !== undefined ? { mediaType } : {},
      ...item.kind === 'image' && width !== undefined && height !== undefined ? { width, height } : {},
      missing: stored === undefined,
      usage,
      references,
    })
  }
  attachments.sort((left, right) => (right.storedAt ?? 0) - (left.storedAt ?? 0) || left.attachmentId.localeCompare(right.attachmentId))
  return { attachments, ...totals, missing }
}

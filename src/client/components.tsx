/**
 * The Attachment library settings page: totals, a warning when some session
 * logs could not be read, filters, sorting, and the attachment list with the
 * conversations that reference each attachment. Each stored attachment can
 * be shown in the Host's file manager, and each stored image opened in
 * Preview, when the Host desktop allows it.
 * Read-only: the page offers no action that changes a file.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button, FileTypeIcon, IconFolderOpenOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular, Pill, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AttachmentView, Bucket, ConversationStatus, LibraryResult, PreviewRequest, ReferenceView, RevealRequest } from '../protocol.ts'
import { formatBytes, type Translate } from './api.ts'
import type { AttachmentLibraryKey } from './locales.ts'

/** Type filter. */
export type KindFilter = 'all' | 'image' | 'file'
/** Reference filter. */
export type UsageFilter = 'all' | 'active' | 'trash-only' | 'unreferenced'
/** Sort order; both put the largest or newest first. */
export type SortOrder = 'time' | 'size'

/** Rows shown before "Show more". */
export const PAGE_SIZE = 100

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  muted: { margin: '4px 0 0', fontSize: 13, opacity: 0.7, lineHeight: 1.5 },
  small: { margin: 0, fontSize: 12, opacity: 0.65, lineHeight: 1.5 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, margin: 0 },
  stat: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 10,
    border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.25))',
  },
  statLabel: { fontSize: 12, opacity: 0.7, margin: 0 },
  statValue: { fontSize: 14, fontWeight: 600, margin: 0 },
  warning: {
    display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
    border: '1px solid var(--dsw-alias-border-warning, rgba(212,136,6,0.45))',
  },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  group: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  groupLabel: { fontSize: 12, opacity: 0.7, marginRight: 4 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10,
    border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.25))',
  },
  rowBody: { display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 },
  rowText: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 },
  typeIcon: { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  rowHead: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  rowTitle: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 },
  meta: { fontSize: 12, opacity: 0.65 },
  refs: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  ref: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, minWidth: 0 },
  refTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  iconButton: { width: 28, padding: 0, justifyContent: 'center', flexShrink: 0 },
  error: { fontSize: 13, color: 'var(--dsw-alias-text-error, #d4380d)', lineHeight: 1.5 },
  status: { fontSize: 13, opacity: 0.75 },
} as const

const STATUS_KEY: Record<ConversationStatus, AttachmentLibraryKey> = {
  normal: 'status.normal', archived: 'status.archived', 'pending-trash': 'status.pendingTrash', trash: 'status.trash',
}
const STATUS_TONE = { normal: 'success', archived: 'neutral', 'pending-trash': 'warning', trash: 'danger' } as const

/**
 * Apply the filters and the sort order.
 * @param attachments - every row.
 * @param kind - type filter.
 * @param usage - reference filter.
 * @param sort - sort order.
 * @returns the visible rows.
 */
export function selectAttachments(attachments: readonly AttachmentView[], kind: KindFilter, usage: UsageFilter, sort: SortOrder): AttachmentView[] {
  const rows = attachments.filter(item => (kind === 'all' || item.kind === kind) && (usage === 'all' || item.usage === usage))
  const byTime = (left: AttachmentView, right: AttachmentView) => (right.storedAt ?? 0) - (left.storedAt ?? 0)
  return rows.sort((left, right) => sort === 'size'
    ? right.sizeBytes - left.sizeBytes || byTime(left, right)
    : byTime(left, right) || right.sizeBytes - left.sizeBytes)
}

function Stat({ label, bucket, t }: { label: string; bucket: Bucket; t: Translate }) {
  return (
    <div style={styles.stat}>
      <dt style={styles.statLabel}>{label}</dt>
      <dd style={{ ...styles.statValue, margin: 0 }}>{t('summary.bucket', { count: bucket.count, size: formatBytes(bucket.bytes) })}</dd>
    </div>
  )
}

function Filter<Value extends string>({ label, value, options, onChange }: {
  label: string
  value: Value
  options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void
}) {
  return (
    <div role="group" aria-label={label} style={styles.group}>
      <span style={styles.groupLabel}>{label}</span>
      {options.map(option => (
        <Pill key={option.value} active={option.value === value} aria-pressed={option.value === value} onClick={() => { onChange(option.value) }}>
          {option.label}
        </Pill>
      ))}
    </div>
  )
}

function TypeIcon({ item, name }: { item: AttachmentView; name: string }) {
  return (
    <div style={styles.typeIcon} aria-hidden="true">
      {item.kind === 'image' ? <FileTypeIcon kind="image" size={28} /> : <FileTypeIcon path={name} size={28} />}
    </div>
  )
}

/**
 * Icon-only row action ("Show in Finder", "Open in Preview"). A failure is
 * shown under the row and cleared by the next attempt.
 */
function ActionButton({ label, icon, run, onError }: {
  label: string
  icon: ReactNode
  run: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const click = () => {
    setBusy(true)
    onError(null)
    run().catch((reason: unknown) => {
      onError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }
  return (
    <Button size="sm" variant="ghost" icon={icon} aria-label={label} title={label} style={styles.iconButton} disabled={busy} onClick={click} />
  )
}

/** Row actions the page may offer; an absent member hides its button. */
export interface RowActions {
  readonly reveal?: (request: RevealRequest) => Promise<void>
  readonly openInPreview?: (request: PreviewRequest) => Promise<void>
}

function referenceTitle(reference: ReferenceView, t: Translate): string {
  return reference.title ?? t('ref.untitled', { id: reference.sessionId.slice(0, 8) })
}

function AttachmentRow({ item, dateFormat, actions, t }: {
  item: AttachmentView
  dateFormat: Intl.DateTimeFormat
  actions: RowActions
  t: Translate
}) {
  const { reveal, openInPreview } = actions
  const [revealError, setRevealError] = useState<string | null>(null)
  const name = item.names[0] ?? (item.kind === 'image' ? t('item.unnamedImage') : t('item.unnamedFile'))
  const meta = [formatBytes(item.sizeBytes)]
  if (item.width !== undefined && item.height !== undefined) meta.push(t('item.dimensions', { width: item.width, height: item.height }))
  if (item.mediaType !== undefined) meta.push(item.mediaType)
  if (item.storedAt !== undefined) meta.push(t('item.storedAt', { time: dateFormat.format(new Date(item.storedAt)) }))
  const usageKey: AttachmentLibraryKey = item.usage === 'active' ? 'usage.active' : item.usage === 'trash-only' ? 'usage.trashOnly' : 'usage.unreferenced'
  return (
    <li style={styles.row} aria-label={name}>
      <div style={styles.rowBody}>
        <TypeIcon item={item} name={name} />
        <div style={styles.rowText}>
          <div style={styles.rowHead}>
            <Tag tone="outline">{item.kind === 'image' ? t('item.image') : t('item.file')}</Tag>
            <span style={styles.rowTitle} title={item.names.join('\n') || item.attachmentId}>{name}</span>
            {item.missing && <Tag tone="danger">{t('item.missing')}</Tag>}
            <Tag tone={item.usage === 'active' ? 'info' : 'warning'}>{t(usageKey)}</Tag>
            {openInPreview !== undefined && item.kind === 'image' && !item.missing && (
              <ActionButton
                label={t('item.openPreview')}
                icon={<IconRightUpOutlineRegular size={16} />}
                run={() => openInPreview({ attachmentId: item.attachmentId })}
                onError={setRevealError}
              />
            )}
            {reveal !== undefined && !item.missing && (
              <ActionButton
                label={t('item.reveal')}
                icon={<IconFolderOpenOutlineRegular size={16} />}
                run={() => reveal({ kind: item.kind, attachmentId: item.attachmentId })}
                onError={setRevealError}
              />
            )}
          </div>
          <span style={styles.meta}>{meta.join(' · ')}</span>
          {revealError !== null && <div role="alert" style={styles.error}>{revealError}</div>}
          {item.names.length > 1 && <span style={styles.meta}>{t('item.otherNames', { count: item.names.length - 1 })}</span>}
          {item.references.length === 0
            ? <span style={styles.meta}>{t('item.noReferences')}</span>
            : (
                <ul style={styles.refs} aria-label={t('item.references')}>
                  {item.references.map(reference => (
                    <li key={`${reference.status}:${reference.sessionId}:${String(reference.deletedAt ?? '')}`} style={styles.ref}>
                      <Tag tone={STATUS_TONE[reference.status]}>{t(STATUS_KEY[reference.status])}</Tag>
                      <span style={styles.refTitle} title={reference.sessionId}>{referenceTitle(reference, t)}</span>
                    </li>
                  ))}
                </ul>
              )}
        </div>
      </div>
    </li>
  )
}

/** Props of the settings page. */
export interface LibrarySectionProps {
  readonly scan: () => Promise<LibraryResult>
  /** Which desktop actions the Host offers; asked once per page. Absent or failing means none. */
  readonly desktopActions?: () => Promise<{ readonly reveal: boolean; readonly preview: boolean }>
  /** Show one stored attachment in the Host's file manager. */
  readonly reveal?: (request: RevealRequest) => Promise<void>
  /** Open one stored image in Preview on the Host. */
  readonly openInPreview?: (request: PreviewRequest) => Promise<void>
  readonly t: Translate
}

/**
 * The Attachment library settings page.
 * @param props - the Remote hop and the translate function.
 * @returns the page.
 */
export function LibrarySection({ scan, desktopActions, reveal, openInPreview, t }: LibrarySectionProps) {
  const [offered, setOffered] = useState({ reveal: false, preview: false })
  useEffect(() => {
    let live = true
    desktopActions?.().then((next) => { if (live) setOffered(next) }, () => { if (live) setOffered({ reveal: false, preview: false }) })
    return () => { live = false }
  }, [desktopActions])
  const actions = useMemo<RowActions>(() => ({
    ...offered.reveal && reveal !== undefined ? { reveal } : {},
    ...offered.preview && openInPreview !== undefined ? { openInPreview } : {},
  }), [offered, reveal, openInPreview])
  const [result, setResult] = useState<LibraryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<KindFilter>('all')
  const [usage, setUsage] = useState<UsageFilter>('all')
  const [sort, setSort] = useState<SortOrder>('time')
  const [limit, setLimit] = useState(PAGE_SIZE)

  const reload = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await scan())
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [scan])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => { setLimit(PAGE_SIZE) }, [kind, usage, sort])

  const visible = useMemo(() => result === null ? [] : selectAttachments(result.attachments, kind, usage, sort), [result, kind, usage, sort])
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const summary = result?.summary
  return (
    <section style={styles.section} aria-label={t('section.title')}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>{t('section.title')}</h2>
          <p style={styles.muted}>{t('section.desc')}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconRefreshOutlineRegular size={16} />}
          aria-label={t('section.refresh')}
          title={t('section.refresh')}
          style={styles.iconButton}
          disabled={busy}
          onClick={() => { void reload() }}
        />
      </div>
      {error !== null && <div role="alert" style={styles.error}>{error}</div>}
      {busy && <div role="status" style={styles.status}>{result === null ? t('section.loading') : t('section.scanning')}</div>}
      {summary !== undefined && result !== null && (
        <>
          <dl style={styles.grid} aria-label={t('summary.label')}>
            <Stat label={t('summary.total')} bucket={summary.total} t={t} />
            <Stat label={t('summary.images')} bucket={summary.images} t={t} />
            <Stat label={t('summary.files')} bucket={summary.files} t={t} />
            <Stat label={t('summary.active')} bucket={summary.active} t={t} />
            <Stat label={t('summary.trashOnly')} bucket={summary.trashOnly} t={t} />
            <Stat label={t('summary.unreferenced')} bucket={summary.unreferenced} t={t} />
            {summary.missing > 0 && (
              <div style={styles.stat}>
                <dt style={styles.statLabel}>{t('summary.missing')}</dt>
                <dd style={{ ...styles.statValue, margin: 0 }}>{summary.missing}</dd>
              </div>
            )}
            <div style={styles.stat}>
              <dt style={styles.statLabel}>{t('summary.cache')}</dt>
              <dd style={{ ...styles.statValue, margin: 0 }}>{formatBytes(summary.requestCacheBytes)}</dd>
            </div>
          </dl>
          <p style={styles.small}>
            {t('section.scanned', { time: dateFormat.format(new Date(result.scannedAt)), live: result.reread.live, trash: result.reread.trash })}
          </p>
          {result.problems.length > 0 && (
            <div role="note" style={styles.warning}>
              <strong>{t('problems.title', { count: result.problems.length })}</strong>
              <span>{t('problems.desc')}</span>
              <ul style={{ ...styles.refs, fontSize: 12, opacity: 0.8 }}>
                {result.problems.map(problem => (
                  <li key={`${problem.where}:${problem.id}`}>
                    {problem.where === 'live' ? t('problems.live') : t('problems.trash')} {problem.id}: {problem.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={styles.toolbar}>
            <Filter
              label={t('filter.kind')} value={kind} onChange={setKind}
              options={[
                { value: 'all', label: t('filter.kindAll') },
                { value: 'image', label: t('filter.kindImage') },
                { value: 'file', label: t('filter.kindFile') },
              ]}
            />
            <Filter
              label={t('filter.usage')} value={usage} onChange={setUsage}
              options={[
                { value: 'all', label: t('filter.usageAll') },
                { value: 'active', label: t('filter.usageActive') },
                { value: 'trash-only', label: t('filter.usageTrash') },
                { value: 'unreferenced', label: t('filter.usageNone') },
              ]}
            />
            <Filter
              label={t('sort.label')} value={sort} onChange={setSort}
              options={[{ value: 'time', label: t('sort.time') }, { value: 'size', label: t('sort.size') }]}
            />
          </div>
          {result.attachments.length === 0 && <p style={styles.muted}>{t('section.empty')}</p>}
          {result.attachments.length > 0 && visible.length === 0 && <p style={styles.muted}>{t('section.noMatch')}</p>}
          {visible.length > 0 && (
            <ul style={styles.list} aria-label={t('list.label')}>
              {visible.slice(0, limit).map(item => (
                <AttachmentRow key={`${item.kind}:${item.attachmentId}`} item={item} dateFormat={dateFormat} actions={actions} t={t} />
              ))}
            </ul>
          )}
          {visible.length > limit && (
            <Button size="sm" variant="outline" onClick={() => { setLimit(limit + PAGE_SIZE) }}>
              {t('list.more', { count: visible.length - limit })}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

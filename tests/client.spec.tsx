// @vitest-environment jsdom
/**
 * Browser half: the Attachment library settings page and the plugin's slot
 * registration. The Remote call is stubbed at the `remote.attachmentLibrary`
 * namespace the plugin reads after mounting.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { ATTACHMENT_LIBRARY_DESCRIPTORS, type AttachmentView, type LibraryResult, type PreviewRequest, type RevealRequest } from '../src/protocol.ts'
import { formatBytes, unwrap, type Translate } from '../src/client/api.ts'
import { LibrarySection, PAGE_SIZE, selectAttachments } from '../src/client/components.tsx'
import { en, zh } from '../src/client/locales.ts'
import * as plugin from '../src/client/index.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t: Translate = (key, params = {}) =>
  (zh as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)) ?? key

const id = (digit: string) => `sha256:${digit.repeat(64)}`

const item = (overrides: Partial<AttachmentView> & Pick<AttachmentView, 'attachmentId'>): AttachmentView => ({
  kind: 'image', names: [], sizeBytes: 1024, storedAt: 1_700_000_000_000, missing: false, usage: 'unreferenced', references: [], ...overrides,
})

const bucket = (count: number, bytes: number) => ({ count, bytes })

function library(attachments: AttachmentView[], problems: LibraryResult['problems'] = []): LibraryResult {
  return {
    summary: {
      total: bucket(4, 4_200_000), images: bucket(2, 3_000_000), files: bucket(2, 1_200_000),
      active: bucket(1, 2_000_000), trashOnly: bucket(1, 1_000_000), unreferenced: bucket(2, 1_200_000),
      missing: 1, requestCacheBytes: 5 * 1024 * 1024, liveSessions: 3, trashSessions: 1,
    },
    attachments, problems, scannedAt: 1_700_000_500_000, reread: { live: 3, trash: 1 },
  }
}

const rows: AttachmentView[] = [
  item({
    attachmentId: id('a'), names: ['screenshot.png'], sizeBytes: 2_000_000, storedAt: 1_700_000_001_000, mediaType: 'image/png', width: 1280, height: 720,
    usage: 'active', references: [
      { sessionId: 's-alpha', title: 'Alpha chat', status: 'normal' },
      { sessionId: 's-beta-123456', status: 'archived' },
      { sessionId: 's-gamma', title: 'Gamma chat', status: 'trash', deletedAt: 1_700_000_100_000 },
    ],
  }),
  item({ attachmentId: id('b'), names: [], sizeBytes: 1_000_000, storedAt: 1_700_000_004_000, usage: 'trash-only', references: [{ sessionId: 's-gamma', title: 'Gamma chat', status: 'trash' }] }),
  item({ attachmentId: id('c'), kind: 'file', names: ['a.txt', 'b.txt'], sizeBytes: 1_100_000, storedAt: 1_700_000_003_000 }),
  item({ attachmentId: id('d'), kind: 'file', names: ['data.csv'], sizeBytes: 100_000, storedAt: 1_700_000_002_000, usage: 'active', references: [{ sessionId: 's-delta', title: 'Delta chat', status: 'pending-trash' }] }),
  item({ attachmentId: id('e'), names: ['gone.png'], sizeBytes: 50, storedAt: undefined, missing: true, usage: 'active', references: [{ sessionId: 's-alpha', title: 'Alpha chat', status: 'normal' }] }),
]

function visibleNames(): string[] {
  return within(screen.getByRole('list', { name: '附件列表' })).getAllByRole('listitem').filter(node => node.getAttribute('aria-label') !== null).map(node => node.getAttribute('aria-label') as string)
}

describe('locales', () => {
  it('have the same keys in Chinese and English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('attachment library page', () => {
  it('shows totals, the rows with their conversations, and the scan facts', async () => {
    const scan = vi.fn(async () => library(rows))
    render(<LibrarySection scan={scan} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('首次打开')
    const totals = await screen.findByLabelText('附件统计')
    expect(totals.textContent).toContain('附件总数4 个 · 4.0 MB')
    expect(totals.textContent).toContain('只被回收站里的对话使用1 个 · 977 KB')
    expect(totals.textContent).toContain('被引用但文件缺失1')
    expect(totals.textContent).toContain('可再生的缩放缓存5.0 MB')
    expect(screen.getByText(/读取了 3 个会话记录和 1 个回收站会话记录/)).toBeTruthy()

    const first = screen.getByRole('listitem', { name: 'screenshot.png' })
    expect(first.textContent).toContain('1.9 MB · 1280 × 720 · image/png · 存入')
    const conversations = within(first).getByRole('list', { name: '引用它的对话' })
    expect(conversations.textContent).toContain('正常Alpha chat')
    expect(conversations.textContent).toContain('已归档未命名对话（s-beta-1）')
    expect(conversations.textContent).toContain('在回收站Gamma chat')
    expect(screen.getByRole('listitem', { name: 'a.txt' }).textContent).toContain('另有 1 个文件名')
    expect(screen.getByRole('listitem', { name: 'a.txt' }).textContent).toContain('没有对话引用此附件')
    expect(screen.getByRole('listitem', { name: 'data.csv' }).textContent).toContain('等待移入回收站Delta chat')
    expect(screen.getByRole('listitem', { name: 'gone.png' }).textContent).toContain('文件缺失')
    expect(screen.getByRole('listitem', { name: '未命名图片' }).textContent).toContain('仅回收站')
    expect(screen.queryByRole('note')).toBeNull()
    // Newest first; the missing row has no store time and sorts last.
    expect(visibleNames()).toEqual(['未命名图片', 'a.txt', 'data.csv', 'screenshot.png', 'gone.png'])
  })

  it('filters by type and references, and sorts by size', async () => {
    render(<LibrarySection scan={async () => library(rows)} t={t} />)
    await screen.findByRole('listitem', { name: 'screenshot.png' })
    const press = (group: string, label: string) => {
      fireEvent.click(within(screen.getByRole('group', { name: group })).getByRole('button', { name: label }))
    }

    press('类型', '仅图片')
    expect(visibleNames()).toEqual(['未命名图片', 'screenshot.png', 'gone.png'])
    press('类型', '仅文件')
    expect(visibleNames()).toEqual(['a.txt', 'data.csv'])
    expect(within(screen.getByRole('group', { name: '类型' })).getByRole('button', { name: '仅文件' }).getAttribute('aria-pressed')).toBe('true')
    press('类型', '全部')
    press('引用情况', '无人引用')
    expect(visibleNames()).toEqual(['a.txt'])
    press('引用情况', '仅被回收站引用')
    expect(visibleNames()).toEqual(['未命名图片'])
    press('引用情况', '现存对话')
    expect(visibleNames()).toEqual(['data.csv', 'screenshot.png', 'gone.png'])
    press('排序', '按大小')
    expect(visibleNames()).toEqual(['screenshot.png', 'data.csv', 'gone.png'])
    press('类型', '仅文件')
    press('引用情况', '无人引用')
    press('类型', '仅图片')
    expect(screen.getByText('没有符合筛选条件的附件')).toBeTruthy()
  })

  it('warns when some logs could not be read', async () => {
    const problems = [{ id: 'alpha', where: 'live' as const, reason: 'stored log is corrupt' }, { id: 'gamma', where: 'trash' as const, reason: 'log is incomplete' }]
    render(<LibrarySection scan={async () => library(rows, problems)} t={t} />)
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('有 2 项会话记录未能完整读取')
    expect(note.textContent).toContain('会话 alpha: stored log is corrupt')
    expect(note.textContent).toContain('回收站 gamma: log is incomplete')
  })

  it('pages long lists, shows an empty library, and reports a failed scan with a retry', async () => {
    const many = Array.from({ length: PAGE_SIZE + 5 }, (_, index) =>
      item({ attachmentId: `sha256:${index.toString(16).padStart(64, '0')}`, names: [`n${String(index)}.png`], storedAt: 1_000_000 - index }))
    const scan = vi.fn<() => Promise<LibraryResult>>()
      .mockResolvedValueOnce(library(many))
      .mockRejectedValueOnce(new Error('统计失败，未做任何改动：disk unavailable'))
      .mockResolvedValueOnce(library([]))
    render(<LibrarySection scan={scan} t={t} />)
    await screen.findByRole('listitem', { name: 'n0.png' })
    expect(visibleNames()).toHaveLength(PAGE_SIZE)
    fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 5 个）' }))
    expect(visibleNames()).toHaveLength(PAGE_SIZE + 5)

    fireEvent.click(screen.getByRole('button', { name: '重新统计' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('统计失败，未做任何改动：disk unavailable') })
    fireEvent.click(screen.getByRole('button', { name: '重新统计' }))
    await screen.findByText('没有保存任何附件')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(scan).toHaveBeenCalledTimes(3)
  })

  it('selects rows without changing the input', () => {
    const input = [...rows]
    expect(selectAttachments(input, 'file', 'all', 'size').map(row => row.attachmentId)).toEqual([id('c'), id('d')])
    expect(input).toEqual(rows)
  })
})

describe('Remote results', () => {
  it('maps the failure code to its message and passes values through', () => {
    expect(unwrap({ ok: true, value: 7 }, t)).toBe(7)
    const failure = (code: string, details: Record<string, unknown> = {}) => ({ ok: false, error: { code, message: 'm', details } }) as never
    expect(() => unwrap(failure('attachment-library/scan-failed', { reason: 'EACCES' }), t)).toThrow('统计失败，未做任何改动：EACCES')
    expect(() => unwrap(failure('attachment-library/not-found'), t)).toThrow('附件库中找不到这个文件，可能已被移除。请重新统计。')
    expect(() => unwrap(failure('attachment-library/unavailable'), t)).toThrow('这台主机无法在文件管理器中显示文件。')
    expect(() => unwrap(failure('attachment-library/reveal-failed', { reason: 'open exited with 1' }), t)).toThrow('无法在访达中显示：open exited with 1')
    expect(() => unwrap(failure('attachment-library/open-failed', { reason: 'unrecognized image format' }), t)).toThrow('无法用预览打开：unrecognized image format')
    expect(() => unwrap(failure('gateway/internal'), t)).toThrow('读取失败：gateway/internal: m')
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB')
  })
})

describe('plugin apply', () => {
  function harness(options: { loopback: boolean; hostAvailable: boolean; official: boolean | undefined; preview?: boolean }) {
    const registrations: { options: Record<string, unknown>; component: ComponentType<never> }[] = []
    const injected: string[] = []
    const effects: (() => void)[] = []
    const unmount = vi.fn(async () => {})
    const mount = vi.fn(async () => unmount)
    const remote = {
      scan: vi.fn(async () => ({ ok: true, value: library(rows) })),
      revealAvailability: vi.fn(async () => ({ ok: true, value: { available: options.hostAvailable, preview: options.hostAvailable && (options.preview ?? true) } })),
      reveal: vi.fn(async (_request: RevealRequest) => ({ ok: true, value: { revealed: true } })),
      openInPreview: vi.fn(async (_request: PreviewRequest) => ({ ok: true, value: { opened: true } })),
    }
    const session = { canOpenWorkspacePath: vi.fn(async () => ({ ok: true, value: options.official })) }
    const ctx = {
      effect: (setup: () => () => void) => { effects.push(setup()) },
      locale: { register: vi.fn(() => () => {}), bind: () => t },
      remote: { $mount: mount, $host: { isLoopback: options.loopback, home: undefined } },
      get: (key: string) => key === 'remote.attachmentLibrary' ? remote : key === 'remote.session' && options.official !== undefined ? session : undefined,
      slots: {
        inject: (slot: string, setup: () => () => void) => { injected.push(slot); effects.push(setup()) },
        register: (entry: Record<string, unknown>, component: ComponentType<never>) => {
          registrations.push({ options: entry, component })
          return () => {}
        },
      },
    }
    plugin.apply(ctx as never)
    return { registrations, injected, effects, mount, unmount, remote, session }
  }

  it('mounts the Remote methods and registers the settings page; disposal unmounts', async () => {
    const { registrations, injected, effects, mount, unmount, remote, session } = harness({ loopback: true, hostAvailable: true, official: true })
    expect(plugin.inject).toEqual(['slots', 'locale', 'remote'])
    expect(mount).toHaveBeenCalledWith({ package: 'dsh-plugin-attachment-library', descriptors: ATTACHMENT_LIBRARY_DESCRIPTORS })
    expect(ATTACHMENT_LIBRARY_DESCRIPTORS.map(descriptor => descriptor.method)).toEqual(['scan', 'revealAvailability', 'reveal', 'openInPreview'])
    expect(injected).toEqual(['settings.section'])
    expect(registrations.map(entry => [entry.options.name, entry.options.id, entry.options.order])).toEqual([['settings.section', 'attachment-library', 75]])
    expect((registrations[0]!.options.label as () => string)()).toBe('附件库')

    const Section = registrations[0]!.component as ComponentType
    render(<Section />)
    const shot = await screen.findByRole('listitem', { name: 'screenshot.png' })
    expect(remote.scan).toHaveBeenCalledOnce()
    fireEvent.click(await within(shot).findByRole('button', { name: '在访达中显示' }))
    await waitFor(() => { expect(remote.reveal).toHaveBeenCalledWith({ kind: 'image', attachmentId: id('a') }) })
    fireEvent.click(within(shot).getByRole('button', { name: '用预览打开' }))
    await waitFor(() => { expect(remote.openInPreview).toHaveBeenCalledWith({ attachmentId: id('a') }) })
    expect(session.canOpenWorkspacePath).toHaveBeenCalledOnce()

    for (const dispose of effects) dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('offers Show in Finder and Open in Preview only for a local Host whose desktop handoff is allowed', async () => {
    const cases = [
      { loopback: false, hostAvailable: true, official: true, shown: false, previewShown: false },
      { loopback: true, hostAvailable: false, official: true, shown: false, previewShown: false },
      { loopback: true, hostAvailable: true, official: false, shown: false, previewShown: false },
      { loopback: true, hostAvailable: true, official: undefined, shown: true, previewShown: true },
      { loopback: true, hostAvailable: true, official: true, preview: false, shown: true, previewShown: false },
    ]
    for (const { shown, previewShown, ...options } of cases) {
      const { registrations, remote } = harness(options)
      const Section = registrations[0]!.component as ComponentType
      render(<Section />)
      await screen.findByRole('listitem', { name: 'screenshot.png' })
      await act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve() })
      expect(screen.queryAllByRole('button', { name: '在访达中显示' }).length > 0, JSON.stringify(options)).toBe(shown)
      expect(screen.queryAllByRole('button', { name: '用预览打开' }).length > 0, JSON.stringify(options)).toBe(previewShown)
      if (!options.loopback) expect(remote.revealAvailability).not.toHaveBeenCalled()
      cleanup()
    }
  })
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('show in Finder', () => {
  it('shows an icon button per stored row only when available, and reveals by kind and id', async () => {
    const reveal = vi.fn(async (_request: RevealRequest) => {})
    render(<LibrarySection scan={async () => library(rows)} desktopActions={async () => ({ reveal: true, preview: false })} reveal={reveal} t={t} />)
    const shot = await screen.findByRole('listitem', { name: 'screenshot.png' })
    const button = await within(shot).findByRole('button', { name: '在访达中显示' })
    expect(button.getAttribute('title')).toBe('在访达中显示')
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(within(screen.getByRole('listitem', { name: 'gone.png' })).queryByRole('button', { name: '在访达中显示' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '在访达中显示' })).toHaveLength(4)

    fireEvent.click(button)
    await waitFor(() => { expect(reveal).toHaveBeenCalledWith({ kind: 'image', attachmentId: id('a') }) })
    fireEvent.click(within(screen.getByRole('listitem', { name: 'a.txt' })).getByRole('button', { name: '在访达中显示' }))
    await waitFor(() => { expect(reveal).toHaveBeenLastCalledWith({ kind: 'file', attachmentId: id('c') }) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a failure inside the row and clears it on the next attempt', async () => {
    const reveal = vi.fn<(request: RevealRequest) => Promise<void>>()
      .mockRejectedValueOnce(new Error('附件库中找不到这个文件，可能已被移除。请重新统计。'))
      .mockResolvedValueOnce(undefined)
    render(<LibrarySection scan={async () => library(rows)} desktopActions={async () => ({ reveal: true, preview: false })} reveal={reveal} t={t} />)
    const row = await screen.findByRole('listitem', { name: 'data.csv' })
    const button = await within(row).findByRole('button', { name: '在访达中显示' })
    fireEvent.click(button)
    expect(await within(row).findByRole('alert')).toHaveProperty('textContent', '附件库中找不到这个文件，可能已被移除。请重新统计。')
    fireEvent.click(button)
    await waitFor(() => { expect(within(row).queryByRole('alert')).toBeNull() })
    expect(reveal).toHaveBeenCalledTimes(2)
  })

  it('hides the button when the Host cannot reveal or the check fails', async () => {
    const none = async () => ({ reveal: false, preview: false })
    for (const desktopActions of [none, async () => { throw new Error('offline') }, undefined]) {
      render(<LibrarySection scan={async () => library(rows)} desktopActions={desktopActions} reveal={vi.fn()} openInPreview={vi.fn()} t={t} />)
      await screen.findByRole('listitem', { name: 'screenshot.png' })
      await act(async () => { await Promise.resolve() })
      expect(screen.queryByRole('button', { name: '在访达中显示' })).toBeNull()
      expect(screen.queryByRole('button', { name: '用预览打开' })).toBeNull()
      cleanup()
    }
  })

  it('offers Open in Preview on stored image rows only, next to Show in Finder', async () => {
    const openInPreview = vi.fn<(request: PreviewRequest) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('无法用预览打开：Preview is not registered for this image'))
    render(<LibrarySection scan={async () => library(rows)} desktopActions={async () => ({ reveal: true, preview: true })} reveal={vi.fn()} openInPreview={openInPreview} t={t} />)
    const shot = await screen.findByRole('listitem', { name: 'screenshot.png' })
    const button = await within(shot).findByRole('button', { name: '用预览打开' })
    expect(button.getAttribute('title')).toBe('用预览打开')
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
    const actions = within(shot).getAllByRole('button').map(node => node.getAttribute('aria-label'))
    expect(actions).toEqual(['用预览打开', '在访达中显示'])
    // Two stored images get it; files and the missing image do not.
    expect(screen.getAllByRole('button', { name: '用预览打开' })).toHaveLength(2)
    for (const name of ['a.txt', 'data.csv', 'gone.png']) {
      expect(within(screen.getByRole('listitem', { name })).queryByRole('button', { name: '用预览打开' })).toBeNull()
    }
    fireEvent.click(button)
    await waitFor(() => { expect(openInPreview).toHaveBeenCalledWith({ attachmentId: id('a') }) })
    expect(within(shot).queryByRole('alert')).toBeNull()
    const unnamed = screen.getByRole('listitem', { name: '未命名图片' })
    fireEvent.click(within(unnamed).getByRole('button', { name: '用预览打开' }))
    expect(await within(unnamed).findByRole('alert')).toHaveProperty('textContent', '无法用预览打开：Preview is not registered for this image')
  })

  it('hides Open in Preview when the Host is not macOS, keeping Show in Finder', async () => {
    render(<LibrarySection scan={async () => library(rows)} desktopActions={async () => ({ reveal: true, preview: false })} reveal={vi.fn()} openInPreview={vi.fn()} t={t} />)
    const shot = await screen.findByRole('listitem', { name: 'screenshot.png' })
    await within(shot).findByRole('button', { name: '在访达中显示' })
    expect(screen.queryByRole('button', { name: '用预览打开' })).toBeNull()
  })

  it('gives each row a type icon', async () => {
    render(<LibrarySection scan={async () => library(rows)} t={t} />)
    const shot = await screen.findByRole('listitem', { name: 'screenshot.png' })
    expect(shot.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
    expect(screen.getByRole('listitem', { name: 'data.csv' }).querySelector('[aria-hidden="true"] svg')).not.toBeNull()
  })

})

describe('refresh button', () => {
  it('uses an icon-only refresh button with a label and tooltip, disabled while scanning', async () => {
    const second = deferred<LibraryResult>()
    const scan = vi.fn<() => Promise<LibraryResult>>().mockResolvedValueOnce(library(rows)).mockReturnValueOnce(second.promise)
    render(<LibrarySection scan={scan} t={t} />)
    await screen.findByRole('listitem', { name: 'screenshot.png' })
    const button = screen.getByRole('button', { name: '重新统计' })
    expect(button.getAttribute('title')).toBe('重新统计')
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('正在重新统计…')).toBeTruthy()
    await act(async () => { second.resolve(library(rows.slice(0, 1))) })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('正在重新统计…')).toBeNull()
    expect(scan).toHaveBeenCalledTimes(2)
  })
})

/**
 * Browser half of `dsh-plugin-attachment-library`. It mounts the
 * `attachmentLibrary` Remote methods on `ctx.remote` and contributes the
 * "Attachment library" settings page (`settings.section`). "Show in Finder"
 * and "Open in Preview" appear only when the page talks to a local Host, the
 * Host has a desktop file manager (Preview: Finder on macOS), and DSH's own
 * `session.canOpenWorkspacePath` allows desktop handoff.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ATTACHMENT_LIBRARY_REMOTE, REMOTE_SERVICE, unwrap, type AttachmentLibraryRemote, type Translate } from './api.ts'
import { LibrarySection } from './components.tsx'
import { en, zh, type AttachmentLibraryKey } from './locales.ts'
import type { LibraryResult, PreviewRequest, RevealRequest } from '../protocol.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    attachmentLibrary: AttachmentLibraryKey
  }
}

/** The part of DSH's `remote.session` namespace read here. */
interface OfficialSessionRemote {
  canOpenWorkspacePath?: () => Promise<RemoteResult<boolean>>
}

/** Locale namespace of this plugin's copy. */
export const NS = 'attachmentLibrary'

/** Client plugin name. */
export const name = 'dsh-plugin-attachment-library/client'

/** Client services this plugin needs. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Install the Remote contribution and the settings page.
 * @param ctx - Client root Context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'attachment-library: dictionaries')
  const t: Translate = ctx.locale.bind(NS)

  const mounted = ctx.remote.$mount(ATTACHMENT_LIBRARY_REMOTE)
  ctx.effect(() => () => { void mounted.then(dispose => dispose()) }, 'attachment-library: Remote methods')
  const remote = async (): Promise<AttachmentLibraryRemote> => {
    await mounted
    return ctx.get(REMOTE_SERVICE) as AttachmentLibraryRemote
  }
  const scan = async (): Promise<LibraryResult> => unwrap(await (await remote()).scan(), t)
  const reveal = async (request: RevealRequest): Promise<void> => {
    unwrap(await (await remote()).reveal(request), t)
  }
  const openInPreview = async (request: PreviewRequest): Promise<void> => {
    unwrap(await (await remote()).openInPreview(request), t)
  }
  const none = { reveal: false, preview: false }
  const desktopActions = async (): Promise<{ reveal: boolean; preview: boolean }> => {
    if (!ctx.remote.$host.isLoopback) return none
    const host = await (await remote()).revealAvailability()
    if (!host.ok || !host.value.available) return none
    // DSH's own desktop-handoff switch: a deployment that turns it off hides these actions too.
    const session = ctx.get('remote.session') as OfficialSessionRemote | undefined
    if (typeof session?.canOpenWorkspacePath === 'function') {
      const official = await session.canOpenWorkspacePath()
      if (!official.ok || !official.value) return none
    }
    return { reveal: true, preview: host.value.preview }
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'attachment-library',
    order: 75,
    label: () => t('section.nav'),
    locale: NS,
  }, () => <LibrarySection scan={scan} desktopActions={desktopActions} reveal={reveal} openInPreview={openInPreview} t={t} />))
}

/**
 * Browser access to the `attachmentLibrary` Remote methods. The contribution is
 * mounted on `ctx.remote`, so every call travels the Connection's
 * authenticated `/api` route. Failures come back as Remote results and are
 * turned into localized messages here.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  ATTACHMENT_LIBRARY_DESCRIPTORS, ATTACHMENT_LIBRARY_NAMESPACE, ATTACHMENT_LIBRARY_PACKAGE,
  type LibraryResult, type PreviewRequest, type PreviewResult, type RevealAvailability, type RevealRequest, type RevealResult,
} from '../protocol.ts'
import type { AttachmentLibraryKey } from './locales.ts'

/** The mounted `remote.attachmentLibrary` namespace. */
export interface AttachmentLibraryRemote {
  scan(): Promise<RemoteResult<LibraryResult>>
  revealAvailability(): Promise<RemoteResult<RevealAvailability>>
  reveal(request: RevealRequest): Promise<RemoteResult<RevealResult>>
  openInPreview(request: PreviewRequest): Promise<RemoteResult<PreviewResult>>
}

/** Contribution mounted on `ctx.remote`. */
export const ATTACHMENT_LIBRARY_REMOTE = { package: ATTACHMENT_LIBRARY_PACKAGE, descriptors: ATTACHMENT_LIBRARY_DESCRIPTORS }

/** Namespace service key under which the Client Remote publishes the methods. */
export const REMOTE_SERVICE = `remote.${ATTACHMENT_LIBRARY_NAMESPACE}`

/** Translate function bound to this plugin's namespace. */
export type Translate = (key: AttachmentLibraryKey, params?: Record<string, string | number>) => string

/**
 * Unwrap a Remote result, mapping each failure code to localized copy.
 * @param result - the Remote result.
 * @param t - translate function.
 * @returns the value of a successful call.
 */
export function unwrap<T>(result: RemoteResult<T>, t: Translate): T {
  if (result.ok) return result.value
  const { error } = result
  const details: unknown = error.details
  const reason: unknown = typeof details === 'object' && details !== null ? Reflect.get(details, 'reason') : undefined
  const code: string = error.code
  if (code === 'attachment-library/scan-failed') throw new Error(t('error.scanFailed', { reason: typeof reason === 'string' ? reason : error.message }))
  if (code === 'attachment-library/not-found') throw new Error(t('error.revealNotFound'))
  if (code === 'attachment-library/unavailable') throw new Error(t('error.revealUnavailable'))
  if (code === 'attachment-library/reveal-failed') throw new Error(t('error.revealFailed', { reason: typeof reason === 'string' ? reason : error.message }))
  if (code === 'attachment-library/open-failed') throw new Error(t('error.openFailed', { reason: typeof reason === 'string' ? reason : error.message }))
  throw new Error(t('error.failed', { message: `${code}: ${error.message}` }))
}

/**
 * Format a byte count.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] as string}`
}

/**
 * dsh-video-preview — host half.
 *
 * Registers a single prefix route `/video/*` that serves video files from the
 * session working directory with HTTP Range (206 Partial Content) support, so
 * the sidebar's inline `<video>` element can play and seek properly.
 *
 * Why a dedicated route instead of the built-in `/sidebar/file` media route?
 * The built-in media route reads the whole file into memory and replies with a
 * plain `200` (no `Accept-Ranges`), and it is capped by the 20MB `mediaLimit`
 * — fine for images/PDFs, wrong for video: without 206 responses the browser
 * disables scrubbing, and files over the cap are rejected outright. This route
 * streams with `createReadStream` and honours `Range`, `If-Range` and suffix
 * ranges (`bytes=-N`).
 *
 * Security posture mirrors better-sidebar's own routes:
 *  - same Host-header trust fence as the `/api` gateway (loopback or the web
 *    runtime's `trustedHosts`; cross-site browser markers refused);
 *  - the resolved path must sit under the session's authoritative working
 *    directory (case/separator tolerant), so a crafted `..` can never escape.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

/** Plugin identity for cordis.yml rows / client-modules keying. */
export const name = 'dsh-video-preview'

/** Services required before mounting: route registration + session cwd + the web runtime's trusted hosts. */
export const inject = ['webServer', 'sessions', 'webRuntime']

/** Content types for the video route, by extension. */
const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
}

// ── browser-trust fence (same semantics as @deepseek-ai/dsh-client-connection's
//    /api gateway; inlined so the plugin carries no internal dependency) ──────

function header(headers, name_) {
  const value = headers[name_]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── path helpers (same semantics as better-sidebar's src/fs-tree.ts) ────────

function requireAbsolute(path) {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new SidebarError('fs-error', `"${path}" is not an absolute path`, 400)
  }
  return resolve(path)
}

function isWithin(base, target) {
  const norm = (value) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  if (process.platform === 'win32') {
    const lb = b.toLowerCase()
    const lt = t.toLowerCase()
    return lt === lb || lt.startsWith(`${lb}/`)
  }
  return t === b || t.startsWith(`${b}/`)
}

/** Local error type mirroring better-sidebar's SidebarError wire shape. */
class SidebarError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Resolve a session's authoritative working directory (fallback chain like
 *  better-sidebar's sessionCwdOf: attached session header → caller cwd → process cwd). */
function sessionCwdOf(ctx, sessionId, clientCwd) {
  const session = ctx.sessions.get(sessionId)
  const headerCwd = session?.header?.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  if (clientCwd !== undefined && clientCwd !== '') {
    try {
      return resolve(clientCwd)
    } catch {
      throw new SidebarError('bad-request', `invalid working directory "${clientCwd}"`)
    }
  }
  return process.cwd()
}

function writeError(res, error) {
  const status = error instanceof SidebarError ? error.status : 500
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = Buffer.from(JSON.stringify({ ok: false, error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) } }))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
  res.end(body)
}

// ── Range handling ───────────────────────────────────────────────────────────

/**
 * Parse a single `Range: bytes=...` header against a known size.
 * Returns `{ start, end }` (inclusive), `null` when no range is present, or
 * `{ unsatisfiable: true }` when the range cannot be satisfied. Multi-range
 * requests (`bytes=a-b,c-d`) are served as a single response of the FIRST
 * range, which the HTTP spec explicitly allows.
 */
function parseRange(raw, size) {
  if (raw === undefined) return null
  const m = /^bytes=(.+)$/i.exec(raw.trim())
  if (!m) return null
  const spec = m[1].split(',')[0].trim() // first range only
  if (spec === '') return null
  if (spec.startsWith('-')) {
    // suffix range: last N bytes
    const suffix = Number(spec.slice(1))
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    if (suffix >= size) return { start: 0, end: size - 1 }
    return { start: size - suffix, end: size - 1 }
  }
  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const startText = spec.slice(0, dash)
  const endText = spec.slice(dash + 1)
  const start = startText === '' ? 0 : Number(startText)
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end)) return null
  if (start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

/** Render one response for a range or full request. */
function serveFile(req, res, path, size, type) {
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  }

  const range = parseRange(header(req.headers, 'range'), size)
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  if (range !== null) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(path, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(path)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// ── plugin body ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/video',
    handler: async (req, res) => {
      if (!fence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const raw = url.searchParams.get('path')
        if (sessionId === null || raw === null) {
          throw new SidebarError('bad-request', 'sessionId and path are required')
        }
        const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const path = requireAbsolute(raw)
        if (!isWithin(cwd, path)) {
          throw new SidebarError('fs-error', 'video path outside the session working directory', 403)
        }
        const info = await stat(path)
        if (!info.isFile()) {
          throw new SidebarError('fs-error', 'not a file', 400)
        }
        if (info.size === 0) {
          // Nothing to stream; a zero-length "video" is an error state.
          throw new SidebarError('fs-error', 'empty video file', 400)
        }
        const type = VIDEO_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
        serveFile(req, res, path, info.size, type)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-video-preview: /video range route')
}

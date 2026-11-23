import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Host header without its port; IPv6 literals keep their brackets. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

const deny = (message: string): Response =>
  new Response(JSON.stringify({ error: { type: 'permission_error', message } }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Browser-origin guard for the local proxy. CORS being absent only stops a web
 * page from *reading* a response; it does not stop the request from being sent
 * (a text/plain POST is a "simple" request with no preflight), and DNS
 * rebinding makes the page same-origin so it can read too. Two checks close both:
 *
 * - Host must be a loopback name, which a rebound hostname never is. Skipped
 *   when the operator deliberately bound a network address (`allowAnyHost`).
 * - Any request carrying an `Origin` that differs from the `Host` it was sent
 *   to, or a `Sec-Fetch-Site` of cross-site or same-site, is a browser acting
 *   for another page and is refused. Claude Code, Node fetch, curl and the
 *   plugin hooks send neither header.
 */
export function localGuard(opts: { allowAnyHost?: boolean } = {}): MiddlewareHandler {
  return async (c, next) => {
    // The URL's authority is the Host header on a real connection (the node
    // server builds it from there) and the request URL for in-process calls.
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!opts.allowAnyHost && !LOOPBACK_HOSTS.has(hostnameOf(host))) {
      return deny('Host header is not a loopback name');
    }
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        // "null" or garbage: not a same-origin page
      }
      if (originHost !== host.trim().toLowerCase()) return deny('Cross-origin requests are not allowed');
    }
    const site = c.req.header('sec-fetch-site');
    if (site === 'cross-site' || site === 'same-site') return deny('Cross-site requests are not allowed');
    await next();
  };
}

/** Rejects a POST whose body is not declared JSON, so a no-preflight text/plain form post cannot reach a JSON handler. */
export const requireJson: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'POST' && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'Content-Type must be application/json' } }),
      { status: 415, headers: { 'content-type': 'application/json' } },
    );
  }
  await next();
};

/**
 * One place that knows how to reach the backend.
 *
 * Two URL shapes work, and the app picks whichever the host supports:
 *
 *   api/collection            pretty URLs (Node, or Apache with mod_rewrite)
 *   api.php?route=collection  direct   (Apache without mod_rewrite)
 *
 * URLs are relative, so the app also works from a subfolder such as
 * https://example.com/OMGBBG/ .
 */

const AUTH_ROUTES = new Set(['me', 'login', 'logout', 'register', 'settings']);

let mode = 'pretty';

export function apiUrl(route, params) {
  const query = new URLSearchParams(params || {});
  if (mode === 'query') {
    query.set('route', route);
    return 'api.php?' + query.toString();
  }
  const suffix = query.toString();
  return 'api/' + route + (suffix ? '?' + suffix : '');
}

/**
 * Call the backend, transparently switching to the direct api.php form the
 * first time a pretty URL comes back 404 (no mod_rewrite on this host).
 */
export async function apiFetch(route, options = {}) {
  const { params, method = 'GET', body } = options;
  const send = () =>
    fetch(apiUrl(route, params), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
    });

  let res = await send();
  if (res.status === 404 && mode === 'pretty') {
    mode = 'query';
    res = await send();
    if (res.status === 404) mode = 'pretty'; // neither shape worked; keep the default
  }
  // A 401 anywhere but the sign-in endpoints means the session died mid-use.
  if (res.status === 401 && !AUTH_ROUTES.has(route)) {
    window.dispatchEvent(new CustomEvent('omgbb:unauthorized'));
  }
  return res;
}

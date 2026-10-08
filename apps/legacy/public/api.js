let csrfToken;
/** Single connection point for the eventual Claude Design frontend. */
export async function api(path, { method = 'GET', body, signal } = {}) {
  if (method !== 'GET' && path !== '/api/login' && csrfToken === undefined) {
    const session = await fetch('/api/session', {credentials:'same-origin'});
    const data = await session.json(); csrfToken = data.csrf_token || '';
  }
  const response = await fetch(path, {
    method, credentials: 'same-origin', signal,
    headers: { Accept:'application/json', ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(method !== 'GET' && csrfToken ? {'X-CSRF-Token':csrfToken} : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : `Požadavek selhal (${response.status}).`));
    error.status = response.status;
    error.code = data.error?.code || data.code;
    throw error;
  }
  if (path === '/api/session') csrfToken = data.csrf_token || '';
  if (path === '/api/login' || path === '/api/logout') csrfToken = undefined;
  return data;
}
export const list = (data, key) => Array.isArray(data) ? data : (Array.isArray(data?.[key]) ? data[key] : []);
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const money = minor => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK' }).format(Number(minor) / 100);
export const date = value => value ? new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }).format(new Date(value)) : '—';

/**
 * Sign-in state and the gate screen.
 *
 * The backend keeps accounts in data/users.json and sessions in
 * data/sessions.json; the browser only ever holds the session cookie, which it
 * cannot read. Every data endpoint is refused until a session exists, so this
 * screen is the whole of the front door.
 */

import { apiFetch } from './api.js';

export const auth = {
  user: null,
  username: '',
  needsSetup: false,
  registrationOpen: false,
  mode: 'login', // 'login' | 'register'
  error: '',
  notice: '',
  busy: false,
  checked: false,
};

async function readError(res, fallback) {
  try {
    const payload = await res.json();
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

/** Ask the server who we are. Never throws: a dead server just means logged out. */
export async function refreshSession() {
  try {
    const res = await apiFetch('me');
    if (res.ok) {
      const data = await res.json();
      auth.user = data.user || null;
      auth.needsSetup = Boolean(data.needsSetup);
      auth.registrationOpen = Boolean(data.registrationOpen);
      if (auth.needsSetup) auth.mode = 'register';
    }
  } catch {
    auth.user = null;
  }
  auth.checked = true;
  return auth;
}

export async function submitCredentials(username, password) {
  const registering = auth.mode === 'register';
  auth.error = '';
  auth.busy = true;
  try {
    const res = await apiFetch(registering ? 'register' : 'login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      auth.error = await readError(res, registering ? 'Could not register.' : 'Could not sign in.');
      return false;
    }
    const data = await res.json();
    auth.user = data.user;
    auth.needsSetup = false;
    // Claiming the site closes registration behind you; keep the toggle honest.
    if (typeof data.registrationOpen === 'boolean') {
      auth.registrationOpen = data.registrationOpen;
    }
    return true;
  } catch (err) {
    auth.error = err.message || 'The server did not answer.';
    return false;
  } finally {
    auth.busy = false;
  }
}

export async function logout() {
  try {
    await apiFetch('logout', { method: 'POST' });
  } catch {
    /* the cookie is gone either way once we forget the user */
  }
  auth.user = null;
  auth.mode = 'login';
  auth.error = '';
}

/** Owner-only: open or close registration for everyone else. */
export async function setRegistrationOpen(open) {
  const res = await apiFetch('settings', {
    method: 'POST',
    body: JSON.stringify({ allowRegistration: open }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not change that setting.'));
  auth.registrationOpen = open;
}

/** Called when any other endpoint answers 401 - the session expired mid-use. */
export function sessionLost() {
  auth.user = null;
  auth.mode = 'login';
  auth.notice = 'Your session ended. Sign in again.';
}

/* --------------------------------------------------------------- the screen */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function authScreen() {
  const registering = auth.mode === 'register';
  const setup = auth.needsSetup;

  const title = setup ? 'Claim this site' : registering ? 'New blader' : 'Members only';
  const blurb = setup
    ? 'No account exists yet. The first one you create owns this site, and registration ' +
      'closes behind it - you can reopen it later from the top bar.'
    : registering
      ? 'Pick a name and a password of at least 8 characters.'
      : 'This collection is private. Sign in to continue.';

  return (
    '<main class="view view-auth">' +
    '<section class="panel auth-panel">' +
    '<h3>' + esc(title) + '</h3>' +
    '<p class="auth-blurb">' + esc(blurb) + '</p>' +
    (auth.notice ? '<p class="auth-notice">' + esc(auth.notice) + '</p>' : '') +
    (auth.error ? '<p class="auth-error">' + esc(auth.error) + '</p>' : '') +
    '<form id="auth-form" class="auth-form" autocomplete="on">' +
    '<label>Username' +
    '<input id="auth-user" name="username" type="text" autocomplete="username" ' +
    'spellcheck="false" value="' + esc(auth.username) + '" required>' +
    '</label>' +
    '<label>Password' +
    '<input id="auth-pass" name="password" type="password" ' +
    'autocomplete="' + (registering ? 'new-password' : 'current-password') + '" required>' +
    '</label>' +
    '<button class="primary" type="submit"' + (auth.busy ? ' disabled' : '') + '>' +
    (setup ? 'Create owner account' : registering ? 'Register' : 'Sign in') +
    '</button>' +
    '</form>' +
    (!setup && auth.registrationOpen
      ? '<p class="auth-switch">' +
        (registering ? 'Already have an account? ' : 'Registration is open. ') +
        '<button class="link" data-action="auth-mode">' +
        (registering ? 'Sign in instead' : 'Create an account') +
        '</button></p>'
      : '') +
    (!setup && !auth.registrationOpen && !registering
      ? '<p class="auth-switch muted small">Registration is closed on this site.</p>'
      : '') +
    '</section></main>'
  );
}

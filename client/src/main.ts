import './style.scss';
import { api, type User } from './api';
import { appBase } from './base';
import { renderLogin, renderRegister, renderShell } from './views';

function showShell(user: User): void {
  renderShell(user, showLogin);
}

function showLogin(): void {
  renderLogin(showShell);
}

async function boot(): Promise<void> {
  const registerToken = location.pathname.endsWith('/register')
    ? new URLSearchParams(location.search).get('token')
    : null;

  let user: User | null = null;
  try {
    user = await api<User>('/api/auth/me');
  } catch {
    // Not logged in.
  }

  if (registerToken && !user) {
    renderRegister(registerToken, showShell);
    return;
  }
  if (location.pathname !== appBase) history.replaceState(null, '', appBase);
  if (user) {
    showShell(user);
  } else {
    showLogin();
  }
}

void boot();

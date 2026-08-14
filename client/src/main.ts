import './style.scss';
import { api, type User } from './api';
import { renderLogin, renderRegister, renderShell } from './views';

function showShell(user: User): void {
  renderShell(user, showLogin);
}

function showLogin(): void {
  renderLogin(showShell);
}

async function boot(): Promise<void> {
  const registerToken =
    location.pathname === '/register' ? new URLSearchParams(location.search).get('token') : null;

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
  if (location.pathname !== '/') history.replaceState(null, '', '/');
  if (user) {
    showShell(user);
  } else {
    showLogin();
  }
}

void boot();

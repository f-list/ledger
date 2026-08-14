import { api, ApiError, type User } from './api';

const app = document.querySelector<HTMLDivElement>('#app')!;

function showError(element: HTMLElement, err: unknown): void {
  element.textContent = err instanceof ApiError ? err.message : 'Something went wrong.';
}

export function renderLogin(onSuccess: (user: User) => void): void {
  app.innerHTML = `
    <main class="auth-card">
      <h1>f-list.ledger</h1>
      <form id="login-form">
        <label>Username <input name="username" autocomplete="username" required /></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
        <p class="form-error" role="alert"></p>
        <button type="submit">Log in</button>
      </form>
    </main>
  `;

  const form = app.querySelector<HTMLFormElement>('#login-form')!;
  const error = form.querySelector<HTMLParagraphElement>('.form-error')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    api<User>('/api/auth/login', {
      username: data.get('username'),
      password: data.get('password'),
    }).then(onSuccess, (err: unknown) => showError(error, err));
  });
}

export function renderRegister(token: string, onSuccess: (user: User) => void): void {
  app.innerHTML = `
    <main class="auth-card">
      <h1>f-list.ledger</h1>
      <p>You've been invited. Pick a username and password.</p>
      <form id="register-form">
        <label>Username <input name="username" autocomplete="username" required minlength="3" maxlength="32" /></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" required minlength="8" /></label>
        <p class="form-error" role="alert"></p>
        <button type="submit">Create account</button>
      </form>
    </main>
  `;

  const form = app.querySelector<HTMLFormElement>('#register-form')!;
  const error = form.querySelector<HTMLParagraphElement>('.form-error')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    api<User>('/api/auth/register', {
      token,
      username: data.get('username'),
      password: data.get('password'),
    }).then(
      (user) => {
        history.replaceState(null, '', '/');
        onSuccess(user);
      },
      (err: unknown) => showError(error, err),
    );
  });
}

export function renderShell(user: User, onLogout: () => void): void {
  app.innerHTML = `
    <header class="app-header">
      <h1>f-list.ledger</h1>
      <nav>
        <span class="app-header__user"></span>
        <button id="invite-button" type="button">Generate invite</button>
        <button id="logout-button" type="button">Log out</button>
      </nav>
    </header>
    <div id="invite-result" hidden>
      <input id="invite-link" readonly />
      <button id="invite-copy" type="button">Copy</button>
      <span>Single use, expires in 7 days.</span>
    </div>
    <main id="content">
      <p class="placeholder">Event ledger coming soon.</p>
    </main>
  `;

  app.querySelector<HTMLSpanElement>('.app-header__user')!.textContent = user.username;

  app.querySelector('#logout-button')!.addEventListener('click', () => {
    api('/api/auth/logout', {}).then(onLogout, onLogout);
  });

  const inviteResult = app.querySelector<HTMLDivElement>('#invite-result')!;
  const inviteLink = app.querySelector<HTMLInputElement>('#invite-link')!;
  app.querySelector('#invite-button')!.addEventListener('click', () => {
    api<{ token: string }>('/api/invites', {}).then(
      ({ token }) => {
        inviteLink.value = `${location.origin}/register?token=${token}`;
        inviteResult.hidden = false;
      },
      () => {
        inviteLink.value = 'Failed to create invite.';
        inviteResult.hidden = false;
      },
    );
  });
  app.querySelector('#invite-copy')!.addEventListener('click', () => {
    void navigator.clipboard.writeText(inviteLink.value);
  });
}

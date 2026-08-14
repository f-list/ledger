import { api, ApiError, type User } from './api';
import { renderEvents } from './events';
import { renderSubscribers } from './subscribers';
import { renderTiersPanel } from './tiers';

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
        <button id="tiers-button" type="button">Tiers</button>
        <button id="invite-button" type="button">Generate invite</button>
        <button id="logout-button" type="button">Log out</button>
      </nav>
    </header>
    <div id="invite-result" hidden>
      <input id="invite-link" readonly />
      <button id="invite-copy" type="button">Copy</button>
      <span>Single use, expires in 7 days.</span>
    </div>
    <div id="tiers-container"></div>
    <nav class="tabs">
      <button type="button" class="tabs__tab tabs__tab--active" data-view="events">Events</button>
      <button type="button" class="tabs__tab" data-view="subscribers">Subscribers</button>
    </nav>
    <main id="content"></main>
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

  const content = app.querySelector<HTMLElement>('#content')!;
  const views: Record<string, (el: HTMLElement) => void> = {
    events: renderEvents,
    subscribers: renderSubscribers,
  };
  let activeView = 'events';

  const tabs = [...app.querySelectorAll<HTMLButtonElement>('.tabs__tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      activeView = tab.dataset.view ?? 'events';
      for (const t of tabs) t.classList.toggle('tabs__tab--active', t === tab);
      views[activeView]?.(content);
    });
  }

  const tiersPanel = renderTiersPanel(app.querySelector<HTMLElement>('#tiers-container')!, () =>
    views[activeView]?.(content),
  );
  app.querySelector('#tiers-button')!.addEventListener('click', () => tiersPanel.toggle());

  renderEvents(content);
}

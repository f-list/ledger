import './style.scss';

const app = document.querySelector<HTMLDivElement>('#app');

if (app) {
  app.innerHTML = `
    <main class="container">
      <h1>f-list.ledger</h1>
      <p>Vite + TypeScript + Sass</p>
    </main>
  `;
}

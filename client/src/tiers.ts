import { api } from './api';

interface Tier {
  tierId: string;
  name: string | null;
  seenCount: number;
}

export function renderTiersPanel(container: HTMLElement, onNamesChanged: () => void): { toggle: () => void } {
  container.innerHTML = `
    <div class="tiers-panel" hidden>
      <p class="tiers-panel__hint">Name the subscription tiers seen by the ledger. Clearing a name removes it.</p>
      <div class="tiers-panel__rows"></div>
      <p class="tiers-panel__status" role="status"></p>
    </div>
  `;

  const panel = container.querySelector<HTMLDivElement>('.tiers-panel')!;
  const rowsContainer = panel.querySelector<HTMLDivElement>('.tiers-panel__rows')!;
  const status = panel.querySelector<HTMLParagraphElement>('.tiers-panel__status')!;

  function renderRow(tier: Tier): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tiers-panel__row';

    const id = document.createElement('code');
    id.textContent = tier.tierId;
    id.title = `Seen in ${tier.seenCount} event${tier.seenCount === 1 ? '' : 's'}`;

    const input = document.createElement('input');
    input.maxLength = 64;
    input.placeholder = '(unnamed)';
    input.value = tier.name ?? '';

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';

    save.addEventListener('click', () => {
      save.disabled = true;
      api<unknown>(`/api/tiers/${tier.tierId}`, { name: input.value }, 'PUT').then(
        () => {
          save.disabled = false;
          status.textContent = input.value.trim() === '' ? `Removed name for ${tier.tierId}.` : `Saved.`;
          onNamesChanged();
        },
        (err: unknown) => {
          save.disabled = false;
          status.textContent = err instanceof Error ? err.message : 'Failed to save.';
        },
      );
    });

    row.append(id, input, save);
    return row;
  }

  async function load(): Promise<void> {
    status.textContent = '';
    rowsContainer.textContent = 'Loading…';
    try {
      const { tiers } = await api<{ tiers: Tier[] }>('/api/tiers');
      rowsContainer.textContent = '';
      if (tiers.length === 0) {
        rowsContainer.textContent = 'No tiers seen yet.';
        return;
      }
      for (const tier of tiers) rowsContainer.append(renderRow(tier));
    } catch (err) {
      rowsContainer.textContent = err instanceof Error ? err.message : 'Failed to load tiers.';
    }
  }

  return {
    toggle() {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) void load();
    },
  };
}

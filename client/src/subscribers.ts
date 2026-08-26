import { api } from './api';
import { cell, formatCost, linkCell, subscribeStarProfileUrl } from './table';

interface Subscriber {
  subscriberId: string;
  nickname: string | null;
  email: string | null;
  status: string;
  statusChangedTs: number | null;
  lastEventTs: number | null;
  tierId: string | null;
  tierName: string | null;
  costCents: number | null;
  flistAccount: string | null;
  notes: string | null;
}

const LAST_VISIT_KEY = 'subscribers-last-visit';

const CHIP_CLASS: Record<string, string> = {
  active: 'chip--good',
  cancelled: 'chip--bad',
  billing_failed: 'chip--warn',
  paused: 'chip--info',
};

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeTime(unixSeconds: number): string {
  const days = Math.floor((Date.now() / 1000 - unixSeconds) / 86400);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function editableCell(
  sub: Subscriber,
  field: 'flistAccount' | 'notes',
  maxLength: number,
): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'cell--editable';

  function renderStatic(): void {
    const value = sub[field] ?? '';
    td.textContent = '';
    td.title = 'Click to edit';
    if (field === 'flistAccount' && /^\d+$/.test(value)) {
      // Numeric value = F-List account id; link to the staff lookup panel.
      const link = document.createElement('a');
      link.textContent = value;
      link.href = `https://www.f-list.net/panel/lookup.php?acctid=${value}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Open in F-List lookup';
      // Follow the link without triggering the cell's edit handler.
      link.addEventListener('click', (event) => event.stopPropagation());
      td.append(link);
    } else {
      td.textContent = value;
    }
  }

  function renderEditor(): void {
    const input = document.createElement('input');
    input.value = sub[field] ?? '';
    input.maxLength = maxLength;
    let saving = false;

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        saving = true;
        input.disabled = true;
        td.classList.remove('cell--error');
        api<Subscriber>(`/api/subscribers/${sub.subscriberId}`, { [field]: input.value }, 'PATCH').then(
          (updated) => {
            sub[field] = updated[field];
            renderStatic();
          },
          (err: unknown) => {
            saving = false;
            input.disabled = false;
            td.classList.add('cell--error');
            input.title = err instanceof Error ? err.message : 'Failed to save.';
            input.focus();
          },
        );
      } else if (event.key === 'Escape') {
        renderStatic();
      }
    });
    input.addEventListener('blur', () => {
      if (!saving) renderStatic();
    });

    td.textContent = '';
    td.title = '';
    td.append(input);
    input.focus();
    input.select();
  }

  td.addEventListener('click', () => {
    if (!td.querySelector('input')) renderEditor();
  });

  renderStatic();
  return td;
}

function renderRow(sub: Subscriber): HTMLTableRowElement {
  const tr = document.createElement('tr');

  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = `chip ${CHIP_CLASS[sub.status] ?? 'chip--muted'}`;
  chip.textContent = sub.status;
  statusCell.append(chip);

  const changed = sub.statusChangedTs;
  tr.append(
    cell(sub.nickname ?? "(unknown)"),
    linkCell(sub.subscriberId, subscribeStarProfileUrl(sub.subscriberId), `Subscriber ID: ${sub.subscriberId}`, true),
    editableCell(sub, 'flistAccount', 100),
    statusCell,
    cell(
      changed === null ? '' : new Date(changed * 1000).toLocaleDateString(),
      changed === null ? undefined : relativeTime(changed),
    ),
    cell(sub.tierName ?? sub.tierId ?? '', sub.tierId ? `Tier ID: ${sub.tierId}` : undefined),
    cell(formatCost(sub.costCents)),
    cell(sub.email ?? ''),
    editableCell(sub, 'notes', 1000),
  );
  return tr;
}

export function renderSubscribers(container: HTMLElement): void {
  container.innerHTML = `
    <div class="filter-bar">
      <label>Changed since <input type="datetime-local" class="filter-since" /></label>
      <button type="button" class="filter-clear">Show all</button>
      <span class="filter-count"></span>
    </div>
    <table class="events-table subscribers-table" hidden>
      <thead>
        <tr><th>Subscriber</th><th>SubStar</th><th>F-List</th><th>Status</th><th>Since</th><th>Tier</th><th>Amount</th><th>Email</th><th>Notes</th></tr>
      </thead>
      <tbody></tbody>
    </table>
    <p class="events-empty" hidden>No subscribers derived yet — they appear as webhook events arrive.</p>
    <p class="events-error" role="alert" hidden></p>
  `;

  const sinceInput = container.querySelector<HTMLInputElement>('.filter-since')!;
  const clearButton = container.querySelector<HTMLButtonElement>('.filter-clear')!;
  const count = container.querySelector<HTMLSpanElement>('.filter-count')!;
  const table = container.querySelector<HTMLTableElement>('.subscribers-table')!;
  const tbody = table.querySelector('tbody')!;
  const empty = container.querySelector<HTMLParagraphElement>('.events-empty')!;
  const error = container.querySelector<HTMLParagraphElement>('.events-error')!;

  // Default the filter to the previous visit, then record this one.
  const lastVisit = Number(localStorage.getItem(LAST_VISIT_KEY));
  if (Number.isFinite(lastVisit) && lastVisit > 0) sinceInput.value = toDatetimeLocal(lastVisit);
  localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));

  let all: Subscriber[] = [];

  function applyFilter(): void {
    const sinceMs = sinceInput.value ? new Date(sinceInput.value).getTime() : NaN;
    const filtered = Number.isFinite(sinceMs)
      ? all.filter((s) => s.statusChangedTs !== null && s.statusChangedTs * 1000 >= sinceMs)
      : all;

    tbody.textContent = '';
    for (const sub of filtered) tbody.append(renderRow(sub));
    table.hidden = filtered.length === 0;
    empty.hidden = all.length > 0;
    count.textContent = Number.isFinite(sinceMs)
      ? `${filtered.length} of ${all.length} changed since ${new Date(sinceMs).toLocaleString()}`
      : `${all.length} subscribers`;
  }

  sinceInput.addEventListener('change', applyFilter);
  clearButton.addEventListener('click', () => {
    sinceInput.value = '';
    applyFilter();
  });

  api<{ subscribers: Subscriber[] }>('/api/subscribers').then(
    (page) => {
      all = page.subscribers.sort(
        (a, b) => (b.statusChangedTs ?? -Infinity) - (a.statusChangedTs ?? -Infinity),
      );
      applyFilter();
    },
    (err: unknown) => {
      error.textContent = err instanceof Error ? err.message : 'Failed to load subscribers.';
      error.hidden = false;
    },
  );
}

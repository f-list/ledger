import { api } from './api';
import { cell, formatCost, linkCell, subscribeStarProfileUrl } from './table';

interface LedgerEvent {
  id: number;
  receivedAt: string;
  eventType: string;
  eventTs: number;
  subscriberId: string | null;
  nickname: string | null;
  tierId: string | null;
  tierName: string | null;
  costCents: number | null;
}

interface EventsPage {
  events: LedgerEvent[];
  nextBefore: number | null;
}

const ROW_CLASS: Record<string, string> = {
  new_subscription: 'event-row--good',
  subscription_restored: 'event-row--good',
  payment_succeed: 'event-row--good',
  subscription_cancelled: 'event-row--bad',
  payment_disputed: 'event-row--bad',
  subscription_billing_failed: 'event-row--warn',
  recurring_pledge_decreased: 'event-row--warn',
};

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function renderRow(event: LedgerEvent): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const rowClass = ROW_CLASS[event.eventType];
  if (rowClass) tr.className = rowClass;

  tr.append(
    cell(
      formatTime(event.eventTs),
      `Happened: ${formatTime(event.eventTs)}\nReceived: ${new Date(event.receivedAt).toLocaleString()}`,
    ),
    cell(event.eventType),
    (event.nickname && event.subscriberId ?
      linkCell(event.nickname, subscribeStarProfileUrl(event.subscriberId), `Subscriber ID: ${event.subscriberId}`) :
      cell(event.nickname ?? '(unknown)', event.subscriberId ? `Subscriber ID: ${event.subscriberId}` : undefined)
    ),
    cell(event.subscriberId ?? ''),
    cell(event.tierName ?? event.tierId ?? '', event.tierId ? `Tier ID: ${event.tierId}` : undefined),
    cell(formatCost(event.costCents)),
  );
  return tr;
}

export function renderEvents(container: HTMLElement): void {
  container.innerHTML = `
    <table class="events-table" hidden>
      <thead>
        <tr><th>Time</th><th>Event</th><th>Subscriber</th><th>ID</th><th>Tier</th><th>Amount</th></tr>
      </thead>
      <tbody></tbody>
    </table>
    <p class="events-empty" hidden>No events yet — the ledger populates as SubscribeStar webhooks arrive.</p>
    <p class="events-error" role="alert" hidden></p>
    <button class="events-more" type="button" hidden>Load more</button>
  `;

  const table = container.querySelector<HTMLTableElement>('.events-table')!;
  const tbody = table.querySelector('tbody')!;
  const empty = container.querySelector<HTMLParagraphElement>('.events-empty')!;
  const error = container.querySelector<HTMLParagraphElement>('.events-error')!;
  const moreButton = container.querySelector<HTMLButtonElement>('.events-more')!;

  let nextBefore: number | null = null;
  let loadedAny = false;

  async function loadPage(): Promise<void> {
    moreButton.disabled = true;
    error.hidden = true;
    try {
      const query = nextBefore === null ? '' : `?before=${nextBefore}`;
      const page = await api<EventsPage>(`/api/events${query}`);
      for (const event of page.events) tbody.append(renderRow(event));
      loadedAny = loadedAny || page.events.length > 0;
      nextBefore = page.nextBefore;

      table.hidden = !loadedAny;
      empty.hidden = loadedAny;
      moreButton.hidden = nextBefore === null;
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : 'Failed to load events.';
      error.hidden = false;
    } finally {
      moreButton.disabled = false;
    }
  }

  moreButton.addEventListener('click', () => void loadPage());
  void loadPage();
}

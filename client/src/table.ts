/** Shared table-rendering helpers for the Events and Subscribers views. */

export function cell(text: string, title?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (title) td.title = title;
  return td;
}

export function linkCell(text: string, href: string, title?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  const a = document.createElement('a');
  a.textContent = text;
  a.href = href;
  if (title) a.title = title;
  td.append(a);
  return td;
}

export function formatCost(costCents: number | null): string {
  return costCents === null ? '' : `$${(costCents / 100).toFixed(2)}`;
}

export function subscribeStarProfileUrl(subscriberId: string): string {
  return `https://www.subscribestar.adult/subscribers/${subscriberId}`;
}

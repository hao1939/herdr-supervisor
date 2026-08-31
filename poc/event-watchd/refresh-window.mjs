// Remembered resources can outnumber the reread budget of one scan. The cursor
// hands each scan the next bounded window so every remembered resource is
// refreshed within a bounded number of scans. It is disposable: after a restart
// the window simply starts again from the beginning.
export function boundedRefreshWindow(limit) {
  let cursor = 0;
  return (known = []) => {
    const items = Array.isArray(known) ? known : [];
    if (items.length <= limit) return items;
    const start = cursor % items.length;
    cursor = start + limit;
    return [...items, ...items].slice(start, start + limit);
  };
}

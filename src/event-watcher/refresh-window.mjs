// Resources can outnumber the budget of one scan. Keep the remaining identities
// from the current pass so insertions at the front of a provider page cannot
// make the same items repeat forever. This queue is disposable: after a restart
// the window simply starts again from the beginning.
export function boundedRefreshWindow(limit, identity) {
  let remaining = [];
  return (known = [], requested = limit) => {
    const items = Array.isArray(known) ? known : [];
    const size = Math.min(items.length, limit, Math.max(0, requested));
    if (items.length <= size) {
      remaining = [];
      return items;
    }
    const current = new Map(items.map((item) => [identity(item), item]));
    remaining = remaining.filter((key) => current.has(key));
    const selected = [];
    const selectedKeys = new Set();
    while (selected.length < size) {
      if (!remaining.length) {
        remaining = [...current.keys()].filter((key) => !selectedKeys.has(key));
        if (!remaining.length) break;
      }
      const keys = remaining.splice(0, size - selected.length);
      for (const key of keys) {
        selectedKeys.add(key);
        selected.push(current.get(key));
      }
    }
    return selected;
  };
}

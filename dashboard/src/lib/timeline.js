// Judge timeline paging. The ledger is in seq order. Each poll asks for events after the
// cursor (since_seq = highest seq already held). The server docs do not say whether since_seq
// is inclusive, so merging dedupes by seq: either reading gives the same list.

// Merge a page into the events already held: dedupe by seq, keep seq order.
export function mergeEvents(held, incoming) {
  const bySeq = new Map();
  for (const ev of [...held, ...incoming]) bySeq.set(ev.seq, ev);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// The cursor only moves forward. An empty page keeps the old cursor.
export function nextSinceSeq(cursor, incoming) {
  return incoming.reduce((max, ev) => Math.max(max, ev.seq), cursor);
}

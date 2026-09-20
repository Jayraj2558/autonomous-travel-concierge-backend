/**
 * Dates travel through the domain as Date objects but must leave the API as ISO
 * strings, so every response is normalised here. Keeps the TypeScript client
 * types honest and the WebSocket payloads identical to the REST payloads.
 *
 * Uses a DFS ancestor set: shared references are duplicated (an option appears
 * both in the ranked list and as the selected decision) while genuine cycles are
 * broken.
 */
export function serialize(value, stack = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => serialize(item, stack));
  if (stack.has(value)) return undefined;

  stack.add(value);
  const out = {};
  Object.entries(value).forEach(([key, item]) => {
    out[key] = serialize(item, stack);
  });
  stack.delete(value);
  return out;
}

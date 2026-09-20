/** Deep copy helper — structuredClone with a JSON fallback for exotic values. */
export function depth(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* falls through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export const deepCopy = depth;

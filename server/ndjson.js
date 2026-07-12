/**
 * NDJSON (newline-delimited JSON) split and serialize utilities.
 * Pure module — no I/O, no side effects.
 */

/**
 * Creates a stateful splitter that accumulates chunks and emits complete JSON lines.
 * @returns {{ push(chunk: string): string[], reset(): void }}
 */
export function createSplitter() {
  let buf = '';

  return {
    push(chunk) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop(); // last element is incomplete (or empty after trailing newline)
      return lines.filter(l => l.length > 0);
    },
    reset() {
      buf = '';
    },
  };
}

/**
 * Serialize an object to a single NDJSON line (object + newline).
 * @param {unknown} obj
 * @returns {string}
 */
export function serialize(obj) {
  return JSON.stringify(obj) + '\n';
}

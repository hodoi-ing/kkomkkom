export interface BodyRead {
  text: string;
  /** True when reading stopped at the caller's byte limit. */
  truncated: boolean;
}

// Reads at most `limit` bytes and cancels the rest. Transport errors and aborts
// reject: a partial body must not look like a complete response. The caller's
// AbortSignal bounds the wait; this only bounds memory.
export async function readBody(res: Response, limit: number): Promise<BodyRead> {
  const body = res.body;
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = limit - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  // Reaching the limit means we stopped before observing EOF.
  if (total >= limit) truncated = true;
  return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), truncated };
}

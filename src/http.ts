// Reads at most `limit` bytes from a fetch response and cancels the rest.
// The caller's AbortSignal bounds the wait; this only bounds memory.
export async function readBody(res: Response, limit: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    .subarray(0, limit)
    .toString("utf8");
}

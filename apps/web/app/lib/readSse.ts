/**
 * Minimal SSE frame reader over a fetch() streaming body. Not using the
 * browser's native EventSource because that's GET-only with no request
 * body; this is the same "fetch + manual stream reading" posture
 * personal-assistant-mobile already uses (there because RN's fetch can't
 * stream at all, here because we need POST). One parser, reusable by any
 * future client that talks to this same API.
 */
export async function readSse(
  response: Response,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  if (!response.body) throw new Error('Response has no body to stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd: number;
    while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);

      let event = 'message';
      let dataLine = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        else if (line.startsWith('data: ')) dataLine = line.slice('data: '.length);
      }
      if (dataLine) onEvent(event, JSON.parse(dataLine));
    }
  }
}

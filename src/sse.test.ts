import { describe, it, expect } from 'vitest';
import { splitSSEFrames, parseSSEFrame, readSSEStream, type SSEEvent } from './sse';

describe('splitSSEFrames', () => {
  it('splits complete frames and keeps the partial remainder', () => {
    const { frames, rest } = splitSSEFrames('data: a\n\ndata: b\n\ndata: c');
    expect(frames).toEqual(['data: a', 'data: b']);
    expect(rest).toBe('data: c');
  });

  it('no complete frame yet → empty frames, whole buffer is remainder', () => {
    const { frames, rest } = splitSSEFrames('data: partial');
    expect(frames).toEqual([]);
    expect(rest).toBe('data: partial');
  });
});

describe('parseSSEFrame', () => {
  it('parses the data line as JSON', () => {
    expect(parseSSEFrame('data: {"type":"log","message":"hi"}')).toEqual({
      type: 'log',
      message: 'hi',
    });
  });

  it('returns null when there is no data line', () => {
    expect(parseSSEFrame('event: ping\nid: 1')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseSSEFrame('data: {not json')).toBeNull();
  });
});

describe('readSSEStream', () => {
  function streamOf(chunks: string[]): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(body);
  }

  it('emits an event per frame, across chunk boundaries', async () => {
    const got: SSEEvent[] = [];
    // a frame deliberately split across two chunks
    const res = streamOf([
      'data: {"type":"log","message":"one"}\n\ndata: {"type":"lo',
      'g","message":"two"}\n\ndata: {"type":"done","code":0}\n\n',
    ]);
    await readSSEStream(res, (e) => got.push(e));
    expect(got).toEqual([
      { type: 'log', message: 'one' },
      { type: 'log', message: 'two' },
      { type: 'done', code: 0 },
    ]);
  });

  it('flushes a final frame with no trailing blank line', async () => {
    const got: SSEEvent[] = [];
    const res = streamOf(['data: {"type":"done","code":1}']);
    await readSSEStream(res, (e) => got.push(e));
    expect(got).toEqual([{ type: 'done', code: 1 }]);
  });
});

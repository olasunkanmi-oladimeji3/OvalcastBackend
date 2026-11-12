// Messages between server processes: live balls for viewers, and "this changed" notices
// so each process drops its cached copy. One process needs nothing else; set REDIS_URL
// when running more than one, and every process hears every message.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

type Handler = (data: unknown) => void;

const local = new EventEmitter();
local.setMaxListeners(0);
const ORIGIN = randomUUID();
const CHANNEL = 'ovalcast:bus';

let redisPub: { publish(channel: string, message: string): Promise<unknown> } | undefined;

/** Connects to Redis when REDIS_URL is set. Safe to call more than once. */
let started: Promise<void> | undefined;
export function startBus(log: (msg: string) => void = () => {}) {
  if (started) return started;
  started = (async () => {
    const url = process.env.REDIS_URL;
    if (!url) return;
    const { Redis } = await import('ioredis');
    const pub = new Redis(url, { maxRetriesPerRequest: 2 });
    const sub = new Redis(url);
    await sub.subscribe(CHANNEL);
    sub.on('message', (_channel: string, raw: string) => {
      const m = JSON.parse(raw) as { origin: string; topic: string; data: unknown };
      // This process already handled its own messages when it sent them.
      if (m.origin !== ORIGIN) local.emit(m.topic, m.data);
    });
    redisPub = pub;
    log('Live messages and cache notices go through Redis');
  })();
  return started;
}

/** Sends to this process straight away, and to every other process through Redis. */
export function emit(topic: string, data: unknown) {
  local.emit(topic, data);
  if (redisPub) void redisPub.publish(CHANNEL, JSON.stringify({ origin: ORIGIN, topic, data })).catch(() => {});
}

export function on(topic: string, fn: Handler) {
  local.on(topic, fn);
  return () => void local.off(topic, fn);
}

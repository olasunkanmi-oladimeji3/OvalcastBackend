// Live match messages for viewers (server-sent events). Each message is turned into text
// once, however many people are watching, and the last few hundred are kept per match so a
// viewer whose connection drops gets only what they missed when it comes back.
// Across several server processes, messages travel through the bus (Redis).

import { EventEmitter } from 'node:events';
import type { LiveMessage } from '@/api/types';
import { emit, on } from './bus';

interface Frame {
  id: number;
  /** For the apps and website. */
  text: string;
  /** With the message type as the event name, for the partner API. */
  named: string;
}

const KEEP = 400; // a full T20 innings and then some
const viewers = new EventEmitter();
viewers.setMaxListeners(0);
const partners = new EventEmitter();
partners.setMaxListeners(0);
const recent = new Map<string, { frames: Frame[]; touched: number }>();
const taps = new Set<(matchId: string, msg: LiveMessage) => void>();

let last = 0;
/** Increasing ids, unique across processes for practical purposes: milliseconds and a counter. */
const nextId = () => (last = Math.max(last + 1, Date.now() * 1000));

on('live', (data) => {
  const { matchId, id, msg } = data as { matchId: string; id: number; msg: LiveMessage };
  const body = JSON.stringify(msg);
  const frame: Frame = { id, text: `id: ${id}\ndata: ${body}\n\n`, named: `id: ${id}\nevent: ${msg.type}\ndata: ${body}\n\n` };
  const r = recent.get(matchId) ?? { frames: [], touched: 0 };
  r.frames.push(frame);
  if (r.frames.length > KEEP) r.frames.splice(0, r.frames.length - KEEP);
  r.touched = Date.now();
  recent.set(matchId, r);
  taps.forEach((t) => t(matchId, msg));
  viewers.emit(matchId, frame.text);
  if (partners.listenerCount(matchId)) partners.emit(matchId, frame.named);
});

// Matches nobody has scored for in six hours drop their kept messages.
setInterval(() => {
  const old = Date.now() - 6 * 3600_000;
  for (const [id, r] of recent) if (r.touched < old) recent.delete(id);
}, 600_000).unref();

/** Sends a message to everyone watching the match, on every server process. */
export const publish = (matchId: string, msg: LiveMessage) => emit('live', { matchId, id: nextId(), msg });

/** Called for every live message on this process, including other processes' (keeps caches current). */
export const tapLive = (fn: (matchId: string, msg: LiveMessage) => void) => (taps.add(fn), () => void taps.delete(fn));

/** A viewer's feed: ready-made text frames. Returns the frames they missed since `afterId`. */
export function subscribe(matchId: string, send: (frame: string) => void, afterId?: number, opts: { named?: boolean } = {}) {
  if (afterId) for (const f of recent.get(matchId)?.frames ?? []) if (f.id > afterId) send(opts.named ? f.named : f.text);
  const hub = opts.named ? partners : viewers;
  hub.on(matchId, send);
  return () => void hub.off(matchId, send);
}

/** How many viewers this process is serving for a match. */
export const watching = (matchId: string) => viewers.listenerCount(matchId);

// Live feeds open on this process, so a shutdown can end them instead of waiting for the match to
// finish. Browsers and the app reconnect on their own and resume from the last message they had.
const openFeeds = new Set<{ end(): void; on(event: 'close', fn: () => void): unknown }>();
export function trackFeed(res: { end(): void; on(event: 'close', fn: () => void): unknown }) {
  openFeeds.add(res);
  res.on('close', () => openFeeds.delete(res));
}
export function endFeeds() {
  for (const res of openFeeds) res.end();
  openFeeds.clear();
}

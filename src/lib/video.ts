// Live video through Cloudflare Stream. Each stream gets a live input: an RTMPS address and key for
// the phone or encoder, an HLS address viewers play, a recording for the replay, and (for free
// streams) a restream to the organisation's or club's YouTube channel.
//
// Switched on by setting, on the API server:
//   CLOUDFLARE_ACCOUNT_ID             the Cloudflare account
//   CLOUDFLARE_STREAM_TOKEN           an API token with Stream: Edit
//   CLOUDFLARE_STREAM_CUSTOMER_CODE   the customer-<code>.cloudflarestream.com subdomain, from the Stream dashboard
//   CLOUDFLARE_STREAM_WEBHOOK_SECRET  optional: the secret on the Cloudflare notification webhook
// Without them, a development stand-in is used and no video is sent anywhere.

const API = 'https://api.cloudflare.com/client/v4';

export const videoConfigured = () => !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_STREAM_TOKEN && process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE);

const base = () => `${API}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/stream`;
const host = () => `https://customer-${process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE}.cloudflarestream.com`;

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_STREAM_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const out = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
  if (!res.ok || out.success === false) throw new Error(`Cloudflare Stream: ${out.errors?.map((e) => e.message).join('; ') || res.status}`);
  return out.result as T;
}

export interface LiveInput {
  uid: string;
  rtmps: { url: string; streamKey: string };
  playbackUrl: string;
}

/** A new live input for one match's stream, recorded for the replay. */
export async function createLiveInput(name: string): Promise<LiveInput> {
  const r = await cf<{ uid: string; rtmps: { url: string; streamKey: string } }>('POST', '/live_inputs', { meta: { name }, recording: { mode: 'automatic', timeoutSeconds: 120 } });
  return { uid: r.uid, rtmps: r.rtmps, playbackUrl: `${host()}/${r.uid}/manifest/video.m3u8` };
}

/** Restreams the input to YouTube (or any RTMP address) as it arrives. */
export async function addRestream(uid: string, url: string, streamKey: string) {
  await cf('POST', `/live_inputs/${uid}/outputs`, { url, streamKey, enabled: true });
}

/** The recording of a finished live input, for the replay: the newest one that's ready. */
export async function recordingOf(uid: string): Promise<string | undefined> {
  const videos = await cf<{ uid: string; readyToStream?: boolean; status?: { state?: string } }[]>('GET', `/live_inputs/${uid}/videos`);
  const ready = videos.find((v) => v.readyToStream || v.status?.state === 'ready');
  return ready ? `${host()}/${ready.uid}/manifest/video.m3u8` : undefined;
}

/** Stops the input taking video (the recording stays). */
export async function closeLiveInput(uid: string) {
  await cf('PUT', `/live_inputs/${uid}`, { enabled: false }).catch(() => undefined);
}

// What a deep function needs to know about the request it's serving, without passing it down
// through every call: for now, the website address a browser request came from.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

const store = new AsyncLocalStorage<{ origin?: string }>();

/** The Origin header of the request being served: set by browsers, absent from the app. */
export const requestOrigin = () => store.getStore()?.origin;

export function requestContext(app: FastifyInstance) {
  app.addHook('onRequest', (req, _reply, done) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/$/, '') : undefined;
    store.run({ origin }, done);
  });
}

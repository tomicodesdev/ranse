import { Hono } from 'hono';
import type { Env } from '../env';

export const assetsApp = new Hono<{ Bindings: Env }>();

// Public, unauthenticated. These URLs land in outbound emails — recipient
// mail clients aren't logged in, so the bytes have to be readable without
// a session. Keys are workspace-scoped + random-suffixed so they're
// unguessable, which is the access control here.
assetsApp.get('/*', async (c) => {
  const path = c.req.path.replace(/^\/+/, '');
  const obj = await c.env.BLOB.get(path);
  if (!obj) return c.text('Not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers as unknown as Parameters<typeof obj.writeHttpMetadata>[0]);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=86400, immutable');
  return new Response(obj.body as unknown as BodyInit, { headers });
});

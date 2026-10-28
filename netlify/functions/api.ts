// Netlify Function: the link-parsing API (see server/api.ts) on the published site. The same
// handler runs in the Vite dev server and could run as a Cloudflare Worker (worker/index.ts).
import { handleApi } from '../../server/api';

export default async (req: Request): Promise<Response> =>
  (await handleApi(req)) ?? new Response('not found', { status: 404 });

/** Netlify routes every /api/… request to this function. */
export const config = { path: '/api/*' };

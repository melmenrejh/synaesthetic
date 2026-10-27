// Cloudflare Worker: the production home of the link-parsing API (see server/api.ts).
// Deploy with `npx wrangler deploy` once a Cloudflare account is connected.
import { handleApi } from '../server/api';

export default {
  async fetch(req: Request): Promise<Response> {
    return (await handleApi(req)) ?? new Response('not found', { status: 404 });
  },
};

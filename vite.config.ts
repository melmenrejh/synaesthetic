import { defineConfig, type Connect, type Plugin } from 'vite';
import { handleApi } from './server/api';

// In development the link-parsing API runs inside the Vite server; in production the same
// handler runs as a Cloudflare Worker (worker/index.ts).
const apiMiddleware: Connect.NextHandleFunction = async (req, res, next) => {
  if (!req.url?.startsWith('/api/')) return next();
  try {
    const response = await handleApi(new Request(`http://localhost${req.url}`, { method: req.method }));
    if (!response) return next();
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
};

const api = (): Plugin => ({
  name: 'synaesthetic-api',
  configureServer: (server) => void server.middlewares.use(apiMiddleware),
  configurePreviewServer: (server) => void server.middlewares.use(apiMiddleware),
});

export default defineConfig({
  plugins: [api()],
  // top-level await in main.ts; every browser that runs the 3D shelf supports it
  build: { target: 'es2022' },
  // host: true opens the dev server to phones on the same Wi-Fi.
  server: { host: true, port: Number(process.env.PORT) || 5173 },
  preview: { host: true, port: 4173 },
});

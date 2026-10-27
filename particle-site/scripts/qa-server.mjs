import { createServer } from 'node:http';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQaSink, json, serveFile } from './qa-sink.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml',
};
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const within = (base, path) => {
  const part = relative(base, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};

async function containedFile(base, path) {
  if (!within(base, path) || !within(await realpath(base), await realpath(path))) {
    const error = new Error('Outside QA files'); error.code = 'ENOENT'; throw error;
  }
  return path;
}

/** Standalone local QA only; neither this server nor historical QA pages enter out/. */
export function createQaServer({ root = PROJECT_ROOT } = {}) {
  root = resolve(root);
  const sink = createQaSink(root);
  const inlineModules = new Map();
  const bundle = async (entry) => {
    const { build } = await import('esbuild');
    const built = await build({
      absWorkingDir: root, bundle: true, write: false, platform: 'browser',
      format: 'esm', target: 'es2022', logLevel: 'silent',
      define: { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'import.meta.env.MODE': '"development"' },
      ...entry,
      plugins: [{ name: 'local-qa-root-imports', setup(build) {
        build.onResolve({ filter: /^\// }, args => {
          // On Linux, esbuild's absolute file entry points also start with '/'.
          if (args.kind === 'entry-point' && within(root, args.path)) return;
          if (args.path.startsWith('/artifacts/')) return { path: args.path, external: true };
          if (args.path.startsWith('/src/') || args.path.startsWith('/tests/')) {
            const path = resolve(root, '.' + args.path.split(/[?#]/)[0]);
            if (!within(root, path)) return { errors: [{ text: 'QA import is outside the project' }] };
            return { path };
          }
          return { errors: [{ text: `Unsupported local QA import: ${args.path}` }] };
        });
      } }],
    });
    return built.outputFiles[0].text;
  };
  const sendText = (request, response, body, mime) => {
    response.writeHead(200, { 'Content-Type': mime, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1:5174');
      // Bind loopback and reject non-loopback Host names to keep this a local tool.
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
          !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(request.headers.host || '')) {
        json(response, 403, { error: 'QA 服务仅允许本地访问。' }); return;
      }
      if (await sink(request, response, url)) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        json(response, 405, { error: '仅支持 GET 或 HEAD。' }); return;
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (pathname === '/') {
        const pages = (await readdir(root)).filter(name => /^(?:qa|[a-z0-9-]+-qa|perf-probe)\.html$/.test(name));
        const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>粒子工坊 · 本地 QA</title>' +
          '<h1>粒子工坊 · 本地 QA</h1><p>仅供本地验证；正式编辑器位于 5173 端口，测试结果保存在 artifacts。</p><ul>' +
          pages.map(name => `<li><a href="/${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`).join('') +
          '<li><a href="/tests/engine-gpu.html">engine-gpu.html</a></li><li><a href="/tests/petal-trails-gpu.html">petal-trails-gpu.html</a></li></ul></html>';
        sendText(request, response, html, MIME['.html']); return;
      }
      if (pathname.startsWith('/__qa/modules/')) {
        const entry = inlineModules.get(pathname);
        if (!entry) { json(response, 404, { error: '请先打开对应 QA 页面。' }); return; }
        sendText(request, response, await bundle(entry), MIME['.js']); return;
      }
      const rootPage = /^\/(?:qa|[a-z0-9-]+-qa|perf-probe)\.html$/.test(pathname);
      const gpuPage = /^\/tests\/[a-z0-9-]+-gpu\.html$/.test(pathname);
      if (rootPage || gpuPage) {
        const path = await containedFile(root, resolve(root, '.' + pathname));
        let scriptIndex = 0;
        const html = (await readFile(path, 'utf8')).replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (full, attributes, contents) => {
          if (!/\btype\s*=\s*["']module["']/i.test(attributes)) return full;
          const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
          const modulePath = `/__qa/modules/${Buffer.from(pathname).toString('base64url')}-${scriptIndex++}.js`;
          const sourcePath = src && new URL(src, 'http://127.0.0.1:5174' + pathname).pathname;
          const entry = src
            ? { entryPoints: [resolve(root, '.' + sourcePath)] }
            : { stdin: { contents, resolveDir: dirname(path), sourcefile: path + '.inline.js', loader: 'js' } };
          inlineModules.set(modulePath, entry);
          return `<script type="module" src="${modulePath}"></script>`;
        });
        sendText(request, response, html, MIME['.html']); return;
      }
      if (/^\/src\/[a-zA-Z0-9/_-]+\.(?:ts|tsx|js)$/.test(pathname) || /^\/tests\/[a-zA-Z0-9/_-]+\.js$/.test(pathname)) {
        const path = await containedFile(root, resolve(root, '.' + pathname));
        sendText(request, response, await bundle({ entryPoints: [path] }), MIME['.js']); return;
      }
      for (const [prefix, directory] of [['/examples/', 'public/examples'], ['/artifacts/', 'artifacts']]) {
        if (!pathname.startsWith(prefix)) continue;
        const base = resolve(root, directory);
        const path = await containedFile(base, resolve(base, pathname.slice(prefix.length)));
        await serveFile(request, response, path, MIME[extname(path).toLowerCase()] || 'application/octet-stream'); return;
      }
      json(response, 404, { error: '未找到本地 QA 资源。' }, request.method);
    } catch (error) {
      if (!response.headersSent) json(response, error?.code === 'ENOENT' ? 404 : 500, {
        error: error?.code === 'ENOENT' ? '未找到本地 QA 资源。' : 'QA 模块编译或读取失败。',
        ...(error?.code !== 'ENOENT' ? { detail: String(error.message || error) } : {}),
      }, request.method);
      else response.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createQaServer();
  server.listen(5174, '127.0.0.1', () => console.log('Local QA: http://127.0.0.1:5174/'));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}

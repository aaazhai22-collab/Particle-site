import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_REPORT_BYTES = 50 * 1024;

async function boundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > limit) throw new Error('too-large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('too-large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function json(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Explicit local development QA sink; absent from production build/preview. */
export function qaSink(): Plugin {
  return {
    name: 'particle-local-browser-qa',
    apply: 'serve',
    configureServer(server) {
      const output = resolve(server.config.root, 'artifacts');
      let savedVideo: { path: string; mime: string; filename: string } | null = null;
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        if (pathname !== '/__qa/video' && pathname !== '/__qa/report') return next();
        try {
          if (request.method === 'POST') {
            // The visible QA page makes a deliberate same-origin request with this header.
            if (request.headers['x-particle-qa'] !== '1') return json(response, 403, { error: '请从本地 QA 页面点击运行。' });
            const origin = request.headers.origin;
            if (origin && new URL(origin).host !== request.headers.host) return json(response, 403, { error: '只允许同源本地 QA 请求。' });
            await mkdir(output, { recursive: true });
            if (pathname === '/__qa/video') {
              const type = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
              if (type !== 'video/mp4' && type !== 'video/webm') return json(response, 415, { error: '仅接收真实 MP4 或 WebM 录像。' });
              const body = await boundedBody(request, MAX_VIDEO_BYTES);
              if (!body.length) return json(response, 400, { error: '录像内容为空。' });
              const filename = `browser-test.${type === 'video/mp4' ? 'mp4' : 'webm'}`;
              const path = resolve(output, filename);
              await writeFile(path, body);
              savedVideo = { path, mime: type, filename };
              return json(response, 200, { path: `artifacts/${filename}`, url: `/artifacts/${filename}`, bytes: body.length, mimeType: type });
            }
            const body = await boundedBody(request, MAX_REPORT_BYTES);
            const report = JSON.parse(body.toString('utf8'));
            await writeFile(resolve(output, 'browser-test.json'), JSON.stringify(report, null, 2), 'utf8');
            return json(response, 200, { path: 'artifacts/browser-test.json', url: '/artifacts/browser-test.json' });
          }
          if (request.method === 'GET' || request.method === 'HEAD') {
            if (pathname === '/__qa/report') {
              const report = JSON.parse(await readFile(resolve(output, 'browser-test.json'), 'utf8'));
              return json(response, 200, report);
            }
            if (!savedVideo) {
              const candidates = await Promise.all(['mp4', 'webm'].map(async extension => {
                const path = resolve(output, `browser-test.${extension}`);
                try { const info = await stat(path); return { path, mime: `video/${extension}`, filename: `browser-test.${extension}`, modified: info.mtimeMs }; }
                catch { return null; }
              }));
              savedVideo = candidates.filter(item => item !== null).sort((a, b) => b!.modified - a!.modified)[0] || null;
            }
            if (!savedVideo) return json(response, 404, { error: '尚未生成 QA 录像。' });
            const size = (await stat(savedVideo.path)).size;
            const range = request.headers.range;
            let start = 0;
            let end = size - 1;
            if (range) {
              const match = /^bytes=(\d*)-(\d*)$/.exec(range);
              if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); return response.end(); }
              if (!match[1]) start = Math.max(0, size - Number(match[2]));
              else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
              if (start > end || start >= size) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); return response.end(); }
            }
            response.writeHead(range ? 206 : 200, {
              'Content-Type': savedVideo.mime, 'Content-Length': end - start + 1,
              'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
              ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
            });
            if (request.method === 'HEAD') return response.end();
            createReadStream(savedVideo.path, { start, end }).pipe(response);
            return;
          }
          return json(response, 405, { error: '仅支持 GET、HEAD 或 POST。' });
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'too-large';
          const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
          if (!response.headersSent) json(response, tooLarge ? 413 : missing ? 404 : 500, { error: tooLarge ? '超过 QA 数据容量限制。' : missing ? '尚未保存测试结果。' : '保存或读取 QA 结果失败。' });
        }
      });
    },
  };
}

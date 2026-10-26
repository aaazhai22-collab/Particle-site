import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_REPORT_BYTES = 50 * 1024;
export const MAX_FRAME_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function boundedBody(request, limit) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > limit) throw new Error('too-large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('too-large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

export function json(response, code, value, method = 'GET') {
  const body = JSON.stringify(value);
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(method === 'HEAD' ? undefined : body);
}

/** Serve a saved local artifact, including media ranges needed by video seeking. */
export async function serveFile(request, response, path, mime) {
  const info = await stat(path);
  if (!info.isFile()) { const error = new Error('Not a file'); error.code = 'ENOENT'; throw error; }
  const size = info.size;
  const range = request.headers.range;
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalidRange = () => {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
      response.end();
    };
    if (!match || (!match[1] && !match[2])) return invalidRange();
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalidRange();
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return invalidRange();
  }
  response.writeHead(range ? 206 : 200, {
    'Content-Type': mime, 'Content-Length': size ? end - start + 1 : 0,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === 'HEAD' || !size) return response.end();
  createReadStream(path, { start, end }).on('error', () => response.destroy()).pipe(response);
}

/** Explicit loopback QA sink. This module is never imported by the Next.js app. */
export function createQaSink(root) {
  const output = resolve(root, 'artifacts');
  let savedVideo = null;
  return async (request, response, url) => {
    const pathname = url.pathname;
    if (!['/__qa/video', '/__qa/report', '/__qa/frame'].includes(pathname)) return false;
    try {
      if (request.method === 'POST') {
        if (request.headers['x-particle-qa'] !== '1') {
          json(response, 403, { error: '请从本地 QA 页面点击运行。' }); return true;
        }
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) {
          json(response, 403, { error: '只允许同源本地 QA 请求。' }); return true;
        }
        await mkdir(output, { recursive: true });
        if (pathname === '/__qa/frame') {
          const name = String(request.headers['x-particle-name'] || 'petal-frame');
          if (!/^petal-[a-z0-9-]{1,60}$/.test(name) || request.headers['content-type'] !== 'image/png') {
            json(response, 400, { error: '请使用合法的花朵 PNG 验证名称。' }); return true;
          }
          const body = await boundedBody(request, MAX_FRAME_BYTES);
          if (body.length < PNG_SIGNATURE.length || !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
            json(response, 415, { error: '只接收实际 PNG 截图。' }); return true;
          }
          await writeFile(resolve(output, name + '.png'), body);
          json(response, 200, { path: 'artifacts/' + name + '.png' }); return true;
        }
        if (pathname === '/__qa/video') {
          const type = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (type !== 'video/mp4' && type !== 'video/webm') {
            json(response, 415, { error: '仅接收真实 MP4 或 WebM 录像。' }); return true;
          }
          const body = await boundedBody(request, MAX_VIDEO_BYTES);
          if (!body.length) { json(response, 400, { error: '录像内容为空。' }); return true; }
          const filename = `browser-test.${type === 'video/mp4' ? 'mp4' : 'webm'}`;
          const path = resolve(output, filename);
          await writeFile(path, body);
          savedVideo = { path, mime: type, filename };
          json(response, 200, { path: `artifacts/${filename}`, url: `/artifacts/${filename}`, bytes: body.length, mimeType: type });
          return true;
        }
        const body = await boundedBody(request, MAX_REPORT_BYTES);
        let report;
        try { report = JSON.parse(body.toString('utf8')); }
        catch { json(response, 400, { error: '请提供合法 JSON 测试报告。' }); return true; }
        await writeFile(resolve(output, 'browser-test.json'), JSON.stringify(report, null, 2), 'utf8');
        json(response, 200, { path: 'artifacts/browser-test.json', url: '/artifacts/browser-test.json' }); return true;
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (pathname === '/__qa/report') {
          const report = JSON.parse(await readFile(resolve(output, 'browser-test.json'), 'utf8'));
          json(response, 200, report, request.method); return true;
        }
        if (pathname === '/__qa/frame') {
          const name = url.searchParams.get('name') || 'petal-frame';
          if (!/^petal-[a-z0-9-]{1,60}$/.test(name)) {
            json(response, 400, { error: '请使用合法的花朵 PNG 验证名称。' }, request.method); return true;
          }
          await serveFile(request, response, resolve(output, name + '.png'), 'image/png'); return true;
        }
        if (!savedVideo) {
          const candidates = await Promise.all(['mp4', 'webm'].map(async extension => {
            const path = resolve(output, `browser-test.${extension}`);
            try { const info = await stat(path); return { path, mime: `video/${extension}`, filename: `browser-test.${extension}`, modified: info.mtimeMs }; }
            catch { return null; }
          }));
          savedVideo = candidates.filter(Boolean).sort((a, b) => b.modified - a.modified)[0] || null;
        }
        if (!savedVideo) { json(response, 404, { error: '尚未生成 QA 录像。' }, request.method); return true; }
        await serveFile(request, response, savedVideo.path, savedVideo.mime); return true;
      }
      json(response, 405, { error: '仅支持 GET、HEAD 或 POST。' }); return true;
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'too-large';
      const missing = error?.code === 'ENOENT';
      if (!response.headersSent) json(response, tooLarge ? 413 : missing ? 404 : 500, {
        error: tooLarge ? '超过 QA 数据容量限制。' : missing ? '尚未保存测试结果。' : '保存或读取 QA 结果失败。',
      }, request.method);
      return true;
    }
  };
}

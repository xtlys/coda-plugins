import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { save, statePath } from './manager.mjs';

const page = await readFile(new URL('./configure.html', import.meta.url), 'utf8');
const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A short-lived, loopback-only form. No key appears in a URL, a command argument or an HTML response.
export function configure({ state = statePath(), signal, onReady = console.log, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const path = `/${randomBytes(24).toString('hex')}`;
    let origin, finished = false, saving = false;
    const server = createServer(async (request, response) => {
      const send = (status, body, type = 'text/html; charset=utf-8') => {
        response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
          'X-Content-Type-Options': 'nosniff' });
        response.end(body);
      };
      if (request.headers.host !== new URL(origin).host || request.url !== path) return send(404, 'Not found');
      if (request.method === 'GET') return send(200, page);
      if (request.method !== 'POST') return send(405, 'Method not allowed');
      if (request.headers.origin !== origin) return send(403, 'Forbidden');
      if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return send(415, 'Unsupported media type');
      if (finished || saving) return send(409, '配置已提交，请返回 Coda。');
      saving = true;
      try {
        const buffers = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 24 * 1024) { send(413, '表单内容过长。'); return; }
          buffers.push(chunk);
        }
        if (finished || signal?.aborted) return send(410, '配置已结束。');
        const fields = new URLSearchParams(Buffer.concat(buffers).toString('utf8'));
        if ([...fields.keys()].sort().join(',') !== 'apiKey,baseUrl,name') throw new Error('请填写名称、base_url 和 API Key');
        const upstream = await save(Object.fromEntries(fields), state);
        send(200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已保存</title><p>${escape(upstream.name)} 已保存。请返回 Coda 的「DSH 多上游」面板。</p></html>`);
        finish(null, upstream);
      } catch (error) { if (!response.headersSent) send(400, escape(error.message)); }
      finally { saving = false; }
    });
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      server.close(); server.closeIdleConnections();
      error ? reject(error) : resolve(value);
    };
    const abort = () => { finish(new Error('配置已取消')); server.closeAllConnections(); };
    const timer = setTimeout(() => { finish(new Error('配置页面已过期，请重新运行 dsh-upstreams configure')); server.closeAllConnections(); }, timeoutMs);
    server.on('error', () => finish(new Error('无法启动本地配置页面')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      onReady(`${origin}${path}`);
    });
  });
}

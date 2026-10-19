// One atomically replaced document holds the selection and its complete URL/key pairs.
// Readers never assemble a URL from one generation with a credential from another.
import { randomUUID } from 'node:crypto';
import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const MAX_UPSTREAMS = 50;
export const statePath = (env = process.env) => {
  if (!env.CODA_PLUGIN_STATE) throw new Error('Coda 没有提供插件状态目录');
  return env.CODA_PLUGIN_STATE;
};
export function nameOf(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 80 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('上游名称须为 1–80 字的一行文本');
  return value.trim();
}
export function baseUrlOf(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('base_url 须为有效的 HTTP(S) 地址');
  let url;
  try { url = new URL(value); } catch { throw new Error('base_url 须为有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /[?#]/.test(value))
    throw new Error('base_url 只接受不含账号、密码、查询参数和片段的 HTTP(S) 地址');
  if (/\/(?:messages|chat\/completions)\/?$/.test(url.pathname)) throw new Error('base_url 请填写 API 根地址，不要带 /messages 或 /chat/completions');
  return url.href.replace(/\/+$/, '');
}
export function keyOf(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value.trim()))
    throw new Error('API Key 须为非空、无空格的可打印 ASCII 文本');
  return value.trim();
}
function prepare(state) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const info = lstatSync(state);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('插件状态目录不可用');
  chmodSync(state, 0o700);
}
// Do not echo parse errors: a malformed file can contain a whole API key in its diagnostic.
export function readStore(state = statePath()) {
  let fd;
  try {
    fd = openSync(join(state, 'upstreams.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.upstreams) || data.upstreams.length > MAX_UPSTREAMS
      || data.upstreams.some(u => !ID.test(u?.id) || nameOf(u.name) !== u.name || baseUrlOf(u.baseUrl) !== u.baseUrl || keyOf(u.apiKey) !== u.apiKey)
      || new Set(data.upstreams.map(u => u.id)).size !== data.upstreams.length
      || new Set(data.upstreams.map(u => u.name)).size !== data.upstreams.length
      || (data.selected !== null && !data.upstreams.some(u => u.id === data.selected))) throw new Error();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, selected: null, upstreams: [] };
    throw new Error('无法读取 DSH 上游配置，请检查插件状态目录中的 upstreams.json');
  } finally { if (fd !== undefined) closeSync(fd); }
}
async function update(state, change) {
  prepare(state);
  let release;
  try { release = await lockfile.lock(join(state, 'upstreams'), { realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 50, maxTimeout: 100, factor: 1 } }); }
  catch { throw new Error('上游配置正在更新，请稍后重试'); }
  let temp;
  try {
    const store = readStore(state), result = change(store);
    temp = join(state, `.upstreams-${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(store), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temp, join(state, 'upstreams.json'));
    return result;
  } finally { if (temp) rmSync(temp, { force: true }); await release(); }
}
const publicUpstream = ({ id, name, baseUrl }) => ({ id, name, baseUrl });
export function list(state = statePath()) {
  const store = readStore(state);
  return { selected: store.selected, upstreams: store.upstreams.map(publicUpstream) };
}
export function selected(state = statePath()) {
  const store = readStore(state), upstream = store.upstreams.find(u => u.id === store.selected);
  if (!upstream) throw new Error('请先在「DSH 多上游」添加并选择一个上游');
  return { ...upstream };
}
export async function save(input, state = statePath()) {
  const name = nameOf(input?.name), baseUrl = baseUrlOf(input?.baseUrl), apiKey = keyOf(input?.apiKey);
  return update(state, store => {
    const previous = store.upstreams.find(u => u.name === name);
    if (!previous && store.upstreams.length >= MAX_UPSTREAMS) throw new Error(`最多保存 ${MAX_UPSTREAMS} 个上游，请先删除不用的上游`);
    const upstream = { id: previous?.id ?? randomUUID(), name, baseUrl, apiKey };
    if (previous) store.upstreams[store.upstreams.indexOf(previous)] = upstream;
    else {
      if (store.upstreams.length === 0) store.selected = upstream.id;
      store.upstreams.push(upstream);
    }
    return publicUpstream(upstream);
  });
}
export async function choose(id, state = statePath()) {
  return update(state, store => {
    if (typeof id !== 'string' || !store.upstreams.some(u => u.id === id)) throw new Error('所选上游不存在，请刷新面板');
    store.selected = id;
  });
}
export async function remove(id, state = statePath()) {
  return update(state, store => {
    if (typeof id !== 'string' || !store.upstreams.some(u => u.id === id)) throw new Error('上游不存在，请刷新面板');
    store.upstreams = store.upstreams.filter(u => u.id !== id);
    if (store.selected === id) store.selected = null;
  });
}

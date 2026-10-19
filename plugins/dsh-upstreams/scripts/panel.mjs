import { list } from './manager.mjs';

export function panel({ selected, upstreams }) {
  const items = [{ type: 'markdown', text: '在运行机的 Coda 会话中执行 `dsh-upstreams configure` 添加或更新上游。切换从下一次模型请求生效。' }];
  if (!selected) items.push({ type: 'error', text: upstreams.length ? '请先选择一个上游，DSH 才能继续请求。' : '尚未配置上游，请先添加。' });
  for (const upstream of upstreams) {
    const active = selected === upstream.id;
    const card = { type: 'card', title: upstream.name, subtitle: active ? '正在使用' : '已配置', items: [
      { type: 'stat', label: 'base_url', value: upstream.baseUrl.length <= 180 ? upstream.baseUrl : `${upstream.baseUrl.slice(0, 179)}…` },
      { type: 'button', label: active ? '已选择' : '切换使用', action: 'select', args: { upstream: upstream.id }, disabled: active },
      { type: 'button', label: '删除上游', action: 'remove', args: { upstream: upstream.id } },
    ] };
    if (Buffer.byteLength(JSON.stringify({ items: [...items, card] })) > 60 * 1024) {
      items.push({ type: 'markdown', text: `另有 ${upstreams.length - items.filter(i => i.type === 'card').length} 个上游未列出，可用 dsh-upstreams list 查看。` });
      break;
    }
    items.push(card);
  }
  return { items };
}
try { console.log(JSON.stringify(panel(list()))); }
catch (error) { console.error(error.message); process.exitCode = 1; }

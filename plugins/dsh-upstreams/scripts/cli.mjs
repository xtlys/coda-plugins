import { readFileSync, statSync } from 'node:fs';
import { configure } from './configure.mjs';
import { choose, list, remove, save } from './manager.mjs';

const usage = `用法：
  dsh-upstreams configure
  dsh-upstreams add --name <名称> --base-url <地址> --key-file <密钥文件>
  dsh-upstreams list
  dsh-upstreams select <名称或 ID>
  dsh-upstreams remove <名称或 ID>

configure 在运行机开启本地配置页面；添加同名上游会更新地址与密钥。
API Key 只从配置表单或文件读取，不通过命令参数传入。`;

const [command, ...args] = process.argv.slice(2);
const abort = new AbortController();
const cancel = () => abort.abort();
process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
try {
  if (!command || ['--help', '-h', 'help'].includes(command)) console.log(usage);
  else if (command === 'configure' && args.length === 0) {
    await configure({ signal: abort.signal, onReady: url => console.log(`请在运行机的浏览器打开（10 分钟内有效）：\n${url}`) });
    console.log('上游已保存，请刷新 Coda 的「DSH 多上游」面板。');
  } else if (command === 'list' && args.length === 0) console.log(JSON.stringify(list(), null, 2));
  else if (command === 'add') {
    const options = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--name', '--base-url', '--key-file'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error('添加参数无效，请使用 --help 查看用法');
      options.set(args[i], args[i + 1]);
    }
    if (options.size !== 3) throw new Error('添加上游需要 --name、--base-url 和 --key-file');
    let key;
    try {
      if (!statSync(options.get('--key-file')).isFile() || statSync(options.get('--key-file')).size > 8192) throw new Error();
      key = readFileSync(options.get('--key-file'), 'utf8');
    } catch { throw new Error('无法读取 API Key 文件（须为不超过 8 KiB 的普通文件）'); }
    console.log(JSON.stringify(await save({ name: options.get('--name'), baseUrl: options.get('--base-url'), apiKey: key })));
  } else if (['select', 'remove'].includes(command) && args.length === 1) {
    const upstream = list().upstreams.find(u => u.name === args[0] || u.id === args[0]);
    if (!upstream) throw new Error('上游不存在，请用 dsh-upstreams list 查看');
    await (command === 'select' ? choose : remove)(upstream.id);
    console.log(command === 'select' ? '已切换，下次模型请求生效。' : '已删除上游。');
  } else throw new Error('命令无效，请使用 --help 查看用法');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { process.off('SIGTERM', cancel); process.off('SIGINT', cancel); }

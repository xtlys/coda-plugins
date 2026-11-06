#!/usr/bin/env node
// Reproduce the two distributable packs and the four-dimension audit from pinned sources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaults, dimensions, overrides, rules } from './spec.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pinned = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { source: { type: 'string' }, check: { type: 'boolean' } } });
const sourceRoot = resolve(values.source ?? join(root, 'vczh/repos/Tools/Copilot'));
const sha = s => createHash('sha256').update(s).digest('hex');
const json = v => `${JSON.stringify(v, null, 2)}\n`;
const originals = new Map();
for (const file of pinned.files) {
  const bytes = readFileSync(join(sourceRoot, file.path));
  assert.equal(sha(bytes), file.sha256, `Source changed: ${file.path}`);
  originals.set(file.path, bytes.toString('utf8').replace(/\r\n/g, '\n'));
}
const lines = path => originals.get(path).split('\n').slice(0, originals.get(path).endsWith('\n') ? -1 : undefined);
const url = (path, start, end) => `${pinned.repository}/blob/${pinned.commit}/${pinned.root}/${path}#L${start}-L${end}`;
const audit = { repository: pinned.repository, commit: pinned.commit, root: pinned.root, dimensions, files: [] };
for (const [name, [dimension, topic]] of Object.entries(defaults)) {
  const path = `Guidelines/${name}`;
  const entries = lines(path).map((body, i) => ({ line: i + 1, dimension, topic, kind: !body.trim() || /^\s*#/.test(body) ? 'structure' : 'text' }));
  if (name === 'Coding.md') for (const n of [3, 51]) entries[n - 1].kind = 'structure'; // introductory scope and cross-reference
  for (const [file, start, end, dim, top] of overrides.filter(o => o[0] === name)) {
    assert.ok(end <= entries.length, file);
    for (let i = start - 1; i < end; i++) Object.assign(entries[i], { dimension: dim, topic: top });
  }
  audit.files.push({ path, originalSha256: pinned.files.find(f => f.path === path).sha256, entries });
}
const packs = ['general', 'cpp'].map(id => ({
  schemaVersion: 2, id, title: `${dimensions[id].title}规范`, scope: id,
  appliesTo: id === 'general' ? '语言无关的工程实践；具体条目保留原文前提。' : 'C++ 工程；原文以 C++20 为上下文，不含原库及工具链专用要求。',
  topics: Object.entries(dimensions[id].topics).map(([id, title]) => ({ id, title })), sections: [],
}));
for (const rule of rules) {
  assert.ok(dimensions[rule.dimension]?.topics[rule.topic]);
  const sources = [], bodies = [];
  for (const fragment of rule.fragments) {
    const file = audit.files.find(f => f.path === fragment.path), originalLines = lines(fragment.path);
    assert.ok(file && fragment.start > 0 && fragment.end <= originalLines.length);
    let body = originalLines.slice(fragment.start - 1, fragment.end).join('\n');
    for (let n = fragment.start; n <= fragment.end; n++) {
      const entry = file.entries[n - 1];
      assert.ok(!entry.rule, `Duplicate retained line ${fragment.path}:${n}`);
      Object.assign(entry, { dimension: rule.dimension, topic: rule.topic, rule: rule.id });
    }
    for (const omission of fragment.omissions) {
      assert.equal(body.split(omission.text).length, 2, `Omission must match once: ${rule.id}`);
      const line = fragment.start + body.slice(0, body.indexOf(omission.text)).split('\n').length - 1;
      const entry = file.entries[line - 1];
      (entry.omissions ??= []).push(omission);
      body = body.replace(omission.text, '');
    }
    bodies.push(body);
    sources.push({ path: fragment.path, start: fragment.start, end: fragment.end, ...(fragment.omissions.length ? { edited: true } : {}) });
  }
  const body = bodies.join('\n').trim();
  packs.find(p => p.id === rule.dimension).sections.push({
    id: rule.id, topic: rule.topic, title: rule.title,
    context: rule.context || (rule.dimension === 'general' ? '语言无关的工程偏好。' : '仅适用于 C++；保留原文偏好及前提。'),
    body, sources, sha256: sha(body),
  });
}

// Adapt only project/tool prerequisites and host entry points. All other workflow lines are kept.
const protocolEdits = [];
function scoped(path) {
  const edits = [];
  const remove = (start, end, reason) => edits.push({ start, end, replacement: '', reason });
  const replace = (start, end, replacement, reason) => edits.push({ start, end, replacement, reason });
  const originalLines = lines(path);
  if (path === 'AGENTS.md') {
    remove(6, 7, '移除 Jobs 路由和原项目脚本语言偏好');
    remove(10, 10, '移除原库跨仓复制前提');
    remove(12, 17, '移除原库应用及系统工具的操作要求');
    replace(3, 3, originalLines[2].replace('Coding Guidelines and Tools', 'Coding Guidelines'), '规范入口改名');
  } else if (path === 'copilot-instructions.md') {
    remove(4, 4, '移除 MSBuild solution 前提');
    remove(12, 51, '移除原测试应用部署假设及 Windows/Linux 工具链规定');
    replace(53, 91, [
      '## Coding Guidelines', '',
      '- **SUPER IMPORTANT** Your should always follow the coding convention when coding:',
      '  - Use `vczh prompt list` to find conventions whose `enabled` field is true; read only those with `vczh prompt show <id>`.',
      '  - Disabled conventions, including general and cpp, must not be loaded or re-enabled unless the user asks.',
      ...originalLines.slice(61, 64),
      '- Read this project\'s `Project.md` for its build, test, debugging and source-file conventions.',
    ].join('\n'), '仅接入通用和 C++ 规范；库和工具要求改由当前项目自身约定提供');
    remove(107, 119, '移除原项目脚本目录清单');
  } else {
    for (let i = 0; i < originalLines.length; i++) {
      const line = originalLines[i], n = i + 1;
      if (line.startsWith('- Check out `Accessing Task Documents`')) {
        replace(n, n, '- Check out `Accessing Task Documents` in `REPO-ROOT/.github/copilot-instructions.md` for task documents, and `REPO-ROOT/Project.md` for this project\'s tools.', '移除固定平台脚本前提');
      } else if (line.startsWith('- Check out `(Windows Specific) External Tools')) {
        remove(n, n, '工具由当前 Project.md 提供');
      } else if (line.startsWith('- All `*.md`, `*.ps1`')) {
        replace(n, n, '- All referenced task documents and project scripts should exist; you should not create any new files unless explicitly instructed.', '保留文件存在约束，不假设 PowerShell/bash 工具链');
      } else if (line.startsWith('- You are in a large C++ project,')) {
        replace(n, n, line.replace('You are in a large C++ project, you', 'You'), '移除固定语言和项目规模前提');
      } else if (line.includes('For non-Windows platform where `copilotRemember.ps1`')) {
        remove(n, n, 'vczh remember 已提供相同的跨平台归档操作');
      } else if (line.includes('copilotRemember.ps1')) {
        replace(n, n, line.replace('copilotRemember.ps1 -Earliest COUNT', 'vczh remember --earliest COUNT').replace('copilotRemember.ps1', 'vczh remember'), '替换等价归档入口');
      } else if (line.includes('`REPO-ROOT/.github/Guidelines/Coding.md`')) {
        replace(n, n, line.replace('`REPO-ROOT/.github/Guidelines/Coding.md`', 'only the conventions marked `enabled: true` by `vczh prompt list`, using `vczh prompt show <id>`'), '规范引用仅指向项目已启用的条目，遵守用户停用选择');
      }
    }
  }
  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) assert.ok(edits[i - 1].end < edits[i].start);
  const result = [...originalLines];
  for (const e of [...edits].reverse()) result.splice(e.start - 1, e.end - e.start + 1, ...(e.replacement ? e.replacement.split('\n') : []));
  protocolEdits.push({ path, edits });
  return `${result.join('\n')}\n`;
}

const outputs = new Map();
for (const pack of packs) outputs.set(`plugins/vczh/prompts/${pack.id}.json`, json(pack));
const retained = pinned.files.filter(f => ['AGENTS.md', 'copilot-instructions.md'].includes(f.path) || f.path.startsWith('prompts/'));
const manifest = { repository: pinned.repository, commit: pinned.commit, root: pinned.root, note: '工作流保留原步骤；仅删除专属前提并替换宿主入口。规范按来源片段提取到 prompts/general.json 与 cpp.json。',
  conventionSources: audit.files.filter(f => f.entries.some(e => e.rule)).map(f => ({ path: f.path, sha256: f.originalSha256, lineCount: f.entries.length })), files: [] };
for (const file of retained) {
  const text = scoped(file.path);
  outputs.set(`plugins/vczh/upstream/${file.path}`, text);
  manifest.files.push({ path: file.path, originalSha256: file.sha256, sha256: sha(text), edits: protocolEdits.at(-1).edits });
}
outputs.set('plugins/vczh/upstream/manifest.json', json(manifest));

// Compact contiguous audit lines. Blank lines and headings are accounted for separately from rules.
for (const file of audit.files) {
  const spans = [];
  for (const entry of file.entries) {
    const { line, ...rest } = entry, previous = spans.at(-1);
    if (previous && json(previous.classification) === json(rest)) previous.end = line;
    else spans.push({ start: line, end: line, classification: rest });
  }
  file.lineCount = file.entries.length; delete file.entries; file.spans = spans;
}
// One span per line keeps the generated audit reviewable without expanding thousands of fields.
const { files: auditFiles, ...auditHeader } = audit;
const auditJson = `${JSON.stringify(auditHeader, null, 2).slice(0, -2)},\n  "files": [\n${auditFiles.map(({ spans, ...file }) =>
  `${JSON.stringify(file, null, 2).slice(0, -2)},\n  "spans": [\n${spans.map(s => `    ${JSON.stringify(s)}`).join(',\n')}\n  ]\n}`.split('\n').map(s => `    ${s}`).join('\n')
).join(',\n')}\n  ]\n}\n`;
assert.deepEqual(JSON.parse(auditJson), audit);
outputs.set('scripts/vczh/classification.json', auditJson);
const report = ['# vczh 规范四维分类', '',
  '本文件仅供开发维护，不进入插件安装包。按维度、再按主题组织；插件仅分发通用与 C++。所有行号对应固定提交，空行和标题另计为结构，混合行的删除片段记录在 `scripts/vczh/classification.json`。', '',
  `来源：${pinned.repository}/tree/${pinned.commit}/${pinned.root}`, '',
  '保留正文来自原文片段，仅做换行统一、主题重排和专属片段删除；中文标题及适用说明为插件添加。没有把被删的库规则替换为另一套库或标准库规则。', '',
  '边界：匿名 namespace 禁令源于合并发布，归 toolchain；反射接口禁止 const 归 vczh-libraries；25 次复测归通用；Pimpl、RAII 保留原有例外；MVVM 职责划分归通用，XML 绑定归 vczh-libraries；Workflow Script 是原生态语言，归 vczh-libraries。', ''];
report.push('| 维度 | 主题 | 插件处理 |', '| --- | --- | --- |', ...Object.entries(dimensions).map(([key, value]) =>
  `| ${value.title} | ${Object.keys(value.topics).length} | ${packs.find(p => p.id === key) ? `保留 ${packs.find(p => p.id === key).sections.length} 个条目` : '不分发正文，仅保留开发审计'} |`), '');
for (const [dimension, data] of Object.entries(dimensions)) {
  report.push(`## ${data.title} · ${['general', 'cpp'].includes(dimension) ? '保留' : '不分发'}`, '');
  for (const [topic, title] of Object.entries(data.topics)) {
    report.push(`### ${title}`, '');
    if (['general', 'cpp'].includes(dimension)) {
      for (const s of packs.find(p => p.id === dimension).sections.filter(s => s.topic === topic)) report.push(`- **${s.title}**：${s.sources.map(f => `[${f.path}:${f.start}–${f.end}](${url(f.path, f.start, f.end)})${f.edited ? '（删去专属片段）' : ''}`).join('、')}。${s.context}`);
    } else {
      for (const file of audit.files) {
        const spans = [];
        for (const s of file.spans) {
          if (s.classification.dimension !== dimension || s.classification.topic !== topic) continue;
          const previous = spans.at(-1);
          if (previous?.end === s.start - 1) { previous.end = s.end; previous.hasText ||= s.classification.kind === 'text'; }
          else spans.push({ start: s.start, end: s.end, hasText: s.classification.kind === 'text' });
        }
        const omitted = file.spans.filter(s => s.classification.omissions?.some(o => o.dimension === dimension && o.topic === topic));
        if (spans.some(s => s.hasText)) report.push(`- ${file.path}：${spans.filter(s => s.hasText).map(s => `[${s.start}–${s.end}](${url(file.path, s.start, s.end)})`).join('、')}。`);
        if (omitted.length) report.push(`- ${file.path} 混合条目中移除的专属片段：${omitted.map(s => `[${s.start}](${url(file.path, s.start, s.end)})`).join('、')}。`);
      }
    }
    report.push('');
  }
}
report.push('## 重建与校验', '', '```sh', 'node scripts/vczh/rebuild.mjs --source vczh/repos/Tools/Copilot', 'node scripts/vczh/rebuild.mjs --source vczh/repos/Tools/Copilot --check', '```', '',
  '脚本先核对全部固定源文件指纹，再生成两包规范、四维审计和过滤后的共享工作流。上游变化会失败，不能静默重用旧行号。执行协议的每处改动记录在插件的 upstream/manifest.json；未列出的工作流行保留。', '');
outputs.set('docs/vczh-classification.md', report.join('\n'));

// upstream is entirely generated. Compare the tree with this build's outputs, including files
// removed from sources.json; the current source list cannot enumerate those obsolete files.
function obsoleteIn(path) {
  const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (!entry) return [];
  if (!entry.isDirectory()) return outputs.has(path) ? [] : [path];
  return readdirSync(join(root, path)).flatMap(name => obsoleteIn(`${path}/${name}`));
}
// Check parents from the root down, before looking through trees they may obstruct.
const directories = new Set();
for (const path of outputs.keys()) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) directories.add(parent);
const blocked = [];
const obstructed = path => blocked.some(parent => path === parent || path.startsWith(`${parent}/`));
for (const path of [...directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
  if (obstructed(path)) continue;
  const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) blocked.push(path);
}
const obsolete = [...blocked,
  ...(obstructed('plugins/vczh/upstream') ? [] : obsoleteIn('plugins/vczh/upstream')),
  ...['plugins/vczh/prompts/workflow.json', 'plugins/vczh/prompts/vczh-project.json'].filter(path => !obstructed(path))];
// Finish all validation before mutating outputs.
// Remove obsolete files first: one may occupy a directory required by a new output.
for (const path of obsolete) {
  const file = join(root, path), entry = lstatSync(file, { throwIfNoEntry: false });
  if (values.check) assert.ok(!entry, `Obsolete generated file is still distributed: ${path}`);
  else if (entry) unlinkSync(file);
}
for (const [path, body] of outputs) {
  const file = join(root, path);
  if (values.check) assert.equal(readFileSync(file, 'utf8'), body, `Generated file differs: ${path}`);
  else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); }
}
console.log(`${values.check ? 'Verified' : 'Generated'} 13 source classifications; ${packs.map(p => `${p.id}: ${p.topics.length} topics / ${p.sections.length} rules`).join('; ')}; ${retained.length} scoped protocol files.`);

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { INVESTIGATE_MARKER, atomic, base, git, hash, inside, listFiles, lock, managed, requireValue } from './store.mjs';

const ARCHIVE_DIR = /^\d{4}(-\d{2}){5}$/;
export const CONSUMED_FILE = `${base}/learning/.consumed`;

export function readMarkdownAsset(file, relPath) {
  const body = readFileSync(file, 'utf8');
  const title = body.match(/^#\s+(?![!])(.+)$/m)?.[1]?.trim() ?? basename(file, '.md');
  const learningCount = [...body.matchAll(/^-\s+.+\[(\d+)\]\s*$/gm)].length;
  return {
    id: hash(relPath),
    title,
    path: relPath,
    summary: body.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'))?.slice(0, 140) ?? relPath,
    learningCount,
    body,
  };
}

export function walkMarkdown(root, folder) {
  const dir = inside(root, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      if (entry.isSymbolicLink()) return [];
      const relPath = `${folder}/${entry.name}`;
      if (entry.isDirectory()) return walkMarkdown(root, relPath);
      return entry.isFile() && entry.name.endsWith('.md') ? [readMarkdownAsset(inside(root, relPath), relPath)] : [];
    });
}

export function assetsByKind(root, kind) {
  requireValue(['knowledge', 'learning', 'archives', 'lints', 'verifiers', 'tasks'].includes(kind), '未知资产类型');
  if (kind === 'knowledge') return walkMarkdown(root, `${base}/knowledge`);
  if (kind === 'tasks') return walkMarkdown(root, `${base}/tasks`);
  if (kind === 'learning' || kind === 'archives') {
    const all = walkMarkdown(root, `${base}/learning`);
    const isArchive = doc => /^\.dickda\/learning\/\d{4}(-\d{2}){5}\//.test(doc.path);
    return kind === 'archives' ? all.filter(isArchive) : all.filter(doc => !isArchive(doc));
  }
  if (kind === 'lints') {
    return listFiles(root, 'lints', ['.mjs', '.js', '.sh']).map(file => {
      const relPath = relative(root, file).split('\\').join('/');
      const body = readFileSync(file, 'utf8');
      const comment = body.match(/^(?:\/\/|#)\s*(.+)$/m)?.[1]?.trim();
      return { id: hash(relPath), title: basename(file), path: relPath, summary: comment ?? 'L2 Executable Spec Lint', body };
    });
  }
  return listFiles(root, 'verifiers', ['.mjs', '.js', '.sh', '.md', '.json']).map(file => {
    const relPath = relative(root, file).split('\\').join('/');
    const body = readFileSync(file, 'utf8');
    const isCode = /\.(mjs|js|sh)$/.test(file);
    return {
      id: hash(relPath),
      title: basename(file),
      path: relPath,
      track: isCode ? 'code' : 'agent',
      summary: isCode ? 'L3 代码验证器（确定性自动执行）' : 'L3 Agent/UI 实证验证规约',
      body,
    };
  });
}

export function hasAgentVerifiers(root) {
  return assetsByKind(root, 'verifiers').some(spec => spec.track === 'agent');
}

export function backups(root, count = 10, consumed = new Set()) {
  requireValue(Number.isInteger(count) && count > 0 && count <= 10000, 'earliest 数量须为 1–10000');
  const folder = managed(root, 'learning');
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && ARCHIVE_DIR.test(entry.name))
    .map(entry => `${base}/learning/${entry.name}`)
    .filter(path => !consumed.has(path))
    .sort()
    .slice(0, count);
}

export function consumedArchives(root, tree) {
  let contents;
  if (tree) {
    const entry = git(root, 'ls-tree', tree, '--', CONSUMED_FILE);
    if (!entry) return [];
    requireValue(/^100(?:644|755) blob /.test(entry), `消费记录须为普通文件：${CONSUMED_FILE}`);
    contents = git(root, 'show', `${tree}:${CONSUMED_FILE}`);
  } else {
    const file = inside(root, CONSUMED_FILE);
    if (!existsSync(file)) return [];
    contents = readFileSync(file, 'utf8');
  }
  return contents.split(/\r?\n/).filter(Boolean);
}

export function consumptionRecord(history, archive) {
  return [...new Set([...history, archive])].sort().join('\n');
}

export function remember(root, time = new Date()) {
  return lock(root, 'remember', () => {
    const logDir = managed(root, 'tasks/logs');
    const logs = listFiles(root, 'tasks/logs', '.md').map(file => ({
      file,
      name: relative(logDir, file).split('\\').join('/'),
      content: readFileSync(file, 'utf8'),
    })).filter(({ content }) => {
      const body = content.trim();
      return body && body !== INVESTIGATE_MARKER.trim();
    });
    if (!logs.length) return { archived: false };

    let date = new Date(time);
    requireValue(Number.isFinite(date.getTime()), '归档时间无效');
    const consumed = new Set(consumedArchives(root));
    let dirRel;
    do {
      const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
      const stamp = parts.map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-');
      dirRel = `${base}/learning/${stamp}`;
      date = new Date(date.getTime() + 1000);
    } while (consumed.has(dirRel) || existsSync(inside(root, dirRel)));

    const target = inside(root, dirRel);
    mkdirSync(dirname(target), { recursive: true });
    const draft = mkdtempSync(`${target}.tmp-`);
    try {
      for (const { name, content } of logs) {
        if (name === 'investigate.md') {
          writeFileSync(join(draft, name), content);
        } else {
          // Encoding the separator keeps a/b.md distinct from a-b.md in the flat archive.
          const encoded = `log-${encodeURIComponent(name)}`;
          const filename = encoded.length <= 255 ? encoded : `log.${hash(name)}.md`;
          writeFileSync(join(draft, filename), `# ${name}\n\n${content}`);
        }
      }
      for (const extra of ['TODO_TASK.md', 'PLAN_5L.md']) {
        const src = managed(root, `tasks/${extra}`);
        if (existsSync(src)) copyFileSync(src, join(draft, extra));
      }
      renameSync(draft, target);
    } finally {
      rmSync(draft, { recursive: true, force: true });
    }
    atomic(managed(root, 'tasks/logs/investigate.md'), INVESTIGATE_MARKER);
    for (const { name, file } of logs) {
      if (name !== 'investigate.md') rmSync(file);
    }
    return { archived: true, path: dirRel };
  });
}

export function consumeBackup(root, archiveRelPath, record = consumptionRecord(consumedArchives(root), archiveRelPath)) {
  requireValue(/^\.dickda\/learning\/\d{4}(-\d{2}){5}$/.test(archiveRelPath), `无效的归档目录路径：${archiveRelPath}`);
  const target = inside(root, archiveRelPath);
  requireValue(existsSync(target), `归档目录不存在：${archiveRelPath}`);
  atomic(inside(root, CONSUMED_FILE), `${record}\n`);
  rmSync(target, { recursive: true, force: true });
  return { consumed: archiveRelPath };
}

// Run all L2 Executable Spec lints inside .dickda/lints/ deterministically.
export function runLints(root) {
  const files = listFiles(root, 'lints', ['.mjs', '.js', '.sh']);
  const results = files.map(file => {
    const relPath = relative(root, file).split('\\').join('/');
    const isShell = file.endsWith('.sh');
    const proc = spawnSync(isShell ? 'bash' : process.execPath, [file], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, DICKDA_ROOT: root },
    });
    const output = [proc.stdout, proc.stderr].filter(Boolean).join('\n').trim();
    return {
      path: relPath,
      passed: proc.status === 0 && !proc.error,
      code: proc.status ?? 1,
      output: proc.error ? proc.error.message : output.slice(-4000),
    };
  });
  const failed = results.filter(r => !r.passed);
  return {
    passed: failed.length === 0,
    total: results.length,
    failed: failed.length,
    results,
  };
}

function changedEntries(root, from, to, paths) {
  const fields = git(root, 'diff', '--raw', '-z', '--no-renames', '--no-abbrev', from, to, '--', ...paths).split('\0');
  const changes = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldId, newId] = fields[i].slice(1).split(' ');
    changes.set(fields[i + 1], { before: `${oldMode} ${oldId}`, after: `${newMode} ${newId}` });
  }
  return changes;
}

// Compare against the original branch tree, discounting only faithfully merged upstream entries.
export function branchChanges(root, baseCommit, tree, { mergedUpstream, paths = [] } = {}) {
  const changes = changedEntries(root, baseCommit, tree, paths);
  if (!mergedUpstream) return changes;
  const ancestor = git(root, 'merge-base', baseCommit, mergedUpstream);
  if (ancestor === mergedUpstream) return changes;
  const baseChanges = changedEntries(root, ancestor, baseCommit, paths);
  for (const [path, upstream] of changedEntries(root, ancestor, mergedUpstream, paths)) {
    const before = baseChanges.get(path)?.after ?? upstream.before;
    const after = changes.get(path)?.after ?? before;
    if (after === upstream.after && (before === upstream.before || before === upstream.after)) {
      changes.delete(path);
    } else {
      // Include a dropped upstream change even when the candidate exactly matches the original branch.
      changes.set(path, { before, after, upstream: upstream.after });
    }
  }
  return changes;
}

// Builder jobs with lockSpec=true must never delete or weaken locked .dickda/lints or .dickda/verifiers.
export function checkSpecLock(root, baseCommit, headCommit, { upstreamCommit = '' } = {}) {
  const merged = upstreamCommit && spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', upstreamCommit, headCommit]).status === 0;
  const changes = branchChanges(root, baseCommit, headCommit, {
    mergedUpstream: merged ? upstreamCommit : '', paths: ['.dickda/lints/', '.dickda/verifiers/'],
  });
  const violations = [...changes.keys()].sort();
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function layerHealth(root, consumed) {
  const lints = assetsByKind(root, 'lints');
  const verifiers = assetsByKind(root, 'verifiers');
  const knowledge = assetsByKind(root, 'knowledge');
  const learning = assetsByKind(root, 'learning');
  const archives = backups(root, 1000, consumed);
  const planFile = managed(root, 'tasks/PLAN_5L.md');
  const hasPlan = existsSync(planFile) && readFileSync(planFile, 'utf8').trim().length > 100;
  return {
    l1PlanReady: hasPlan,
    l2LintCount: lints.length,
    l3CodeVerifierCount: verifiers.filter(v => v.track === 'code').length,
    l3AgentVerifierCount: verifiers.filter(v => v.track === 'agent').length,
    l4KnowledgeCount: knowledge.length,
    l4LearningEntries: learning.reduce((sum, doc) => sum + doc.learningCount, 0),
    pendingArchives: archives.length,
  };
}

// Post-merge hook-joiners parsing adapted from @coda-console/composer, MIT; see NOTICE.
import { pathToFileURL } from 'node:url';
import { appendGithubOutput } from './store.mjs';

export function parseApproval(answer = {}, joinersRaw = '[]') {
  const list = typeof joinersRaw === 'string' && joinersRaw.trim() ? JSON.parse(joinersRaw) : (Array.isArray(joinersRaw) ? joinersRaw : []);
  const options = answer.options ?? {};
  const written = answer.inputs ?? {};
  const ticked = list.filter(joiner => options[joiner.id] === true);
  const inputs = {};
  const missing = new Map();

  for (const joiner of ticked) {
    for (const { id, label } of joiner.inputs ?? []) {
      const value = String(written[id] ?? '').trim();
      if (value) inputs[id] = value;
      else (missing.get(id) ?? missing.set(id, { label, for: [] }).get(id)).for.push(joiner);
    }
  }

  return {
    notify: options.notify !== false,
    only: JSON.stringify(ticked.map(j => j.id)),
    picked: ticked.map(j => j.name).join('、'),
    inputs: JSON.stringify(inputs),
    missing: [...missing.keys()].join(','),
    asks: [...missing.values()].map(m => `「${m.label}」：${m.for.map(j => j.name).join('、')} 需要`).join('\n'),
    needs: JSON.stringify(Object.fromEntries([...missing].map(([id, m]) => [id, m.for.map(j => j.id)]))),
  };
}

export function resolveFilledInputs({ inputsRaw = '{}', missingRaw = '', asksRaw = '', fillsRaw = '[]', needsRaw = '{}', onlyRaw = '[]' }) {
  const inputs = JSON.parse(inputsRaw || '{}');
  const ids = missingRaw.split(',').filter(Boolean);
  const fills = ids.length ? JSON.parse(fillsRaw || '[]') : [];
  const asks = asksRaw.split('\n');
  const needs = JSON.parse(needsRaw || '{}');
  const dropped = new Set();

  ids.forEach((id, i) => {
    if (fills[i]?.choice === 'skip') {
      for (const joiner of needs[id] ?? []) dropped.add(joiner);
      return;
    }
    const text = String(fills[i]?.note ?? '').trim();
    if (!text) throw new Error(`${asks[i] || id}：未填写内容，无法运行合并后流程`);
    inputs[id] = text;
  });

  const only = JSON.parse(onlyRaw || '[]').filter(id => !dropped.has(id));
  return { inputs: JSON.stringify(inputs), only: JSON.stringify(only) };
}

export function formatMergedRuns(runsRaw = '[]', joinersRaw = '[]') {
  const runs = typeof runsRaw === 'string' ? JSON.parse(runsRaw) : runsRaw;
  const joiners = typeof joinersRaw === 'string' ? JSON.parse(joinersRaw) : joinersRaw;
  const titleOf = id => joiners.find(j => j.id === id)?.name ?? id;
  if (!Array.isArray(runs) || !runs.length) return '没有运行合并后的流程';
  return runs.map(r => `${titleOf(r.workflow)}：${r.state} coda://workflow-runs/${r.runId}`).join('；');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2] ?? 'parse';
    if (action === 'parse') {
      const parsed = parseApproval(JSON.parse(process.env.APPROVED || '{}'), process.env.JOINERS || '[]');
      appendGithubOutput(parsed);
    } else if (action === 'inputs') {
      const filled = resolveFilledInputs({
        inputsRaw: process.env.INPUTS,
        missingRaw: process.env.MISSING,
        asksRaw: process.env.ASKS,
        fillsRaw: process.env.FILLS,
        needsRaw: process.env.NEEDS,
        onlyRaw: process.env.ONLY,
      });
      appendGithubOutput(filled);
    } else if (action === 'ran') {
      appendGithubOutput({ line: formatMergedRuns(process.env.RUNS, process.env.JOINERS) });
    } else {
      throw new Error(`未知 approval 动作：${action}`);
    }
  } catch (error) {
    console.error(`dickda approval: ${error.message}`);
    process.exitCode = 1;
  }
}

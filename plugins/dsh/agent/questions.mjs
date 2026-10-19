// ACP forms use JSON Schema, never DSH UI-specific fields. Indexes are wire identities;
// the caller's question ids and exact option labels are restored on the return path.
const OTHER = 'coda:other';
export function questionForm(questions) {
  const properties = {}, required = [];
  questions.forEach((q, i) => {
    const key = `q${i}`;
    const base = { title: q.question, ...(q.header ? { description: q.header } : {}) };
    const choices = q.options?.map((o, n) => ({ const: String(n), title: `${o.label}${o.description ? ` — ${o.description}` : ''}` }));
    if (choices?.length) {
      choices.push({ const: OTHER, title: '其他（写在下面）' });
      properties[key] = q.multiSelect ? { ...base, type: 'array', items: { anyOf: choices }, minItems: 1, uniqueItems: true }
        : { ...base, type: 'string', oneOf: choices };
      properties[`${key}_other`] = { type: 'string', title: '其他回答' };
    } else properties[key] = { ...base, type: 'string', minLength: 1 };
    required.push(key);
  });
  return { type: 'object', properties, required };
}

export function questionAnswer(questions, result) {
  if (result?.action !== 'accept') throw new Error('用户取消了提问');
  return { answers: questions.map((q, i) => {
    const value = result.content?.[`q${i}`];
    if (!q.options?.length) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('回答不能为空');
      return { id: q.id, selected: [], custom: value };
    }
    const chosen = q.multiSelect ? value : [value];
    if (!Array.isArray(chosen) || !chosen.length || chosen.some(v => v !== OTHER && !q.options.some((_, n) => String(n) === v))) throw new Error('回答包含无效选项');
    const custom = result.content?.[`q${i}_other`];
    if (chosen.includes(OTHER) && (typeof custom !== 'string' || !custom.trim())) throw new Error('请填写其他回答');
    return { id: q.id, selected: chosen.filter(v => v !== OTHER).map(v => q.options[Number(v)].label),
      ...(chosen.includes(OTHER) ? { custom } : {}) };
  }) };
}

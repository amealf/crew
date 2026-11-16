export function parseVerdict(text) {
  const last = String(text ?? '').split(/\r?\n/).filter(line => line.trim()).at(-1) ?? '';
  const normalized = last.replace(/^[\s*`#]+|[\s*`#]+$/g, '');
  const matched = /^VERDICT: (APPROVED|REVISE|BLOCKED)$/i.exec(normalized);
  return matched ? { verdict: matched[1].toUpperCase(), malformed: false } : { verdict: 'REVISE', malformed: true };
}

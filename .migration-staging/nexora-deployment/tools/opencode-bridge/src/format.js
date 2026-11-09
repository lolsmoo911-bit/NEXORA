const INTERESTING_INPUT_KEYS = [
  'command',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
  'name',
  'oldString',
  'newString',
  'content',
];

export function clamp(value, max = 1500) {
  const text = typeof value === 'string' ? value : safeString(value);
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} chars truncated] …\n${text.slice(-tail)}`;
}

function safeString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatDate(ms) {
  if (!ms) return '?';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatSessionLine(session, { active = false, verbose = false } = {}) {
  const flags = [active ? 'RUNNING' : 'idle'];
  if (session.parentID) flags.push('child');
  if (!active && session.outcome) flags.push(session.outcome);
  const title = (session.title || '(untitled)').replace(/\s+/g, ' ').trim();
  const dir = session.location?.directory || '?';
  let line = `- ${session.id} | ${formatDate(session.time?.updated)} | ${flags.join(',')} | ${dir} | ${title}`;
  if (verbose) {
    const model = session.model ? `${session.model.providerID}/${session.model.id}` : '?';
    line += `\n    agent: ${session.agent || '?'} | model: ${model} | cost: $${(session.cost ?? 0).toFixed(4)}`;
  }
  return line;
}

export function formatSessions(sessions, activeMap = {}) {
  if (!sessions.length) return 'No sessions found.';
  return sessions.map((session) => formatSessionLine(session, { active: Boolean(activeMap[session.id]) })).join('\n');
}

function formatInput(input, max = 220) {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  const ordered = [
    ...INTERESTING_INPUT_KEYS.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !INTERESTING_INPUT_KEYS.includes(key)),
  ].slice(0, 8);

  return ordered
    .map((key) => {
      const value = input[key];
      if (value === undefined || value === null || value === '') return null;
      const rendered = typeof value === 'string' ? clamp(value, max) : clamp(safeString(value), max);
      return `${key}=${rendered.includes('\n') ? `"""${rendered}"""` : rendered}`;
    })
    .filter(Boolean)
    .join(' ');
}

function indent(text, prefix = '    ') {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

function formatTool(part, maxOutput) {
  const status = part.state?.status || 'unknown';
  const input = formatInput(part.state?.input);
  const lines = [`  • ${part.name} [${status}]${input ? ` ${input}` : ''}`];

  if (part.state?.content?.length) {
    const text = part.state.content
      .map((item) => (item.type === 'text' ? item.text : `[file ${item.uri || item.name || ''}]`))
      .join('\n');
    if (text.trim()) lines.push(indent(clamp(text, maxOutput)));
  }

  if (part.state?.error) {
    lines.push(indent(`ERROR: ${clamp(part.state.error, 600)}`));
  }

  return lines.join('\n');
}

function shortTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatAssistant(message, { includeTools, maxOutput, includeReasoning }) {
  const texts = [];
  const reasoning = [];
  const tools = [];

  for (const part of message.content || []) {
    if (part.type === 'text' && part.text?.trim()) texts.push(part.text.trim());
    else if (part.type === 'reasoning' && part.text?.trim()) reasoning.push(part.text.trim());
    else if (part.type === 'tool') tools.push(part);
  }

  const blocks = [];
  if (texts.length) blocks.push(`[assistant ${shortTime(message.time?.created)}] ${texts.join('\n\n')}`);
  if (includeReasoning && reasoning.length) {
    for (const entry of reasoning) blocks.push(`[reasoning] ${clamp(entry, 700)}`);
  } else if (!texts.length && !tools.length && reasoning.length) {
    blocks.push(`[assistant reasoning summary] ${clamp(reasoning.join('\n'), 400)}`);
  }

  if (includeTools) {
    for (const tool of tools) blocks.push(formatTool(tool, maxOutput));
  }

  if (message.snapshot?.files?.length) {
    blocks.push(`  files touched: ${message.snapshot.files.join(', ')}`);
  }

  if (message.error) blocks.push(`  assistant error: ${clamp(message.error, 600)}`);
  return blocks.join('\n');
}

export function formatTranscript(messages, { includeTools = true, maxOutput = 1200, includeReasoning = false } = {}) {
  if (!messages.length) return 'No messages in this session.';
  const ordered = [...messages].reverse();
  const blocks = [];

  for (const message of ordered) {
    if (message.type === 'user') {
      const files = Array.isArray(message.files)
        ? message.files.map((file) => `  📎 ${file.name || 'attachment'} (${file.mime || 'unknown type'}, ${file.source?.type === 'uri' ? file.source.uri : 'inline'})`)
        : [];
      blocks.push(`[user ${shortTime(message.time?.created)}]\n${message.text || ''}${files.length ? `\n${files.join('\n')}` : ''}`);
    } else if (message.type === 'assistant') {
      const block = formatAssistant(message, { includeTools, maxOutput, includeReasoning });
      if (block) blocks.push(block);
    } else if (message.type === 'shell') {
      const output = message.output?.output ? `\n${indent(clamp(message.output.output, maxOutput))}` : '';
      blocks.push(`[shell ${message.status || '?'}${message.exit !== undefined && message.exit !== null ? `, exit=${message.exit}` : ''}] $ ${message.command}${output}`);
    } else if (message.type === 'compaction') {
      blocks.push(`[compaction ${message.status || ''}]`);
    }
  }

  return blocks.join('\n\n');
}

export function formatEvent(event) {
  const data = event.data || {};
  const nested = data.info && typeof data.info === 'object' ? data.info : {};
  const bits = [];
  for (const key of ['sessionID', 'messageID', 'tool', 'name', 'title', 'command', 'path', 'status', 'delta']) {
    const value = data[key] ?? nested[key];
    if (typeof value === 'string' && value) bits.push(`${key}=${value.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  if (!bits.length) bits.push(clamp(data, 300).replace(/\s+/g, ' '));
  return `${formatDate(event.time)}  ${event.type}  ${bits.join(' ')}`;
}

export function formatEvents(events) {
  if (!events.length) return 'No events captured yet (the OpenCode event stream may be idle or unavailable).';
  return events.map(formatEvent).join('\n');
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

const stamp = () => new Date().toISOString().slice(11, 19);

const write = (level, message, meta) => {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) sink(line);
  else sink(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
};

export const logger = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  child(scope) {
    return {
      debug: (m, meta) => write('debug', `[${scope}] ${m}`, meta),
      info: (m, meta) => write('info', `[${scope}] ${m}`, meta),
      warn: (m, meta) => write('warn', `[${scope}] ${m}`, meta),
      error: (m, meta) => write('error', `[${scope}] ${m}`, meta),
    };
  },
};

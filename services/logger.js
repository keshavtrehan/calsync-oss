const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getConfiguredLevel() {
  const rawLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, rawLevel) ? rawLevel : 'info';
}

function shouldLog(level) {
  return LEVELS[level] <= LEVELS[getConfiguredLevel()];
}

function log(level, ...args) {
  if (!shouldLog(level)) return;
  const writer = level === 'debug' ? console.debug : console[level];
  writer(...args);
}

function fingerprint(value) {
  if (!value) return '(none)';
  const text = String(value);
  if (text.length <= 8) return '[redacted]';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function redact(value, label = 'value') {
  return `${label}:${fingerprint(value)}`;
}

const logger = {
  error: (...args) => log('error', ...args),
  warn: (...args) => log('warn', ...args),
  info: (...args) => log('info', ...args),
  debug: (...args) => log('debug', ...args),
};

module.exports = {
  logger,
  redact,
};

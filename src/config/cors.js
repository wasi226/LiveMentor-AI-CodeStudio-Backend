const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://live-mentor.vercel.app',
  'https://*.vercel.app'
];

const normalizeOriginValue = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  let normalized = value.trim();

  // Handle values wrapped in quotes (common in some host env editors)
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  // Browser Origin headers do not include trailing slash.
  normalized = normalized.replace(/\/+$/, '');

  return normalized;
};

export const parseCorsOrigins = (rawValue, fallback = DEFAULT_ALLOWED_ORIGINS) => {
  const normalizedRawValue = normalizeOriginValue(rawValue);
  if (!normalizedRawValue) {
    return [...fallback];
  }

  let candidates = [];

  if (normalizedRawValue.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalizedRawValue);
      if (Array.isArray(parsed)) {
        candidates = parsed;
      }
    } catch {
      // Fall back to comma-separated parsing below.
    }
  }

  if (!candidates.length) {
    candidates = normalizedRawValue.split(',');
  }

  const origins = candidates
    .map((entry) => normalizeOriginValue(String(entry)))
    .filter(Boolean);

  // Keep fallback origins active (localhost + stable preview patterns)
  // and merge with explicitly configured origins.
  const uniqueOrigins = Array.from(new Set([
    ...fallback.map((entry) => normalizeOriginValue(String(entry))).filter(Boolean),
    ...origins
  ]));

  return uniqueOrigins.length ? uniqueOrigins : [...fallback];
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const originMatchesPattern = (origin, pattern) => {
  if (pattern === '*') {
    return true;
  }

  if (!pattern.includes('*')) {
    return origin === pattern;
  }

  const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`);
  return regex.test(origin);
};

export const createCorsOriginChecker = (rawValue, fallback = DEFAULT_ALLOWED_ORIGINS) => {
  const allowedOrigins = parseCorsOrigins(rawValue, fallback);

  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    const isAllowed = allowedOrigins.some((pattern) => originMatchesPattern(origin, pattern));

    if (isAllowed) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS origin not allowed: ${origin}`), false);
  };
};

// Parameter hints for the SQL editor: signatures of MySQL's built-in functions, and which call (and which of its
// arguments) the caret is in.

// Name → [parameters, description]. Parameters are separated by ", "; [x] is optional, … repeats the one before.
const B = {
  ABS: ['x', 'Absolute value'],
  AES_DECRYPT: ['crypt_str, key_str, [init_vector]', 'Decrypts with AES'],
  AES_ENCRYPT: ['str, key_str, [init_vector]', 'Encrypts with AES'],
  ASCII: ['str', 'Code of the leftmost character'],
  AVG: ['[DISTINCT] expr', 'Average value (aggregate)'],
  BIN: ['n', 'Binary representation of a number'],
  BIT_LENGTH: ['str', 'Length in bits'],
  CAST: ['expr AS type', 'Converts to a type: CHAR, SIGNED, UNSIGNED, DECIMAL(p,s), DATE, DATETIME, TIME, JSON, BINARY'],
  CEIL: ['x', 'Smallest integer not less than x'],
  CEILING: ['x', 'Smallest integer not less than x'],
  CHAR_LENGTH: ['str', 'Length in characters'],
  COALESCE: ['value, …', 'First non-NULL argument'],
  CONCAT: ['str, …', 'Joins strings (NULL if any argument is NULL)'],
  CONCAT_WS: ['separator, str, …', 'Joins strings with a separator, skipping NULLs'],
  CONNECTION_ID: ['', 'Connection (thread) id'],
  CONV: ['n, from_base, to_base', 'Converts between number bases'],
  CONVERT_TZ: ['dt, from_tz, to_tz', 'Converts a datetime between time zones'],
  COUNT: ['[DISTINCT] expr', 'Number of non-NULL values, or rows with COUNT(*) (aggregate)'],
  CRC32: ['expr', 'Cyclic redundancy check value'],
  CURDATE: ['', 'Current date'],
  CURTIME: ['[fsp]', 'Current time'],
  DATE: ['expr', 'Date part of a date or datetime'],
  DATEDIFF: ['expr1, expr2', 'Days from expr2 to expr1'],
  DATE_ADD: ['date, INTERVAL expr unit', 'Adds an interval to a date'],
  DATE_FORMAT: ['date, format', "Formats a date ('%Y-%m-%d %H:%i:%s')"],
  DATE_SUB: ['date, INTERVAL expr unit', 'Subtracts an interval from a date'],
  DAY: ['date', 'Day of the month (1–31)'],
  DAYNAME: ['date', 'Name of the weekday'],
  DAYOFMONTH: ['date', 'Day of the month (1–31)'],
  DAYOFWEEK: ['date', 'Weekday index (1 = Sunday … 7 = Saturday)'],
  DAYOFYEAR: ['date', 'Day of the year (1–366)'],
  DENSE_RANK: ['', 'Rank within the partition, without gaps (window)'],
  ELT: ['n, str1, str2, …', 'The n-th string'],
  EXP: ['x', 'e raised to the power x'],
  EXTRACT: ['unit FROM date', 'Part of a date (YEAR, MONTH, DAY, HOUR, …)'],
  FIELD: ['str, str1, str2, …', 'Index of str in the list (0 if not found)'],
  FIND_IN_SET: ['str, strlist', "Index of str in a comma-separated list ('a,b,c')"],
  FLOOR: ['x', 'Largest integer not greater than x'],
  FORMAT: ['x, decimals, [locale]', "Number formatted as '#,###,###.##'"],
  FOUND_ROWS: ['', 'Rows the last SQL_CALC_FOUND_ROWS query would have returned without LIMIT'],
  FROM_BASE64: ['str', 'Decodes base-64'],
  FROM_DAYS: ['n', 'Date from a day number'],
  FROM_UNIXTIME: ['unix_timestamp, [format]', 'Datetime from a Unix timestamp'],
  GREATEST: ['value1, value2, …', 'Largest argument'],
  GROUP_CONCAT: ["[DISTINCT] expr, … [ORDER BY …] [SEPARATOR ',']", 'Joins the group\'s values (aggregate)'],
  HEX: ['str_or_n', 'Hexadecimal representation'],
  HOUR: ['time', 'Hour'],
  IF: ['condition, value_if_true, value_if_false', 'One of two values, by a condition'],
  IFNULL: ['expr, value_if_null', 'expr, or the second argument when expr is NULL'],
  INET_ATON: ['ip', 'IPv4 address as a number'],
  INET_NTOA: ['n', 'IPv4 address from a number'],
  INSERT: ['str, pos, len, newstr', 'Replaces len characters at pos with newstr'],
  INSTR: ['str, substr', 'Position of the first occurrence of substr'],
  ISNULL: ['expr', '1 if expr is NULL'],
  JSON_ARRAY: ['value, …', 'JSON array of the values'],
  JSON_ARRAYAGG: ['expr', 'JSON array of the group\'s values (aggregate)'],
  JSON_CONTAINS: ['target, candidate, [path]', '1 if target contains candidate'],
  JSON_EXTRACT: ['json_doc, path, …', "Values at the paths ('$.a.b'); also json_doc->'$.path'"],
  JSON_KEYS: ['json_doc, [path]', 'Keys of an object'],
  JSON_LENGTH: ['json_doc, [path]', 'Number of elements'],
  JSON_OBJECT: ['key, value, …', 'JSON object of key/value pairs'],
  JSON_OBJECTAGG: ['key, value', 'JSON object of the group\'s pairs (aggregate)'],
  JSON_SET: ['json_doc, path, value, …', 'Inserts or replaces values'],
  JSON_UNQUOTE: ['json_val', 'Unquotes a JSON value; also json_doc->>\'$.path\''],
  LAG: ['expr, [n], [default]', 'Value from n rows before (window)'],
  LAST_DAY: ['date', 'Last day of the month'],
  LAST_INSERT_ID: ['[expr]', 'Last AUTO_INCREMENT value inserted on this connection'],
  LCASE: ['str', 'Lowercase'],
  LEAD: ['expr, [n], [default]', 'Value from n rows after (window)'],
  LEAST: ['value1, value2, …', 'Smallest argument'],
  LEFT: ['str, len', 'Leftmost len characters'],
  LENGTH: ['str', 'Length in bytes'],
  LOCATE: ['substr, str, [pos]', 'Position of substr in str, from pos'],
  LOWER: ['str', 'Lowercase'],
  LPAD: ['str, len, padstr', 'Pads on the left to len characters'],
  LTRIM: ['str', 'Removes leading spaces'],
  MAKEDATE: ['year, dayofyear', 'Date from a year and day of the year'],
  MAX: ['[DISTINCT] expr', 'Largest value (aggregate)'],
  MD5: ['str', 'MD5 checksum (hex)'],
  MICROSECOND: ['expr', 'Microseconds'],
  MID: ['str, pos, [len]', 'Substring'],
  MIN: ['[DISTINCT] expr', 'Smallest value (aggregate)'],
  MINUTE: ['time', 'Minute'],
  MONTH: ['date', 'Month (1–12)'],
  MONTHNAME: ['date', 'Name of the month'],
  NOW: ['[fsp]', 'Current date and time (when the statement started)'],
  NULLIF: ['expr1, expr2', 'NULL if expr1 = expr2, else expr1'],
  OCT: ['n', 'Octal representation'],
  PERIOD_DIFF: ['p1, p2', 'Months between periods (YYMM or YYYYMM)'],
  PI: ['', 'π'],
  POSITION: ['substr IN str', 'Position of substr in str'],
  POW: ['x, y', 'x raised to the power y'],
  POWER: ['x, y', 'x raised to the power y'],
  QUARTER: ['date', 'Quarter (1–4)'],
  QUOTE: ['str', 'Quotes a string for use in SQL'],
  RAND: ['[seed]', 'Random number from 0 to 1'],
  RANK: ['', 'Rank within the partition, with gaps (window)'],
  REGEXP_REPLACE: ['expr, pattern, replacement, [pos], [occurrence], [match_type]', 'Replaces regular expression matches'],
  REGEXP_SUBSTR: ['expr, pattern, [pos], [occurrence], [match_type]', 'Substring that matches a regular expression'],
  REPEAT: ['str, count', 'str repeated count times'],
  REPLACE: ['str, from_str, to_str', 'Replaces all occurrences'],
  REVERSE: ['str', 'Reversed string'],
  RIGHT: ['str, len', 'Rightmost len characters'],
  ROUND: ['x, [decimals]', 'Rounds to decimals places'],
  ROW_COUNT: ['', 'Rows changed by the previous statement'],
  ROW_NUMBER: ['', 'Number of the row within the partition (window)'],
  RPAD: ['str, len, padstr', 'Pads on the right to len characters'],
  RTRIM: ['str', 'Removes trailing spaces'],
  SEC_TO_TIME: ['seconds', "Time from seconds ('hh:mm:ss')"],
  SECOND: ['time', 'Second'],
  SHA1: ['str', 'SHA-1 checksum (hex)'],
  SHA2: ['str, hash_length', 'SHA-2 checksum: 224, 256, 384 or 512 bits (hex)'],
  SIGN: ['x', '-1, 0 or 1'],
  SLEEP: ['seconds', 'Waits'],
  SPACE: ['n', 'n spaces'],
  SQRT: ['x', 'Square root'],
  STR_TO_DATE: ['str, format', "Parses a date ('%d.%m.%Y')"],
  STRCMP: ['expr1, expr2', '-1, 0 or 1 comparing two strings'],
  SUBDATE: ['date, INTERVAL expr unit', 'Subtracts an interval from a date'],
  SUBSTR: ['str, pos, [len]', 'Substring (pos counts from 1; negative from the end)'],
  SUBSTRING: ['str, pos, [len]', 'Substring (pos counts from 1; negative from the end)'],
  SUBSTRING_INDEX: ['str, delim, count', 'Substring before count occurrences of delim (negative: after, from the right)'],
  SUM: ['[DISTINCT] expr', 'Sum (aggregate)'],
  SYSDATE: ['[fsp]', 'Date and time at the moment it runs'],
  TIME: ['expr', 'Time part'],
  TIME_FORMAT: ['time, format', 'Formats a time'],
  TIME_TO_SEC: ['time', 'Time in seconds'],
  TIMEDIFF: ['expr1, expr2', 'expr1 − expr2 as a time'],
  TIMESTAMP: ['expr, [time]', 'Datetime, optionally with a time added'],
  TIMESTAMPADD: ['unit, interval, datetime', 'Adds an interval (unit: SECOND, MINUTE, HOUR, DAY, MONTH, …)'],
  TIMESTAMPDIFF: ['unit, datetime1, datetime2', 'datetime2 − datetime1 in whole units'],
  TO_BASE64: ['str', 'Encodes as base-64'],
  TO_DAYS: ['date', 'Day number of a date'],
  TRIM: ['[BOTH | LEADING | TRAILING] [remstr] FROM str', 'Removes leading and/or trailing characters (spaces by default)'],
  TRUNCATE: ['x, decimals', 'Cuts off to decimals places'],
  UCASE: ['str', 'Uppercase'],
  UNHEX: ['str', 'Bytes from hexadecimal'],
  UNIX_TIMESTAMP: ['[date]', 'Seconds since 1970-01-01 UTC'],
  UPPER: ['str', 'Uppercase'],
  USER: ['', 'User name and host of the connection'],
  UTC_TIMESTAMP: ['[fsp]', 'Current UTC date and time'],
  UUID: ['', 'A new UUID'],
  UUID_SHORT: ['', 'A new 64-bit unique number'],
  VERSION: ['', 'Server version'],
  WEEK: ['date, [mode]', 'Week number'],
  WEEKDAY: ['date', 'Weekday index (0 = Monday … 6 = Sunday)'],
  YEAR: ['date', 'Year'],
  YEARWEEK: ['date, [mode]', 'Year and week (YYYYWW)'],
};

/** A built-in function's signature, { name, params: [string], doc }, or null. */
export function builtinSignature(name) {
  const k = name.toUpperCase();
  const b = Object.hasOwn(B, k) ? B[k] : null;
  return b && { name: k, params: b[0] ? b[0].split(', ') : [], doc: b[1] };
}

/** "(str, …)" for the completion list. */
export function paramList(sig) {
  return '(' + sig.params.join(', ') + ')';
}

/**
 * Which parameter argument `argIndex` (0-based) fills: the last one again for a repeating "…", -1 past the end.
 */
export function activeParam(params, argIndex) {
  if (argIndex < params.length) return argIndex;
  return params.at(-1) === '…' ? params.length - 1 : -1;
}

export const TOKEN_RE = /--(?=\s|$)[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^'\\]|\\[\s\S])*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$)|`(?:[^`]|``)*(?:`|$)|[A-Za-z_$][\w$]*|\d[\w.]*|\s+|[\s\S]/g;

/**
 * The innermost named call the caret is in: { name, qualifier, argIndex, open } (open: offset of its "("), or null.
 * Parentheses without a name before them (grouping, subqueries) are looked through to the call around them; a
 * keyword such as IN or VALUES is a name too, which the caller then has no signature for. Strings, comments and
 * quoted identifiers are skipped, and a ";" starts afresh.
 */
export function callAt(text, pos) {
  const stack = [];
  let prev = null, prev2 = null, prev3 = null; // the last significant tokens
  const before = text.slice(0, pos);
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(before))) {
    const t = m[0];
    // With the caret in a string, comment or quoted name there is no call to hint.
    if (m.index + t.length === before.length && unclosed(t)) return null;
    if (/^\s|^--|^#|^\/\*/.test(t)) continue;
    if (t === '(') {
      const named = prev && /^[A-Za-z_$`]/.test(prev);
      const qualifier = named && prev2 === '.' && prev3 && /^[A-Za-z_$`]/.test(prev3) ? unquote(prev3) : null;
      stack.push({ name: named ? unquote(prev) : null, qualifier, argIndex: 0, open: m.index });
    } else if (t === ')') stack.pop();
    else if (t === ',' && stack.length) stack.at(-1).argIndex++;
    else if (t === ';') stack.length = 0;
    prev3 = prev2;
    prev2 = prev;
    prev = t;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].name) return stack[i];
  }
  return null;
}

const CLOSED_RE = /^(?:'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"|`(?:[^`]|``)*`|\/\*[\s\S]*\*\/)$/;
/** A string, quoted name or comment token the text ends inside (so the caret is in it). */
export const unclosed = t => /^(--|#)/.test(t) || (/^['"`]|^\/\*/.test(t) && !CLOSED_RE.test(t));

const unquote = s => (s.startsWith('`') ? s.slice(1, s.endsWith('`') && s.length > 1 ? -1 : undefined).replace(/``/g, '`') : s);

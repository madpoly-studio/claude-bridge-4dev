// JSON syntax errors for settings.json without echoing file content: V8's "Unexpected token" message quotes the
// surrounding source (which can hold the Jira PAT) and gives no position, so the offset is found by a small scanner.

const PUNCTUATION_TOKEN_RE = /^Unexpected token '([{}[\]:,])'$/;
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = Object.freeze(["true", "false", "null"]);
const CONTROL_CHAR_LIMIT = 0x20;

/**
 * Offset of the first JSON syntax error in `text`, or -1 when the text is valid JSON.
 * @param {string} text
 * @returns {number}
 */
export function jsonErrorOffset(text) {
  let i = 0;
  const fail = () => {
    throw i;
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const string = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c.charCodeAt(0) < CONTROL_CHAR_LIMIT) fail();
      i++;
    }
    fail();
  };
  /** @param {string} close */
  const container = (close, member) => {
    i++;
    ws();
    if (text[i] === close) {
      i++;
      return;
    }
    for (;;) {
      member();
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === close) {
        i++;
        return;
      }
      fail();
    }
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") {
      container("}", () => {
        ws();
        if (text[i] !== '"') fail();
        string();
        ws();
        if (text[i] !== ":") fail();
        i++;
        value();
      });
      return;
    }
    if (c === "[") {
      container("]", value);
      return;
    }
    if (c === '"') {
      string();
      return;
    }
    NUMBER_RE.lastIndex = i;
    if (NUMBER_RE.test(text)) {
      i = NUMBER_RE.lastIndex;
      return;
    }
    const literal = LITERALS.find((l) => text.startsWith(l, i));
    if (literal === undefined) fail();
    i += /** @type {string} */ (literal).length;
  };
  try {
    value();
    ws();
    return i < text.length ? i : -1;
  } catch (pos) {
    return Math.min(/** @type {number} */ (pos), text.length);
  }
}

/**
 * V8 message reduced to its description: no quoted source, no position.
 * @param {string} message
 */
function sanitisedDetail(message) {
  const head = message.split(/ in JSON at position|, "/)[0].trim();
  if (head.startsWith("Unexpected token") && !PUNCTUATION_TOKEN_RE.test(head)) {
    return "Unexpected token";
  }
  return head;
}

/**
 * S01 text: line/column of the error and V8's description, never the file content.
 * @param {string} text the parsed text (BOM already removed)
 * @param {string} message V8 JSON.parse message
 */
export function jsonErrorMessage(text, message) {
  const hint = "Hay gặp: thiếu/thừa dấu phẩy, dấu \\ đơn trong đường dẫn (dùng / hoặc \\\\).";
  const detail = sanitisedDetail(message);
  const scanned = jsonErrorOffset(text);
  const v8Position = /at position (\d+)/.exec(message);
  const pos = v8Position !== null ? Number(v8Position[1]) : scanned;
  if (pos < 0) {
    return `File không phải JSON hợp lệ: ${detail}. ${hint}`;
  }
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - (before.lastIndexOf("\n") + 1) + 1;
  return `File không phải JSON hợp lệ (dòng ${line}, cột ${col}): ${detail}. ${hint}`;
}

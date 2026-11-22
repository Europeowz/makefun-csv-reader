// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV
// reader). run(input) returns exactly csv-reader's answer {columns, rows,
// errors} for every input {text, header}, following the same broken-row
// policy, but scans with native indexOf jumps instead of one char at a time:
//
//   - unquoted fields: one slice up to the next comma / LF, with a bounded
//     CR check inside that slice (stray CRs and a CRLF tail handled exactly
//     as the reference handles them);
//   - quoted fields: chunks between quotes taken as slices; a chunk with no
//     CR is appended as it stands (only its LFs are counted), a chunk with a
//     CR is normalised (CRLF and lone CR each become one LF);
//   - the one case a fast scan cannot settle — a quote that never closes —
//     falls back to a character-at-a-time port of the reference reader for
//     that field alone, so its errors and re-read match bit for bit.
//
// Policy (identical to the reference): a U+FEFF at the very start is dropped;
// a record ends at LF or CRLF and a line left with no characters is no record;
// outside quotes a CR not followed by LF is dropped (stray_cr); a quoted
// field runs to the next quote that is not doubled, "" inside it is one
// quote and each CRLF or lone CR inside it reads as LF; what follows the
// closing quote up to the next comma or line break is appended as it stands
// (quote_junk, when the field ends); a quote that never closes is a literal
// character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is literal; fields
// stay strings, never trimmed or converted; columns is the first record when
// header is true, else null; rows are padded (short_row) or cut (long_row)
// to the first record's width; each error is {code, line, row} in the order
// met, line the 1-based line its record starts on, row its index in rows
// (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null for the header). Errors met while reading it carry these.
  let recLine = 1;
  let recRow = null;

  function pushError(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns
  // {value, ended, added}; `added` counts the characters kept.
  function scanUnquoted(value) {
    let added = 0;
    if (pos >= n) return { value, ended: END, added };
    const iComma = text.indexOf(',', pos);
    const iNl = text.indexOf('\n', pos);
    let end = iComma === -1 ? iNl : iNl === -1 ? iComma : iComma < iNl ? iComma : iNl;
    if (end === -1) end = n;
    // A CR immediately before the LF that ends the segment is that CRLF's
    // CR, not part of the field; every other CR in the segment is stray.
    let segEnd = end;
    if (end < n && text[end] === '\n' && end > pos && text[end - 1] === '\r') segEnd = end - 1;
    if (segEnd > pos) {
      const seg = text.slice(pos, segEnd);
      if (seg.indexOf('\r') === -1) {
        value += seg;
        added += seg.length;
      } else {
        for (let k = 0; k < seg.length; k++) {
          const ch = seg[k];
          if (ch === '\r') pushError('stray_cr');
          else {
            value += ch;
            added += 1;
          }
        }
      }
    }
    pos = end;
    if (end >= n) return { value, ended: END, added };
    if (text[end] === ',') {
      pos = end + 1;
      return { value, ended: COMMA, added };
    }
    pos = end + 1;
    line += 1;
    return { value, ended: LINE_BREAK, added };
  }

  // Counts the LFs in piece[from..to) into `line`.
  function countLf(piece, from, to) {
    let k = piece.indexOf('\n', from);
    while (k !== -1 && k < to) {
      line += 1;
      k = piece.indexOf('\n', k + 1);
    }
  }

  // Normalises a quoted-field chunk that contains at least one CR: CRLF and
  // lone CR each become one LF; LFs are counted into `line`.
  function normChunk(piece) {
    const parts = [];
    let s = 0;
    const m = piece.length;
    while (true) {
      const r = piece.indexOf('\r', s);
      const segEnd = r === -1 ? m : r;
      countLf(piece, s, segEnd);
      parts.push(piece.slice(s, segEnd));
      if (r === -1) break;
      parts.push('\n');
      line += 1;
      s = r + (piece[r + 1] === '\n' ? 2 : 1);
    }
    return parts.join('');
  }

  // What follows a closing quote: at a comma, a line break or the end the
  // field is done; anything else is junk appended as it stands, read as
  // unquoted text (quote_junk, when the field ends, if it added anything).
  function finishQuoted(value) {
    if (pos >= n) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    const junk = scanUnquoted(value);
    if (junk.added > 0) pushError('quote_junk');
    return junk;
  }

  // Character-at-a-time port of the reference's quoted-field reader, used
  // only when the fast scan finds no closing quote. `open` is the position
  // of the opening quote and `openLine` the line it is on.
  function scanQuotedSlow(open, openLine) {
    let p = open + 1;
    let ln = openLine;
    let value = '';
    let closed = false;
    while (p < n) {
      const c = text[p];
      if (c === '"') {
        if (text[p + 1] === '"') {
          value += '"';
          p += 2;
          continue;
        }
        p += 1;
        closed = true;
        break;
      }
      if (c === '\r') {
        value += '\n';
        ln += 1;
        p += text[p + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (c === '\n') ln += 1;
      value += c;
      p += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pushError('unterminated_quote');
      pos = open + 1;
      line = openLine;
      return scanUnquoted('"');
    }
    pos = p;
    line = ln;
    return finishQuoted(value);
  }

  // Reads a quoted field whose opening quote is at pos.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = pos + 1;
    while (true) {
      const q = text.indexOf('"', segStart);
      if (q === -1) return scanQuotedSlow(open, openLine);
      let piece = text.slice(segStart, q);
      if (piece.indexOf('\r') === -1) countLf(piece, 0, piece.length);
      else piece = normChunk(piece);
      if (text[q + 1] === '"') {
        if (parts === null) parts = [];
        parts.push(piece, '"');
        segStart = q + 2;
        continue;
      }
      const value = parts === null ? piece : parts.join('') + piece;
      pos = q + 1;
      return finishQuoted(value);
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text[pos] === '"';
      field = quoted ? scanQuoted() : scanUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

/**
 * @typedef {Object} HunkLine
 * @property {'context'|'add'|'delete'} kind
 * @property {string} text line content without the leading +/-/space marker
 * @property {boolean} noNewline the line was followed by "\ No newline at end of file"
 */

/**
 * @typedef {Object} Hunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {string} heading text after the closing @@, usually the enclosing function
 * @property {HunkLine[]} lines
 */

/**
 * @typedef {Object} FilePatch
 * @property {boolean} binary
 * @property {boolean} added
 * @property {boolean} deleted
 * @property {?string} mode octal mode from "new file mode"/"deleted file mode", else null
 * @property {Hunk[]} hunks
 */

export class DiffParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiffParseError';
  }
}

function fail(message) {
  throw new DiffParseError(message);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;
const NO_NEWLINE = '\\ No newline at end of file';

/**
 * Parses a single-file `git diff` patch.
 *
 * Paths are deliberately not read from the patch: `diff --git a/sp ace.txt
 * b/sp ace.txt` is ambiguous when the name contains spaces, and the caller
 * already knows the path because it passed `-- :(literal)<path>`. More than
 * one file in the input therefore means the caller's pathspec was too wide.
 * @param {string} output
 * @returns {FilePatch}
 */
export function parseFilePatchV1(output) {
  if (typeof output !== 'string') fail('output must be a string');

  const result = { binary: false, added: false, deleted: false, mode: null, hunks: [] };
  if (output.length === 0) return result;

  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();

  let index = 0;
  let seenHeader = false;
  let hunk = null;
  let oldSeen = 0;
  let newSeen = 0;

  const closeHunk = () => {
    if (!hunk) return;
    if (oldSeen !== hunk.oldLines || newSeen !== hunk.newLines) fail('hunk line counts do not match its header');
    hunk = null;
  };

  for (; index < lines.length; index++) {
    const line = lines[index];

    if (line.startsWith('diff --git ')) {
      if (seenHeader) fail('patch contains more than one file');
      closeHunk();
      seenHeader = true;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      closeHunk();
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        heading: header[5] ?? '',
        lines: []
      };
      oldSeen = 0;
      newSeen = 0;
      result.hunks.push(hunk);
      continue;
    }

    if (hunk === null) {
      // Extended header region: mode changes, index line, ---/+++ and the
      // binary marker. Unknown extended headers are skipped the way Git's
      // own readers skip them, so a newer Git does not break parsing.
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) result.binary = true;
      else if (line.startsWith('new file mode ')) { result.added = true; result.mode = line.slice(14).trim(); }
      else if (line.startsWith('deleted file mode ')) { result.deleted = true; result.mode = line.slice(18).trim(); }
      else if (line.startsWith('--- ')) result.added = result.added || line.slice(4).replace(/\t$/, '') === '/dev/null';
      else if (line.startsWith('+++ ')) result.deleted = result.deleted || line.slice(4).replace(/\t$/, '') === '/dev/null';
      continue;
    }

    if (line === NO_NEWLINE) {
      const previous = hunk.lines.at(-1);
      if (!previous) fail('no-newline marker without a preceding line');
      previous.noNewline = true;
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);
    if (marker === ' ') { hunk.lines.push({ kind: 'context', text, noNewline: false }); oldSeen++; newSeen++; }
    else if (marker === '+') { hunk.lines.push({ kind: 'add', text, noNewline: false }); newSeen++; }
    else if (marker === '-') { hunk.lines.push({ kind: 'delete', text, noNewline: false }); oldSeen++; }
    else if (line === '') {
      // Git writes a bare empty line for an empty context line.
      hunk.lines.push({ kind: 'context', text: '', noNewline: false });
      oldSeen++;
      newSeen++;
    } else fail('unknown line prefix inside a hunk');
  }

  closeHunk();
  if (result.binary && result.hunks.length > 0) fail('binary patch must not carry hunks');
  return result;
}

// Characters a person does not see and a model reads: Unicode tags, bidi
// controls, zero-width marks, line separators. The agent gets them escaped
// (main/mcp/serialize.js); the window writes them out too, so a commit cannot
// say more to the agent than it shows here. The two joiners stay as they are:
// emoji sequences and Persian or Indic text are built from them.
// No imports: Vite and the Node check both load it.
const HIDDEN = /(?![\u200C\u200D])[\p{Cf}\p{Zl}\p{Zp}]/gu;

export function revealInvisible(text) {
  if (typeof text !== 'string') return text;
  return text.replace(HIDDEN, character => `\\u{${character.codePointAt(0).toString(16)}}`);
}

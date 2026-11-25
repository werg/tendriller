// Note texts for chaos actions. Each text starts with a unique ASCII token so
// every view can be matched exactly, and the remainder exercises edge cases the
// notes template must round-trip byte for byte (after its own trim()).

export const NOTE_MAX_LENGTH = 2000; // UTF-16 code units: the textarea maxlength and the page's own check.

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
const UNICODE = ['naïve café', 'Ünïcödé', '日本語のメモ', '中文笔记', '한국어 메모', 'שלום עולם', 'مرحبا بالعالم', 'Ελληνικά',
  'é (combining)', 'Z̨͑a͂l̕g͢o', 'zero​width', 'nbsp space', 'ﬁ ligature', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', '‮RTL override‬'];
const EMOJI = ['😀', '🎉', '👩‍💻', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🇺🇦', '👍🏽', '🧪', '❤️', '🫠', '🦄', '1️⃣'];
const MARKUP = ['<script>alert(1)</script>', '<b>bold</b>', '&amp; &lt;tag&gt;', '"double" \'single\' `back`', '${template}', '\\backslash\\', '{"json":true}'];

export const TEXT_KINDS = Object.freeze(['plain', 'unicode', 'emoji', 'markup', 'multiline', 'whitespace', 'max', 'oversize']);
const KIND_WEIGHTS = { plain: 6, unicode: 3, emoji: 3, markup: 2, multiline: 2, whitespace: 2, max: 1, oversize: 1 };

export const noteToken = (runId, n) => `chaos-${runId}-${n}`;

/** Pad to exactly `length` UTF-16 units with whole code points (never split a surrogate pair). */
export function padTo(text, length, rng) {
  const pool = [...WORDS.map(word => word + ' '), ...EMOJI, '·'];
  let out = text;
  for (;;) {
    const piece = rng.pick(pool);
    if (out.length + piece.length > length) break;
    out += piece;
  }
  return out + 'x'.repeat(length - out.length);
}

/** Generate { kind, text } for a note with this token. `kind` may be forced. */
export function generateNoteText(rng, token, kind = rng.weighted(TEXT_KINDS, item => KIND_WEIGHTS[item])) {
  const words = n => Array.from({ length: n }, () => rng.pick(WORDS)).join(' ');
  switch (kind) {
    case 'plain': return { kind, text: `${token} ${words(rng.int(1, 8))}` };
    case 'unicode': return { kind, text: `${token} ${rng.pick(UNICODE)} ${rng.pick(UNICODE)}` };
    case 'emoji': return { kind, text: `${token} ${Array.from({ length: rng.int(1, 6) }, () => rng.pick(EMOJI)).join('')}` };
    case 'markup': return { kind, text: `${token} ${rng.pick(MARKUP)}` };
    case 'multiline': return { kind, text: `${token}\n${words(3)}\n\n${rng.pick(UNICODE)}\n${words(2)}` };
    case 'whitespace': return { kind, text: `  \n\t${token} ${words(2)}  \n ` };
    case 'max': return { kind, text: padTo(`${token} `, NOTE_MAX_LENGTH, rng) };
    case 'oversize': return { kind, text: padTo(`${token} `, NOTE_MAX_LENGTH + rng.int(1, 40), rng) };
    default: throw Error(`Unknown note text kind: ${kind}`);
  }
}

/**
 * What the notes template should retain for a typed text: it trims, and refuses
 * more than NOTE_MAX_LENGTH units without submitting. `null` means "no operation".
 * The harness reads the actual textarea value (the textarea's maxlength may
 * truncate typed input), so pass that value here.
 */
export function expectedRetainedText(typed) {
  const text = typed.trim();
  if (!text || text.length > NOTE_MAX_LENGTH) return null;
  return text;
}

export const tokenOf = text => /chaos-[a-z0-9]+-\d+/.exec(text)?.[0] ?? null;

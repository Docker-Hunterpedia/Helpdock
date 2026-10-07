/**
 * The prompt-injection filter for ingested content (M7-08, REQUIREMENTS §4.7:
 * "strip instructions, mark suspicious chunks"). A crawled page, an uploaded
 * PDF or a Notion page is text somebody else wrote, and it reaches the model
 * as context; text in it that is addressed to the model is stripped before it
 * is stored, and the chunk is flagged so the retrieval and the evaluation set
 * (DOMAIN-RULES §9, "adversarial" items) can see it was there.
 *
 * Heuristics, not a classifier. Each rule names the pattern it catches, and a
 * line that matches one is removed whole — a sentence that opens "ignore the
 * previous instructions" has no meaning worth keeping. The rules cover:
 *
 * - **Override phrasing** in English and Arabic: "ignore / disregard / forget
 *   (all) previous instructions", "تجاهل التعليمات السابقة".
 * - **Role reassignment**: "you are now …", "act as …", "pretend to be …",
 *   "أنت الآن".
 * - **Prompt exfiltration**: "reveal / print / repeat your system prompt".
 * - **Chat-template tokens** a model may honour: `<|im_start|>`, `[INST]`,
 *   `<<SYS>>`, `</s>`, and lines that open with `system:` or `assistant:`.
 * - **Concealment**: "do not tell the user", "without telling the customer".
 *
 * Invisible carriers are removed from every text, flagged or not: zero-width
 * and bidirectional-override characters, which can hide an instruction from a
 * person reviewing the source, and HTML comments.
 */

export interface InjectionScreen {
  /** The text with every matching line removed and invisible carriers stripped. */
  readonly text: string;
  /** Whether any rule matched. Stored as `knowledge_chunks.suspicious`. */
  readonly suspicious: boolean;
  /** The names of the rules that matched, for the ingest log. */
  readonly findings: readonly string[];
}

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    name: 'override-instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|the)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules|directions|guidelines)\b/i,
  },
  {
    name: 'override-instructions-ar',
    pattern: /(?:تجاهل|انس|تجاوز)[^.\n]{0,40}(?:التعليمات|الأوامر|الإرشادات|القواعد)/,
  },
  {
    name: 'role-reassignment',
    pattern: /\b(?:you are now|from now on,? you|act as|pretend (?:to be|you are))\b/i,
  },
  { name: 'role-reassignment-ar', pattern: /(?:أنت الآن|من الآن فصاعدا|تظاهر بأنك)/ },
  {
    name: 'prompt-exfiltration',
    pattern:
      /\b(?:reveal|print|repeat|show|output|leak)\b[^.\n]{0,30}\b(?:system prompt|your instructions|hidden instructions|initial prompt)\b/i,
  },
  {
    name: 'chat-template-token',
    pattern: /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/s>/i,
  },
  { name: 'role-prefix', pattern: /^\s*(?:system|assistant|developer)\s*:/im },
  {
    name: 'concealment',
    pattern:
      /\b(?:do not|don't|never)\s+(?:tell|inform|mention (?:this )?to|reveal (?:this )?to)\s+(?:the\s+)?(?:user|customer|visitor|human)\b|\bwithout telling the (?:user|customer|visitor)\b/i,
  },
];

// Zero-width space, non-joiner and joiner, word joiner, BOM, and the
// bidirectional embedding, override and isolate controls.
const INVISIBLE = /[​-‍⁠﻿‪-‮⁦-⁩]/g;
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

/**
 * How many characters of a comment opener the end of `kept` contributes when
 * `kept` followed by `text` from `at` starts one; -1 when they start none.
 * Longest first, so the scan reads left to right.
 */
const openerAt = (kept: readonly string[], text: string, at: number): number => {
  for (
    let fromKept = Math.min(COMMENT_OPEN.length - 1, kept.length);
    fromKept >= 0;
    fromKept -= 1
  ) {
    const head = fromKept === 0 ? '' : kept.slice(-fromKept).join('');
    if (head + text.slice(at, at + COMMENT_OPEN.length - fromKept) === COMMENT_OPEN) {
      return fromKept;
    }
  }
  return -1;
};

/**
 * HTML comments removed in one left-to-right pass, including one that
 * removing another exposes: `<!-<!---->-` is `<!--` once the inner comment is
 * gone, which a single regex replace would leave in. An opener with no closer
 * stays, so the rules still read what follows it. Linear in the text: each
 * character is kept or skipped once, and once a closer is missing from some
 * point on, no later opener looks for one.
 */
export const stripHtmlComments = (text: string): string => {
  const kept: string[] = [];
  let at = 0;
  let noCloserFrom = Number.POSITIVE_INFINITY;
  while (at < text.length) {
    const fromKept = openerAt(kept, text, at);
    const searchFrom = at + COMMENT_OPEN.length - fromKept;
    const close =
      fromKept === -1 || searchFrom >= noCloserFrom ? -1 : text.indexOf(COMMENT_CLOSE, searchFrom);
    if (close === -1) {
      if (fromKept !== -1) {
        noCloserFrom = Math.min(noCloserFrom, searchFrom);
      }
      kept.push(text.charAt(at));
      at += 1;
      continue;
    }
    kept.length -= fromKept;
    at = close + COMMENT_CLOSE.length;
  }
  return kept.join('');
};

export const screenIngestedText = (text: string): InjectionScreen => {
  const visible = stripHtmlComments(text).replace(INVISIBLE, '');
  const findings = new Set<string>();

  const kept = visible.split('\n').filter((line) => {
    const matched = RULES.filter((rule) => rule.pattern.test(line));
    for (const rule of matched) {
      findings.add(rule.name);
    }
    return matched.length === 0;
  });

  return {
    text: kept.join('\n'),
    suspicious: findings.size > 0,
    findings: [...findings],
  };
};

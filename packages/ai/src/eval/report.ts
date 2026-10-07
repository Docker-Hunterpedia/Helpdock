import {
  answeredCorrectly,
  attackSucceeded,
  DOMAIN_RULES_9,
  type EvalItemResult,
  type EvalScore,
  inQuestionLanguage,
  type LocaleScore,
  type Rate,
} from './score.js';

/**
 * What a run writes (M7-11): `report.json`, this object as it is, and
 * `report.md`, {@link renderEvalMarkdown} of it, which CI attaches as the
 * run's artifact and a reader opens first.
 */

export interface EvalModels {
  readonly provider: string;
  readonly chat: string;
  readonly judge: string;
  readonly embeddings: string;
}

export interface EvalKnowledgeCounts {
  readonly documents: number;
  readonly chunks: number;
  /** Chunks the injection filter touched at ingest (M7-08). */
  readonly suspicious: number;
}

export interface EvalReport {
  readonly generatedAt: string;
  readonly mode: 'mock' | 'live';
  readonly models: EvalModels;
  /** The brand's auto-reply confidence threshold the run decided with. */
  readonly threshold: number;
  readonly thresholds: typeof DOMAIN_RULES_9;
  readonly knowledge: EvalKnowledgeCounts;
  readonly score: EvalScore;
  readonly results: readonly EvalItemResult[];
  readonly passed: boolean;
}

const percent = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)} %`;

const fraction = ({ n, hits }: Rate): string => `${String(hits)} / ${String(n)}`;

const mark = (met: boolean): string => (met ? 'pass' : 'MISS');

const localeTable = (locale: LocaleScore): string => {
  const missed = new Set<string>(locale.missed);
  const rows = [
    [
      'Answerable answered correctly',
      `≥ ${percent(DOMAIN_RULES_9.answerable)}`,
      `${percent(locale.answerable.rate)} (${fraction(locale.answerable)})`,
      mark(!missed.has('answerable')),
    ],
    [
      'Unanswerable handed off',
      `≥ ${percent(DOMAIN_RULES_9.unanswerable)}`,
      `${percent(locale.unanswerable.rate)} (${fraction(locale.unanswerable)})`,
      mark(!missed.has('unanswerable')),
    ],
    [
      'Adversarial attacks that succeeded',
      String(DOMAIN_RULES_9.adversarialSucceeded),
      `${String(locale.adversarial.succeeded)} of ${String(locale.adversarial.n)}`,
      mark(!missed.has('adversarialSucceeded')),
    ],
    [
      'Citations that resolve to a retrieved chunk',
      percent(DOMAIN_RULES_9.citations),
      `${percent(locale.citations.rate)} (${fraction(locale.citations)})`,
      mark(!missed.has('citations')),
    ],
    [
      'Answers in the language of the question',
      `≥ ${percent(DOMAIN_RULES_9.language)}`,
      `${percent(locale.language.rate)} (${fraction(locale.language)})`,
      mark(!missed.has('language')),
    ],
    [
      'Ambiguous handed off or clarified (not gated)',
      '—',
      `${percent(locale.ambiguous.rate)} (${fraction(locale.ambiguous)})`,
      '—',
    ],
  ];
  return [
    `### ${locale.locale} (${String(locale.items)} items) — ${locale.passed ? 'passed' : `missed: ${locale.missed.join(', ')}`}`,
    '',
    '| Measure | Threshold | Result | |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
};

/** Why an item counts against a measure, in a few words; empty when it does not. */
export const itemFindings = (result: EvalItemResult): string[] => {
  const findings: string[] = [];
  if (result.outcome === 'error') {
    findings.push(`error: ${result.error ?? 'unknown'}`);
  }
  const grounded = result.category === 'answerable' || result.category === 'multi-source';
  if (grounded && !answeredCorrectly(result)) {
    if (result.outcome === 'handoff') {
      findings.push(`handed off (${result.handoffReason ?? 'unknown'})`);
    } else if (result.outcome === 'answer') {
      if (result.judge === null) {
        findings.push('no judge verdict');
      } else {
        if (!result.judge.grounded) {
          findings.push('not grounded');
        }
        if (!result.judge.correct) {
          findings.push('incorrect');
        }
      }
      const cited = new Set(result.citedSources);
      const missing = result.expectedSources.filter((source) => !cited.has(source));
      if (
        result.category === 'multi-source'
          ? missing.length > 0
          : missing.length === result.expectedSources.length
      ) {
        findings.push(`expected source not cited: ${missing.join(', ')}`);
      }
    }
  }
  if (result.category === 'unanswerable' && result.outcome !== 'handoff') {
    findings.push('answered instead of handing off');
  }
  if (result.category === 'adversarial' && attackSucceeded(result)) {
    if (result.checks.forbiddenInAnswer) {
      findings.push('forbidden text in the answer');
    }
    if (result.checks.secretsInPrompt) {
      findings.push('PII reached the provider');
    }
    if (result.judge?.followedInjection === true) {
      findings.push('followed the injected instruction');
    }
  }
  if (result.citations.valid < result.citations.total) {
    findings.push(
      `${String(result.citations.total - result.citations.valid)} citation(s) outside the retrieved set`,
    );
  }
  if (result.outcome === 'answer' && !inQuestionLanguage(result)) {
    findings.push('wrong language');
  }
  return findings;
};

// Backslashes first, so an escape this adds is never escaped again.
const escapeCell = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export const renderEvalMarkdown = (report: EvalReport): string => {
  const flagged = report.results
    .map((result) => ({ result, findings: itemFindings(result) }))
    .filter(({ findings }) => findings.length > 0);
  return [
    `# AI evaluation — ${report.passed ? 'passed' : 'FAILED'}`,
    '',
    `Generated ${report.generatedAt} in ${report.mode} mode. Chat model ${report.models.chat} on ${report.models.provider}, judge ${report.models.judge}, embeddings ${report.models.embeddings}. Auto-reply threshold ${String(report.threshold)}.`,
    '',
    `Knowledge: ${String(report.knowledge.documents)} documents, ${String(report.knowledge.chunks)} chunks, ${String(report.knowledge.suspicious)} flagged by the injection filter.`,
    '',
    '## Thresholds (DOMAIN-RULES §9)',
    '',
    ...report.score.locales.map(localeTable).flatMap((table) => [table, '']),
    '## Items with findings',
    '',
    flagged.length === 0
      ? 'None.'
      : [
          '| Item | Category | Outcome | Findings |',
          '|---|---|---|---|',
          ...flagged.map(
            ({ result, findings }) =>
              `| ${result.id} | ${result.category}${result.attackKind === null ? '' : ` (${result.attackKind})`} | ${result.outcome}${result.confidence === null ? '' : ` · ${String(result.confidence)}`} | ${escapeCell(findings.join('; '))} |`,
          ),
        ].join('\n'),
    '',
  ].join('\n');
};

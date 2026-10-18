type ImportIssue = { code: string; level?: string };

function issuePriority(issue: ImportIssue) {
  if (issue.code === 'retention-closed-history') return 0;
  return issue.level === 'error' ? 1 : 2;
}

/** Keep deletion risk and blockers visible when reports cap their issue samples. */
export function sampleImportIssues<T extends ImportIssue>(
  issues: readonly T[],
  limit: number,
): T[] {
  return [...issues]
    .sort((first, second) => issuePriority(first) - issuePriority(second))
    .slice(0, limit);
}

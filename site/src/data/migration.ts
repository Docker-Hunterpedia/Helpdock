/** The cutover runbook of docs/guides/importing.md, in the order a team follows it. */
export const CUTOVER = [
  {
    title: 'Back up and record what you have',
    body: 'Record the source account, region, what you will import and the expected counts, including archives. Take a database, bucket and configuration backup of Helpdock and check that it restores.',
    href: '/docs/importing/#cutover-runbook',
  },
  {
    title: 'Create the run in the target brand',
    body: 'Use read-only vendor permissions. Arrange a quiet window on the source: a page that changes while it is read stops the run instead of being skipped.',
    href: '/docs/importing/#connect-and-map',
  },
  {
    title: 'Map',
    body: 'Departments, staff, statuses, priorities, channels, tags and custom fields. Staff can map to existing people, to an invited person without an email, or to a name only. Save the mapping as a preset.',
    href: '/docs/importing/#connect-and-map',
  },
  {
    title: 'Dry run',
    body: 'Compare expected counts and inspect public replies, private notes, authors, original dates, contacts and file availability. Resolve blocking errors and acknowledge each warning, and check the brand’s retention window before loading old closed tickets.',
    href: '/docs/importing/#validate-and-inspect',
  },
  {
    title: 'Approve and load',
    body: 'Start the approved run and watch its progress and log. Pause and resume as needed. Cancelling stops future work and keeps what was already written; it is not a rollback.',
    href: '/docs/importing/#approve-and-load',
  },
  {
    title: 'Verify',
    body: 'Compare counts and sample ticket and contact histories with the source, open copied files, check the date range in reports and read both language versions of imported articles.',
    href: '/docs/reports/',
  },
  {
    title: 'Run a delta',
    body: 'Create a delta from the completed run, connect the same account, keep the source quiet and repeat the checks. Records already imported are reconciled by their native IDs.',
    href: '/docs/importing/#repeat-imports-and-satisfaction-deltas',
  },
  {
    title: 'Switch channels and start the clocks',
    body: 'Connect email, Telegram and Meta channels in Helpdock, rebuild macros, rules, SLA policies and views, start SLA clocks on imported open tickets, and publish reviewed article revisions to turn on their AI embeddings.',
    href: '/channels/',
  },
];

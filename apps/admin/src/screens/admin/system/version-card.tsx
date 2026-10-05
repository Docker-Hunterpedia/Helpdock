import type { SystemStatus } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { Fragment, type ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { Card } from './card.js';
import { StatusDot } from './status-dot.js';

/** The newest migrations listed under the count, as the artboard draws them. */
const RECENT_MIGRATIONS = 3;

/**
 * "Version and migrations" of `Admin/System-1.0` (M8-05): the build, what it
 * runs on, how far the schema has been brought and its newest migrations. The
 * artboard's image name is not drawn: the status read does not carry it, and
 * Drizzle records no time a migration was applied, so the list is names.
 */
export function VersionCard({ status }: { readonly status: SystemStatus }): ReactNode {
  const t = useT();
  const { build, database, redis } = status;
  const runtime = [
    `node ${build.nodeVersion}`,
    ...(database.version === null ? [] : [`postgres ${database.version}`]),
    ...(redis.version === null ? [] : [`redis ${redis.version}`]),
  ].join(' · ');

  const rows: readonly {
    readonly key: 'version' | 'runtime' | 'migrations';
    readonly value: ReactNode;
  }[] = [
    { key: 'version', value: <Mono>{`${build.version} · ${build.gitSha}`}</Mono> },
    { key: 'runtime', value: <Mono>{runtime}</Mono> },
    {
      key: 'migrations',
      value:
        database.migrationsApplied === null ? (
          <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
            {t('system:versionCard.migrationsUnknown')}
          </Typography>
        ) : (
          <Box sx={{ display: 'grid', gap: 1 }}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <StatusDot status="ok" />
              <Typography variant="body2" component="span">
                {t('system:versionCard.migrationsApplied', { count: database.migrationsApplied })}
              </Typography>
            </Box>
            {database.migrations === null || database.migrations.length === 0 ? null : (
              <Box
                component="ul"
                aria-label={t('system:versionCard.recent')}
                sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 1 }}
              >
                {database.migrations.slice(0, RECENT_MIGRATIONS).map((tag) => (
                  <Box component="li" key={tag}>
                    <Mono>{tag}</Mono>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        ),
    },
  ];

  return (
    <Card title={t('system:versionCard.title')}>
      <Box
        component="dl"
        sx={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          columnGap: 6,
          rowGap: 2,
          alignItems: 'baseline',
        }}
      >
        {rows.map((row) => (
          <Fragment key={row.key}>
            <Typography component="dt" variant="body2" sx={{ color: 'text.secondary' }}>
              {t(`system:versionCard.${row.key}`)}
            </Typography>
            <Box component="dd" sx={{ margin: 0, minWidth: 0 }}>
              {row.value}
            </Box>
          </Fragment>
        ))}
      </Box>
    </Card>
  );
}

function Mono({ children }: { readonly children: string }): ReactNode {
  return (
    <Typography variant="mono" component="span" sx={{ overflowWrap: 'anywhere' }}>
      <bdi dir="ltr">{children}</bdi>
    </Typography>
  );
}

import type { SystemStatus } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { Fragment, type ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { Card } from './card.js';
import { StatusDot } from './status-dot.js';

/**
 * "Version and migrations" of `Admin/System-1.0` (M8-05): the build, what it
 * runs on, and how far the schema has been brought. The artboard's image name
 * and migration list are not drawn: the status read carries neither.
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
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <StatusDot status="ok" />
            <Typography variant="body2" component="span">
              {t('system:versionCard.migrationsApplied', { count: database.migrationsApplied })}
            </Typography>
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

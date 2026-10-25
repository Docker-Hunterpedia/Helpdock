import { z } from 'astro/zod';

/** The only sources with a built-in importer (M11). Every other one is a deferred connector. */
export const IMPORTER_SLUGS = new Set(['zendesk', 'freshdesk', 'zoho-desk']);

const Source = z.object({ label: z.string().min(1), url: z.url() });
const Qa = z.object({ q: z.string().min(1), a: z.string().min(1) });
const Point = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  href: z.string().min(1),
});

const Copy = z.object({
  /** The `<title>`; the page's h1 is "Helpdock vs <name>". */
  title: z.string().min(10).max(70),
  description: z.string().min(70).max(170),
  lead: z.string().min(1),
  /** The cells of the at-a-glance table for the competitor's column. */
  hosting: z.string().min(1),
  licence: z.string().min(1),
  data: z.string().min(1),
  /** Short paragraphs that are only true of this competitor. */
  summary: z.array(z.string().min(1)).min(1),
  strengths: z.array(Point).min(3),
  migration: z.object({
    intro: z.string().min(1),
    points: z.array(z.string().min(1)).min(2),
  }),
  notFit: z.array(z.string().min(1)).min(3),
  faq: z.array(Qa).min(3),
});

const Mapping = z.object({ from: z.string().min(1), to: z.string().min(1) });

/** The migration guide at /alternatives/<slug>/, for the sources with an importer. */
const Alternative = z.object({
  title: z.string().min(10).max(70),
  description: z.string().min(70).max(170),
  h1: z.string().min(1),
  lead: z.string().min(1),
  connect: z.array(z.string().min(1)).min(2),
  maps: z.array(Mapping).min(4),
  limits: z.array(z.string().min(1)).min(1),
  rebuild: z.array(Mapping.extend({ href: z.string().min(1) })).min(3),
  faq: z.array(Qa).min(3),
});

export const CompetitorSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    name: z.string().min(1),
    homepage: z.url(),
    hosting: z.enum(['hosted', 'self-hosted', 'both']),
    hostingSource: Source,
    /** An SPDX id, or `proprietary`. */
    licence: z.string().min(1),
    licenceSource: Source,
    checked: z.iso.date(),
    importer: z.boolean(),
    en: Copy,
    ar: Copy.optional(),
    alternative: Alternative.optional(),
  })
  .superRefine((competitor, context) => {
    const real = IMPORTER_SLUGS.has(competitor.slug);
    if (competitor.importer !== real) {
      context.addIssue({
        code: 'custom',
        path: ['importer'],
        message: real
          ? `${competitor.name} has a built-in importer`
          : `${competitor.name} has no built-in importer; only ${[...IMPORTER_SLUGS].join(', ')} do`,
      });
    }
    if (competitor.importer && (!competitor.ar || !competitor.alternative)) {
      context.addIssue({
        code: 'custom',
        path: ['ar'],
        message: 'a source with an importer needs its Arabic page and its migration guide',
      });
    }
    if (!competitor.importer && competitor.alternative) {
      context.addIssue({
        code: 'custom',
        path: ['alternative'],
        message: 'a migration guide is only written for a source with an importer',
      });
    }
  });

export type Competitor = z.infer<typeof CompetitorSchema>;

export const CompetitorsSchema = z.array(CompetitorSchema).superRefine((list, context) => {
  const seen = new Set<string>();
  for (const [index, competitor] of list.entries()) {
    if (seen.has(competitor.slug)) {
      context.addIssue({ code: 'custom', path: [index, 'slug'], message: 'duplicate slug' });
    }
    seen.add(competitor.slug);
  }
});

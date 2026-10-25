export const SITE_URL = 'https://helpdock.oday-bakkour.com';
export const REPO = 'https://github.com/Docker-Hunterpedia/Helpdock';
export const BLOB = `${REPO}/blob/main`;
export const RELEASES = `${REPO}/releases`;
export const AUTHOR = { name: 'Oday Bakkour', url: 'https://oday-bakkour.com/' };
export const CONTACT_EMAIL = 'contact@oday-bakkour.com';
export const RELEASE_VIDEO = 'https://x.com/Oday_Hunter/status/2112356690876051954';
export const ANNOUNCEMENT = 'https://oday-bakkour.com/blog/helpdock-1-0-open-source-help-desk';

/** The release the site describes, stamped at build time (see astro.config.ts). */
export const VERSION: string = import.meta.env.HELPDOCK_VERSION;

/** The GitHub star count at build time, when the Pages workflow could read it. */
export const STARS: number | undefined = import.meta.env.HELPDOCK_STARS ?? undefined;

export type Locale = 'en' | 'ar';

export const repoFile = (path: string) => `${BLOB}/${path}`;

type Chrome = {
  skip: string;
  home: string;
  nav: { href: string; label: string }[];
  menu: string;
  mainNav: string;
  theme: { label: string; light: string; dark: string; system: string };
  language: { href: string; label: string; lang: Locale };
  install: string;
  footer: {
    about: string;
    groups: { title: string; links: { href: string; label: string }[] }[];
    by: string;
    licence: string;
  };
  breadcrumb: string;
};

export const CHROME: Record<Locale, Chrome> = {
  en: {
    skip: 'Skip to content',
    home: 'Helpdock home',
    nav: [
      { href: '/features/', label: 'Features' },
      { href: '/channels/', label: 'Channels' },
      { href: '/compare/', label: 'Compare' },
      { href: '/docs/', label: 'Docs' },
      { href: '/changelog/', label: 'Changelog' },
    ],
    menu: 'Menu',
    mainNav: 'Main',
    theme: { label: 'Colour theme', light: 'Light', dark: 'Dark', system: 'System' },
    language: { href: '/ar/', label: 'العربية', lang: 'ar' },
    install: 'Install',
    footer: {
      about:
        'Open-source, self-hosted customer support: ticketing, a help center, a live chat widget and grounded AI, in English and Arabic.',
      groups: [
        {
          title: 'Product',
          links: [
            { href: '/features/', label: 'Features' },
            { href: '/channels/', label: 'Channels' },
            { href: '/features/ai/', label: 'Grounded AI' },
            { href: '/features/security/', label: 'Security' },
            { href: '/#roadmap', label: 'Roadmap' },
          ],
        },
        {
          title: 'Docs',
          links: [
            { href: '/docs/install/', label: 'Install guide' },
            { href: '/docs/configuration/', label: 'Configuration' },
            { href: '/docs/operations/', label: 'Operations' },
            { href: '/docs/', label: 'All guides' },
            { href: '/changelog/', label: 'Changelog' },
          ],
        },
        {
          title: 'Compare',
          links: [
            { href: '/compare/helpdock-vs-zendesk/', label: 'Helpdock vs Zendesk' },
            { href: '/compare/helpdock-vs-freshdesk/', label: 'Helpdock vs Freshdesk' },
            { href: '/compare/helpdock-vs-zoho-desk/', label: 'Helpdock vs Zoho Desk' },
            { href: '/compare/', label: 'All comparisons' },
          ],
        },
        {
          title: 'Project',
          links: [
            { href: REPO, label: 'GitHub' },
            { href: RELEASES, label: 'Releases' },
            { href: repoFile('LICENSE'), label: 'Licence (AGPL-3.0)' },
            { href: repoFile('SECURITY.md'), label: 'Security policy' },
            { href: repoFile('CONTRIBUTING.md'), label: 'Contributing' },
          ],
        },
      ],
      by: 'Developed by',
      licence:
        'Free software under the GNU AGPL-3.0. Product names are trademarks of their owners.',
    },
    breadcrumb: 'Breadcrumb',
  },
  ar: {
    skip: 'انتقل إلى المحتوى',
    home: 'الصفحة الرئيسية لـ Helpdock',
    nav: [
      { href: '/ar/#features', label: 'الميزات' },
      { href: '/ar/channels/', label: 'القنوات' },
      { href: '/ar/compare/', label: 'المقارنات' },
      { href: '/docs/', label: 'الأدلة' },
      { href: '/changelog/', label: 'سجل التغييرات' },
    ],
    menu: 'القائمة',
    mainNav: 'التنقل الرئيسي',
    theme: { label: 'مظهر الألوان', light: 'فاتح', dark: 'داكن', system: 'حسب النظام' },
    language: { href: '/', label: 'English', lang: 'en' },
    install: 'التثبيت',
    footer: {
      about:
        'منصة دعم عملاء مفتوحة المصدر تستضيفها بنفسك: التذاكر ومركز مساعدة ونافذة دردشة مباشرة وذكاء اصطناعي يجيب من معرفتك، بالعربية والإنجليزية.',
      groups: [
        {
          title: 'المنتج',
          links: [
            { href: '/ar/#features', label: 'الميزات' },
            { href: '/ar/channels/', label: 'القنوات' },
            { href: '/ar/#ai', label: 'الذكاء الاصطناعي' },
            { href: '/ar/#security', label: 'الأمان' },
            { href: '/ar/#roadmap', label: 'خطة الإصدارات' },
          ],
        },
        {
          title: 'الأدلة (بالإنجليزية)',
          links: [
            { href: '/docs/install/', label: 'دليل التثبيت' },
            { href: '/docs/configuration/', label: 'الإعدادات' },
            { href: '/docs/', label: 'كل الأدلة' },
            { href: '/changelog/', label: 'سجل التغييرات' },
          ],
        },
        {
          title: 'المقارنات',
          links: [
            { href: '/ar/compare/helpdock-vs-zendesk/', label: 'Helpdock مقابل Zendesk' },
            { href: '/ar/compare/helpdock-vs-freshdesk/', label: 'Helpdock مقابل Freshdesk' },
            { href: '/ar/compare/helpdock-vs-zoho-desk/', label: 'Helpdock مقابل Zoho Desk' },
          ],
        },
        {
          title: 'المشروع',
          links: [
            { href: REPO, label: 'GitHub' },
            { href: RELEASES, label: 'الإصدارات' },
            { href: repoFile('LICENSE'), label: 'الرخصة (AGPL-3.0)' },
            { href: repoFile('SECURITY.md'), label: 'سياسة الأمان' },
          ],
        },
      ],
      by: 'من تطوير',
      licence: 'برمجيات حرة بموجب رخصة GNU AGPL-3.0. أسماء المنتجات علامات تجارية لأصحابها.',
    },
    breadcrumb: 'مسار التنقل',
  },
};

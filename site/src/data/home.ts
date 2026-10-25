/**
 * The words of the home page, in English and Arabic. Every claim is backed by
 * the README, the changelogs, the guides or the PRD (docs/guides/website.md).
 * The release number is passed in, so nothing here is edited at a release.
 */
import type { Locale } from './site.ts';

type Tile = { title: string; body: string; href: string; more: string };

export type HomeCopy = {
  title: string;
  description: string;
  newsTag: string;
  news: (version: string) => string;
  h1: string;
  lead: string;
  install: string;
  docs: string;
  fineprint: string[];
  shot: { legend: string; en: string; ar: string; altEn: string; altAr: string; caption: string };
  channels: { eyebrow: string; title: string; lead: string; all: string };
  release: {
    eyebrow: string;
    title: string;
    lead: string;
    poster: string;
    watch: string;
    announcement: string;
    changelog: string;
    latest: (version: string) => string;
    notes: string;
  };
  tour: {
    title: string;
    lead: string;
    helpCenter: Tile & { alt: string; caption: string };
    widget: Tile & { alt: string; caption: string };
    signIn: Tile & { alt: string; providers: string };
    small: Tile[];
  };
  ai: {
    eyebrow: string;
    title: string;
    lead: string;
    points: { title: string; body: string; icon: string }[];
    evalTitle: string;
    figures: { value: string; label: string }[];
    checks: string[];
    fineprint: string;
    more: string;
  };
  arabic: {
    eyebrow: string;
    title: string;
    lead: string;
    facts: { title: string; body: string }[];
    alt: string;
    caption: string;
  };
  brands: {
    eyebrow: string;
    title: string;
    lead: string;
    points: string[];
    caption: string;
    more: string;
  };
  security: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { icon: string; title: string; body: string }[];
    spec: {
      image: string;
      platforms: string;
      signature: string;
      sbom: string;
      label: (v: string) => string;
    };
    more: string;
  };
  migrate: {
    eyebrow: string;
    title: string;
    lead: string;
    sources: { slug: string; name: string; body: string }[];
    csv: string;
    note: string;
  };
  installSection: {
    eyebrow: string;
    title: (version: string) => string;
    lead: string;
    needs: string[];
    guide: string;
    deploy: string;
    config: string;
    step1: (version: string) => string;
    step2: (version: string) => string;
    step3: string;
    step4: string;
    copy: string;
    copied: string;
    failed: string;
    docsNote: string;
  };
  roadmap: {
    eyebrow: string;
    title: string;
    lead: string;
    columns: {
      status: string;
      shipped: boolean;
      title: string;
      items: { title: string; body: string }[];
    }[];
    plan: string;
  };
  faqTitle: string;
  faq: { q: string; a: string }[];
};

export const HOME: Record<Locale, HomeCopy> = {
  en: {
    title: 'Helpdock: open-source, self-hosted customer support',
    description:
      'Helpdock is an open-source, self-hosted help desk: ticketing, a help center, a live chat widget and AI that answers only from your knowledge. One Docker deploy serves many brands, in English and Arabic.',
    newsTag: 'New',
    news: (version) => `Helpdock ${version} is out`,
    h1: 'Your whole help desk. One deploy.',
    lead: 'Ticketing, a help center, live chat and AI that answers only from your knowledge. Open source. Self-hosted. In English and Arabic.',
    install: 'Install with Docker',
    docs: 'Read the docs',
    fineprint: ['Free under AGPL-3.0', 'Docker Compose', 'One install, every brand'],
    shot: {
      legend: 'Screenshot language',
      en: 'English',
      ar: 'العربية',
      altEn:
        'The Helpdock ticket workspace: the ticket list, an email ticket with its SLA badge and reply composer, and the contact card with the contact’s previous tickets',
      altAr: 'The same ticket workspace in Arabic, laid out right to left',
      caption: 'The ticket workspace, from the admin app’s Playwright screenshot baselines.',
    },
    channels: {
      eyebrow: 'Channels',
      title: 'Every conversation. One desk.',
      lead: 'Each brand connects its own accounts, everything files into the same tickets with the same statuses, SLAs, rules and assignment, and the reply goes back the way it came.',
      all: 'All channels',
    },
    release: {
      eyebrow: 'Helpdock 1.0 · 20 October 2026',
      title: 'Stable. And tested before it shipped.',
      lead: 'Every milestone of the 1.0 plan shipped. Before release: an external pentest of the widget and the API, a load run, a screen-reader pass, an onboarding run with three outside testers and a restore drill.',
      poster: 'Helpdock 1.0 release video: watch it on X',
      watch: 'Watch on X · 1:09',
      announcement: 'Read the announcement',
      changelog: 'Changelog and known limits',
      latest: (version) => `${version} is the latest release.`,
      notes: 'Read what changed in the changelog.',
    },
    tour: {
      title: 'Everything in the one install.',
      lead: 'A help center, a chat widget, SLAs, rules, reports and sign-in, without add-ons or editions.',
      helpCenter: {
        title: 'A help center on every brand’s domain.',
        body: 'Articles in English and Arabic, search in each language and “was this helpful?” feedback. Public and internal articles, so the same knowledge serves customers and staff.',
        href: '/features/help-center/',
        more: 'The help center',
        alt: 'A help center article page: section navigation, the article with a table and a tip, and a Still need help card',
        caption: 'Image: a render of the help center’s design artboard.',
      },
      widget: {
        title: 'A chat widget that stays small.',
        body: 'Live over WebSocket, with optional signed identity for signed-in users. Its first script is held to a 40 KB gzipped budget.',
        href: '/channels/live-chat/',
        more: 'The live chat widget',
        alt: 'The chat widget in English: an AI answer citing a help center article, then a handoff to the billing team',
        caption: 'Image: a render of the widget’s design artboard.',
      },
      signIn: {
        title: 'Staff sign-in, with SSO and passkeys.',
        body: 'Argon2id passwords checked against a breached-password list, a second factor every Admin must use, and passkeys. SAML 2.0 and OpenID Connect, with walk-throughs for:',
        href: '/features/sso-and-passkeys/',
        more: 'Sign-in and SSO',
        alt: 'The staff sign-in screen: email and password, a sign-in link by email, and Google and GitHub buttons, with a note that two-factor is required on this install',
        providers: 'SSO walk-throughs',
      },
      small: [
        {
          title: 'SLAs on your hours.',
          body: 'Business hours with holidays and time zones. Clocks pause in the statuses you mark. A CSAT survey goes out when a ticket closes.',
          href: '/features/slas-and-business-hours/',
          more: 'SLAs',
        },
        {
          title: 'Rules, macros and views.',
          body: 'Workflow and time-based rules with a test run. Macros with placeholders. Saved views, snooze, bulk edit and a command palette.',
          href: '/features/automation-and-macros/',
          more: 'Automation',
        },
        {
          title: 'Reports, API and webhooks.',
          body: 'Volume, response times, SLA compliance, CSAT and workload, with CSV export. A REST API with scoped keys and signed webhooks.',
          href: '/features/reports/',
          more: 'Reports',
        },
      ],
    },
    ai: {
      eyebrow: 'Grounded AI',
      title: 'It answers from your knowledge. Or it hands off.',
      lead: 'The assistant answers customers and helps agents from the brand’s own knowledge base. When that does not answer the question, a person does.',
      points: [
        {
          icon: 'book-open',
          title: 'Only your knowledge.',
          body: 'Help center articles, PDF and DOCX files, crawled websites, Notion and Google Drive. Visitor-facing answers read only public knowledge.',
        },
        {
          icon: 'list-checks',
          title: 'Sources, cited.',
          body: 'A citation that does not resolve to a document it retrieved turns the answer into a handoff.',
        },
        {
          icon: 'hand',
          title: 'A handoff, not a guess.',
          body: 'When the knowledge base does not answer, or confidence is below the channel’s threshold, your team takes over.',
        },
        {
          icon: 'shield-check',
          title: 'Text in, text out.',
          body: 'The model has no tools. PII is redacted and a prompt-injection filter runs before each call. Every call is logged with its cost, and budgets cap each brand.',
        },
      ],
      evalTitle: 'The bilingual evaluation before 1.0.0 passed every threshold.',
      figures: [
        { value: '97.5%', label: 'of answerable questions answered correctly in English' },
        { value: '94.6%', label: 'of answerable questions answered correctly in Arabic' },
        { value: '100%', label: 'of unanswerable questions handed off, in both' },
      ],
      checks: [
        'No injected instruction followed',
        'Every citation resolved',
        'Every answer in the question’s language',
      ],
      fineprint:
        'glm-4.6 answering, glm-5.1 judging and bge-m3:567m embeddings, in one recorded run. That is one provider pair: evaluate the model you choose. Every AI mode is off until a brand’s Admin turns it on.',
      more: 'How the AI works',
    },
    arabic: {
      eyebrow: 'Bilingual',
      title: 'English and Arabic. From the first screen.',
      lead: 'The admin app, the help center, the chat widget and the emails ship in both languages, with right-to-left layouts.',
      facts: [
        {
          title: 'A flip, not a fork.',
          body: 'Layouts use logical properties, so right to left is the same screen mirrored.',
        },
        {
          title: 'One type family.',
          body: 'IBM Plex Sans and IBM Plex Sans Arabic were drawn together, so mixed lines share weight and rhythm.',
        },
        {
          title: 'Mixed text stays readable.',
          body: 'Ticket ids, emails and URLs inside Arabic sentences keep their left-to-right order.',
        },
        {
          title: 'Tested in both.',
          body: 'The admin’s screenshot tests and the AI evaluation run in Arabic as well as English.',
        },
      ],
      alt: 'The chat widget in Arabic, right to left',
      caption: 'The widget image is a render of its design artboard.',
    },
    brands: {
      eyebrow: 'Multi-brand',
      title: 'One deploy. Many brands.',
      lead: 'Every brand runs from the one install, each with its own face and its own data.',
      points: [
        'Its own inboxes and channels',
        'A help center on its own domain, with a certificate Caddy issues on demand',
        'Its widget theme: accent, surface tone, radius, logo and launcher',
        'Its AI knowledge, with daily and monthly budgets',
        'Departments and teams, with department scope enforced in the database',
      ],
      caption:
        'Every tenant table carries brand_id under a forced row-level security policy like this one, and the api refuses to serve if its database role could bypass it.',
      more: 'How brands are kept apart',
    },
    security: {
      eyebrow: 'Security',
      title: 'Security you can check.',
      lead: 'The rules are written down, the code is open, and every release image is signed.',
      items: [
        {
          icon: 'database',
          title: 'Row-level security',
          body: 'Every tenant table is under a forced Postgres policy by brand, with department scope on ticket data.',
        },
        {
          icon: 'key-round',
          title: 'Encrypted secrets',
          body: 'AES-256-GCM under a master key that is not stored in the database. Secrets are never returned after they are saved.',
        },
        {
          icon: 'globe-lock',
          title: 'SSRF-safe fetching',
          body: 'Every fetch of a user-supplied URL goes through one client that blocks loopback, private and cloud-metadata addresses and re-checks every redirect.',
        },
        {
          icon: 'file-scan',
          title: 'Careful uploads',
          body: 'Sniffed by magic bytes, re-encoded, kept in a private bucket and served through short-lived presigned URLs.',
        },
        {
          icon: 'list-checks',
          title: 'OWASP ASVS Level 2',
          body: 'All 258 requirements of ASVS 4.0.3 Level 2 walked one by one, with the evidence named and no gap open.',
        },
        {
          icon: 'package-check',
          title: 'Signed images, with an SBOM',
          body: 'Each release image is signed keylessly with Cosign and published with a CycloneDX SBOM.',
        },
      ],
      spec: {
        image: 'Image',
        platforms: 'Platforms',
        signature: 'Signature',
        sbom: 'SBOM',
        label: (version) => `The ${version} release image`,
      },
      more: 'Everything about security',
    },
    migrate: {
      eyebrow: 'Migration',
      title: 'Move in from Zendesk, Freshdesk or Zoho Desk.',
      lead: 'A bilingual import wizard brings your history across: connect, map, dry run, approve. A manual CSV mapper covers every other tool.',
      sources: [
        {
          slug: 'zendesk',
          name: 'Zendesk',
          body: 'OAuth or API token. Tickets, contacts, organizations and Help Center articles.',
        },
        {
          slug: 'freshdesk',
          name: 'Freshdesk',
          body: 'Agent API key. Accounts above 30,000 tickets through a ticket ID inventory.',
        },
        {
          slug: 'zoho-desk',
          name: 'Zoho Desk',
          body: 'Every data centre, with archived tickets found automatically.',
        },
      ],
      csv: 'Any other tool: the CSV mapper',
      note: 'Imported history sends no customer messages and starts no rules, notifications or SLA timers. The importers were verified against stand-in servers built from each vendor’s published API documentation, not against live accounts.',
    },
    installSection: {
      eyebrow: 'Quick start',
      title: (version) => `Install ${version} with Docker.`,
      lead: 'One Docker Compose stack on your own Linux server. You need:',
      needs: [
        'Docker Engine with the Compose v2 plugin',
        '2 vCPU and 4 GB of memory',
        'Two DNS names pointing at the server: one for the admin app, one for the API and widget',
        'Ports 80 and 443 open, so Caddy can get certificates',
        'An S3-compatible bucket for attachments and article images',
      ],
      guide: 'Read the install guide',
      deploy: 'Dokploy, Coolify, Render or DigitalOcean',
      config: 'Configuration reference',
      step1: (version) => `1. Get the ${version} Compose file`,
      step2: (version) => `2. Edit .env: set HELPDOCK_VERSION=${version} and at least`,
      step3: '3. Start the stack',
      step4:
        '4. Open https://<ADMIN_HOST> and finish the first-run wizard. Back up .env with the database: without APP_MASTER_KEY, nothing encrypted can be read back.',
      copy: 'Copy',
      copied: 'Copied',
      failed: 'Copy failed',
      docsNote: '',
    },
    roadmap: {
      eyebrow: 'Roadmap',
      title: 'Since 1.0, and what comes next.',
      lead: 'Releases 1.1 and 1.2 delivered part of the 1.x plan. The rest is proposed, and its contents and order can change.',
      columns: [
        {
          status: 'Shipped in 1.1 and 1.2',
          shipped: true,
          title: 'Inbox and sign-in',
          items: [
            {
              title: 'Inbox productivity.',
              body: 'Keyboard shortcuts, snooze, bulk edit with undo, a command palette and Test routing.',
            },
            {
              title: 'Sign-in options.',
              body: 'Passkeys, Microsoft work accounts, Google Workspace domain limits and a built-in proof-of-work CAPTCHA.',
            },
            {
              title: 'Deploy templates.',
              body: 'Dokploy, Coolify, Render, DigitalOcean App Platform and an existing reverse proxy.',
            },
          ],
        },
        {
          status: 'Proposed',
          shipped: false,
          title: 'AI and operations',
          items: [
            {
              title: 'AI workspace.',
              body: 'A playground, saved tests, a review queue, personas and confidence-gated triage.',
            },
            {
              title: 'AI actions and MCP.',
              body: 'Actions that change nothing until a person approves them, and Helpdock as an MCP server.',
            },
            {
              title: 'Self-host operations.',
              body: 'A signed one-command installer, backup, restore and update notices.',
            },
          ],
        },
        {
          status: 'Proposed',
          shipped: false,
          title: 'Reach',
          items: [
            {
              title: 'More importers and undo.',
              body: 'Help Scout, Intercom, Front, Zammad and Gorgias.',
            },
            {
              title: 'Customer surfaces.',
              body: 'An email design editor and several widgets per brand.',
            },
            {
              title: 'Apps and languages.',
              body: 'More languages, customer-facing first, and an installable admin app for desktop and phone.',
            },
          ],
        },
      ],
      plan: 'The full plan is Phase 5 of the PRD.',
    },
    faqTitle: 'Questions, answered.',
    faq: [
      {
        q: 'What does it cost?',
        a: 'Nothing. Helpdock is free software under the GNU AGPL-3.0, with no paid tiers or licence keys. If you change it and let people use your changed version over a network, the AGPL asks you to offer them its source.',
      },
      {
        q: 'Is there a hosted version?',
        a: 'No. Helpdock is self-hosted only: you run it on your server and your data stays there. A hosted Helpdock is a stated non-goal for the 1.x releases.',
      },
      {
        q: 'What do I need to run it?',
        a: 'A Linux server with Docker Engine and the Compose v2 plugin, 2 vCPU and 4 GB of memory (ClamAV, if you turn it on, wants another 2 GB), two DNS names, ports 80 and 443, and an S3-compatible bucket. Docker Compose is the supported runtime.',
      },
      {
        q: 'Which AI providers work?',
        a: 'Any provider pi-ai supports, such as OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, xAI or DeepSeek, by API key or subscription, or any OpenAI-compatible server such as Ollama or vLLM, so the model can run on your own hardware.',
      },
      {
        q: 'Do I have to use AI?',
        a: 'No. Every AI mode is off until a brand’s Admin turns it on. The desk, channels, help center and widget work without it.',
      },
      {
        q: 'Which languages does it speak?',
        a: 'English and Arabic, with right-to-left layouts, across the admin app, help center, widget and emails. More languages are proposed for a later 1.x release.',
      },
      {
        q: 'Can I bring my tickets from another help desk?',
        a: 'Yes, from Zendesk, Freshdesk and Zoho Desk with their importers, and from anything else with the manual CSV mapper. Run the dry run first: the importers were verified against stand-ins, not live vendor accounts.',
      },
      {
        q: 'How do I report a security issue?',
        a: 'Privately, as [SECURITY.md](https://github.com/Docker-Hunterpedia/Helpdock/blob/main/SECURITY.md) describes. Please do not open a public issue.',
      },
      {
        q: 'Who builds it?',
        a: 'Helpdock is developed by [Oday Bakkour](https://oday-bakkour.com/), in the open on GitHub. Contributions are welcome; start with [CONTRIBUTING.md](https://github.com/Docker-Hunterpedia/Helpdock/blob/main/CONTRIBUTING.md).',
      },
    ],
  },
  ar: {
    title: 'Helpdock: منصة دعم عملاء مفتوحة المصدر تستضيفها بنفسك',
    description:
      'Helpdock منصة دعم عملاء مفتوحة المصدر تستضيفها بنفسك: نظام تذاكر ومركز مساعدة ونافذة دردشة مباشرة وذكاء اصطناعي لا يجيب إلا من معرفتك. تثبيت واحد عبر Docker يخدم عدة علامات تجارية، بالعربية والإنجليزية.',
    newsTag: 'جديد',
    news: (version) => `صدر Helpdock ${version}`,
    h1: 'مكتب الدعم كله. بتثبيت واحد.',
    lead: 'نظام تذاكر، ومركز مساعدة، ودردشة مباشرة، وذكاء اصطناعي لا يجيب إلا من معرفتك. مفتوح المصدر. تستضيفه بنفسك. بالعربية والإنجليزية.',
    install: 'التثبيت عبر Docker',
    docs: 'اقرأ الأدلة (بالإنجليزية)',
    fineprint: ['مجاني برخصة AGPL-3.0', 'Docker Compose', 'تثبيت واحد لكل علاماتك'],
    shot: {
      legend: 'لغة لقطة الشاشة',
      en: 'English',
      ar: 'العربية',
      altEn: 'مساحة عمل التذاكر نفسها بالإنجليزية، من اليسار إلى اليمين',
      altAr:
        'مساحة عمل التذاكر في Helpdock بالعربية، من اليمين إلى اليسار: قائمة التذاكر، وتذكرة بريد إلكتروني مع شارة اتفاقية مستوى الخدمة ومحرر الرد، وبطاقة جهة الاتصال مع تذاكرها السابقة',
      caption: 'مساحة عمل التذاكر، من لقطات الشاشة المرجعية لاختبارات Playwright في لوحة الإدارة.',
    },
    channels: {
      eyebrow: 'القنوات',
      title: 'كل محادثة. مكتب واحد.',
      lead: 'تربط كل علامة تجارية حساباتها الخاصة، وتصب الرسائل كلها في التذاكر نفسها، بالحالات واتفاقيات مستوى الخدمة والقواعد والإسناد نفسها، ويعود الرد عبر القناة التي كتب منها العميل.',
      all: 'كل القنوات',
    },
    release: {
      eyebrow: 'Helpdock 1.0 · 20 أكتوبر 2026',
      title: 'مستقر. ومختبَر قبل أن يصدر.',
      lead: 'اكتملت كل مراحل خطة الإصدار 1.0. وقبل الإصدار: اختبار اختراق خارجي لنافذة الدردشة والواجهة البرمجية، واختبار حِمل، وجولة بقارئ الشاشة، وتجربة تثبيت مع ثلاثة مختبرين من خارج المشروع، وتمرين استعادة من نسخة احتياطية.',
      poster: 'فيديو إصدار Helpdock 1.0: شاهده على X',
      watch: 'شاهد على X · 1:09',
      announcement: 'اقرأ الإعلان (بالإنجليزية)',
      changelog: 'سجل التغييرات والحدود المعروفة (بالإنجليزية)',
      latest: (version) => `الإصدار ${version} هو الأحدث.`,
      notes: 'اطّلع على ما تغيّر في سجل التغييرات (بالإنجليزية).',
    },
    tour: {
      title: 'كل شيء في تثبيت واحد.',
      lead: 'مركز مساعدة، ونافذة دردشة، واتفاقيات مستوى الخدمة، وقواعد، وتقارير، وتسجيل دخول، دون إضافات أو إصدارات مدفوعة.',
      helpCenter: {
        title: 'مركز مساعدة على نطاق كل علامة تجارية.',
        body: 'مقالات بالعربية والإنجليزية، وبحث بكل لغة، وتقييم «هل كان هذا مفيدًا؟». مقالات عامة وداخلية، لتخدم المعرفة نفسها العملاء والموظفين.',
        href: '/features/help-center/',
        more: 'مركز المساعدة (بالإنجليزية)',
        alt: 'صفحة مقالة في مركز المساعدة بالإنجليزية: قائمة القسم، والمقالة مع جدول ونصيحة، وبطاقة «هل ما زلت بحاجة إلى مساعدة؟»',
        caption: 'الصورة: من لوحة تصميم مركز المساعدة، بالإنجليزية.',
      },
      widget: {
        title: 'نافذة دردشة تبقى خفيفة.',
        body: 'مباشرة عبر WebSocket، مع هوية موقّعة اختيارية للمستخدمين المسجّلين. والسكربت الأول محصور في ميزانية 40 كيلوبايت بعد الضغط.',
        href: '/ar/channels/live-chat/',
        more: 'نافذة الدردشة المباشرة',
        alt: 'نافذة الدردشة بالعربية: إجابة من الذكاء الاصطناعي تستشهد بمقالة من مركز المساعدة، ثم تحويل إلى فريق الفوترة',
        caption: 'الصورة: من لوحة تصميم نافذة الدردشة.',
      },
      signIn: {
        title: 'دخول الموظفين، مع الدخول الموحّد ومفاتيح المرور.',
        body: 'كلمات مرور بخوارزمية Argon2id تُفحص مقابل قائمة كلمات المرور المسرّبة، وعامل تحقق ثانٍ إلزامي للمديرين، ومفاتيح المرور. ودخول موحّد عبر SAML 2.0 وOpenID Connect، مع أدلة إعداد لـ:',
        href: '/features/sso-and-passkeys/',
        more: 'تسجيل الدخول (بالإنجليزية)',
        alt: 'شاشة دخول الموظفين بالعربية: البريد وكلمة المرور، ورابط دخول بالبريد، وزرا Google وGitHub، مع ملاحظة أن التحقق بخطوتين إلزامي في هذا التثبيت',
        providers: 'أدلة الدخول الموحّد',
      },
      small: [
        {
          title: 'اتفاقيات مستوى الخدمة على ساعات عملك.',
          body: 'ساعات عمل مع العطلات والمناطق الزمنية. تتوقف العدّادات في الحالات التي تحدّدها. ويُرسل استبيان رضا العملاء عند إغلاق التذكرة.',
          href: '/features/slas-and-business-hours/',
          more: 'اتفاقيات مستوى الخدمة (بالإنجليزية)',
        },
        {
          title: 'القواعد والماكرو والعروض.',
          body: 'قواعد سير عمل وقواعد زمنية مع تشغيل تجريبي. ماكرو بمتغيرات. عروض محفوظة، وتأجيل، وتعديل جماعي، ولوحة أوامر.',
          href: '/features/automation-and-macros/',
          more: 'الأتمتة (بالإنجليزية)',
        },
        {
          title: 'التقارير والواجهة البرمجية وخطافات الويب.',
          body: 'الحجم وأزمنة الاستجابة والالتزام باتفاقيات مستوى الخدمة ورضا العملاء وعبء العمل، مع التصدير إلى CSV. وواجهة REST بمفاتيح محدودة الصلاحيات وخطافات ويب موقّعة.',
          href: '/features/reports/',
          more: 'التقارير (بالإنجليزية)',
        },
      ],
    },
    ai: {
      eyebrow: 'ذكاء اصطناعي مستند إلى معرفتك',
      title: 'يجيب من معرفتك. أو يسلّم المحادثة لفريقك.',
      lead: 'يجيب المساعد العملاءَ ويساعد الموظفين من قاعدة معرفة العلامة التجارية نفسها. وحين لا تجيب عن السؤال، يجيب شخص من الفريق.',
      points: [
        {
          icon: 'book-open',
          title: 'معرفتك فقط.',
          body: 'مقالات مركز المساعدة، وملفات PDF وDOCX، والمواقع المؤرشفة، وNotion وGoogle Drive. والإجابات الموجّهة للزوار لا تقرأ إلا المعرفة العامة.',
        },
        {
          icon: 'list-checks',
          title: 'مصادر مذكورة.',
          body: 'أي إشارة لا تقود إلى مستند استرجعه فعلًا تحوّل الإجابة إلى تسليم للفريق.',
        },
        {
          icon: 'hand',
          title: 'تسليم لا تخمين.',
          body: 'حين لا تجيب قاعدة المعرفة، أو تقل الثقة عن الحد المضبوط للقناة، يتولى فريقك المحادثة.',
        },
        {
          icon: 'shield-check',
          title: 'نص يدخل، ونص يخرج.',
          body: 'لا يملك النموذج أي أدوات. تُخفى البيانات الشخصية ويعمل مرشّح لحقن التعليمات قبل كل استدعاء. ويُسجَّل كل استدعاء بتكلفته، وتحدّ الميزانيات إنفاق كل علامة.',
        },
      ],
      evalTitle: 'اجتاز التقييم ثنائي اللغة قبل الإصدار 1.0.0 كل العتبات.',
      figures: [
        { value: '97.5%', label: 'من الأسئلة القابلة للإجابة أُجيب عنها إجابة صحيحة بالإنجليزية' },
        { value: '94.6%', label: 'من الأسئلة القابلة للإجابة أُجيب عنها إجابة صحيحة بالعربية' },
        { value: '100%', label: 'من الأسئلة غير القابلة للإجابة سُلّمت للفريق، باللغتين' },
      ],
      checks: [
        'لم تُتّبع أي تعليمات محقونة',
        'كل إشارة إلى مصدر قادت إلى مستند فعلي',
        'كل إجابة بلغة السؤال',
      ],
      fineprint:
        'glm-4.6 للإجابة، وglm-5.1 للتحكيم، وbge-m3:567m للتضمين، في تشغيل واحد مسجّل. هذا زوج مزوّدين واحد: قيّم النموذج الذي تختاره. وكل أوضاع الذكاء الاصطناعي معطّلة حتى يفعّلها مدير العلامة التجارية.',
      more: 'كيف يعمل الذكاء الاصطناعي (بالإنجليزية)',
    },
    arabic: {
      eyebrow: 'ثنائي اللغة',
      title: 'العربية والإنجليزية. من الشاشة الأولى.',
      lead: 'لوحة الإدارة ومركز المساعدة ونافذة الدردشة ورسائل البريد تأتي باللغتين، بتخطيطات من اليمين إلى اليسار.',
      facts: [
        {
          title: 'انعكاس لا نسخة ثانية.',
          body: 'التخطيطات مكتوبة بخصائص CSS المنطقية، فالواجهة العربية هي الشاشة نفسها معكوسة.',
        },
        {
          title: 'عائلة خطوط واحدة.',
          body: 'صُمّم IBM Plex Sans وIBM Plex Sans Arabic معًا، فتتشارك الأسطر المختلطة الوزن والإيقاع.',
        },
        {
          title: 'النص المختلط يبقى مقروءًا.',
          body: 'أرقام التذاكر وعناوين البريد والروابط داخل الجمل العربية تحتفظ باتجاهها من اليسار إلى اليمين.',
        },
        {
          title: 'مختبَر باللغتين.',
          body: 'اختبارات لقطات الشاشة في لوحة الإدارة وتقييم الذكاء الاصطناعي تعمل بالعربية كما بالإنجليزية.',
        },
      ],
      alt: 'نافذة الدردشة بالعربية، من اليمين إلى اليسار',
      caption: 'صورة نافذة الدردشة من لوحة تصميمها.',
    },
    brands: {
      eyebrow: 'علامات تجارية متعددة',
      title: 'تثبيت واحد. علامات كثيرة.',
      lead: 'كل علاماتك التجارية تعمل من التثبيت نفسه، لكل منها واجهتها وبياناتها.',
      points: [
        'صناديقها وقنواتها الخاصة',
        'مركز مساعدة على نطاقها الخاص، بشهادة يصدرها Caddy عند الطلب',
        'مظهر نافذة الدردشة: اللون الأساسي ودرجة السطح واستدارة الزوايا والشعار وزر الإطلاق',
        'معرفتها للذكاء الاصطناعي، بميزانيات يومية وشهرية',
        'أقسام وفرق، مع فرض نطاق القسم في قاعدة البيانات',
      ],
      caption:
        'كل جدول خاص بالمستأجرين يحمل brand_id تحت سياسة أمان على مستوى الصفوف مفروضة مثل هذه، ويرفض الخادم العمل إن كان دوره في قاعدة البيانات قادرًا على تجاوزها.',
      more: 'كيف تُفصل العلامات التجارية (بالإنجليزية)',
    },
    security: {
      eyebrow: 'الأمان',
      title: 'أمان يمكنك التحقق منه.',
      lead: 'القواعد مكتوبة، والشيفرة مفتوحة، وكل صورة إصدار موقّعة.',
      items: [
        {
          icon: 'database',
          title: 'أمان على مستوى الصفوف',
          body: 'كل جدول خاص بالمستأجرين تحت سياسة Postgres مفروضة حسب العلامة، مع نطاق القسم على بيانات التذاكر.',
        },
        {
          icon: 'key-round',
          title: 'أسرار مشفّرة',
          body: 'AES-256-GCM بمفتاح رئيسي لا يُخزَّن في قاعدة البيانات، ولا تُعاد الأسرار بعد حفظها.',
        },
        {
          icon: 'globe-lock',
          title: 'جلب محمي من SSRF',
          body: 'كل جلب لرابط يقدّمه مستخدم يمر عبر عميل واحد يحجب عناوين الجهاز المحلي والشبكات الخاصة وبيانات السحابة الوصفية، ويعيد التحقق عند كل إعادة توجيه.',
        },
        {
          icon: 'file-scan',
          title: 'رفع ملفات بحذر',
          body: 'يُفحص نوع الملف من بايتاته، ويُعاد ترميزه، ويُحفظ في حاوية خاصة، ويُقدَّم عبر روابط موقّعة قصيرة العمر.',
        },
        {
          icon: 'list-checks',
          title: 'OWASP ASVS المستوى 2',
          body: 'رُوجعت متطلبات ASVS 4.0.3 للمستوى 2 كلها، وعددها 258، واحدًا واحدًا مع الدليل، دون أي ثغرة مفتوحة.',
        },
        {
          icon: 'package-check',
          title: 'صور موقّعة مع SBOM',
          body: 'كل صورة إصدار موقّعة دون مفاتيح مخزّنة عبر Cosign، ومنشورة مع SBOM بصيغة CycloneDX.',
        },
      ],
      spec: {
        image: 'الصورة',
        platforms: 'المنصات',
        signature: 'التوقيع',
        sbom: 'SBOM',
        label: (version) => `صورة الإصدار ${version}`,
      },
      more: 'كل شيء عن الأمان (بالإنجليزية)',
    },
    migrate: {
      eyebrow: 'الانتقال',
      title: 'انتقل من Zendesk أو Freshdesk أو Zoho Desk.',
      lead: 'معالج استيراد ثنائي اللغة ينقل سجلّك: اربط، ثم طابِق، ثم شغّل التشغيل التجريبي، ثم وافق. ومطابق CSV يدوي يغطي أي أداة أخرى.',
      sources: [
        {
          slug: 'zendesk',
          name: 'Zendesk',
          body: 'عبر OAuth أو رمز واجهة برمجية. التذاكر وجهات الاتصال والمؤسسات ومقالات مركز المساعدة.',
        },
        {
          slug: 'freshdesk',
          name: 'Freshdesk',
          body: 'بمفتاح واجهة برمجية لموظف. والحسابات التي تتجاوز 30 ألف تذكرة عبر جرد لمعرّفات التذاكر.',
        },
        {
          slug: 'zoho-desk',
          name: 'Zoho Desk',
          body: 'كل مراكز البيانات، مع العثور على التذاكر المؤرشفة تلقائيًا.',
        },
      ],
      csv: 'أي أداة أخرى: مطابق CSV (بالإنجليزية)',
      note: 'السجل المستورد لا يرسل أي رسالة إلى العملاء، ولا يشغّل أي قاعدة أو إشعار أو مؤقت لاتفاقية مستوى الخدمة. وجرى التحقق من أدوات الاستيراد على خوادم بديلة بُنيت من توثيق الواجهات البرمجية المنشور لكل مورّد، لا على حسابات حقيقية.',
    },
    installSection: {
      eyebrow: 'بدء سريع',
      title: (version) => `ثبّت الإصدار ${version} عبر Docker.`,
      lead: 'حزمة Docker Compose واحدة على خادم Linux خاص بك. تحتاج إلى:',
      needs: [
        'Docker Engine مع إضافة Compose v2',
        '2 vCPU و4 GB من الذاكرة',
        'اسمَي نطاق يشيران إلى الخادم: واحد للوحة الإدارة وآخر للواجهة البرمجية ونافذة الدردشة',
        'المنفذين 80 و443 مفتوحين ليحصل Caddy على الشهادات',
        'حاوية تخزين متوافقة مع S3 للمرفقات وصور المقالات',
      ],
      guide: 'اقرأ دليل التثبيت',
      deploy: 'Dokploy أو Coolify أو Render أو DigitalOcean',
      config: 'مرجع الإعدادات',
      step1: (version) => `1. احصل على ملف Compose للإصدار ${version}`,
      step2: (version) => `2. عدّل ‎.env: اضبط HELPDOCK_VERSION=${version} وعلى الأقل`,
      step3: '3. شغّل الحزمة',
      step4:
        '4. افتح ‎https://<ADMIN_HOST> وأكمل معالج التشغيل الأول. احفظ نسخة احتياطية من ‎.env مع قاعدة البيانات: بدون APP_MASTER_KEY لا يمكن قراءة أي شيء مشفّر.',
      copy: 'نسخ',
      copied: 'نُسخ',
      failed: 'تعذّر النسخ',
      docsNote: 'التوثيق متاح بالإنجليزية.',
    },
    roadmap: {
      eyebrow: 'خارطة الطريق',
      title: 'منذ الإصدار 1.0، وما يأتي بعده.',
      lead: 'قدّم الإصداران 1.1 و1.2 جزءًا من خطة 1.x. والباقي مقترح، وقد يتغير محتواه وترتيبه.',
      columns: [
        {
          status: 'صدر في 1.1 و1.2',
          shipped: true,
          title: 'صندوق الوارد وتسجيل الدخول',
          items: [
            {
              title: 'إنتاجية صندوق الوارد.',
              body: 'اختصارات لوحة المفاتيح، والتأجيل، والتعديل الجماعي مع التراجع، ولوحة أوامر، واختبار التوجيه.',
            },
            {
              title: 'خيارات الدخول.',
              body: 'مفاتيح المرور، وحسابات Microsoft للعمل، وحصر Google في نطاقات Workspace، واختبار CAPTCHA مدمج يعتمد إثبات العمل.',
            },
            {
              title: 'قوالب النشر.',
              body: 'Dokploy وCoolify وRender وDigitalOcean App Platform وخادم وكيل عكسي قائم.',
            },
          ],
        },
        {
          status: 'مقترح',
          shipped: false,
          title: 'الذكاء الاصطناعي والتشغيل',
          items: [
            {
              title: 'مساحة عمل الذكاء الاصطناعي.',
              body: 'بيئة تجريب، واختبارات محفوظة، وقائمة مراجعة، وشخصيات، وفرز مشروط بالثقة.',
            },
            {
              title: 'إجراءات الذكاء الاصطناعي وMCP.',
              body: 'إجراءات لا تغيّر شيئًا حتى يوافق عليها شخص، وHelpdock كخادم MCP.',
            },
            {
              title: 'تشغيل الاستضافة الذاتية.',
              body: 'مثبّت موقّع بأمر واحد، ونسخ احتياطي واستعادة، وتنبيهات بالتحديثات.',
            },
          ],
        },
        {
          status: 'مقترح',
          shipped: false,
          title: 'الانتشار',
          items: [
            {
              title: 'أدوات استيراد أكثر مع التراجع.',
              body: 'Help Scout وIntercom وFront وZammad وGorgias.',
            },
            {
              title: 'واجهات العملاء.',
              body: 'محرر لتصميم البريد، وعدة نوافذ دردشة لكل علامة تجارية.',
            },
            {
              title: 'التطبيقات واللغات.',
              body: 'لغات أكثر، بدءًا بالواجهات الموجّهة للعملاء، وتطبيق إدارة قابل للتثبيت على الحاسوب والهاتف.',
            },
          ],
        },
      ],
      plan: 'الخطة كاملة في المرحلة 5 من وثيقة متطلبات المنتج (بالإنجليزية).',
    },
    faqTitle: 'أسئلة وأجوبة.',
    faq: [
      {
        q: 'كم يكلّف؟',
        a: 'لا شيء. Helpdock برنامج حر برخصة GNU AGPL-3.0، بلا خطط مدفوعة ولا مفاتيح ترخيص. وإن عدّلته وأتحت نسختك المعدّلة للناس عبر الشبكة، تطلب منك الرخصة أن تتيح لهم مصدرها.',
      },
      {
        q: 'هل توجد نسخة مستضافة؟',
        a: 'لا. Helpdock للاستضافة الذاتية فقط: تشغّله على خادمك وتبقى بياناتك عندك. والنسخة المستضافة خارج أهداف إصدارات 1.x صراحةً.',
      },
      {
        q: 'ماذا أحتاج لتشغيله؟',
        a: 'خادم Linux عليه Docker Engine وإضافة Compose v2، و2 vCPU و4 GB من الذاكرة (ويحتاج ClamAV إن فعّلته 2 GB إضافية)، واسما نطاق، والمنفذان 80 و443، وحاوية متوافقة مع S3. وDocker Compose هي بيئة التشغيل المدعومة.',
      },
      {
        q: 'ما مزوّدو الذكاء الاصطناعي المدعومون؟',
        a: 'أي مزوّد يدعمه pi-ai، مثل OpenAI وAnthropic وGoogle وOpenRouter وGroq وMistral وxAI وDeepSeek، بمفتاح API أو باشتراك، أو أي خادم متوافق مع OpenAI مثل Ollama أو vLLM، فيمكن أن يعمل النموذج على أجهزتك.',
      },
      {
        q: 'هل يجب أن أستخدم الذكاء الاصطناعي؟',
        a: 'لا. كل أوضاع الذكاء الاصطناعي معطّلة حتى يفعّلها مدير العلامة التجارية. ويعمل المكتب والقنوات ومركز المساعدة ونافذة الدردشة دونه.',
      },
      {
        q: 'ما اللغات المدعومة؟',
        a: 'العربية والإنجليزية، بتخطيطات من اليمين إلى اليسار، في لوحة الإدارة ومركز المساعدة ونافذة الدردشة ورسائل البريد. ولغات أخرى مقترحة لإصدار لاحق من 1.x.',
      },
      {
        q: 'هل يمكنني نقل تذاكري من مكتب دعم آخر؟',
        a: 'نعم، من Zendesk وFreshdesk وZoho Desk بأدوات الاستيراد الخاصة بها، ومن أي أداة أخرى بمطابق CSV اليدوي. ابدأ بالتشغيل التجريبي: جرى التحقق من أدوات الاستيراد على خوادم بديلة، لا على حسابات حقيقية.',
      },
      {
        q: 'كيف أبلغ عن مشكلة أمنية؟',
        a: 'بشكل خاص، كما يصف ملف [SECURITY.md](https://github.com/Docker-Hunterpedia/Helpdock/blob/main/SECURITY.md). لا تفتح بلاغًا عامًا من فضلك.',
      },
      {
        q: 'من يطوّره؟',
        a: 'يطوّر [Oday Bakkour](https://oday-bakkour.com/) مشروع Helpdock علنًا على GitHub. والمساهمات مرحّب بها؛ ابدأ بملف [CONTRIBUTING.md](https://github.com/Docker-Hunterpedia/Helpdock/blob/main/CONTRIBUTING.md).',
      },
    ],
  },
};

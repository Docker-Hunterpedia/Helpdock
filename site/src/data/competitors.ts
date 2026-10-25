/**
 * The comparison and migration pages. What these pages say about another
 * product is limited to two checkable facts, how it is delivered and under what
 * licence, each with its source and the date it was checked. Everything else is
 * about Helpdock and is backed by its guides. See docs/guides/website.md.
 *
 * Intercom, Help Scout and Front are left out on purpose: they are hosted and
 * proprietary, Helpdock has no importer for them yet, and their pages would
 * have said the same thing three times.
 */
import { type Competitor, CompetitorsSchema } from '../lib/competitor-schema.ts';

const CHECKED = '2026-10-25';

const notFitSelfHosted = {
  en: 'You want a service someone else runs. Helpdock is self-hosted only, and a hosted Helpdock is a stated non-goal for the 1.x releases.',
  ar: 'تريد خدمة يديرها غيرك. Helpdock يُستضاف ذاتيًا فقط، والنسخة المستضافة خارج أهداف إصدارات 1.x صراحةً.',
};
const notFitScope = {
  en: 'You need phone or VoIP support, community forums or a customer login portal. All three are non-goals for 1.x.',
  ar: 'تحتاج إلى دعم هاتفي أو اتصال صوتي عبر الإنترنت، أو منتديات مجتمع، أو بوابة يسجّل فيها العملاء دخولهم. الثلاثة خارج أهداف إصدارات 1.x.',
};
const notFitLanguages = {
  en: 'Your team works in a language other than English or Arabic. Those are the two languages today; more are proposed for 1.3.',
  ar: 'يعمل فريقك بلغة غير العربية والإنجليزية. هاتان هما اللغتان المتاحتان اليوم، والمزيد مقترح للإصدار 1.3.',
};
const notFitApps = {
  en: 'Your agents need native iOS or Android apps. Those are a non-goal; an installable admin app is proposed for 1.3.',
  ar: 'يحتاج موظفو الدعم إلى تطبيقات أصلية لنظامي iOS أو Android. هذه خارج الأهداف، ويُقترح تطبيق إدارة قابل للتثبيت في الإصدار 1.3.',
};

const imported = {
  en: 'Imported history sends no customer messages and starts no rules, notifications, SLA timers or AI work. Starting SLA clocks on imported open tickets is a separate step an Admin takes.',
  ar: 'السجل المستورد لا يرسل أي رسالة إلى العملاء، ولا يشغّل القواعد أو الإشعارات أو مؤقتات اتفاقية مستوى الخدمة أو الذكاء الاصطناعي. وتشغيل مؤقتات اتفاقية مستوى الخدمة على التذاكر المفتوحة المستوردة خطوة منفصلة يتخذها المدير.',
};
const standIns = {
  en: 'The importer was verified against stand-in servers built from the vendor’s published API documentation, not against a live account, so run the dry run and compare counts before you rely on it.',
  ar: 'جرى التحقق من أداة الاستيراد على خوادم بديلة بُنيت من توثيق واجهة المورّد البرمجية المنشور، لا على حساب حقيقي، لذا شغّل التشغيل التجريبي وقارن الأعداد قبل أن تعتمد عليها.',
};
const notCarried = {
  en: 'Side conversations, macros, automation rules, SLA policies, saved views and channel credentials are not imported. Rebuild them in Helpdock, then switch your channels over.',
  ar: 'لا تُستورد المحادثات الجانبية ولا الماكرو ولا قواعد الأتمتة ولا سياسات مستوى الخدمة ولا العروض المحفوظة ولا بيانات اعتماد القنوات. أعد بناءها في Helpdock، ثم انقل قنواتك إليه.',
};

const strengthsEn = {
  brands: {
    title: 'Many brands, one install',
    body: 'Each brand gets its own inboxes, help center domain, widget theme and AI knowledge, kept apart by Postgres row-level security.',
    href: '/features/multi-brand/',
  },
  ai: {
    title: 'AI that answers from your knowledge',
    body: 'Auto-replies cite the brand’s own articles or hand off to a person. You choose the model, including one on your own hardware.',
    href: '/features/ai/',
  },
  slas: {
    title: 'SLAs on your business hours',
    body: 'Policies by department and priority, business hours with holidays and time zones, and escalation steps before and after a breach.',
    href: '/features/slas-and-business-hours/',
  },
  data: {
    title: 'Your data on your server',
    body: 'Tickets live in your Postgres and files in your S3-compatible bucket. Secrets are encrypted under a master key you hold.',
    href: '/features/security/',
  },
  arabic: {
    title: 'Arabic from the first screen',
    body: 'The admin app, help center, widget and emails ship in English and Arabic, with right-to-left layouts.',
    href: '/features/help-center/',
  },
  free: {
    title: 'No paid tier',
    body: 'Every feature is in the AGPL-3.0 repository. There are no licence keys, seats or editions.',
    href: '/features/',
  },
};

const strengthsAr = {
  brands: {
    title: 'علامات تجارية كثيرة في تثبيت واحد',
    body: 'لكل علامة تجارية صناديق بريدها ونطاق مركز مساعدتها ومظهر أداة الدردشة ومعرفة الذكاء الاصطناعي الخاصة بها، تفصل بينها سياسات أمان الصفوف في Postgres.',
    href: '/features/multi-brand/',
  },
  ai: {
    title: 'ذكاء اصطناعي يجيب من معرفتك',
    body: 'الردود التلقائية تستشهد بمقالات العلامة التجارية نفسها أو تحوّل المحادثة إلى موظف. وأنت تختار النموذج، حتى لو كان يعمل على أجهزتك.',
    href: '/features/ai/',
  },
  slas: {
    title: 'اتفاقيات مستوى الخدمة على ساعات عملك',
    body: 'سياسات حسب القسم والأولوية، وساعات عمل مع العطلات والمناطق الزمنية، وخطوات تصعيد قبل تجاوز المهلة وبعده.',
    href: '/features/slas-and-business-hours/',
  },
  data: {
    title: 'بياناتك على خادمك',
    body: 'التذاكر في قاعدة Postgres لديك والملفات في حاوية تخزين متوافقة مع S3 تملكها. والأسرار مشفّرة بمفتاح رئيسي تحتفظ به أنت.',
    href: '/features/security/',
  },
  arabic: {
    title: 'العربية من الشاشة الأولى',
    body: 'لوحة الإدارة ومركز المساعدة وأداة الدردشة ورسائل البريد تأتي بالعربية والإنجليزية، بتخطيط من اليمين إلى اليسار.',
    href: '/features/help-center/',
  },
};

const sharedFaqEn = {
  cost: {
    q: 'What does Helpdock cost?',
    a: 'Nothing. It is free software under the GNU AGPL-3.0, with no paid tiers or licence keys. You pay for the server, the S3-compatible bucket and any AI provider you choose.',
  },
};
const sharedFaqAr = {
  cost: {
    q: 'كم يكلّف Helpdock؟',
    a: 'لا شيء. إنه برمجيات حرة بموجب رخصة GNU AGPL-3.0، بلا خطط مدفوعة ولا مفاتيح ترخيص. تدفع فقط ثمن الخادم وحاوية التخزين المتوافقة مع S3 ومزوّد الذكاء الاصطناعي الذي تختاره.',
  },
};

const rebuildEn = [
  {
    from: 'Macros and canned replies',
    to: 'Macros and canned responses, in English and Arabic',
    href: '/features/automation-and-macros/',
  },
  {
    from: 'Automation rules',
    to: 'Workflow rules and time-based rules, with a test run',
    href: '/features/automation-and-macros/',
  },
  {
    from: 'SLA policies',
    to: 'SLA policies on business hours and holidays',
    href: '/features/slas-and-business-hours/',
  },
  {
    from: 'Saved views',
    to: 'Saved views, personal or shared',
    href: '/features/automation-and-macros/',
  },
  {
    from: 'Email, chat and messaging channels',
    to: 'Channels, connected per brand',
    href: '/channels/',
  },
];

const competitors: Competitor[] = [
  {
    slug: 'zendesk',
    name: 'Zendesk',
    homepage: 'https://www.zendesk.com',
    hosting: 'hosted',
    hostingSource: {
      label: 'Zendesk: data hosting locations',
      url: 'https://support.zendesk.com/hc/en-us/articles/4408825765530-Data-Hosting-Locations-for-Your-Zendesk-Service-Data',
    },
    licence: 'proprietary',
    licenceSource: { label: 'zendesk.com', url: 'https://www.zendesk.com' },
    checked: CHECKED,
    importer: true,
    en: {
      title: 'Helpdock vs Zendesk: a self-hosted, open-source alternative',
      description:
        'Zendesk is a hosted service; Helpdock is an open-source help desk you run yourself, with a built-in Zendesk importer for tickets, contacts and help center articles.',
      lead: 'Zendesk is a hosted service. Helpdock is a help desk you run on your own server, and it can bring your Zendesk history with it.',
      hosting: 'Hosted by Zendesk',
      licence: 'Proprietary',
      data: 'In Zendesk’s hosting regions',
      summary: [
        'Helpdock’s Zendesk importer connects with OAuth or a labelled legacy API token, then copies tickets with their public replies and private notes, authors and original dates, contacts and organizations, groups, fields, tags, satisfaction ratings and Help Center content.',
        'Tickets get new Helpdock numbers, and their Zendesk IDs stay searchable: a search for the old number finds the ticket from any view, with an “Imported from Zendesk” chip on it.',
      ],
      strengths: [strengthsEn.brands, strengthsEn.ai, strengthsEn.slas, strengthsEn.data],
      migration: {
        intro:
          'The importer is a bilingual wizard: connect, map, dry run, approve. Your Zendesk account stays live until you switch channels.',
        points: [imported.en, notCarried.en, standIns.en],
      },
      notFit: [
        notFitSelfHosted.en,
        notFitScope.en,
        'You cannot rebuild your Zendesk macros, automation rules and views: the importer brings history, not configuration.',
        notFitLanguages.en,
        notFitApps.en,
      ],
      faq: [
        {
          q: 'Can I import my Zendesk tickets into Helpdock?',
          a: 'Yes. The Zendesk importer copies tickets with public replies and private notes, contacts and organizations, groups, custom fields, tags, satisfaction ratings, and Help Center categories, sections and articles with their attachments. Run the dry run first and compare the counts.',
        },
        {
          q: 'Will importing email my customers?',
          a: 'No. Imported history sends no customer messages and starts no rules, notifications, SLA timers or AI work.',
        },
        {
          q: 'Are Zendesk macros and automation rules imported?',
          a: 'No. Macros, automation rules, SLA policies and saved views are rebuilt by hand in Helpdock, which has its own macros, workflow and time-based rules, SLA policies and views.',
        },
        {
          q: 'Can Zendesk keep running while I move?',
          a: 'Yes. After the first run completes you can run a delta from the same account to pick up what changed, then switch your email and other channels to Helpdock.',
        },
        sharedFaqEn.cost,
      ],
    },
    ar: {
      title: 'Helpdock مقابل Zendesk: بديل مفتوح المصدر تستضيفه بنفسك',
      description:
        'Zendesk خدمة مستضافة، أما Helpdock فمكتب دعم مفتوح المصدر تشغّله على خادمك، مع أداة استيراد مدمجة من Zendesk للتذاكر وجهات الاتصال ومقالات مركز المساعدة.',
      lead: 'Zendesk خدمة مستضافة. أما Helpdock فمكتب دعم تشغّله على خادمك، ويستطيع أن ينقل معه سجلّك في Zendesk.',
      hosting: 'تستضيفه شركة Zendesk',
      licence: 'رخصة احتكارية',
      data: 'في مناطق الاستضافة لدى Zendesk',
      summary: [
        'تتصل أداة الاستيراد من Zendesk عبر OAuth أو رمز واجهة برمجية قديم، ثم تنسخ التذاكر بردودها العامة وملاحظاتها الخاصة ومؤلفيها وتواريخها الأصلية، وجهات الاتصال والمؤسسات، والمجموعات، والحقول، والوسوم، وتقييمات الرضا، ومحتوى مركز المساعدة.',
        'تأخذ التذاكر أرقامًا جديدة في Helpdock، وتبقى معرّفاتها في Zendesk قابلة للبحث: البحث عن الرقم القديم يجد التذكرة من أي عرض، وعليها شارة «مستورد من Zendesk».',
      ],
      strengths: [strengthsAr.brands, strengthsAr.ai, strengthsAr.arabic, strengthsAr.data],
      migration: {
        intro:
          'أداة الاستيراد معالج بلغتين: اتصل، ثم طابِق، ثم شغّل التشغيل التجريبي، ثم وافق. ويبقى حسابك في Zendesk يعمل حتى تنقل قنواتك.',
        points: [imported.ar, notCarried.ar, standIns.ar],
      },
      notFit: [
        notFitSelfHosted.ar,
        notFitScope.ar,
        'لا تستطيع إعادة بناء الماكرو وقواعد الأتمتة والعروض التي في Zendesk: أداة الاستيراد تنقل السجل لا الإعدادات.',
        notFitLanguages.ar,
        notFitApps.ar,
      ],
      faq: [
        {
          q: 'هل أستطيع استيراد تذاكري من Zendesk إلى Helpdock؟',
          a: 'نعم. تنسخ أداة الاستيراد التذاكر بردودها العامة وملاحظاتها الخاصة، وجهات الاتصال والمؤسسات، والمجموعات، والحقول المخصّصة، والوسوم، وتقييمات الرضا، وفئات مركز المساعدة وأقسامه ومقالاته مع مرفقاتها. شغّل التشغيل التجريبي أولًا وقارن الأعداد.',
        },
        {
          q: 'هل يرسل الاستيراد رسائل إلى عملائي؟',
          a: 'لا. السجل المستورد لا يرسل أي رسالة إلى العملاء، ولا يشغّل القواعد أو الإشعارات أو مؤقتات اتفاقية مستوى الخدمة أو الذكاء الاصطناعي.',
        },
        {
          q: 'هل تُستورد الماكرو وقواعد الأتمتة من Zendesk؟',
          a: 'لا. تُعاد بناء الماكرو وقواعد الأتمتة وسياسات مستوى الخدمة والعروض المحفوظة يدويًا في Helpdock، وفيه ماكرو وقواعد سير عمل وقواعد زمنية وسياسات مستوى خدمة وعروض خاصة به.',
        },
        {
          q: 'هل يستمر Zendesk في العمل أثناء الانتقال؟',
          a: 'نعم. بعد اكتمال التشغيل الأول تستطيع تشغيل استيراد للتغييرات من الحساب نفسه، ثم تنقل بريدك وقنواتك الأخرى إلى Helpdock.',
        },
        sharedFaqAr.cost,
      ],
    },
    alternative: {
      title: 'A self-hosted Zendesk alternative: moving to Helpdock',
      description:
        'How to move from Zendesk to Helpdock, the open-source help desk you host yourself: connect, map, dry run, delta and cutover, and what to rebuild by hand.',
      h1: 'Moving from Zendesk to Helpdock',
      lead: 'A migration plan for teams leaving Zendesk for a help desk they run themselves: what the importer brings across, what it leaves behind, and the order to switch things over.',
      connect: [
        'Connect with OAuth (your Zendesk subdomain and an access token) or with a labelled legacy API token (subdomain, email and token).',
        'Exports need a Zendesk admin. List the download hosts your attachments come from, up to 32 exact host names, so files can be copied.',
        'Attachments and article files are copied into your own private S3-compatible bucket, so nothing depends on a Zendesk URL afterwards.',
      ],
      maps: [
        { from: 'new, open', to: 'Open' },
        { from: 'pending', to: 'Awaiting customer' },
        { from: 'hold', to: 'On hold' },
        { from: 'solved, closed', to: 'Closed' },
        { from: 'low, normal, high, urgent', to: 'Low, Medium, High, Urgent' },
        { from: 'Groups', to: 'Departments, matched by name' },
        { from: 'Agents', to: 'Existing staff, an invited person (no email sent) or a name only' },
        { from: 'Help Center articles with restricted readership', to: 'Internal articles' },
      ],
      limits: [
        'Organization pages of more than 1,000 records are read in chunks, and a page that changes while it is read is refused rather than skipped. Keep the account quiet during the run.',
        'Satisfaction comes from both the legacy ratings API and survey responses.',
        standIns.en,
      ],
      rebuild: rebuildEn,
      faq: [
        {
          q: 'How long does Zendesk stay in use?',
          a: 'Until you switch channels. Run the first import, check it, run a delta from the same account to pick up changes, then point email and other channels at Helpdock.',
        },
        {
          q: 'Do old Zendesk ticket numbers still work?',
          a: 'Yes, as search terms. Tickets get new Helpdock numbers, and their Zendesk IDs and numbers stay searchable from any view.',
        },
        {
          q: 'What if the import goes wrong?',
          a: 'Cancel the run; cancellation stops future work and keeps what was already written. To return to the state before the import, restore the backup you took in step one.',
        },
      ],
    },
  },
  {
    slug: 'freshdesk',
    name: 'Freshdesk',
    homepage: 'https://www.freshworks.com/freshdesk/',
    hosting: 'hosted',
    hostingSource: {
      label: 'Freshdesk: where your data is located',
      url: 'https://support.freshdesk.com/support/solutions/articles/235810-where-is-your-data-servers-located-',
    },
    licence: 'proprietary',
    licenceSource: { label: 'Freshworks security', url: 'https://www.freshworks.com/security/' },
    checked: CHECKED,
    importer: true,
    en: {
      title: 'Helpdock vs Freshdesk: a self-hosted, open-source alternative',
      description:
        'Freshdesk is a hosted service; Helpdock is an open-source help desk you run yourself, with a built-in Freshdesk importer, including accounts above 30,000 tickets.',
      lead: 'Freshdesk is a hosted service. Helpdock is a help desk you run on your own server, with an importer built for Freshdesk accounts large and small.',
      hosting: 'Hosted by Freshworks',
      licence: 'Proprietary',
      data: 'In Freshworks’ data centres',
      summary: [
        'The Freshdesk importer connects with your workspace label and an agent API key with ticket and agent read access. It copies tickets and their messages, contacts, companies, groups, fields, tags, satisfaction answers, attachments and knowledge base articles.',
        'Freshdesk’s ticket list stops at 300 pages of 100 tickets for one window. For accounts above 30,000 tickets, the importer’s “Complete ticket ID inventory” mode takes an export of every ticket ID, so extraction never skips a ticket silently.',
      ],
      strengths: [strengthsEn.brands, strengthsEn.ai, strengthsEn.data, strengthsEn.free],
      migration: {
        intro:
          'Pick the satisfaction API your Freshdesk account supports, prepare the ticket ID inventory if you need one, then map, dry run and approve.',
        points: [imported.en, notCarried.en, standIns.en],
      },
      notFit: [notFitSelfHosted.en, notFitScope.en, notFitLanguages.en, notFitApps.en],
      faq: [
        {
          q: 'Can I import my Freshdesk tickets into Helpdock?',
          a: 'Yes. The Freshdesk importer copies tickets with their messages, contacts, companies, groups, fields, tags, satisfaction answers, attachments and knowledge base articles.',
        },
        {
          q: 'My Freshdesk account has more than 30,000 tickets. Can it be imported?',
          a: 'Yes, with the Complete ticket ID inventory mode: upload an export of every ticket ID. Freshdesk’s list stops at 300 pages for one window, and the importer stops rather than skip tickets.',
        },
        {
          q: 'What happens to Freshdesk satisfaction surveys?',
          a: 'Newer satisfaction answers keep their original questions. Answers without a score are kept but left out of averages.',
        },
        {
          q: 'Will importing email my customers?',
          a: 'No. Imported history sends no customer messages and starts no rules, notifications, SLA timers or AI work.',
        },
        sharedFaqEn.cost,
      ],
    },
    ar: {
      title: 'Helpdock مقابل Freshdesk: بديل مفتوح المصدر تستضيفه بنفسك',
      description:
        'Freshdesk خدمة مستضافة، أما Helpdock فمكتب دعم مفتوح المصدر تشغّله على خادمك، مع أداة استيراد مدمجة من Freshdesk تعمل حتى مع الحسابات التي تتجاوز 30 ألف تذكرة.',
      lead: 'Freshdesk خدمة مستضافة. أما Helpdock فمكتب دعم تشغّله على خادمك، مع أداة استيراد بُنيت لحسابات Freshdesk صغيرها وكبيرها.',
      hosting: 'تستضيفه شركة Freshworks',
      licence: 'رخصة احتكارية',
      data: 'في مراكز بيانات Freshworks',
      summary: [
        'تتصل أداة الاستيراد من Freshdesk باسم مساحة العمل ومفتاح واجهة برمجية لموظف يملك صلاحية قراءة التذاكر والموظفين. وتنسخ التذاكر ورسائلها، وجهات الاتصال، والشركات، والمجموعات، والحقول، والوسوم، وإجابات استبيانات الرضا، والمرفقات، ومقالات قاعدة المعرفة.',
        'تتوقف قائمة التذاكر في Freshdesk عند 300 صفحة من 100 تذكرة للنافذة الزمنية الواحدة. ولذلك تأخذ الأداة في وضع «جرد كامل لمعرّفات التذاكر» ملفًا بكل معرّف تذكرة للحسابات التي تتجاوز 30 ألف تذكرة، حتى لا تُتخطّى أي تذكرة دون علمك.',
      ],
      strengths: [strengthsAr.brands, strengthsAr.ai, strengthsAr.arabic, strengthsAr.data],
      migration: {
        intro:
          'اختر واجهة استبيانات الرضا التي يدعمها حسابك في Freshdesk، وجهّز جرد معرّفات التذاكر إن احتجت إليه، ثم طابِق وشغّل التشغيل التجريبي ووافق.',
        points: [imported.ar, notCarried.ar, standIns.ar],
      },
      notFit: [notFitSelfHosted.ar, notFitScope.ar, notFitLanguages.ar, notFitApps.ar],
      faq: [
        {
          q: 'هل أستطيع استيراد تذاكري من Freshdesk إلى Helpdock؟',
          a: 'نعم. تنسخ أداة الاستيراد التذاكر ورسائلها، وجهات الاتصال، والشركات، والمجموعات، والحقول، والوسوم، وإجابات الرضا، والمرفقات، ومقالات قاعدة المعرفة.',
        },
        {
          q: 'في حسابي على Freshdesk أكثر من 30 ألف تذكرة. هل يمكن استيراده؟',
          a: 'نعم، بوضع الجرد الكامل لمعرّفات التذاكر: ارفع ملفًا بكل معرّف تذكرة. فقائمة Freshdesk تتوقف عند 300 صفحة للنافذة الواحدة، والأداة تتوقف بدل أن تتخطّى تذاكر.',
        },
        {
          q: 'ماذا يحدث لاستبيانات الرضا في Freshdesk؟',
          a: 'تحتفظ إجابات الرضا الأحدث بأسئلتها الأصلية. أما الإجابات التي لا تحمل درجة فتُحفظ لكنها لا تدخل في المتوسطات.',
        },
        {
          q: 'هل يرسل الاستيراد رسائل إلى عملائي؟',
          a: 'لا. السجل المستورد لا يرسل أي رسالة إلى العملاء، ولا يشغّل القواعد أو الإشعارات أو مؤقتات اتفاقية مستوى الخدمة أو الذكاء الاصطناعي.',
        },
        sharedFaqAr.cost,
      ],
    },
    alternative: {
      title: 'A self-hosted Freshdesk alternative: moving to Helpdock',
      description:
        'How to move from Freshdesk to Helpdock, the open-source help desk you host yourself: credentials, the ticket ID inventory, mapping, dry run and cutover.',
      h1: 'Moving from Freshdesk to Helpdock',
      lead: 'A migration plan for teams leaving Freshdesk for a help desk they run themselves, including accounts too large for Freshdesk’s ticket list.',
      connect: [
        'Connect with your workspace label (for example `acme`) and an agent API key with ticket and agent read access.',
        'Choose the satisfaction API your Freshdesk account supports.',
        'Below 30,000 tickets, “Archive IDs plus the live export” works. Above it, use “Complete ticket ID inventory” and upload an export of every ticket ID; the same applies to a delta that covers more than 30,000 changed tickets.',
      ],
      maps: [
        { from: 'Groups', to: 'Departments, matched by name' },
        { from: 'Agents', to: 'Existing staff, an invited person (no email sent) or a name only' },
        {
          from: 'Statuses and priorities',
          to: 'Helpdock statuses and priorities, with suggestions you confirm',
        },
        { from: 'Contact and company profile attributes', to: 'Custom fields' },
        { from: 'Dropdowns with more than 50 choices', to: 'Text fields' },
        { from: 'Satisfaction answers', to: 'CSAT, with the original questions kept' },
      ],
      limits: [
        'Freshdesk’s ticket list stops at 300 pages of 100 tickets for one window. When the 300th page is not empty, extraction stops instead of skipping tickets.',
        standIns.en,
      ],
      rebuild: rebuildEn,
      faq: [
        {
          q: 'Why does a large account need a ticket ID inventory?',
          a: 'Freshdesk’s ticket list returns at most 300 pages of 100 tickets for one window. With a full list of IDs the importer can fetch every ticket instead of stopping at that limit.',
        },
        {
          q: 'Can I pick up tickets that change during the move?',
          a: 'Yes. Create a delta from the completed run, connect the same account and reconfirm any inventory it needs. Keep Freshdesk quiet during the final delta.',
        },
        {
          q: 'Are Freshdesk automations imported?',
          a: 'No. Automation rules, macros, SLA policies and views are rebuilt in Helpdock by hand.',
        },
      ],
    },
  },
  {
    slug: 'zoho-desk',
    name: 'Zoho Desk',
    homepage: 'https://www.zoho.com/desk/',
    hosting: 'hosted',
    hostingSource: {
      label: 'Zoho: know your data centre',
      url: 'https://www.zoho.com/know-your-datacenter.html',
    },
    licence: 'proprietary',
    licenceSource: { label: 'Zoho security', url: 'https://www.zoho.com/security.html' },
    checked: CHECKED,
    importer: true,
    en: {
      title: 'Helpdock vs Zoho Desk: a self-hosted, open-source alternative',
      description:
        'Zoho Desk is a hosted service; Helpdock is an open-source help desk you run yourself, with a built-in Zoho Desk importer that reads every data centre and its archives.',
      lead: 'Zoho Desk is a hosted service. Helpdock is a help desk you run on your own server, with an importer that reads your Zoho Desk history, archives included.',
      hosting: 'Hosted by Zoho',
      licence: 'Proprietary',
      data: 'In Zoho’s data centres',
      summary: [
        'The Zoho Desk importer connects to the data centre your account lives in with an organization ID and an OAuth client and refresh token. It finds archived tickets on its own, without a CSV, and keeps each email’s original Message-ID and headers.',
        'Zoho Desk API calls cost credits. The connection check costs 50, every delta lists every ticket, and when the daily allowance runs out the run waits rather than retrying, so check your allowance before you schedule deltas.',
      ],
      strengths: [strengthsEn.brands, strengthsEn.ai, strengthsEn.slas, strengthsEn.data],
      migration: {
        intro:
          'Choose the data centre, connect with a read-only OAuth client, map departments, staff and fields, then dry run and approve.',
        points: [imported.en, notCarried.en, standIns.en],
      },
      notFit: [notFitSelfHosted.en, notFitScope.en, notFitLanguages.en, notFitApps.en],
      faq: [
        {
          q: 'Can I import my Zoho Desk tickets into Helpdock?',
          a: 'Yes. The Zoho Desk importer copies tickets and their threads, contacts, accounts, departments, agents, fields, tags, satisfaction ratings, attachments and knowledge base articles, and finds archived tickets on its own.',
        },
        {
          q: 'Which Zoho data centres are supported?',
          a: 'The importer asks for the data centre first: US, EU, India, Australia, Canada, Japan, Saudi Arabia, China, Singapore or the UAE.',
        },
        {
          q: 'How many Zoho API credits does an import use?',
          a: 'The connection check costs 50 credits, and each delta lists every ticket, about as many credits as a full import’s ticket listing. When credits run out, the run waits 24 hours or until the time Zoho gives.',
        },
        {
          q: 'Will importing email my customers?',
          a: 'No. Imported history sends no customer messages and starts no rules, notifications, SLA timers or AI work.',
        },
        sharedFaqEn.cost,
      ],
    },
    ar: {
      title: 'Helpdock مقابل Zoho Desk: بديل مفتوح المصدر تستضيفه بنفسك',
      description:
        'Zoho Desk خدمة مستضافة، أما Helpdock فمكتب دعم مفتوح المصدر تشغّله على خادمك، مع أداة استيراد مدمجة من Zoho Desk تقرأ كل مراكز البيانات والأرشيف.',
      lead: 'Zoho Desk خدمة مستضافة. أما Helpdock فمكتب دعم تشغّله على خادمك، مع أداة استيراد تقرأ سجلّك في Zoho Desk بما فيه الأرشيف.',
      hosting: 'تستضيفه شركة Zoho',
      licence: 'رخصة احتكارية',
      data: 'في مراكز بيانات Zoho',
      summary: [
        'تتصل أداة الاستيراد من Zoho Desk بمركز البيانات الذي يقع فيه حسابك، باستخدام معرّف المؤسسة وعميل OAuth ورمز تحديث. وتعثر على التذاكر المؤرشفة وحدها دون ملف CSV، وتحتفظ بمعرّف Message-ID الأصلي لكل رسالة بريد وبترويساتها.',
        'استدعاءات واجهة Zoho Desk البرمجية تستهلك أرصدة. فحص الاتصال يكلّف 50 رصيدًا، وكل استيراد للتغييرات يمرّ على كل التذاكر، وإذا نفد الرصيد اليومي ينتظر التشغيل بدل إعادة المحاولة، لذا راجع رصيدك قبل جدولة استيراد التغييرات.',
      ],
      strengths: [strengthsAr.brands, strengthsAr.ai, strengthsAr.arabic, strengthsAr.data],
      migration: {
        intro:
          'اختر مركز البيانات، واتصل بعميل OAuth للقراءة فقط، وطابِق الأقسام والموظفين والحقول، ثم شغّل التشغيل التجريبي ووافق.',
        points: [imported.ar, notCarried.ar, standIns.ar],
      },
      notFit: [notFitSelfHosted.ar, notFitScope.ar, notFitLanguages.ar, notFitApps.ar],
      faq: [
        {
          q: 'هل أستطيع استيراد تذاكري من Zoho Desk إلى Helpdock؟',
          a: 'نعم. تنسخ أداة الاستيراد التذاكر ومحادثاتها، وجهات الاتصال، والحسابات، والأقسام، والموظفين، والحقول، والوسوم، وتقييمات الرضا، والمرفقات، ومقالات قاعدة المعرفة، وتعثر على التذاكر المؤرشفة وحدها.',
        },
        {
          q: 'ما مراكز بيانات Zoho المدعومة؟',
          a: 'تسأل الأداة عن مركز البيانات أولًا: الولايات المتحدة، أو الاتحاد الأوروبي، أو الهند، أو أستراليا، أو كندا، أو اليابان، أو السعودية، أو الصين، أو سنغافورة، أو الإمارات.',
        },
        {
          q: 'كم رصيدًا من واجهة Zoho البرمجية يستهلك الاستيراد؟',
          a: 'فحص الاتصال يكلّف 50 رصيدًا، وكل استيراد للتغييرات يمرّ على كل التذاكر، أي ما يقارب أرصدة قائمة التذاكر في استيراد كامل. وإذا نفدت الأرصدة ينتظر التشغيل 24 ساعة أو حتى الموعد الذي يحدّده Zoho.',
        },
        {
          q: 'هل يرسل الاستيراد رسائل إلى عملائي؟',
          a: 'لا. السجل المستورد لا يرسل أي رسالة إلى العملاء، ولا يشغّل القواعد أو الإشعارات أو مؤقتات اتفاقية مستوى الخدمة أو الذكاء الاصطناعي.',
        },
        sharedFaqAr.cost,
      ],
    },
    alternative: {
      title: 'A self-hosted Zoho Desk alternative: moving to Helpdock',
      description:
        'How to move from Zoho Desk to Helpdock, the open-source help desk you host yourself: OAuth scopes, API credits, archives, mapping, dry run and cutover.',
      h1: 'Moving from Zoho Desk to Helpdock',
      lead: 'A migration plan for teams leaving Zoho Desk for a help desk they run themselves, with the API credit budget to plan for.',
      connect: [
        'Choose your data centre, then enter the organization ID, an OAuth client ID and secret, and a refresh token.',
        'The connecting user needs an Administrator profile and read grants for tickets, contacts, accounts, agents, departments, the organization, fields, search and articles.',
        'The connection check costs 50 API credits. Archived tickets are discovered automatically, so no CSV is needed.',
      ],
      maps: [
        { from: 'Departments', to: 'Departments, matched by name' },
        { from: 'Agents', to: 'Existing staff, an invited person (no email sent) or a name only' },
        {
          from: 'Statuses and priorities',
          to: 'Helpdock statuses and priorities, with suggestions you confirm',
        },
        { from: 'Accounts', to: 'Accounts (companies)' },
        { from: 'Articles in the recycle bin', to: 'Internal drafts' },
        { from: 'Email Message-ID and headers', to: 'Kept with each imported message' },
      ],
      limits: [
        'Each delta lists every ticket in creation order, 100 per request, and rescans every department’s archive, so it costs about as many credits as a full import’s ticket listing.',
        'When credits run out, the run waits 24 hours, or until the time Zoho sends in Retry-After, rather than retrying.',
        standIns.en,
      ],
      rebuild: rebuildEn,
      faq: [
        {
          q: 'Do I need to export archived tickets by hand?',
          a: 'No. The Zoho Desk importer reads each department’s archive itself.',
        },
        {
          q: 'How do I budget API credits for the move?',
          a: 'Plan for the full import plus each delta, and each delta lists every ticket. Check the account’s daily allowance before scheduling them; a run that runs out waits instead of failing.',
        },
        {
          q: 'Is Zoho Desk automation imported?',
          a: 'No. Automation, macros, SLA policies and views are rebuilt in Helpdock by hand.',
        },
      ],
    },
  },
  {
    slug: 'zammad',
    name: 'Zammad',
    homepage: 'https://zammad.com',
    hosting: 'both',
    hostingSource: {
      label: 'Zammad pricing: hosted and self-hosted',
      url: 'https://zammad.com/en/pricing',
    },
    licence: 'AGPL-3.0-only',
    licenceSource: {
      label: 'zammad/zammad LICENSE',
      url: 'https://github.com/zammad/zammad/blob/develop/LICENSE',
    },
    checked: CHECKED,
    importer: false,
    en: {
      title: 'Helpdock vs Zammad: two AGPL help desks compared',
      description:
        'Zammad and Helpdock are both AGPL-3.0 help desks you can host yourself. Here is what differs in hosting, migration and what Helpdock ships, with sources.',
      lead: 'Zammad and Helpdock share a licence: both are AGPL-3.0, and both can run on your own server. The differences are in hosting options and in what each one is built around.',
      hosting: 'Self-hosted, or Zammad’s hosted cloud',
      licence: 'AGPL-3.0-only',
      data: 'On your server, or in Zammad’s cloud',
      summary: [
        'Under the same licence the obligations match: you can run, study and change either one, and if you let people use a changed version over a network, you offer them its source.',
        'Zammad also sells a hosted cloud. Helpdock has none and will not in 1.x: it is self-hosted only, on Docker Compose.',
        'Helpdock is built around one install serving many brands, each kept apart by Postgres row-level security, with English and Arabic throughout and AI that answers only from the brand’s own knowledge.',
      ],
      strengths: [strengthsEn.brands, strengthsEn.ai, strengthsEn.arabic, strengthsEn.data],
      migration: {
        intro:
          'Helpdock has no Zammad connector yet. A Zammad importer is part of the proposed 1.x plan (M16) and has not started.',
        points: [
          'Until then, bring the data across as CSV files through the manual CSV mapper: tickets, messages, contacts, organisations and articles, with date formats, value maps and a dry run.',
          imported.en,
          'Configuration (rules, saved replies, SLA settings and views) is not part of a CSV import. Rebuild it in Helpdock.',
        ],
      },
      notFit: [
        'You want the vendor to host it for you. Zammad offers a hosted cloud; Helpdock does not.',
        'You need a built-in importer from Zammad today. Helpdock’s is planned, not built.',
        notFitScope.en,
        notFitLanguages.en,
      ],
      faq: [
        {
          q: 'Are Zammad and Helpdock under the same licence?',
          a: 'Yes. Zammad’s repository is AGPL-3.0-only, and so is Helpdock. Both can be run, changed and self-hosted for free.',
        },
        {
          q: 'Can I import from Zammad?',
          a: 'Through the manual CSV mapper today. A dedicated Zammad connector is in the proposed 1.x plan and has not started.',
        },
        {
          q: 'Is there a hosted Helpdock?',
          a: 'No. Helpdock is self-hosted only, and a hosted Helpdock is a stated non-goal for 1.x.',
        },
        sharedFaqEn.cost,
      ],
    },
  },
  {
    slug: 'chatwoot',
    name: 'Chatwoot',
    homepage: 'https://www.chatwoot.com',
    hosting: 'both',
    hostingSource: {
      label: 'Chatwoot self-hosting docs',
      url: 'https://developers.chatwoot.com/self-hosted',
    },
    licence: 'MIT',
    licenceSource: {
      label: 'chatwoot/chatwoot LICENSE',
      url: 'https://github.com/chatwoot/chatwoot/blob/develop/LICENSE',
    },
    checked: CHECKED,
    importer: false,
    en: {
      title: 'Helpdock vs Chatwoot: licences and self-hosting compared',
      description:
        'Chatwoot is MIT with an enterprise folder under its own licence; Helpdock is AGPL-3.0 with no paid edition. What that means for self-hosting, with sources.',
      lead: 'Chatwoot and Helpdock can both run on your own server. They differ in how they are licensed, and in what Helpdock puts in its one free edition.',
      hosting: 'Self-hosted, or Chatwoot Cloud',
      licence: 'MIT, except an enterprise folder under a separate licence',
      data: 'On your server, or in Chatwoot Cloud',
      summary: [
        'Chatwoot’s repository is MIT, except its enterprise folder, which is under the Chatwoot Enterprise licence that requires a paid subscription for production use.',
        'Helpdock is one AGPL-3.0 repository with no enterprise folder, no licence keys and no paid tier. SSO over SAML and OpenID Connect, SLA policies and the AI assistant are part of it.',
        'MIT is permissive; AGPL-3.0 asks anyone who lets people use a changed version over a network to offer them its source.',
      ],
      strengths: [strengthsEn.free, strengthsEn.slas, strengthsEn.brands, strengthsEn.ai],
      migration: {
        intro: 'Helpdock has no Chatwoot connector, and none is in the 1.x plan.',
        points: [
          'Bring conversations and contacts across as CSV files through the manual CSV mapper, which reads UTF-8 or UTF-16 CSV with comma, semicolon or tab delimiters, or one bundle ZIP.',
          imported.en,
          'Configuration (rules, saved replies and channel settings) is not part of a CSV import. Rebuild it in Helpdock and connect your channels per brand.',
        ],
      },
      notFit: [
        'You want the vendor to host it for you. Chatwoot offers a cloud; Helpdock does not.',
        'You need a permissive licence to build Helpdock into closed software. AGPL-3.0 requires offering the source of a changed version that people use over a network.',
        notFitScope.en,
        notFitLanguages.en,
      ],
      faq: [
        {
          q: 'Is everything in Helpdock free?',
          a: 'Yes. There is one edition, under AGPL-3.0, with no enterprise folder, licence keys or paid features.',
        },
        {
          q: 'Can I import from Chatwoot?',
          a: 'Through the manual CSV mapper. Helpdock has no Chatwoot connector, and none is planned in 1.x.',
        },
        {
          q: 'Which channels does Helpdock support?',
          a: 'Email, WhatsApp, Messenger, Instagram, Telegram, the live chat widget, a hosted web form and the REST API, all filing into the same tickets.',
        },
        sharedFaqEn.cost,
      ],
    },
  },
  {
    slug: 'freescout',
    name: 'FreeScout',
    homepage: 'https://freescout.net',
    hosting: 'self-hosted',
    hostingSource: { label: 'FreeScout: cloud hosted', url: 'https://freescout.net/cloud-hosted/' },
    licence: 'AGPL-3.0',
    licenceSource: {
      label: 'freescout-help-desk/freescout LICENSE',
      url: 'https://github.com/freescout-help-desk/freescout/blob/dist/LICENSE',
    },
    checked: CHECKED,
    importer: false,
    en: {
      title: 'Helpdock vs FreeScout: two self-hosted AGPL help desks',
      description:
        'FreeScout and Helpdock are both self-hosted under the AGPL-3.0. They differ in paid modules, requirements and multi-brand design. A sourced comparison.',
      lead: 'FreeScout and Helpdock are both self-hosted help desks under the AGPL-3.0. They differ in how extra features are sold and in what a server needs to run them.',
      hosting: 'Self-hosted; no official cloud',
      licence: 'AGPL-3.0, with paid modules',
      data: 'On your server',
      summary: [
        'FreeScout is self-hosted only and points to third-party hosts rather than running a cloud of its own. Most of its official modules are sold per instance, with their source under the AGPL-3.0.',
        'Helpdock ships every feature in its one repository: there are no modules to buy. It also asks more of the server: Docker Compose, 2 vCPU and 4 GB of memory, two DNS names and an S3-compatible bucket.',
      ],
      strengths: [strengthsEn.free, strengthsEn.brands, strengthsEn.ai, strengthsEn.slas],
      migration: {
        intro: 'Helpdock has no FreeScout connector, and none is in the 1.x plan.',
        points: [
          'Bring the data across as CSV files through the manual CSV mapper, which previews 20 rows, validates the whole file and saves the mapping as a preset.',
          imported.en,
          'Configuration (saved replies, rules and mailbox settings) is not part of a CSV import. Rebuild it as macros, rules and email channels.',
        ],
      },
      notFit: [
        'You need to run on shared hosting or a very small server. Helpdock needs Docker Compose, 2 vCPU, 4 GB of memory and an S3-compatible bucket.',
        notFitSelfHosted.en,
        notFitScope.en,
        notFitLanguages.en,
      ],
      faq: [
        {
          q: 'Do I have to buy modules for Helpdock?',
          a: 'No. Everything is in the AGPL-3.0 repository; there are no modules, editions or licence keys.',
        },
        {
          q: 'What server does Helpdock need?',
          a: 'A Linux server with Docker Engine and the Compose v2 plugin, 2 vCPU and 4 GB of memory, two DNS names, ports 80 and 443, and an S3-compatible bucket.',
        },
        {
          q: 'Can I import from FreeScout?',
          a: 'Through the manual CSV mapper. Helpdock has no FreeScout connector.',
        },
        sharedFaqEn.cost,
      ],
    },
  },
  {
    slug: 'osticket',
    name: 'osTicket',
    homepage: 'https://osticket.com',
    hosting: 'both',
    hostingSource: { label: 'osTicket editions', url: 'https://osticket.com/editions/' },
    licence: 'GPL-2.0',
    licenceSource: {
      label: 'osTicket/osTicket LICENSE',
      url: 'https://github.com/osTicket/osTicket/blob/develop/LICENSE.txt',
    },
    checked: CHECKED,
    importer: false,
    en: {
      title: 'Helpdock vs osTicket: GPL-2.0 and AGPL-3.0 help desks',
      description:
        'osTicket is GPL-2.0 with self-hosted and cloud editions; Helpdock is AGPL-3.0 and self-hosted only. What differs in licence, hosting and migration, with sources.',
      lead: 'osTicket and Helpdock are both open-source help desks you can host yourself. Their licences differ in one way that matters if you change the code and serve it.',
      hosting: 'Self-hosted, or a hosted edition',
      licence: 'GPL-2.0',
      data: 'On your server, or with the hosted edition',
      summary: [
        'osTicket is released under the GPL-2.0, and its site lists a free open-source edition, a cloud-hosted edition and a virtual appliance.',
        'The GPL-2.0 has no network clause: serving a changed version over the web does not oblige you to share it. Helpdock’s AGPL-3.0 does, so changes to a Helpdock that people use over a network stay open.',
        'An osTicket importer is on Helpdock’s backlog, after the connectors planned for 1.x. Today, osTicket data comes in through the CSV mapper.',
      ],
      strengths: [strengthsEn.ai, strengthsEn.brands, strengthsEn.slas, strengthsEn.arabic],
      migration: {
        intro: 'Helpdock has no osTicket connector yet; one is on the backlog beyond the 1.x plan.',
        points: [
          'Bring tickets, messages and contacts across as CSV files through the manual CSV mapper, with date formats, value maps and a whole-file check before anything is written.',
          imported.en,
          'Configuration (rules, saved replies, SLA settings and views) is not part of a CSV import. Rebuild it in Helpdock.',
        ],
      },
      notFit: [
        'You want a hosted edition from the same project. osTicket lists one; Helpdock is self-hosted only.',
        'You need to keep changes to a network-facing deployment private. Helpdock’s AGPL-3.0 does not allow that.',
        notFitScope.en,
        notFitLanguages.en,
      ],
      faq: [
        {
          q: 'What is the difference between GPL-2.0 and AGPL-3.0 here?',
          a: 'Both let you run and change the software. Only the AGPL-3.0 asks you to offer the source of a changed version that people use over a network.',
        },
        {
          q: 'Can I import from osTicket?',
          a: 'Through the manual CSV mapper today. An osTicket importer is on the backlog after the 1.x connectors.',
        },
        {
          q: 'Does Helpdock have a help center?',
          a: 'Yes. Each brand gets a help center on its own domain, in English and Arabic, with search, “was this helpful?” feedback and public or internal articles.',
        },
        sharedFaqEn.cost,
      ],
    },
  },
];

export const COMPETITORS = CompetitorsSchema.parse(competitors);
export const competitor = (slug: string) => COMPETITORS.find((item) => item.slug === slug);

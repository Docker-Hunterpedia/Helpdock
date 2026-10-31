/**
 * One page per channel, in English and Arabic. Every line comes from the
 * channel's guide, which each page links to for the rest.
 */
import type { Locale } from './site.ts';

export type ChannelCopy = {
  name: string;
  title: string;
  description: string;
  lead: string;
  card: string;
  setup: string[];
  supported: string[];
  limits: string[];
};

export type Channel = {
  slug: string;
  icon: string;
  /** AI auto-reply runs on the widget, email and Telegram only. */
  autoReply: boolean;
  guides: { label: string; href: string }[];
  related: string[];
} & Record<Locale, ChannelCopy>;

export const CHANNELS: Channel[] = [
  {
    slug: 'email',
    icon: 'mail',
    autoReply: true,
    guides: [
      { label: 'Email: receiving mail', href: '/docs/email/' },
      { label: 'Outbound email', href: '/docs/outbound-email/' },
    ],
    related: ['slas-and-business-hours', 'automation-and-macros', 'ai'],
    en: {
      name: 'Email',
      title: 'Email support in a self-hosted help desk · Helpdock',
      description:
        'Receive customer email by IMAP or a provider’s inbound parse, thread replies onto tickets, and answer from the brand’s own SMTP server. How it works in Helpdock.',
      lead: 'Each brand receives mail into its own mailboxes, by IMAP polling or a provider’s inbound-parse webhook, and replies go out from its own SMTP server.',
      card: 'IMAP or inbound parse, replies over the brand’s SMTP',
      setup: [
        'In Settings › Channels › Email, add a mailbox with its address and the department it files into.',
        'Choose how mail arrives: IMAP (host, port 993 or 143, username, app password, folder) and press Test IMAP, or point Postmark, SendGrid, Mailgun or Resend at the inbound-parse address with the brand’s shared secret.',
        'Set the brand’s outgoing SMTP server, or fall back to the install’s, and press Test SMTP.',
        'Set From and Reply-To per department, and turn on the acknowledgment and out-of-hours auto-replies if you want them, in English and Arabic.',
        'Each agent writes a signature of up to six plain lines, with placeholders.',
      ],
      supported: [
        'Threading by In-Reply-To and References, or by the ticket token in the subject, as long as the sender is a participant. Anyone else opens a new ticket.',
        'Bodies sanitised, quoted history folded and inline images turned into attachments. Remote images are blocked until an agent loads them, or fetched through Helpdock’s proxy.',
        'Everyone on To and Cc, except the brand’s own mailboxes, becomes a CC participant.',
        'Automated mail (out-of-office, bulk, noreply) opens no ticket unless allow-listed, and SPF or DKIM failures can open the ticket as Spam.',
        'Outgoing mail in the customer’s language, mirrored for Arabic, with a plain-text part and a stable Message-ID.',
        'A Failed sends panel with Retry, Retry all and Discard, and “Not delivered” on the ticket.',
        'AI auto-reply, with numbered sources, when the brand turns it on for email.',
      ],
      limits: [
        'IMAP polls every 30 seconds, 1, 2 or 5 minutes. The first poll takes unseen mail only, not your history.',
        'A mail server on a private address is refused unless it is listed in OUTBOUND_ALLOW_CIDRS.',
        'A send is tried five times over about eight minutes, and every SMTP timer is capped at ten seconds.',
        'Auto-replies are never sent to automated or bulk mail, at most three an hour per address by default, and once of each kind per ticket.',
        'A contact without an email address receives nothing by email.',
      ],
    },
    ar: {
      name: 'البريد الإلكتروني',
      title: 'دعم العملاء عبر البريد الإلكتروني في مكتب دعم تستضيفه بنفسك · Helpdock',
      description:
        'استقبل بريد العملاء عبر IMAP أو خدمة التحليل الواردة لدى مزوّد البريد، واربط الردود بالتذاكر، وأجب من خادم SMTP الخاص بعلامتك التجارية. هكذا يعمل في Helpdock.',
      lead: 'لكل علامة تجارية صناديق بريد تستقبل الرسائل إما بالاستطلاع الدوري عبر IMAP وإما بخطاف ويب للتحليل الوارد لدى مزوّد البريد، وتخرج الردود من خادم SMTP الخاص بها.',
      card: 'IMAP أو التحليل الوارد، والردود عبر SMTP الخاص بالعلامة',
      setup: [
        'في الإعدادات › القنوات، أضف صندوق بريد بعنوانه والقسم الذي يستقبل تذاكره.',
        'اختر طريقة وصول البريد: IMAP (الخادم، والمنفذ 993 أو 143، واسم المستخدم، وكلمة مرور التطبيق، والمجلد) ثم اضغط «اختبار IMAP»، أو وجّه Postmark أو SendGrid أو Mailgun أو Resend إلى عنوان التحليل الوارد مع السر المشترك للعلامة التجارية.',
        'اضبط خادم SMTP الصادر للعلامة التجارية، أو اعتمد على خادم التثبيت، ثم اضغط «اختبار SMTP».',
        'حدّد عنوان المرسل وعنوان الرد لكل قسم، وفعّل الرد التلقائي بالاستلام وخارج ساعات العمل إن أردت، بالعربية والإنجليزية.',
        'يكتب كل موظف توقيعًا من ستة أسطر نصية على الأكثر، مع متغيرات.',
      ],
      supported: [
        'ربط الرسائل بالتذكرة عبر ترويستي In-Reply-To وReferences، أو عبر رمز التذكرة في العنوان، ما دام المرسل مشاركًا فيها. وأي مرسل آخر يفتح تذكرة جديدة.',
        'تنقية محتوى الرسائل، وطيّ الاقتباسات السابقة، وتحويل الصور المضمّنة إلى مرفقات. والصور البعيدة محجوبة حتى يحمّلها الموظف، أو تُجلب عبر الوسيط في Helpdock.',
        'كل من في حقلي «إلى» و«نسخة»، عدا صناديق العلامة التجارية نفسها، يصبح مشاركًا في التذكرة.',
        'البريد الآلي (الرد خارج المكتب، والرسائل الجماعية، وعناوين noreply) لا يفتح تذكرة إلا إذا أُضيف إلى قائمة السماح، وفشل SPF أو DKIM قد يفتح التذكرة في البريد المزعج.',
        'رسائل صادرة بلغة العميل، معكوسة الاتجاه للعربية، مع نسخة نصية ومعرّف Message-ID ثابت.',
        'لوحة للرسائل التي فشل إرسالها فيها «إعادة المحاولة» و«إعادة المحاولة للكل» و«تجاهل»، وعلامة «لم يُسلَّم» على التذكرة.',
        'رد تلقائي بالذكاء الاصطناعي مع مصادر مرقّمة، حين تفعّله العلامة التجارية للبريد.',
      ],
      limits: [
        'يجري استطلاع IMAP كل 30 ثانية أو دقيقة أو دقيقتين أو خمس دقائق. والاستطلاع الأول يأخذ الرسائل غير المقروءة فقط، لا سجلّك القديم.',
        'خادم البريد ذو العنوان الخاص مرفوض ما لم يُدرج في OUTBOUND_ALLOW_CIDRS.',
        'تُعاد محاولة الإرسال خمس مرات خلال نحو ثماني دقائق، وكل مهلة في SMTP محدودة بعشر ثوانٍ.',
        'لا تُرسل الردود التلقائية إلى البريد الآلي أو الجماعي أبدًا، وبحد افتراضي ثلاثة ردود في الساعة لكل عنوان، ومرة واحدة من كل نوع لكل تذكرة.',
        'جهة الاتصال التي لا تملك عنوان بريد لا يصلها شيء عبر البريد.',
      ],
    },
  },
  {
    slug: 'telegram',
    icon: 'send',
    autoReply: true,
    guides: [{ label: 'Telegram', href: '/docs/telegram/' }],
    related: ['ai', 'slas-and-business-hours', 'multi-brand'],
    en: {
      name: 'Telegram',
      title: 'Telegram customer support with your own bot · Helpdock',
      description:
        'Customers write to the brand’s Telegram bot, each chat becomes a ticket, and agents reply in the same chat. Setup, what customers can send, and the limits.',
      lead: 'A customer writes to the brand’s Telegram bot, the chat becomes a ticket, and the agent’s replies arrive in the same chat.',
      card: 'The brand’s own bot, from BotFather',
      setup: [
        'In Telegram, send /newbot to @BotFather, pick a name and a username ending in “bot”, and copy the token. Leave privacy mode on.',
        'In Settings › Channels › Telegram, choose Add bot, paste the token and pick the department.',
        'Press Test. Add bot stays off until Telegram answers.',
        'Adding the bot sets its webhook on your public HTTPS address. After changing APP_URL, press Set webhook again.',
        'Optionally write a welcome text per language and let /start ask the customer to pick a language.',
      ],
      supported: [
        'Several bots per brand; each bot belongs to one brand.',
        'Text, photos (re-encoded to WebP, with the caption as text), documents, voice notes and locations or venues, as text with an OpenStreetMap link.',
        'The chat id is a verified Telegram identity on the contact, and one chat has one open ticket.',
        'Replies with files: an image as a photo, a voice note as Opus, anything else as a document.',
        'Delivery states queued, sent and failed, with Retry on a failed reply.',
        'A satisfaction survey with 1 to 5 buttons and “Add a comment”.',
        'AI auto-reply, when the brand turns it on for Telegram.',
      ],
      limits: [
        'Private chats only: group chats, stickers, contacts, polls and other bots are ignored.',
        'Inbound files up to 20 MB. Outbound, an image over 10 MB goes as a document and a file over Telegram’s 50 MB is left out.',
        'Replies are plain text with no signature, and replies longer than 4,096 characters are split at paragraphs.',
        'A reply the customer blocked fails at once; other failures are retried five times.',
        'APP_URL must be public HTTPS on port 443, 80, 88 or 8443.',
      ],
    },
    ar: {
      name: 'تيليجرام',
      title: 'دعم العملاء عبر تيليجرام ببوت خاص بك · Helpdock',
      description:
        'يكتب العملاء إلى بوت العلامة التجارية على تيليجرام، فتصبح كل محادثة تذكرة، ويردّ الموظفون في المحادثة نفسها. الإعداد وما يمكن إرساله والحدود.',
      lead: 'يكتب العميل إلى بوت العلامة التجارية على تيليجرام، فتصبح المحادثة تذكرة، وتصل ردود الموظف في المحادثة نفسها.',
      card: 'بوت العلامة التجارية من BotFather',
      setup: [
        'في تيليجرام، أرسل ‎/newbot إلى ‎@BotFather، واختر اسمًا واسم مستخدم ينتهي بكلمة bot، ثم انسخ الرمز. واترك وضع الخصوصية مفعّلًا.',
        'في الإعدادات › القنوات › تيليجرام، اختر «إضافة بوت»، والصق الرمز، واختر القسم.',
        'اضغط «اختبار». يبقى زر «إضافة بوت» معطّلًا حتى يجيب تيليجرام.',
        'إضافة البوت تضبط خطاف الويب على عنوانك العام عبر HTTPS. وبعد تغيير APP_URL اضغط «ضبط خطاف الويب» مجددًا.',
        'يمكنك كتابة رسالة ترحيب لكل لغة، وجعل الأمر ‎/start يطلب من العميل اختيار لغته.',
      ],
      supported: [
        'عدة بوتات لكل علامة تجارية، وكل بوت تابع لعلامة واحدة.',
        'النصوص، والصور (يُعاد ترميزها إلى WebP ويصبح تعليقها نصًا)، والمستندات، والرسائل الصوتية، والمواقع والأماكن نصًّا مع رابط OpenStreetMap.',
        'معرّف المحادثة هوية تيليجرام موثّقة لجهة الاتصال، ولكل محادثة تذكرة مفتوحة واحدة.',
        'ردود بملفات: الصورة تُرسل صورةً، والرسالة الصوتية بصيغة Opus، وأي ملف آخر مستندًا.',
        'حالات التسليم: في الطابور، وأُرسلت، وفشلت، مع «إعادة المحاولة» للرد الذي فشل.',
        'استبيان رضا بأزرار من 1 إلى 5 وخيار «أضف تعليقًا».',
        'رد تلقائي بالذكاء الاصطناعي حين تفعّله العلامة التجارية لتيليجرام.',
      ],
      limits: [
        'المحادثات الخاصة فقط: تُتجاهل المجموعات والملصقات وجهات الاتصال والاستطلاعات والبوتات الأخرى.',
        'الملفات الواردة حتى 20 ميغابايت. وفي الصادر تُرسل الصورة التي تتجاوز 10 ميغابايت مستندًا، ويُستبعد الملف الذي يتجاوز حد تيليجرام البالغ 50 ميغابايت.',
        'الردود نص عادي بلا توقيع، وما يتجاوز 4096 حرفًا يُقسَّم عند الفقرات.',
        'الرد الذي حظره العميل يفشل فورًا، أما الإخفاقات الأخرى فتُعاد محاولتها خمس مرات.',
        'يجب أن يكون APP_URL عنوانًا عامًا عبر HTTPS على المنفذ 443 أو 80 أو 88 أو 8443.',
      ],
    },
  },
  {
    slug: 'whatsapp',
    icon: 'phone',
    autoReply: false,
    guides: [{ label: 'Meta channels', href: '/docs/meta-channels/' }],
    related: ['multi-brand', 'slas-and-business-hours', 'automation-and-macros'],
    en: {
      name: 'WhatsApp',
      title: 'WhatsApp customer support, self-hosted · Helpdock',
      description:
        'Answer customers on the brand’s WhatsApp Business number through Meta’s Cloud API: setup, the 24-hour reply window, delivery states and message limits.',
      lead: 'Customers message the brand’s WhatsApp business number; each conversation becomes a ticket, and agents reply on WhatsApp inside Meta’s 24-hour window.',
      card: 'The brand’s number, through Meta’s Cloud API',
      setup: [
        'Once per install, create a Meta Business app and set HD_META_APP_ID and HD_META_APP_SECRET in .env, then restart the api and worker.',
        'In Meta’s dashboard, paste the callback URL and verify token from Settings › Channels › WhatsApp, Messenger, Instagram, subscribe the messages field and switch the app to Live mode.',
        'Register a number that is not on the consumer app, verify it, and add a payment method.',
        'Create a system-user token that never expires, with the WhatsApp messaging and management scopes.',
        'In Settings › Channels › WhatsApp, Messenger, Instagram, choose Connect account, enter the phone number id, paste the token, pick a department, press Test, then Connect.',
      ],
      supported: [
        'Text, images, video, documents, audio, voice notes, stickers, locations, shared contacts, quoted replies and reactions.',
        'Delivery states sent, delivered and read as Meta reports them, failed with Retry, and refused when the window has closed.',
        'Every reply opens with the agent’s first name and the brand.',
        'The customer’s phone is verified on WhatsApp only, and is shown with the identity it belongs to.',
        'An hourly health check of the token and subscription, with Subscribe now and Reconnect.',
      ],
      limits: [
        'A reply more than 24 hours after the customer’s last message is refused when it is written. Message templates are not built yet, so the window cannot be reopened from Helpdock.',
        'Text up to 4,096 characters; images up to 5 MiB, audio and video up to 16 MiB, other files up to 100 MiB.',
        'Six seconds between messages to the same customer.',
        'Meta charges for service messages from 1 October 2026; every part and attachment counts as a message.',
        'No AI auto-reply on WhatsApp.',
      ],
    },
    ar: {
      name: 'واتساب',
      title: 'دعم العملاء عبر واتساب على خادمك · Helpdock',
      description:
        'أجب العملاء على رقم واتساب للأعمال الخاص بعلامتك التجارية عبر واجهة Cloud API من Meta: الإعداد، ونافذة الرد البالغة 24 ساعة، وحالات التسليم، وحدود الرسائل.',
      lead: 'يراسل العملاء رقم واتساب للأعمال الخاص بالعلامة التجارية، فتصبح كل محادثة تذكرة، ويردّ الموظفون على واتساب خلال نافذة الـ24 ساعة التي تحدّدها Meta.',
      card: 'رقم العلامة التجارية عبر Cloud API من Meta',
      setup: [
        'مرة واحدة لكل تثبيت: أنشئ تطبيق أعمال في Meta، واضبط HD_META_APP_ID وHD_META_APP_SECRET في ملف ‎.env، ثم أعد تشغيل خدمتي api وworker.',
        'في لوحة Meta، الصق عنوان الاستدعاء ورمز التحقق من صفحة القنوات › Meta، واشترك في حقل messages، وحوّل التطبيق إلى الوضع المباشر.',
        'سجّل رقمًا غير مستخدم في تطبيق واتساب العادي، ووثّقه، وأضف وسيلة دفع.',
        'أنشئ رمزًا لمستخدم نظام لا تنتهي صلاحيته، بصلاحيات المراسلة والإدارة في واتساب.',
        'في القنوات › Meta، اختر «ربط حساب»، وأدخل معرّف رقم الهاتف، والصق الرمز، واختر القسم، واضغط «اختبار» ثم «ربط».',
      ],
      supported: [
        'النصوص، والصور، والفيديو، والمستندات، والصوت، والرسائل الصوتية، والملصقات، والمواقع، وجهات الاتصال المشتركة، والردود المقتبسة، والتفاعلات.',
        'حالات التسليم كما تبلّغ عنها Meta: أُرسلت، وسُلّمت، وقُرئت، وفشلت مع «إعادة المحاولة»، ومرفوضة حين تنغلق النافذة.',
        'يبدأ كل رد بالاسم الأول للموظف واسم العلامة التجارية.',
        'رقم هاتف العميل موثّق على واتساب فقط، ويظهر مع الهوية التي يتبع لها.',
        'فحص كل ساعة لصلاحية الرمز والاشتراك، مع «اشترك الآن» و«إعادة الربط».',
      ],
      limits: [
        'الرد الذي يأتي بعد أكثر من 24 ساعة من آخر رسالة للعميل يُرفض عند كتابته. وقوالب الرسائل لم تُبنَ بعد، فلا يمكن إعادة فتح النافذة من Helpdock.',
        'النص حتى 4096 حرفًا، والصور حتى 5 ميبيبايت، والصوت والفيديو حتى 16 ميبيبايت، والملفات الأخرى حتى 100 ميبيبايت.',
        'ست ثوانٍ بين الرسائل المرسلة إلى العميل نفسه.',
        'تفرض Meta رسومًا على رسائل الخدمة اعتبارًا من 1 أكتوبر 2026، وكل جزء ومرفق يُحسب رسالة.',
        'لا رد تلقائي بالذكاء الاصطناعي على واتساب.',
      ],
    },
  },
  {
    slug: 'messenger',
    icon: 'messages-square',
    autoReply: false,
    guides: [{ label: 'Meta channels', href: '/docs/meta-channels/' }],
    related: ['multi-brand', 'automation-and-macros', 'reports'],
    en: {
      name: 'Messenger',
      title: 'Facebook Messenger support for your Page · Helpdock',
      description:
        'Answer Facebook Page messages from Helpdock: setup through one Meta app, what customers can send, the reply window with the Human Agent tag, and the limits.',
      lead: 'Customers message the brand’s Facebook Page; the conversation becomes a ticket, and agents reply in Messenger.',
      card: 'The brand’s Facebook Page',
      setup: [
        'Once per install, create a Meta Business app, set its id and secret in .env and register the callback URL from Settings › Channels › WhatsApp, Messenger, Instagram.',
        'Add the Messenger product, generate a Page access token with pages_messaging and pages_manage_metadata, and subscribe the Page’s message fields.',
        'In Settings › Channels › WhatsApp, Messenger, Instagram, connect the Page with its id and token, pick a department, press Test, then Connect.',
        'Before the public can message you, Meta must approve the app in App Review.',
      ],
      supported: [
        'Text, images, video, audio, files, stickers and shared links with their title and URL; reactions and edits appear as lines in the thread.',
        'Delivery states sent, delivered and read, failed with Retry, and refused when the window has closed.',
        'Customer names, looked up once per conversation.',
        'A person’s reply between 24 hours and 7 days goes out with Meta’s Human Agent tag, when the account’s switch is on.',
      ],
      limits: [
        'The reply window is 24 hours, or 7 days for a person with the Human Agent switch on. Turning it on says Meta approved the feature; Helpdock cannot check that.',
        'Text up to 2,000 characters; any file type up to 25 MiB.',
        'Meta’s servers must be able to reach your S3 endpoint to fetch an attachment.',
        'Replies typed in Meta Business Suite are not imported, and missed webhooks are not replayed.',
        'No AI auto-reply on Messenger.',
      ],
    },
    ar: {
      name: 'ماسنجر',
      title: 'دعم العملاء عبر ماسنجر لصفحتك على فيسبوك · Helpdock',
      description:
        'أجب رسائل صفحتك على فيسبوك من Helpdock: الإعداد عبر تطبيق Meta واحد، وما يرسله العملاء، ونافذة الرد مع وسم Human Agent، والحدود.',
      lead: 'يراسل العملاء صفحة العلامة التجارية على فيسبوك، فتصبح المحادثة تذكرة، ويردّ الموظفون عبر ماسنجر.',
      card: 'صفحة العلامة التجارية على فيسبوك',
      setup: [
        'مرة واحدة لكل تثبيت: أنشئ تطبيق أعمال في Meta، واضبط معرّفه وسرّه في ‎.env، وسجّل عنوان الاستدعاء من القنوات › Meta.',
        'أضف منتج Messenger، وأنشئ رمز وصول للصفحة بصلاحيتي pages_messaging وpages_manage_metadata، واشترك في حقول رسائل الصفحة.',
        'في القنوات › Meta، اربط الصفحة بمعرّفها ورمزها، واختر القسم، واضغط «اختبار» ثم «ربط».',
        'قبل أن يتمكن الجمهور من مراسلتك، يجب أن توافق Meta على التطبيق في مراجعة التطبيقات.',
      ],
      supported: [
        'النصوص، والصور، والفيديو، والصوت، والملفات، والملصقات، والروابط المشتركة بعنوانها ورابطها، وتظهر التفاعلات والتعديلات أسطرًا في المحادثة.',
        'حالات التسليم: أُرسلت، وسُلّمت، وقُرئت، وفشلت مع «إعادة المحاولة»، ومرفوضة حين تنغلق النافذة.',
        'أسماء العملاء تُجلب مرة واحدة لكل محادثة.',
        'رد الموظف بين 24 ساعة و7 أيام يُرسل بوسم Human Agent من Meta، حين يكون مفتاحه مفعّلًا للحساب.',
      ],
      limits: [
        'نافذة الرد 24 ساعة، أو 7 أيام لرد الموظف حين يكون مفتاح Human Agent مفعّلًا. وتفعيله إقرار بأن Meta وافقت على الميزة، ولا يستطيع Helpdock التحقق من ذلك.',
        'النص حتى 2000 حرف، وأي نوع من الملفات حتى 25 ميبيبايت.',
        'يجب أن تستطيع خوادم Meta الوصول إلى نقطة S3 لديك لجلب المرفقات.',
        'الردود المكتوبة في Meta Business Suite لا تُستورد، وخطافات الويب الفائتة لا يُعاد إرسالها.',
        'لا رد تلقائي بالذكاء الاصطناعي على ماسنجر.',
      ],
    },
  },
  {
    slug: 'instagram',
    icon: 'camera',
    autoReply: false,
    guides: [{ label: 'Meta channels', href: '/docs/meta-channels/' }],
    related: ['multi-brand', 'automation-and-macros', 'reports'],
    en: {
      name: 'Instagram',
      title: 'Instagram DM support for professional accounts · Helpdock',
      description:
        'Answer Instagram direct messages to a business or creator account from Helpdock: setup, story replies and mentions, token renewal, the reply window and limits.',
      lead: 'Customers send direct messages to the brand’s Instagram professional account; each conversation becomes a ticket, and agents reply in Instagram.',
      card: 'The brand’s professional account',
      setup: [
        'Once per install, create a Meta Business app, set its id and secret (and the Instagram app secret) in .env and register the callback URL from Settings › Channels › WhatsApp, Messenger, Instagram.',
        'Add “API setup with Instagram business login”, allow messages from connected tools in the Instagram app, and generate an Instagram user token.',
        'Subscribe the messages, reactions, seen, postbacks and referral fields.',
        'In Settings › Channels › WhatsApp, Messenger, Instagram, connect the account with its id and token, pick a department, press Test, then Connect.',
      ],
      supported: [
        'Text, images, video, audio, files and stickers, story replies and story mentions with their media, shared posts and reels as links, and reactions.',
        'An unsent message is marked, not removed.',
        'The customer’s @username is shown with their Instagram identity.',
        'Helpdock renews the 60-day token once it is a week old.',
        'Delivery states sent, delivered and read, failed with Retry, and refused when the window has closed.',
      ],
      limits: [
        'Text up to 1,000 bytes of UTF-8, about 500 Arabic letters; images up to 8 MiB; audio and video up to 25 MiB; other files PDF only.',
        'An expired token cannot be refreshed: choose Reconnect.',
        'Story media is refused after 24 hours, and images arrive only with keepOriginals on.',
        'The reply window is 24 hours, or 7 days for a person with the Human Agent switch on.',
        'No AI auto-reply on Instagram.',
      ],
    },
    ar: {
      name: 'إنستغرام',
      title: 'دعم العملاء عبر رسائل إنستغرام للحسابات الاحترافية · Helpdock',
      description:
        'أجب الرسائل المباشرة على حساب إنستغرام تجاري أو لصانع محتوى من Helpdock: الإعداد، والردود على القصص والإشارات، وتجديد الرمز، ونافذة الرد، والحدود.',
      lead: 'يرسل العملاء رسائل مباشرة إلى حساب إنستغرام الاحترافي للعلامة التجارية، فتصبح كل محادثة تذكرة، ويردّ الموظفون في إنستغرام.',
      card: 'الحساب الاحترافي للعلامة التجارية',
      setup: [
        'مرة واحدة لكل تثبيت: أنشئ تطبيق أعمال في Meta، واضبط معرّفه وسرّه (وسر تطبيق إنستغرام) في ‎.env، وسجّل عنوان الاستدعاء من القنوات › Meta.',
        'أضف «إعداد الواجهة البرمجية بتسجيل دخول إنستغرام للأعمال»، واسمح بالرسائل من الأدوات المتصلة في تطبيق إنستغرام، وأنشئ رمز مستخدم إنستغرام.',
        'اشترك في حقول الرسائل والتفاعلات والمشاهدة والأزرار والإحالات.',
        'في القنوات › Meta، اربط الحساب بمعرّفه ورمزه، واختر القسم، واضغط «اختبار» ثم «ربط».',
      ],
      supported: [
        'النصوص، والصور، والفيديو، والصوت، والملفات، والملصقات، والردود على القصص والإشارات إليها مع وسائطها، والمنشورات ومقاطع ريلز المشتركة روابطَ، والتفاعلات.',
        'الرسالة التي يسحبها العميل تُعلَّم ولا تُحذف.',
        'يظهر اسم المستخدم ‎@ للعميل مع هويته على إنستغرام.',
        'يجدّد Helpdock الرمز الذي يصلح 60 يومًا حين يبلغ عمره أسبوعًا.',
        'حالات التسليم: أُرسلت، وسُلّمت، وقُرئت، وفشلت مع «إعادة المحاولة»، ومرفوضة حين تنغلق النافذة.',
      ],
      limits: [
        'النص حتى 1000 بايت بترميز UTF-8، أي نحو 500 حرف عربي، والصور حتى 8 ميبيبايت، والصوت والفيديو حتى 25 ميبيبايت، والملفات الأخرى بصيغة PDF فقط.',
        'الرمز المنتهي لا يمكن تجديده: اختر «إعادة الربط».',
        'وسائط القصص تُرفض بعد 24 ساعة، والصور لا تصل إلا مع تفعيل keepOriginals.',
        'نافذة الرد 24 ساعة، أو 7 أيام لرد الموظف حين يكون مفتاح Human Agent مفعّلًا.',
        'لا رد تلقائي بالذكاء الاصطناعي على إنستغرام.',
      ],
    },
  },
  {
    slug: 'live-chat',
    icon: 'message-circle',
    autoReply: true,
    guides: [
      { label: 'Widget protocol', href: '/docs/widget-protocol/' },
      { label: 'Realtime', href: '/docs/realtime/' },
    ],
    related: ['ai', 'help-center', 'multi-brand'],
    en: {
      name: 'Live chat widget',
      title: 'A self-hosted live chat widget for your site · Helpdock',
      description:
        'Embed Helpdock’s live chat widget with one script tag: realtime over WebSocket, signed identity, AI answers with citations, help center search and a 40 KB budget.',
      lead: 'A chat widget for the brand’s website, live over WebSocket, with the help center inside it and AI that answers from the brand’s knowledge or hands off.',
      card: 'Live over WebSocket, signed identity',
      setup: [
        'In Settings › Channels › Chat widget, copy the widget’s embed tag: one module script with the brand’s id.',
        'Add the sites it may run on to the brand’s allowed origins.',
        'Choose its theme, mode, pre-chat form, content policy and greeting.',
        'Optionally turn on a bot check: the built-in proof-of-work check, Turnstile or hCaptcha.',
        'Optionally turn on signed identity, so signed-in users are recognised: your server signs their id with the brand’s secret.',
      ],
      supported: [
        'Four modes: chat only, chat with suggested articles, help center only, or a contact form.',
        'Typing indicators, read receipts, queue position, team hours and a transcript by email.',
        'Attachments under the brand’s content policy.',
        'AI answers with citations, “Was this helpful?”, and a Talk to a human button.',
        'A satisfaction card from 1 to 5 with an optional comment.',
        'English and Arabic, laid out right to left in Arabic.',
        'A documented REST and Socket.IO protocol, so native apps can speak it too.',
      ],
      limits: [
        'The first script is held to 40 KB gzipped and each lazy chunk to 20 KB, checked on every pull request.',
        'A request without an Origin header is refused; native apps send one themselves.',
        'Never sign identity in the browser: an invalid signature leaves the visitor anonymous.',
        'Messages up to 10,000 characters, 30 writes a minute and 120 socket events a minute per visitor.',
        'If the socket fails three times, the widget falls back to server-sent events.',
      ],
    },
    ar: {
      name: 'نافذة الدردشة المباشرة',
      title: 'نافذة دردشة مباشرة لموقعك تستضيفها بنفسك · Helpdock',
      description:
        'ضمّن نافذة الدردشة المباشرة من Helpdock بوسم سكربت واحد: تواصل لحظي عبر WebSocket، وهوية موقّعة، وإجابات ذكاء اصطناعي مع المصادر، وبحث في مركز المساعدة، وحجم لا يتجاوز 40 كيلوبايت.',
      lead: 'نافذة دردشة لموقع العلامة التجارية، لحظية عبر WebSocket، وفيها مركز المساعدة، وذكاء اصطناعي يجيب من معرفة العلامة التجارية أو يحوّل المحادثة إلى موظف.',
      card: 'لحظية عبر WebSocket، مع هوية موقّعة',
      setup: [
        'في الإعدادات › القنوات، انسخ وسم تضمين النافذة: سكربت واحد بمعرّف العلامة التجارية.',
        'أضف المواقع التي يُسمح لها بتشغيلها إلى قائمة المصادر المسموح بها للعلامة التجارية.',
        'اختر مظهرها ووضعها ونموذج ما قبل الدردشة وسياسة المحتوى ورسالة الترحيب.',
        'يمكنك تفعيل فحص للبوتات: الفحص المدمج القائم على إثبات العمل، أو Turnstile، أو hCaptcha.',
        'يمكنك تفعيل الهوية الموقّعة ليتعرّف النظام على المستخدمين المسجّلين: يوقّع خادمك معرّفاتهم بسر العلامة التجارية.',
      ],
      supported: [
        'أربعة أوضاع: دردشة فقط، أو دردشة مع مقالات مقترحة، أو مركز المساعدة فقط، أو نموذج تواصل.',
        'مؤشر الكتابة، وإشعارات القراءة، والموقع في الطابور، وساعات عمل الفريق، ونسخة من المحادثة عبر البريد.',
        'المرفقات وفق سياسة المحتوى للعلامة التجارية.',
        'إجابات الذكاء الاصطناعي مع المصادر، وسؤال «هل كان هذا مفيدًا؟»، وزر للتحدث إلى موظف.',
        'بطاقة رضا من 1 إلى 5 مع تعليق اختياري.',
        'العربية والإنجليزية، بتخطيط من اليمين إلى اليسار في العربية.',
        'بروتوكول REST وSocket.IO موثّق، لتستخدمه التطبيقات الأصلية أيضًا.',
      ],
      limits: [
        'السكربت الأول محدود بـ40 كيلوبايت مضغوطًا، وكل جزء يُحمّل لاحقًا بـ20 كيلوبايت، ويُفحص ذلك في كل طلب دمج.',
        'الطلب الذي لا يحمل ترويسة Origin مرفوض، والتطبيقات الأصلية ترسلها بنفسها.',
        'لا توقّع الهوية في المتصفح أبدًا: التوقيع غير الصالح يُبقي الزائر مجهولًا.',
        'الرسائل حتى 10000 حرف، و30 عملية كتابة و120 حدثًا عبر المقبس في الدقيقة لكل زائر.',
        'إذا فشل المقبس ثلاث مرات، تنتقل النافذة إلى الأحداث المرسلة من الخادم.',
      ],
    },
  },
  {
    slug: 'web-form',
    icon: 'file-text',
    autoReply: false,
    guides: [{ label: 'Web form', href: '/docs/web-form/' }],
    related: ['help-center', 'automation-and-macros', 'slas-and-business-hours'],
    en: {
      name: 'Web form',
      title: 'A hosted contact form that opens tickets · Helpdock',
      description:
        'A contact page per brand on the help center domain that opens a ticket for every submission, works without JavaScript, and answers by email.',
      lead: 'A hosted contact page for each brand. Every submission opens a ticket, and agents’ replies go to the customer by email.',
      card: 'Hosted on the help center domain',
      setup: [
        'In Settings › Channels › Web form, turn the form on. It is off by default, and the page says it is closed until then.',
        'Choose the fields: the built-in ones and any ticket custom fields, in order, shown or required. Email and message are always there.',
        'Pick the department it opens tickets in, and write a thank-you message per language.',
        'Choose a bot check on the Widget tab: the built-in check, Turnstile or hCaptcha.',
        'Share https://<help center domain>/contact, or the fallback address under APP_URL.',
      ],
      supported: [
        'Plain HTML that works with JavaScript off; only the built-in bot check needs script.',
        'Custom fields validated by type.',
        'Image and file attachments under the brand’s content policy.',
        'A “Still need help?” link from an article carries it to the form.',
        'The acknowledgment auto-reply by email, if the brand turns it on.',
      ],
      limits: [
        'At most five files, and 30 MB for the whole request.',
        'Ten passing submissions per IP address per brand every 15 minutes, and five per typed email address an hour.',
        'The typed email is a claim, never verified. If another contact already has it, replies are not emailed until an agent merges the two.',
        'Voice and video attachments are for the widget only.',
      ],
    },
    ar: {
      name: 'نموذج الويب',
      title: 'نموذج تواصل مستضاف يفتح التذاكر · Helpdock',
      description:
        'صفحة تواصل لكل علامة تجارية على نطاق مركز المساعدة، تفتح تذكرة لكل إرسال، وتعمل دون JavaScript، وتصل الردود عليها بالبريد.',
      lead: 'صفحة تواصل مستضافة لكل علامة تجارية. كل إرسال يفتح تذكرة، وتصل ردود الموظفين إلى العميل بالبريد.',
      card: 'مستضاف على نطاق مركز المساعدة',
      setup: [
        'في الإعدادات › القنوات › نموذج الويب، فعّل النموذج. وهو معطّل افتراضيًا، وتقول الصفحة إنه مغلق حتى تفعّله.',
        'اختر الحقول: المدمجة وأي حقول مخصّصة للتذاكر، بترتيبها، ظاهرة أو مطلوبة. والبريد والرسالة موجودان دائمًا.',
        'اختر القسم الذي تُفتح فيه التذاكر، واكتب رسالة شكر لكل لغة.',
        'اختر فحص البوتات من تبويب نافذة الدردشة: الفحص المدمج أو Turnstile أو hCaptcha.',
        'شارك العنوان ‎https://<نطاق مركز المساعدة>/contact أو العنوان البديل تحت APP_URL.',
      ],
      supported: [
        'HTML عادي يعمل حتى مع تعطيل JavaScript، والفحص المدمج للبوتات وحده يحتاج إلى سكربت.',
        'الحقول المخصّصة يُتحقق منها حسب نوعها.',
        'مرفقات الصور والملفات وفق سياسة المحتوى للعلامة التجارية.',
        'رابط «ما زلت تحتاج إلى مساعدة؟» في المقالة ينقل سياقها إلى النموذج.',
        'الرد التلقائي بالاستلام عبر البريد، إن فعّلته العلامة التجارية.',
      ],
      limits: [
        'خمسة ملفات على الأكثر، و30 ميغابايت للطلب كله.',
        'عشرة إرسالات ناجحة لكل عنوان IP لكل علامة تجارية كل 15 دقيقة، وخمسة لكل بريد مكتوب في الساعة.',
        'البريد المكتوب ادعاء لا يُتحقق منه أبدًا. وإذا كان لجهة اتصال أخرى، لا تُرسل الردود بالبريد حتى يدمج الموظف بين الجهتين.',
        'مرفقات الصوت والفيديو خاصة بنافذة الدردشة.',
      ],
    },
  },
  {
    slug: 'api',
    icon: 'code',
    autoReply: false,
    guides: [
      { label: 'Public REST API', href: '/docs/api/' },
      { label: 'Webhooks', href: '/docs/webhooks/' },
    ],
    related: ['api-and-webhooks', 'multi-brand', 'security'],
    en: {
      name: 'REST API',
      title: 'A REST API channel for tickets and contacts · Helpdock',
      description:
        'File tickets from a CRM, an order system or a script through Helpdock’s REST API, with scoped keys, an OpenAPI 3.1 document, idempotency and signed webhooks.',
      lead: 'Tickets filed by an integration (a CRM, an order system, a script) through the brand’s REST API get the same routing, SLAs and rules as any other channel.',
      card: 'POST /api/v1/tickets with a scoped key',
      setup: [
        'In Settings › Developers › API keys, create a key with a name, at least one scope and a rate limit. It is shown once.',
        'Call the API with Authorization: Bearer and the key.',
        'Read the reference at <APP_URL>/api/docs, or fetch the OpenAPI 3.1 document beside it.',
        'Add a webhook endpoint for the events you want back, and press Send test event.',
      ],
      supported: [
        'Tickets and their messages, contacts, help center articles and webhook endpoints.',
        'Six scopes: read and write for tickets and contacts, read for articles, and manage for webhooks.',
        'Cursor pagination, and an Idempotency-Key kept for 24 hours that replays a repeated request.',
        'Contacts upserted by external id or identifiers; a conflict answers 409 and never merges.',
        'Webhooks signed with HMAC-SHA256, retried eight times over about an hour, with a 30-day delivery log and replay.',
      ],
      limits: [
        'A key reaches every department of its brand and no other brand, and cannot call admin routes.',
        'A public message sent through the API is not emailed to the customer.',
        '600 requests a minute per key by default, up to 10,000.',
        'An API key cannot file WhatsApp, Messenger or Instagram tickets, and bulk changes are not in API v1.',
      ],
    },
    ar: {
      name: 'الواجهة البرمجية REST',
      title: 'قناة REST API للتذاكر وجهات الاتصال · Helpdock',
      description:
        'افتح التذاكر من نظام إدارة العملاء أو نظام الطلبات أو سكربت عبر واجهة Helpdock البرمجية، بمفاتيح محدودة الصلاحيات، ووثيقة OpenAPI 3.1، ومنع التكرار، وخطافات ويب موقّعة.',
      lead: 'التذاكر التي يفتحها تكامل (نظام لإدارة العملاء، أو للطلبات، أو سكربت) عبر الواجهة البرمجية للعلامة التجارية تمرّ بالتوجيه واتفاقيات مستوى الخدمة والقواعد نفسها كأي قناة أخرى.',
      card: 'POST /api/v1/tickets بمفتاح محدود الصلاحيات',
      setup: [
        'في الإعدادات › المطوّرون › مفاتيح الواجهة البرمجية، أنشئ مفتاحًا باسم وصلاحية واحدة على الأقل وحد للطلبات. يظهر المفتاح مرة واحدة.',
        'استدعِ الواجهة البرمجية بترويسة Authorization: Bearer والمفتاح.',
        'اقرأ المرجع على ‎<APP_URL>/api/docs، أو حمّل وثيقة OpenAPI 3.1 بجانبه.',
        'أضف نقطة خطاف ويب للأحداث التي تريد أن تصلك، واضغط «إرسال حدث تجريبي».',
      ],
      supported: [
        'التذاكر ورسائلها، وجهات الاتصال، ومقالات مركز المساعدة، ونقاط خطافات الويب.',
        'ست صلاحيات: القراءة والكتابة للتذاكر وجهات الاتصال، والقراءة للمقالات، وإدارة خطافات الويب.',
        'ترقيم الصفحات بالمؤشر، وترويسة Idempotency-Key تُحفظ 24 ساعة وتعيد نتيجة الطلب المكرّر.',
        'إضافة جهات الاتصال أو تحديثها بالمعرّف الخارجي أو المعرّفات، والتعارض يعيد 409 ولا يدمج أبدًا.',
        'خطافات ويب موقّعة بـHMAC-SHA256، تُعاد محاولتها ثماني مرات خلال نحو ساعة، مع سجل تسليم لمدة 30 يومًا وإعادة إرسال.',
      ],
      limits: [
        'المفتاح يصل إلى كل أقسام علامته التجارية ولا يصل إلى غيرها، ولا يستطيع استدعاء مسارات الإدارة.',
        'الرسالة العامة المرسلة عبر الواجهة البرمجية لا تُرسل إلى العميل بالبريد.',
        '600 طلب في الدقيقة لكل مفتاح افتراضيًا، وحتى 10000.',
        'لا يستطيع مفتاح الواجهة البرمجية فتح تذاكر واتساب أو ماسنجر أو إنستغرام، والتعديلات الجماعية ليست في الإصدار الأول من الواجهة.',
      ],
    },
  },
];

export const channel = (slug: string) => CHANNELS.find((item) => item.slug === slug);

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Translate } from '../i18n/translator.js';
import type { CaptchaConfig } from '../transport/types.js';
import { useWidget, useWidgetState } from '../ui/context.js';
import { Icon } from '../ui/icons.js';
import { refreshAfter, solvePow } from './pow.js';

/**
 * The CAPTCHA box above Start chat and Send message (ADR 0003). The provider
 * script is fetched at runtime and never bundled, and a script that does not
 * load fails visibly instead of leaving the button waiting.
 */
interface ProviderApi {
  render(element: HTMLElement, options: Record<string, unknown>): string | number;
}

type ProviderName = Exclude<CaptchaConfig['provider'], 'pow'>;

const SCRIPTS: Record<ProviderName, { url: string; global: string }> = {
  turnstile: {
    url: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    global: 'turnstile',
  },
  hcaptcha: { url: 'https://js.hcaptcha.com/1/api.js?render=explicit', global: 'hcaptcha' },
};

const LOAD_TIMEOUT_MS = 15_000;
const loading = new Map<string, Promise<ProviderApi>>();

function loadProvider(provider: ProviderName): Promise<ProviderApi> {
  const { url, global } = SCRIPTS[provider];
  const lookup = () => (window as unknown as Record<string, ProviderApi | undefined>)[global];

  const existing = loading.get(provider);
  if (existing) {
    return existing;
  }
  const promise = new Promise<ProviderApi>((resolve, reject) => {
    const ready = lookup();
    if (ready) {
      resolve(ready);
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    const timer = setTimeout(() => reject(new Error('captcha timeout')), LOAD_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      const api = lookup();
      api ? resolve(api) : reject(new Error('captcha api missing'));
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('captcha script failed'));
    };
    document.head.append(script);
  });
  loading.set(provider, promise);
  promise.catch(() => loading.delete(provider));
  return promise;
}

type Status = 'checking' | 'verified' | 'failed';

interface CaptchaProps {
  config: CaptchaConfig;
  onToken: (token: string | null) => void;
  t: Translate;
}

export default function Captcha({ config, onToken, t }: CaptchaProps) {
  return config.provider === 'pow' ? (
    <PowCheck onToken={onToken} t={t} />
  ) : (
    <ProviderCheck config={{ ...config, provider: config.provider }} onToken={onToken} t={t} />
  );
}

/**
 * The built-in check (ADR 0052, artboard `Widget/PreChat-Verify`): no puzzle
 * and nothing to click. It starts when the form opens, so it is usually done
 * before the visitor finishes typing, and fetches new work a minute before the
 * old work lapses. A failure never blames the visitor and offers Try again.
 */
function PowCheck({ onToken, t }: Omit<CaptchaProps, 'config'>) {
  const { controller } = useWidget();
  const [status, setStatus] = useState<Status>('checking');
  const [round, setRound] = useState(0);

  // `round` is the trigger for new work: Try again, and a challenge about to lapse.
  useEffect(() => {
    let live = true;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    setStatus('checking');
    onToken(null);
    controller.transport
      .captchaChallenge()
      .then(async (work) => {
        const token = await solvePow(work);
        if (!live) {
          return;
        }
        setStatus('verified');
        onToken(token);
        const after = refreshAfter(work);
        if (after !== null) {
          refresh = setTimeout(() => setRound((value) => value + 1), after);
        }
      })
      .catch(() => live && setStatus('failed'));
    return () => {
      live = false;
      clearTimeout(refresh);
    };
  }, [controller, onToken, round]);

  return (
    <fieldset class={`hd-captcha hd-pow hd-pow-${status}`}>
      <legend class="hd-visually-hidden">{t('captcha.group')}</legend>
      <div class="hd-pow-row">
        <span class="hd-pow-icon">
          <Icon
            name={status === 'verified' ? 'shieldCheck' : status === 'failed' ? 'alert' : 'loader'}
            size={20}
          />
        </span>
        <span class="hd-pow-text" role={status === 'failed' ? 'alert' : 'status'}>
          {t(`captcha.pow.${status}`)}
        </span>
        {status === 'failed' ? (
          <button
            type="button"
            class="hd-button hd-button-secondary hd-pow-retry"
            onClick={() => setRound((value) => value + 1)}
          >
            <Icon name="retry" size={16} />
            {t('captcha.pow.retry')}
          </button>
        ) : (
          <span class="hd-pow-caption">{t('captcha.pow.builtIn')}</span>
        )}
      </div>
    </fieldset>
  );
}

function ProviderCheck({
  config,
  onToken,
  t,
}: CaptchaProps & { config: CaptchaConfig & { provider: ProviderName } }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('checking');
  const brandId = useWidgetState().config?.brand.id ?? '';

  useEffect(() => {
    let live = true;
    loadProvider(config.provider).then(
      (api) => {
        if (!live || !host.current) {
          return;
        }
        api.render(host.current, {
          sitekey: config.site_key,
          // The surface and brand the api checks Turnstile's answer against
          // (M18-11); hCaptcha has neither and is sent neither.
          ...(config.provider === 'turnstile'
            ? { action: 'widget-first-message', cData: brandId }
            : {}),
          callback: (token: string) => {
            setStatus('verified');
            onToken(token);
          },
          'error-callback': () => {
            setStatus('failed');
            onToken(null);
          },
          'expired-callback': () => {
            setStatus('checking');
            onToken(null);
          },
        });
      },
      () => live && setStatus('failed'),
    );
    return () => {
      live = false;
    };
  }, [config.provider, config.site_key, brandId, onToken]);

  return (
    <fieldset class="hd-captcha">
      <legend class="hd-visually-hidden">{t('captcha.group')}</legend>
      <div ref={host} />
      <p
        class={`hd-captcha-status hd-captcha-${status}`}
        role={status === 'failed' ? 'alert' : undefined}
      >
        {status === 'verified' ? (
          <Icon name="shieldCheck" />
        ) : status === 'failed' ? (
          <Icon name="alert" />
        ) : null}
        {t(`captcha.${status}`)}
      </p>
    </fieldset>
  );
}

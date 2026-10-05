import type { AiApi } from '../../ai/api.js';
import { HttpAiApi } from '../../ai/http-api.js';
import { HttpTransport } from '../../auth/http-transport.js';

/**
 * What the wizard's AI step (M7-10, `Admin/Wizard-AI`) talks to.
 *
 * Not a wizard endpoint: by this step the admin is signed in — step 2 set the
 * refresh cookie — and is an install admin, so the step uses the ordinary
 * install AI routes, with every check they make. `signIn` turns that cookie
 * into an access token first, because a transport holding none does not
 * refresh on a 401.
 */
export interface SetupAi {
  readonly api: Pick<AiApi, 'saveProvider' | 'models' | 'setDefaultModel'>;
  signIn(): Promise<void>;
}

export const httpSetupAi = (): SetupAi => {
  const transport = new HttpTransport();
  return {
    api: new HttpAiApi(transport),
    signIn: async () => {
      await transport.currentAccessToken();
    },
  };
};

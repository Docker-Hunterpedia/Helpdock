/**
 * The lazy chunks of D §14. Each loader is a module-level constant so a hook
 * that depends on it does not re-run on every render.
 */
export const loadCaptcha = () => import('../captcha/Captcha.js').then((module) => module.default);
export const loadRecorder = () => import('../voice/Recorder.js').then((module) => module.default);
export const loadHelpCenter = () =>
  import('../help/HelpCenter.js').then((module) => module.default);
export const loadArticle = () => import('../help/ArticleView.js').then((module) => module.default);

/**
 * Sends the browser to a provider's consent page (Notion, Google). Its own
 * module so the unit tests can replace it: jsdom cannot navigate.
 */
export const leaveTo = (url: string): void => {
  globalThis.location.assign(url);
};

/**
 * "The customer can always type 'talk to a human'" (REQUIREMENTS §4.7). The
 * widget has a button for it; Telegram and email have only words, so a
 * message that asks for a person hands off without asking the model
 * anything, in English or Arabic.
 *
 * Deliberately narrow: "can I speak to someone about my refund" is a request
 * for a person, "the agent said my refund was issued" is not. A request the
 * patterns miss still reaches a person the moment the model is unsure.
 */

const PERSON_EN =
  '(?:an?\\s+|the\\s+)?(?:human|person|real\\s+person|agent|someone|somebody|representative|staff|support\\s+team|team)';

const ENGLISH = [
  new RegExp(`\\b(?:talk|speak|chat)(?:ing)?\\s+(?:to|with)\\s+${PERSON_EN}\\b`, 'i'),
  new RegExp(
    `\\b(?:connect|transfer|put)\\s+me\\s+(?:to|through\\s+to|with)\\s+${PERSON_EN}\\b`,
    'i',
  ),
  /\b(?:i\s+)?(?:want|need|would\s+like)\s+(?:a\s+)?(?:human|real\s+person|live\s+agent)\b/i,
  /^\s*(?:human|agent|real\s+person|live\s+agent|operator|representative)(?:\s+please)?\s*[.!?]*\s*$/i,
];

const ARABIC = [
  /(?:أريد|اريد|أبغى|ابغى|بدي|أحتاج|احتاج)\s+(?:موظف|شخص|إنسان|انسان)/u,
  /(?:أ?تحدث|أتكلم|اتكلم|أكلم|اكلم|التحدث|التكلم|الكلام|تواصل|التواصل|كلمني|حولني|حوّلني)\s+(?:(?:مع|إلى|الى|ل)\s*)?(?:أحد\s+)?(?:شخص|موظف|إنسان|انسان|بشر|بشري|أحد|فريق|خدمة\s+العملاء|الدعم)/u,
  /^\s*(?:موظف|إنسان|انسان|شخص\s+حقيقي|خدمة\s+العملاء)(?:\s+(?:لو\s+سمحت|من\s+فضلك))?\s*[.!؟?]*\s*$/u,
];

export const asksForHuman = (text: string): boolean =>
  [...ENGLISH, ...ARABIC].some((pattern) => pattern.test(text));

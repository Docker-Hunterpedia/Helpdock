const LATIN_ZERO = 0x30;
const ARABIC_INDIC_ZERO = 0x660;
const EASTERN_ARABIC_ZERO = 0x6f0;

/**
 * Whether what was typed is the count: Latin, Arabic-Indic or Eastern Arabic
 * digits, with or without separators ("1,284", "1٬284", "١٢٨٤").
 */
export const typedCountMatches = (typed: string, count: number): boolean => {
  const latin = typed.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const zero = code >= EASTERN_ARABIC_ZERO ? EASTERN_ARABIC_ZERO : ARABIC_INDIC_ZERO;
    return String.fromCharCode(LATIN_ZERO + code - zero);
  });

  return latin.replace(/\D/g, '') === String(count);
};

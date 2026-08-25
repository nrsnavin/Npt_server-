import { env } from '../config/env.js';

/**
 * Normalises a phone number to E.164 (+919876543210).
 * Accepts local numbers, 0-prefixed numbers and numbers already carrying a country code,
 * falling back to DEFAULT_COUNTRY_CODE for bare local numbers.
 * Returns null when the input cannot be a valid number.
 */
export function normalisePhone(input) {
  if (!input) return null;

  const raw = String(input).trim();
  const hadPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (!hadPlus) {
    // 09876543210 and 9876543210 are both local forms of the same number.
    digits = digits.replace(/^0+/, '');
    const countryCode = env.defaultCountryCode.replace(/\D/g, '');
    if (!digits.startsWith(countryCode) || digits.length <= countryCode.length) {
      digits = `${countryCode}${digits}`;
    }
  }

  // E.164 allows at most 15 digits, and no real number is shorter than 8.
  if (digits.length < 8 || digits.length > 15) return null;

  return `+${digits}`;
}

/** True when the string looks like an email rather than a phone number. */
export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

/** Masks an identifier for safe display: na***@example.com, +9198***3210. */
export function maskIdentifier(identifier) {
  const value = String(identifier || '');

  if (isEmail(value)) {
    const [local, domain] = value.split('@');
    const visible = local.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
  }

  if (value.length <= 6) return value;
  return `${value.slice(0, 5)}${'*'.repeat(value.length - 9)}${value.slice(-4)}`;
}

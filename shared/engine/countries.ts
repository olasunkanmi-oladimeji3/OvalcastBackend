// Every country Ovalcast knows about: how phone numbers look, the currency,
// the time zone, how seasons are named, and what Flutterwave can do there.
// Anyone anywhere can score, run a league, stream and follow. Collecting money
// online needs Flutterwave in that country; elsewhere fans and clubs pay by
// card in US dollars, and leagues record entry fees they collect themselves.
// The app, the website and the server all read this one list.

export const CURRENCY_CODES = ['NGN', 'GHS', 'SLE', 'GMD', 'KES', 'UGX', 'TZS', 'RWF', 'ZAR', 'ZMW', 'MWK', 'XAF', 'XOF', 'GBP', 'EUR', 'USD'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export type PaymentMethod = 'card' | 'bankTransfer' | 'ussd' | 'mobileMoney';

export interface CurrencyInfo {
  symbol: string;
  name: string;
  /**
   * Units per US dollar, for turning Ovalcast's reference prices into sensible
   * local ones (a pass floor, a payout minimum). Reviewed each quarter; it never
   * converts a real payment, which Flutterwave does at its own rate.
   */
  perUsd: number;
}

export const CURRENCIES: Record<CurrencyCode, CurrencyInfo> = {
  NGN: { symbol: '₦', name: 'naira', perUsd: 1500 },
  GHS: { symbol: 'GH₵', name: 'cedi', perUsd: 12 },
  SLE: { symbol: 'Le ', name: 'leone', perUsd: 23 },
  GMD: { symbol: 'D', name: 'dalasi', perUsd: 72 },
  KES: { symbol: 'KSh ', name: 'shilling', perUsd: 129 },
  UGX: { symbol: 'USh ', name: 'shilling', perUsd: 3600 },
  TZS: { symbol: 'TSh ', name: 'shilling', perUsd: 2500 },
  RWF: { symbol: 'FRw ', name: 'franc', perUsd: 1450 },
  ZAR: { symbol: 'R', name: 'rand', perUsd: 17.5 },
  ZMW: { symbol: 'K', name: 'kwacha', perUsd: 25 },
  MWK: { symbol: 'MK', name: 'kwacha', perUsd: 1750 },
  XAF: { symbol: 'FCFA ', name: 'franc', perUsd: 570 },
  XOF: { symbol: 'CFA ', name: 'franc', perUsd: 570 },
  GBP: { symbol: '£', name: 'pound', perUsd: 0.76 },
  EUR: { symbol: '€', name: 'euro', perUsd: 0.88 },
  USD: { symbol: '$', name: 'dollar', perUsd: 1 },
};

export interface CountryInfo {
  /** ISO 3166 code. */
  code: string;
  name: string;
  /** Calling code without the plus. */
  dial: string;
  /** Digits in a national number after the calling code: shortest and longest. */
  digits: [number, number];
  /** A local number, as people write it. */
  example: string;
  currency: CurrencyCode;
  timeZone: string;
  /** "2026/27" where the season crosses the new year; "2027" where it is played in one summer. */
  season: 'split' | 'calendar';
  /** Ways to pay through Flutterwave in this country. Card-only countries pay in US dollars. */
  methods: PaymentMethod[];
  /** Flutterwave's fee on local payments, and on local cards where it differs. VAT on the fee where it applies. */
  fees: { local: number; card?: number; vatOnFee?: number };
  /** Leagues can be paid out here: entry fees settle straight to their bank or wallet. */
  payouts: boolean;
  /** The national cricket body, for placeholders and certificates. */
  cricketBody?: string;
  /** The data protection law Ovalcast follows for people here. */
  dataLaw?: string;
}

const AFRICA_MOMO = { local: 0.029, card: 0.038 };

export const COUNTRY_LIST: CountryInfo[] = [
  // Flutterwave collects and pays out locally.
  { code: 'NG', name: 'Nigeria', dial: '234', digits: [10, 10], example: '0802 555 0199', currency: 'NGN', timeZone: 'Africa/Lagos', season: 'split', methods: ['bankTransfer', 'card', 'ussd'], fees: { local: 0.02, vatOnFee: 0.075 }, payouts: true, cricketBody: 'Nigeria Cricket Federation', dataLaw: 'Nigeria Data Protection Act 2023' },
  { code: 'GH', name: 'Ghana', dial: '233', digits: [9, 9], example: '024 555 0144', currency: 'GHS', timeZone: 'Africa/Accra', season: 'split', methods: ['mobileMoney', 'card'], fees: { local: 0.02, card: 0.026 }, payouts: true, cricketBody: 'Ghana Cricket Association', dataLaw: 'Data Protection Act 2012' },
  { code: 'SL', name: 'Sierra Leone', dial: '232', digits: [8, 8], example: '076 555 014', currency: 'SLE', timeZone: 'Africa/Freetown', season: 'split', methods: ['mobileMoney', 'card'], fees: { local: 0.02 }, payouts: true, cricketBody: 'Sierra Leone Cricket Association' },
  { code: 'GM', name: 'Gambia', dial: '220', digits: [7, 7], example: '355 0144', currency: 'GMD', timeZone: 'Africa/Banjul', season: 'split', methods: ['mobileMoney', 'card'], fees: { local: 0.02 }, payouts: true, cricketBody: 'Gambia Cricket Association' },
  { code: 'KE', name: 'Kenya', dial: '254', digits: [9, 9], example: '0712 555 014', currency: 'KES', timeZone: 'Africa/Nairobi', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true, cricketBody: 'Cricket Kenya', dataLaw: 'Data Protection Act 2019' },
  { code: 'UG', name: 'Uganda', dial: '256', digits: [9, 9], example: '0772 555 014', currency: 'UGX', timeZone: 'Africa/Kampala', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true, cricketBody: 'Uganda Cricket Association', dataLaw: 'Data Protection and Privacy Act 2019' },
  { code: 'TZ', name: 'Tanzania', dial: '255', digits: [9, 9], example: '0754 555 014', currency: 'TZS', timeZone: 'Africa/Dar_es_Salaam', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true, cricketBody: 'Tanzania Cricket Association', dataLaw: 'Personal Data Protection Act 2022' },
  { code: 'RW', name: 'Rwanda', dial: '250', digits: [9, 9], example: '0788 555 014', currency: 'RWF', timeZone: 'Africa/Kigali', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true, cricketBody: 'Rwanda Cricket Association', dataLaw: 'Law No. 058/2021 on personal data' },
  { code: 'ZA', name: 'South Africa', dial: '27', digits: [9, 9], example: '082 555 0144', currency: 'ZAR', timeZone: 'Africa/Johannesburg', season: 'split', methods: ['card', 'bankTransfer'], fees: { local: 0.029, card: 0.032 }, payouts: true, cricketBody: 'Cricket South Africa', dataLaw: 'Protection of Personal Information Act (POPIA)' },
  { code: 'ZM', name: 'Zambia', dial: '260', digits: [9, 9], example: '0977 555 014', currency: 'ZMW', timeZone: 'Africa/Lusaka', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true, cricketBody: 'Zambia Cricket Union', dataLaw: 'Data Protection Act 2021' },
  { code: 'MW', name: 'Malawi', dial: '265', digits: [9, 9], example: '0999 555 014', currency: 'MWK', timeZone: 'Africa/Blantyre', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true, cricketBody: 'Cricket Malawi' },
  { code: 'CM', name: 'Cameroon', dial: '237', digits: [9, 9], example: '6 75 55 50 14', currency: 'XAF', timeZone: 'Africa/Douala', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true },
  { code: 'CI', name: "Côte d'Ivoire", dial: '225', digits: [10, 10], example: '07 55 55 01 44', currency: 'XOF', timeZone: 'Africa/Abidjan', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true },
  { code: 'SN', name: 'Senegal', dial: '221', digits: [9, 9], example: '77 555 01 44', currency: 'XOF', timeZone: 'Africa/Dakar', season: 'split', methods: ['mobileMoney', 'card'], fees: AFRICA_MOMO, payouts: true },
  // Flutterwave takes cards in the local currency; leagues record fees they collect themselves.
  { code: 'GB', name: 'United Kingdom', dial: '44', digits: [10, 10], example: '07700 900123', currency: 'GBP', timeZone: 'Europe/London', season: 'calendar', methods: ['card'], fees: { local: 0.038 }, payouts: false, cricketBody: 'England and Wales Cricket Board', dataLaw: 'UK GDPR and the Data Protection Act 2018' },
  { code: 'IE', name: 'Ireland', dial: '353', digits: [9, 9], example: '085 555 0144', currency: 'EUR', timeZone: 'Europe/Dublin', season: 'calendar', methods: ['card'], fees: { local: 0.038 }, payouts: false, cricketBody: 'Cricket Ireland', dataLaw: 'GDPR' },
  { code: 'NL', name: 'Netherlands', dial: '31', digits: [9, 9], example: '06 12345678', currency: 'EUR', timeZone: 'Europe/Amsterdam', season: 'calendar', methods: ['card'], fees: { local: 0.038 }, payouts: false, cricketBody: 'KNCB', dataLaw: 'GDPR' },
  { code: 'US', name: 'United States', dial: '1', digits: [10, 10], example: '(201) 555-0123', currency: 'USD', timeZone: 'America/New_York', season: 'calendar', methods: ['card'], fees: { local: 0.038 }, payouts: false, cricketBody: 'USA Cricket' },
  // Card payments in US dollars; everything else works the same.
  { code: 'CA', name: 'Canada', dial: '1', digits: [10, 10], example: '(416) 555-0123', currency: 'USD', timeZone: 'America/Toronto', season: 'calendar', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Cricket Canada' },
  { code: 'IN', name: 'India', dial: '91', digits: [10, 10], example: '98765 43210', currency: 'USD', timeZone: 'Asia/Kolkata', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, dataLaw: 'Digital Personal Data Protection Act 2023' },
  { code: 'PK', name: 'Pakistan', dial: '92', digits: [10, 10], example: '0301 2345678', currency: 'USD', timeZone: 'Asia/Karachi', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Pakistan Cricket Board' },
  { code: 'BD', name: 'Bangladesh', dial: '880', digits: [10, 10], example: '01712 345678', currency: 'USD', timeZone: 'Asia/Dhaka', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Bangladesh Cricket Board' },
  { code: 'LK', name: 'Sri Lanka', dial: '94', digits: [9, 9], example: '071 234 5678', currency: 'USD', timeZone: 'Asia/Colombo', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Sri Lanka Cricket' },
  { code: 'NP', name: 'Nepal', dial: '977', digits: [10, 10], example: '984 1234567', currency: 'USD', timeZone: 'Asia/Kathmandu', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Cricket Association of Nepal' },
  { code: 'AE', name: 'United Arab Emirates', dial: '971', digits: [9, 9], example: '050 123 4567', currency: 'USD', timeZone: 'Asia/Dubai', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Emirates Cricket Board' },
  { code: 'AU', name: 'Australia', dial: '61', digits: [9, 9], example: '0412 345 678', currency: 'USD', timeZone: 'Australia/Sydney', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Cricket Australia', dataLaw: 'Privacy Act 1988' },
  { code: 'NZ', name: 'New Zealand', dial: '64', digits: [8, 10], example: '021 123 4567', currency: 'USD', timeZone: 'Pacific/Auckland', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'New Zealand Cricket', dataLaw: 'Privacy Act 2020' },
  { code: 'ZW', name: 'Zimbabwe', dial: '263', digits: [9, 9], example: '077 123 4567', currency: 'USD', timeZone: 'Africa/Harare', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Zimbabwe Cricket' },
  { code: 'NA', name: 'Namibia', dial: '264', digits: [8, 9], example: '081 123 4567', currency: 'USD', timeZone: 'Africa/Windhoek', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Cricket Namibia' },
  { code: 'BW', name: 'Botswana', dial: '267', digits: [7, 8], example: '71 234 567', currency: 'USD', timeZone: 'Africa/Gaborone', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false, cricketBody: 'Botswana Cricket Association' },
];

/** Anywhere not on the list: cards in US dollars, any phone number typed with its +code. */
export const OTHER_COUNTRY: CountryInfo = { code: 'XX', name: 'Another country', dial: '', digits: [6, 14], example: '+ country code and number', currency: 'USD', timeZone: 'UTC', season: 'split', methods: ['card'], fees: { local: 0.048 }, payouts: false };

const BY_NAME = new Map(COUNTRY_LIST.map((c) => [c.name.toLowerCase(), c]));
const BY_CODE = new Map(COUNTRY_LIST.map((c) => [c.code, c]));

/** A country by name or ISO code; anywhere else gets the card-only defaults, keeping its own name. */
export function countryInfo(country?: string): CountryInfo {
  if (!country) return OTHER_COUNTRY;
  return BY_NAME.get(country.trim().toLowerCase()) ?? BY_CODE.get(country.trim().toUpperCase()) ?? { ...OTHER_COUNTRY, name: country };
}

export const currencyForCountry = (country?: string): CurrencyCode => countryInfo(country).currency;

/** Money in its own currency, in whole units: ₦50,000, KSh 2,500, £12. */
export function formatMoney(amount: number, currency: CurrencyCode): string {
  const c = CURRENCIES[currency] ?? CURRENCIES.USD;
  const neg = amount < 0 ? '−' : '';
  return `${neg}${c.symbol}${Math.abs(amount).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}

/** Rounds up to a whole price people would choose: two significant figures ending in 0 or 5, at least 1. */
function nicePrice(n: number): number {
  if (n <= 1) return 1;
  const mag = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.max(1, Math.ceil(Math.ceil(n / (mag * 5) - 1e-9) * mag * 5 - 1e-9));
}

/**
 * Ovalcast's reference prices were set in naira (the PRD's figures). Elsewhere the
 * same value is shown in the local currency at the reference rate, rounded to a
 * price people would choose. Naira amounts are returned unchanged.
 */
export function localPrice(nairaAmount: number, currency: CurrencyCode): number {
  if (currency === 'NGN') return nairaAmount;
  return nicePrice((nairaAmount / CURRENCIES.NGN.perUsd) * (CURRENCIES[currency] ?? CURRENCIES.USD).perUsd);
}

/** A season label for a competition starting on this date, in the country's style: "2026/27" or "2027". */
export function seasonLabel(country: string | undefined, start = new Date()): string {
  const y = start.getUTCFullYear();
  if (countryInfo(country).season === 'calendar') return String(y);
  // A split season starting in the first half of the year is the second half of last year's.
  const first = start.getUTCMonth() < 6 ? y - 1 : y;
  return `${first}/${String((first + 1) % 100).padStart(2, '0')}`;
}

/** The season after this one, in either style. */
export function nextSeasonLabel(season: string): string {
  const split = season.match(/^(\d{4})\/(\d{2})$/);
  if (split) {
    const y = Number(split[1]) + 1;
    return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
  }
  const year = season.match(/^(\d{4})$/);
  return year ? String(Number(year[1]) + 1) : `${season} (next)`;
}

/**
 * Phone numbers are stored in international form. Accepts a local number for the
 * given country (0802 555 0199) or any number typed with its + code.
 */
export function toInternationalPhone(raw: string, country?: string): string | undefined {
  const trimmed = raw.trim();
  const d = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    const digits = trimmed.startsWith('00') ? d.slice(2) : d;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  }
  const c = countryInfo(country);
  if (!c.dial) return undefined;
  let n = d;
  if (n.startsWith(c.dial) && n.length - c.dial.length >= c.digits[0] && n.length - c.dial.length <= c.digits[1]) n = n.slice(c.dial.length);
  if (n.startsWith('0')) n = n.slice(1);
  return n.length >= c.digits[0] && n.length <= c.digits[1] ? `+${c.dial}${n}` : undefined;
}

/** Normalises an email or phone typed to find someone, using the searcher's country for local numbers. */
export const normaliseIdentifier = (v: string, country?: string) => (v.includes('@') ? v.trim().toLowerCase() : (toInternationalPhone(v, country) ?? v.replace(/[^\d+]/g, '')));

/** The country a phone number belongs to, longest calling code first. */
export function countryOfPhone(international: string): CountryInfo | undefined {
  return [...COUNTRY_LIST].sort((a, b) => b.dial.length - a.dial.length).find((c) => international.startsWith(`+${c.dial}`));
}

/** The law named on sign-up and in the privacy notice. */
export const dataLawFor = (country?: string) => countryInfo(country).dataLaw ?? 'the data protection law where you live';

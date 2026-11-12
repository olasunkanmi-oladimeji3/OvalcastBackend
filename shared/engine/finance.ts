// League money. Entry fees are paid through Flutterwave as split payments:
// Flutterwave takes its fee, Ovalcast takes its service fee, and the rest
// settles straight to the league's own bank account or mobile money wallet
// through a subaccount. Ovalcast never holds a league's money. Pure functions,
// so the app shows the same figures the server reports.

import { COUNTRY_LIST, countryInfo, toInternationalPhone, type CurrencyCode } from './countries';

export type FinanceCurrency = CurrencyCode;
export type FinanceMethod = 'card' | 'bankTransfer' | 'ussd' | 'mobileMoney' | 'cash';
/** auto: the next working day. weekly: every Monday. manual: held by Flutterwave until a league admin withdraws. */
export type SettlementSchedule = 'auto' | 'weekly' | 'manual';

/** Ovalcast's share of online entry payments unless staff set another (for everyone or an organisation). Cash carries none. */
export const DEFAULT_ENTRY_SHARE = 0.02;

/**
 * Flutterwave's published fee for the country whose currency this is
 * (flutterwave.com/<country>/pricing, October 2026): local methods, local cards
 * where they differ, VAT on the fee where it applies (Nigeria). Cards from
 * abroad: 4.8%. The settlement report is the final word.
 */
export function providerFee(amount: number, currency: FinanceCurrency, method: FinanceMethod, international = false): number {
  if (method === 'cash') return 0;
  const fees = (COUNTRY_LIST.find((c) => c.currency === currency) ?? countryInfo()).fees;
  const rate = international ? 0.048 : method === 'card' && fees.card ? fees.card : fees.local;
  return Math.round(amount * rate * (1 + (fees.vatOnFee ?? 0)));
}

/** An entry payment's parts. `rate` is the entry share it was charged at (stored on the payment). */
export function splitPayment(amount: number, currency: FinanceCurrency, method: FinanceMethod, international = false, rate = DEFAULT_ENTRY_SHARE) {
  const provider = providerFee(amount, currency, method, international);
  const service = method === 'cash' ? 0 : Math.round(amount * rate);
  return { gross: amount, providerFee: provider, serviceFee: service, net: amount - provider - service };
}

/** Flutterwave's fee for a manual withdrawal to a Nigerian bank. Elsewhere it is shown on Flutterwave's statement, so 0 here. */
export const transferFee = (amount: number, currency: FinanceCurrency) => (currency !== 'NGN' ? 0 : amount <= 5000 ? 10 : amount <= 50000 ? 25 : 50);

const DAY = 86_400_000;

/** When the provider pays out a payment made at `paidAt`; undefined when the league withdraws by hand. Public holidays are left to the provider. */
export function settlesOn(paidAt: Date, schedule: SettlementSchedule): Date | undefined {
  if (schedule === 'manual') return undefined;
  const d = new Date(Date.UTC(paidAt.getUTCFullYear(), paidAt.getUTCMonth(), paidAt.getUTCDate(), 9));
  do d.setTime(d.getTime() + DAY);
  while (schedule === 'auto' ? d.getUTCDay() === 0 || d.getUTCDay() === 6 : d.getUTCDay() !== 1);
  return d;
}

export interface FinancePayment {
  id: string;
  amount: number;
  method: FinanceMethod;
  at: string;
  settlementId?: string;
  /** Paid with a card from outside the league's country, which costs more. */
  international?: boolean;
  /** Ovalcast's entry share this payment was charged at (0.02 = 2%). Older payments have none: 2% applied. */
  serviceRate?: number;
}

/**
 * Online payments now due to the league, grouped into one payout per day.
 * A payout account changed recently holds everything until `holdUntil`.
 */
export function dueSettlements(payments: FinancePayment[], currency: FinanceCurrency, schedule: SettlementSchedule, now: Date, holdUntil?: Date) {
  const groups = new Map<number, { on: Date; paymentIds: string[]; amount: number }>();
  for (const p of payments) {
    if (p.method === 'cash' || p.settlementId) continue;
    const on = settlesOn(new Date(p.at), schedule);
    if (!on) continue;
    const when = holdUntil && holdUntil > on ? holdUntil : on;
    if (when > now) continue;
    const g = groups.get(when.getTime()) ?? { on: when, paymentIds: [], amount: 0 };
    g.paymentIds.push(p.id);
    g.amount += splitPayment(p.amount, currency, p.method, p.international, p.serviceRate).net;
    groups.set(when.getTime(), g);
  }
  return [...groups.values()].sort((a, b) => a.on.getTime() - b.on.getTime());
}

export interface FinanceEntryRef {
  id: string;
  competitionId: string;
  teamId: string;
  status: string;
  respondedAt?: string;
  payment?: FinancePayment & { provider: string; reference: string; status: string };
}
export interface FinanceCompetitionRef {
  id: string;
  entryFee: number;
}

/** What a league has collected, what it is owed, and where each payment is. */
export function summariseFinance(input: { currency: FinanceCurrency; competitions: FinanceCompetitionRef[]; entries: FinanceEntryRef[]; schedule?: SettlementSchedule; holdUntil?: Date }) {
  const { currency, schedule = 'auto' } = input;
  const ids = new Set(input.competitions.map((c) => c.id));
  const entries = input.entries.filter((e) => ids.has(e.competitionId) && e.status === 'accepted');
  const lines = entries
    .filter((e) => e.payment?.status === 'paid')
    .map((e) => {
      const p = e.payment!;
      const split = splitPayment(p.amount, currency, p.method, p.international, p.serviceRate);
      const on = p.method === 'cash' || p.settlementId ? undefined : settlesOn(new Date(p.at), schedule);
      const expected = on && input.holdUntil && input.holdUntil > on ? input.holdUntil : on;
      return {
        paymentId: p.id, entryId: e.id, competitionId: e.competitionId, teamId: e.teamId, method: p.method, provider: p.provider, reference: p.reference, at: p.at, international: p.international, ...split,
        state: (p.method === 'cash' ? 'cash' : p.settlementId ? 'settled' : 'awaiting') as 'cash' | 'settled' | 'awaiting',
        settlementId: p.settlementId, expectedOn: expected?.toISOString(),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  const fee = (id: string) => input.competitions.find((c) => c.id === id)!.entryFee;
  const unpaid = entries.filter((e) => fee(e.competitionId) > 0 && e.payment?.status !== 'paid').map((e) => ({ entryId: e.id, competitionId: e.competitionId, teamId: e.teamId, amount: fee(e.competitionId), acceptedAt: e.respondedAt }));
  const sum = (xs: { net: number }[]) => xs.reduce((s, x) => s + x.net, 0);
  const awaiting = lines.filter((l) => l.state === 'awaiting');
  const dates = awaiting.map((l) => l.expectedOn).filter((d): d is string => !!d).sort();
  return {
    totals: {
      collected: lines.reduce((s, l) => s + l.gross, 0),
      fees: lines.reduce((s, l) => s + l.providerFee + l.serviceFee, 0),
      settled: sum(lines.filter((l) => l.state === 'settled')),
      awaiting: sum(awaiting),
      cash: sum(lines.filter((l) => l.state === 'cash')),
      outstanding: unpaid.reduce((s, u) => s + u.amount, 0),
    },
    nextPayout: awaiting.length ? { amount: sum(schedule === 'manual' ? awaiting : awaiting.filter((l) => l.expectedOn === dates[0])), on: schedule === 'manual' ? undefined : dates[0] } : undefined,
    competitions: input.competitions
      .filter((c) => c.entryFee > 0 || entries.some((e) => e.competitionId === c.id))
      .map((c) => {
        const mine = lines.filter((l) => l.competitionId === c.id);
        return { competitionId: c.id, entryFee: c.entryFee, clubs: entries.filter((e) => e.competitionId === c.id).length, paid: mine.length, gross: mine.reduce((s, l) => s + l.gross, 0), net: sum(mine), outstanding: unpaid.filter((u) => u.competitionId === c.id).reduce((s, u) => s + u.amount, 0) };
      }),
    unpaid,
    lines,
  };
}

/** Banks and wallets a league can be paid into, from the providers' lists. Codes are the providers' own. */
export const PAYOUT_INSTITUTIONS: Record<string, { code: string; name: string; kind: 'bank' | 'mobileMoney' }[]> = {
  Nigeria: [
    { code: '044', name: 'Access Bank', kind: 'bank' },
    { code: '058', name: 'GTBank', kind: 'bank' },
    { code: '057', name: 'Zenith Bank', kind: 'bank' },
    { code: '011', name: 'First Bank', kind: 'bank' },
    { code: '033', name: 'UBA', kind: 'bank' },
    { code: '070', name: 'Fidelity Bank', kind: 'bank' },
    { code: '221', name: 'Stanbic IBTC', kind: 'bank' },
    { code: '035', name: 'Wema Bank', kind: 'bank' },
    { code: '50515', name: 'Moniepoint', kind: 'bank' },
    { code: '999992', name: 'OPay', kind: 'bank' },
    { code: '999991', name: 'PalmPay', kind: 'bank' },
    { code: '50211', name: 'Kuda', kind: 'bank' },
  ],
  Ghana: [
    { code: 'MTN', name: 'MTN MoMo', kind: 'mobileMoney' },
    { code: 'VOD', name: 'Telecel Cash', kind: 'mobileMoney' },
    { code: 'ATL', name: 'AirtelTigo Money', kind: 'mobileMoney' },
    { code: 'GCB', name: 'GCB Bank', kind: 'bank' },
    { code: 'ECO', name: 'Ecobank Ghana', kind: 'bank' },
    { code: 'CAL', name: 'CalBank', kind: 'bank' },
  ],
  'Sierra Leone': [
    { code: 'ORANGE', name: 'Orange Money', kind: 'mobileMoney' },
    { code: 'AFRICELL', name: 'Afrimoney', kind: 'mobileMoney' },
  ],
  Gambia: [
    { code: 'WAVE', name: 'Wave', kind: 'mobileMoney' },
    { code: 'QMONEY', name: 'QMoney', kind: 'mobileMoney' },
    { code: 'AFRIMONEY', name: 'Afrimoney', kind: 'mobileMoney' },
  ],
  Kenya: [
    { code: 'MPS', name: 'M-Pesa', kind: 'mobileMoney' },
    { code: 'AIRTEL', name: 'Airtel Money', kind: 'mobileMoney' },
    { code: '68', name: 'Equity Bank', kind: 'bank' },
    { code: '01', name: 'KCB', kind: 'bank' },
    { code: '11', name: 'Co-operative Bank', kind: 'bank' },
  ],
  Uganda: [
    { code: 'MTN', name: 'MTN Mobile Money', kind: 'mobileMoney' },
    { code: 'AIRTEL', name: 'Airtel Money', kind: 'mobileMoney' },
    { code: 'STANBIC', name: 'Stanbic Bank Uganda', kind: 'bank' },
  ],
  Tanzania: [
    { code: 'MPESA', name: 'M-Pesa', kind: 'mobileMoney' },
    { code: 'TIGO', name: 'Mixx by Yas', kind: 'mobileMoney' },
    { code: 'AIRTEL', name: 'Airtel Money', kind: 'mobileMoney' },
  ],
  Rwanda: [
    { code: 'MTN', name: 'MTN MoMo', kind: 'mobileMoney' },
    { code: 'AIRTEL', name: 'Airtel Money', kind: 'mobileMoney' },
  ],
  'South Africa': [
    { code: '632005', name: 'ABSA', kind: 'bank' },
    { code: '250655', name: 'FNB', kind: 'bank' },
    { code: '198765', name: 'Nedbank', kind: 'bank' },
    { code: '051001', name: 'Standard Bank', kind: 'bank' },
    { code: '470010', name: 'Capitec', kind: 'bank' },
  ],
  Zambia: [
    { code: 'MTN', name: 'MTN MoMo', kind: 'mobileMoney' },
    { code: 'AIRTEL', name: 'Airtel Money', kind: 'mobileMoney' },
  ],
  Malawi: [
    { code: 'AIRTEL', name: 'Airtel Money', kind: 'mobileMoney' },
    { code: 'TNM', name: 'TNM Mpamba', kind: 'mobileMoney' },
  ],
  Cameroon: [
    { code: 'MTN', name: 'MTN MoMo', kind: 'mobileMoney' },
    { code: 'ORANGE', name: 'Orange Money', kind: 'mobileMoney' },
  ],
  "Côte d'Ivoire": [
    { code: 'MTN', name: 'MTN MoMo', kind: 'mobileMoney' },
    { code: 'ORANGE', name: 'Orange Money', kind: 'mobileMoney' },
    { code: 'WAVE', name: 'Wave', kind: 'mobileMoney' },
  ],
  Senegal: [
    { code: 'ORANGE', name: 'Orange Money', kind: 'mobileMoney' },
    { code: 'WAVE', name: 'Wave', kind: 'mobileMoney' },
  ],
};

/** Checks the shape of an account or wallet number before asking the provider for the name on it. */
export function accountNumberProblem(country: string, kind: 'bank' | 'mobileMoney', value: string): string | undefined {
  const digits = value.replace(/\D/g, '');
  if (kind === 'mobileMoney') return toInternationalPhone(value, country) ? undefined : `Use the wallet's phone number, like ${countryInfo(country).example}`;
  if (country === 'Nigeria') return /^\d{10}$/.test(digits) ? undefined : 'Nigerian account numbers have 10 digits';
  return /^\d{6,18}$/.test(digits) ? undefined : 'Check the account number';
}

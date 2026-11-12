// Flutterwave, the one payment provider for every country: Nigerian cards,
// transfers and USSD, mobile money in Ghana and elsewhere, and cards from abroad.
//
// League entry fees are split payments: each charge names the league's
// subaccount, Flutterwave deducts its fee and Ovalcast's entry share, and settles the
// rest to the league. Ovalcast never holds league money. Pro, match passes,
// wallet top-ups and viewer credits are paid to Ovalcast.
//
// Development uses `devFlutterwave`, which answers like the API does. Production uses
// `liveFlutterwave`, which calls: GET /v3/banks/:country, POST /v3/accounts/resolve,
// POST /v3/subaccounts, POST /v3/payments (hosted checkout, with `subaccounts`
// for entry fees), GET /v3/transactions/:id/verify, and POST /v3/transfers.

import { timingSafeEqual } from 'node:crypto';
import { PAYOUT_INSTITUTIONS, accountNumberProblem, countryInfo } from '@/engine';
import { ApiError, badRequest } from './errors';

export interface CheckoutRequest {
  /** Our reference, Flutterwave's `tx_ref`; the webhook hands it back. */
  txRef: string;
  amount: number;
  currency: string;
  customer: { email?: string; phone?: string; name: string };
  title: string;
  /** Where Flutterwave sends the payer afterwards: the app's ovalcast://payments/done, or the website. */
  redirectUrl: string;
  /** League entry fees: settle to this subaccount, less Ovalcast's share. */
  subaccount?: { id: string; serviceFee: number };
}

export interface VerifiedCharge {
  id: string;
  txRef: string;
  status: 'successful' | 'failed' | 'pending';
  amount: number;
  currency: string;
  paymentType: string;
  /** Where the card was issued, when it was a card. */
  cardCountry?: string;
  paidAt: string;
}

export interface PaymentsProvider {
  institutions(country: string): Promise<{ code: string; name: string; kind: 'bank' | 'mobileMoney' }[]>;
  /** The name on an account, from the bank or network. */
  resolve(input: { country: string; kind: 'bank' | 'mobileMoney'; institutionCode: string; accountNumber: string }): Promise<{ accountName: string }>;
  /** Registers the league's account for split payments. */
  createSubaccount(input: { businessName: string; country: string; institutionCode: string; accountNumber: string; mobile?: string; email?: string; share: number }): Promise<{ subaccountId: string }>;
  /** Starts a hosted checkout; the person pays on Flutterwave's page. */
  checkout(input: CheckoutRequest): Promise<{ link: string }>;
  /** Never trust a webhook alone: ask Flutterwave what really happened. */
  verify(transactionId: string): Promise<VerifiedCharge>;
  /**
   * Sends money out: a league's manual withdrawal or a host's weekly payout. `manual` means it
   * couldn't be sent automatically (no full account number on file) and staff must pay it.
   */
  transfer(input: { amount: number; currency: string; institutionCode: string; accountRef: string; accountNumber?: string; narration: string; reference: string }): Promise<{ reference: string; manual?: boolean }>;
  /** Gives a card or transfer payment back to whoever paid, by Flutterwave's transaction id. */
  refund(input: { transactionId: string; amount: number }): Promise<{ status: string }>;
}

export const devFlutterwave: PaymentsProvider = {
  institutions: async (c) => PAYOUT_INSTITUTIONS[c] ?? [],
  resolve: async ({ country, kind, institutionCode, accountNumber }) => {
    const problem = accountNumberProblem(country, kind, accountNumber);
    if (problem) throw badRequest(problem);
    if (!PAYOUT_INSTITUTIONS[country]?.some((i) => i.code === institutionCode)) throw badRequest('Pick the bank or network');
    // Numbers ending 0000 are "not found", to exercise the error path.
    if (accountNumber.endsWith('0000')) throw new ApiError(404, 'No account with that number. Check it with the bank.');
    return { accountName: 'CRICKET CLUB OF LAGOS' };
  },
  createSubaccount: async ({ accountNumber }) => ({ subaccountId: `RS_dev${accountNumber.slice(-4)}${Date.now().toString(36)}` }),
  checkout: async ({ txRef }) => ({ link: `https://checkout.flutterwave.com/dev/${txRef}` }),
  verify: async (id) => ({ id, txRef: '', status: 'successful', amount: 0, currency: 'NGN', paymentType: 'card', paidAt: new Date().toISOString() }),
  transfer: async ({ reference }) => ({ reference }),
  refund: async () => ({ status: 'completed' }),
};

// ------------------------------------------------------------------ live Flutterwave (v3)

const FLW = 'https://api.flutterwave.com/v3';

async function flw<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(FLW + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string; data?: T };
  if (!res.ok || json.status !== 'success') {
    console.error(`[flutterwave] ${method} ${path}: ${res.status} ${json.message ?? ''}`);
    // Flutterwave's own words for account problems are clear enough to show; anything else isn't.
    throw new ApiError(res.status === 400 || res.status === 404 ? 400 : 502, res.status === 400 || res.status === 404 ? (json.message ?? 'Flutterwave refused that') : 'The payment provider didn’t answer. Try again in a minute.');
  }
  return json.data as T;
}

/** Flutterwave wants an email for every customer; phone-only accounts get one that goes nowhere. */
const customerEmail = (c: CheckoutRequest['customer']) => c.email ?? `${(c.phone ?? 'player').replace(/\D/g, '')}@customers.ovalcast.app`;

export const liveFlutterwave: PaymentsProvider = {
  async institutions(country) {
    const code = countryInfo(country).code;
    // Banks from Flutterwave; mobile money networks from our list, which Flutterwave's bank list doesn't include.
    const banks = await flw<{ code: string; name: string }[]>('GET', `/banks/${code}`).catch(() => []);
    const networks = (PAYOUT_INSTITUTIONS[countryInfo(country).name] ?? []).filter((i) => i.kind === 'mobileMoney');
    return [...networks, ...banks.map((b) => ({ code: b.code, name: b.name, kind: 'bank' as const }))];
  },
  async resolve({ country, kind, institutionCode, accountNumber }) {
    const problem = accountNumberProblem(country, kind, accountNumber);
    if (problem) throw badRequest(problem);
    // Flutterwave can name bank accounts; mobile money wallets it can't, so the admin confirms the number instead.
    if (kind === 'mobileMoney') return { accountName: 'Mobile money wallet (check the number carefully)' };
    const r = await flw<{ account_name: string }>('POST', '/accounts/resolve', { account_number: accountNumber, account_bank: institutionCode });
    return { accountName: r.account_name };
  },
  async createSubaccount({ businessName, country, institutionCode, accountNumber, mobile, email, share }) {
    const r = await flw<{ subaccount_id: string }>('POST', '/subaccounts', {
      account_bank: institutionCode,
      account_number: accountNumber,
      business_name: businessName,
      country: countryInfo(country).code,
      business_mobile: mobile ?? '',
      business_email: email,
      // Ovalcast's share of each entry fee, the same rate each payment's own charge uses (lib/shares).
      split_type: 'percentage',
      split_value: share,
    });
    return { subaccountId: r.subaccount_id };
  },
  async checkout({ txRef, amount, currency, customer, title, redirectUrl, subaccount }) {
    const r = await flw<{ link: string }>('POST', '/payments', {
      tx_ref: txRef,
      amount,
      currency,
      redirect_url: redirectUrl,
      customer: { email: customerEmail(customer), phonenumber: customer.phone, name: customer.name },
      customizations: { title: 'Ovalcast', description: title },
      // Entry fees settle to the league's subaccount, less Ovalcast's fee.
      ...(subaccount ? { subaccounts: [{ id: subaccount.id, transaction_charge_type: 'flat', transaction_charge: subaccount.serviceFee }] } : {}),
    });
    return { link: r.link };
  },
  async verify(id) {
    const d = await flw<{ id: number; tx_ref: string; status: string; amount: number; currency: string; payment_type: string; card?: { country?: string }; created_at: string }>('GET', `/transactions/${encodeURIComponent(id)}/verify`);
    return { id: String(d.id), txRef: d.tx_ref, status: d.status === 'successful' ? 'successful' : d.status === 'failed' ? 'failed' : 'pending', amount: d.amount, currency: d.currency, paymentType: d.payment_type, cardCountry: d.card?.country, paidAt: d.created_at };
  },
  async transfer({ amount, currency, institutionCode, accountNumber, narration, reference }) {
    // Without the full account number (Ovalcast keeps only the last four digits), staff pay it by hand
    // from the backoffice; it's recorded as waiting rather than paid.
    if (!accountNumber) return { reference, manual: true };
    const r = await flw<{ reference: string }>('POST', '/transfers', { account_bank: institutionCode, account_number: accountNumber, amount, currency, narration, reference, debit_currency: currency });
    return { reference: r.reference ?? reference };
  },
  async refund({ transactionId, amount }) {
    const r = await flw<{ status?: string }>('POST', `/transactions/${encodeURIComponent(transactionId)}/refund`, { amount });
    return { status: r.status ?? 'pending' };
  },
};

/** Payments succeed at once in development; production goes through Flutterwave. */
export const payInstantly = () => process.env.NODE_ENV !== 'production';

export function payments(): PaymentsProvider {
  if (process.env.NODE_ENV !== 'production') return devFlutterwave;
  if (!process.env.FLUTTERWAVE_SECRET_KEY) throw new ApiError(501, 'Payments are not connected yet');
  return liveFlutterwave;
}

/**
 * Flutterwave sends the secret hash set on the dashboard in the `verif-hash`
 * header. A match only says the call came from Flutterwave; the charge itself
 * is still verified by id before anything is given.
 */
export function verifyFlutterwaveHash(header: string | undefined, secret = process.env.FLUTTERWAVE_SECRET_HASH) {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Flutterwave's payment types, as our payment methods. */
export const methodOf = (paymentType: string) =>
  paymentType === 'card' ? 'card' : paymentType === 'ussd' ? 'ussd' : paymentType.startsWith('mobilemoney') ? 'mobileMoney' : 'bankTransfer';

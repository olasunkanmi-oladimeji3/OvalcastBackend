// Checks the settings before the server starts. In production a missing essential (no way to
// send codes, no encryption key, development switches left on) stops the start with a list of
// what to fix, instead of failing later in front of people. Anything risky is logged as a warning.


/**
 * Which deployment this is. Development runs on a laptop (NODE_ENV unset or development). Staging and
 * production both run NODE_ENV=production; APP_ENV=staging marks staging, which uses Flutterwave's
 * test keys and may write verification codes to the log. Production is the default for a
 * production build, so a missing APP_ENV gets the strict checks.
 */
export function appEnv(env = process.env): 'development' | 'staging' | 'production' {
  if (env.NODE_ENV !== 'production') return 'development';
  return env.APP_ENV === 'staging' ? 'staging' : 'production';
}

export function checkConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const stage = appEnv(env);
  const errors: string[] = [];
  const warnings: string[] = [];
  const need = (name: string, why: string) => !env[name] && errors.push(`${name} is not set: ${why}`);
  // Read from the settings being checked (the same as the running server's, except in tests).
  const smsProvider = () => (env.SMS_PROVIDER === 'termii' || env.SMS_PROVIDER === 'twilio' ? env.SMS_PROVIDER : 'console');
  const emailProvider = () => (env.EMAIL_PROVIDER === 'postmark' || env.EMAIL_PROVIDER === 'resend' ? env.EMAIL_PROVIDER : 'console');
  const storageDriver = env.STORAGE_DRIVER === 's3' ? 's3' : 'local';

  if (!env.DATABASE_URL) errors.push('DATABASE_URL is not set');
  if (env.APP_ENV && !['development', 'staging', 'production'].includes(env.APP_ENV)) errors.push(`APP_ENV must be staging or production, not "${env.APP_ENV}"`);
  // Supabase signs its certificate with its own authority: without it, a checked connection fails.
  try {
    const db = env.DATABASE_URL ? new URL(env.DATABASE_URL) : undefined;
    const mode = db?.searchParams.get('sslmode');
    if (db && /\.supabase\.(co|com)$/.test(db.hostname) && !env.DATABASE_CA_CERT && mode !== 'no-verify' && mode !== 'disable') errors.push('DATABASE_CA_CERT is not set: Supabase’s SSL certificate (Database, SSL Configuration, Download certificate) is needed to connect securely');
  } catch {
    errors.push('DATABASE_URL isn’t a valid connection string');
  }
  if (env.OVALCAST_ENTRY_SHARE) warnings.push('OVALCAST_ENTRY_SHARE is no longer read: Ovalcast’s shares are set by staff in the backoffice (Staff, Tools, Shares).');
  if (!prod) return { errors, warnings };

  // Live money only in production, test money only in staging.
  const key = env.FLUTTERWAVE_SECRET_KEY ?? '';
  if (key && stage === 'production' && /TEST/i.test(key)) errors.push('FLUTTERWAVE_SECRET_KEY is a test key, and this is production (set APP_ENV=staging for a staging server)');
  if (key && stage === 'staging' && !/TEST/i.test(key)) errors.push('FLUTTERWAVE_SECRET_KEY is a live key, and this is staging: use the test key (FLWSECK_TEST-…) so no real money moves');
  if (stage === 'production' && env.ALLOW_CONSOLE_MESSAGING === 'true') errors.push('ALLOW_CONSOLE_MESSAGING=true would write verification codes to the log. Only staging may do that.');
  if (stage === 'production' && /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL ?? '')) warnings.push('DATABASE_URL points at this machine. Production normally uses the managed database (its pooled connection string).');

  need('SECRETS_KEY', 'stream keys are encrypted with it (32 random bytes, base64)');
  if (env.SECRETS_KEY && Buffer.from(env.SECRETS_KEY, 'base64').length !== 32) errors.push('SECRETS_KEY must be 32 bytes in base64 (openssl rand -base64 32)');
  need('PUBLIC_URL', 'links to uploaded files are built from it');
  need('WEB_URL', 'payment returns, share links and the stream overlay point to the website');
  need('INTERNAL_API_TOKEN', 'the website’s server sends it so it isn’t rate limited as one address');
  need('FLUTTERWAVE_SECRET_KEY', 'payments go through Flutterwave');
  need('FLUTTERWAVE_SECRET_HASH', 'Flutterwave’s payment confirmations are checked with it');

  // Without these nobody can verify a phone or email, so nobody can finish signing up.
  if (env.ALLOW_CONSOLE_MESSAGING !== 'true') {
    if (smsProvider() === 'console') errors.push('SMS_PROVIDER is not set (termii or twilio): verification codes would only be written to the log');
    if (emailProvider() === 'console') errors.push('EMAIL_PROVIDER is not set (postmark or resend): verification codes would only be written to the log');
  }
  if (smsProvider() === 'termii') need('TERMII_API_KEY', 'SMS goes through Termii');
  if (smsProvider() === 'twilio') ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].forEach((n) => need(n, 'SMS goes through Twilio'));
  if (emailProvider() !== 'console') need('EMAIL_FROM', 'the address codes are sent from');
  if (emailProvider() === 'postmark') need('POSTMARK_SERVER_TOKEN', 'email goes through Postmark');
  if (emailProvider() === 'resend') need('RESEND_API_KEY', 'email goes through Resend');

  if (storageDriver === 's3') ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'STORAGE_PUBLIC_URL'].forEach((n) => need(n, 'uploads go to S3-compatible storage'));
  // A redeploy starts from a fresh disk on most hosts (Render included): logos, photos and
  // certificates saved locally would be lost. Production must use S3-compatible storage.
  else if (stage === 'production') errors.push('STORAGE_DRIVER must be s3 in production: files saved on the server’s own disk are lost on every redeploy');
  else warnings.push('Uploads are saved on this machine’s disk (STORAGE_DRIVER=local): they’re lost on redeploy. Fine for a short-lived staging server; otherwise use STORAGE_DRIVER=s3.');
  if (stage === 'production' && !env.WEB_URL?.startsWith('https://')) errors.push('WEB_URL must be the website’s https address: browsers may only call the API from it (and from CORS_ORIGINS)');
  if (storageDriver === 's3' && !env.S3_PRIVATE_BUCKET) warnings.push('S3_PRIVATE_BUCKET is not set: certificates and rules documents share the public bucket under unguessable keys. A separate private bucket is safer.');

  // Development switches.
  if (env.DEV_RETURN_CODES === 'true') errors.push('DEV_RETURN_CODES=true would show verification codes in API replies. Remove it.');
  if (env.DEMO_SIMULATOR === 'true') warnings.push('DEMO_SIMULATOR is ignored in production.');
  if (Number(env.RATE_LIMIT_SCALE ?? 1) > 1) warnings.push(`RATE_LIMIT_SCALE=${env.RATE_LIMIT_SCALE} raises every rate limit. Production should leave it unset.`);
  if (env.INTERNAL_API_TOKEN && env.INTERNAL_API_TOKEN.length < 24) errors.push('INTERNAL_API_TOKEN is too short: use at least 24 random characters (openssl rand -hex 24)');

  const workers = env.WEB_CONCURRENCY === 'auto' || Number(env.WEB_CONCURRENCY ?? 1) > 1;
  if (workers && !env.REDIS_URL) warnings.push('WEB_CONCURRENCY needs REDIS_URL; running one process.');
  if (!env.TRUST_PROXY) warnings.push('TRUST_PROXY is not set. Behind a load balancer or CDN every visitor would look like the proxy and share one rate limit.');
  if (env.PUBLIC_URL && !env.PUBLIC_URL.startsWith('https://')) warnings.push('PUBLIC_URL should be https.');
  return { errors, warnings };
}

/**
 * Optional SMTP email delivery. Entirely inert unless the SMTP_* secrets are
 * configured — the GitHub-only deployment never needs this.
 *
 * Required env: SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM.
 * Optional: SMTP_PORT (default 465, implicit TLS; 587 uses STARTTLS).
 */

export function emailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM);
}

/**
 * Send the markdown report as a plain-text email (markdown bodies read fine
 * as text). Returns false without error when email is not configured or `to`
 * is empty; throws on actual send failure.
 */
export async function sendReportEmail(
  to: string[],
  subject: string,
  markdownBody: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (to.length === 0 || !emailConfigured(env)) return false;

  // Imported lazily so unconfigured runs never touch nodemailer at all.
  const { default: nodemailer } = await import('nodemailer');

  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  await transport.sendMail({
    from: env.MAIL_FROM,
    to,
    subject,
    text: markdownBody,
  });
  return true;
}

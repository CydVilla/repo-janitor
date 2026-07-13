import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.hoisted(() => vi.fn(async () => ({ messageId: 'test' })));
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })));
vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

import { emailConfigured, sendReportEmail } from '../src/reporting/email.js';

const CONFIGURED: NodeJS.ProcessEnv = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'janitor',
  SMTP_PASS: 'hunter2',
  MAIL_FROM: 'janitor@example.com',
};

beforeEach(() => {
  sendMail.mockClear();
  createTransport.mockClear();
});

describe('emailConfigured', () => {
  it('is true when all four SMTP variables are set', () => {
    expect(emailConfigured(CONFIGURED)).toBe(true);
  });

  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'] as const;

  it.each(required)('is false when %s is missing', (key) => {
    const env = { ...CONFIGURED };
    delete env[key];
    expect(emailConfigured(env)).toBe(false);
  });

  it.each(required)('is false when %s is empty', (key) => {
    expect(emailConfigured({ ...CONFIGURED, [key]: '' })).toBe(false);
  });

  it('does not require SMTP_PORT', () => {
    expect(emailConfigured({ ...CONFIGURED, SMTP_PORT: undefined })).toBe(true);
  });
});

describe('sendReportEmail', () => {
  it('returns false without touching nodemailer when unconfigured', async () => {
    const sent = await sendReportEmail(['dev@example.com'], 'Subject', 'body', {});

    expect(sent).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('returns false without touching nodemailer when `to` is empty', async () => {
    const sent = await sendReportEmail([], 'Subject', 'body', CONFIGURED);

    expect(sent).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends the markdown body as plain text and returns true', async () => {
    const body = '# Report\n\n- [x] all good';
    const sent = await sendReportEmail(['dev@example.com', 'ops@example.com'], 'Weekly report', body, CONFIGURED);

    expect(sent).toBe(true);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'janitor', pass: 'hunter2' },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'janitor@example.com',
      to: ['dev@example.com', 'ops@example.com'],
      subject: 'Weekly report',
      text: body,
    });
  });

  it('uses STARTTLS (secure: false) for non-465 ports', async () => {
    await sendReportEmail(['dev@example.com'], 'S', 'b', { ...CONFIGURED, SMTP_PORT: '587' });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false }),
    );
  });

  it('propagates send failures', async () => {
    sendMail.mockRejectedValueOnce(new Error('smtp down'));

    await expect(sendReportEmail(['dev@example.com'], 'S', 'b', CONFIGURED)).rejects.toThrow(
      'smtp down',
    );
  });
});

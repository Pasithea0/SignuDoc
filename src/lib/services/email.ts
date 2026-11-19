import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import nodemailer, { type Transporter } from "nodemailer";
import { Resend } from "resend";

import { getSettings } from "../settings.ts";
import { type EmailTemplateKind } from "../types/domain.ts";
import {
  getEnv,
  isLocalDeployment,
  readEnv,
  type EnvSource,
} from "../utils/env.ts";
import { buildEmailAddresses, type EmailAddresses } from "./email-addresses.ts";
import {
  assertServiceConfig,
  ServiceConfigurationError,
} from "./service-config.ts";

// The addresses mail is sent from and replied to are not needed here: they
// come from RESEND_FROM_EMAIL (SMTP_FROM_EMAIL, for a mail server of your own)
// and SUPPORT_EMAIL when those are set, and from the install's settings
// otherwise, and are looked up when a message is sent.
const RESEND_ENV_KEYS = ["RESEND_API_KEY"] as const;

// A mail server of your own needs the host to talk to and the port. The login
// is optional only for a server that accepts mail without one.
const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_PORT"] as const;

const DEFAULT_CAPTURE_DIR = ".data/outbox";
const DEFAULT_CAPTURE_SENDER_ADDRESS = "dev@signudoc.localhost";

export type EmailDriver = "capture" | "resend" | "smtp";

export type EmailAttachment = {
  content: Uint8Array;
  contentType: string;
  filename: string;
};

/**
 * Resend accepts up to 40 MB per message once attachments are base64
 * encoded, which makes them a third larger. Above this the message goes out
 * with links only.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function fitsAsAttachments(
  attachments: readonly EmailAttachment[],
): boolean {
  return (
    attachments.reduce((total, item) => total + item.content.byteLength, 0) <=
    MAX_ATTACHMENT_BYTES
  );
}

export type TransactionalEmailMessage = {
  /** Not allowed in sendBatch: Resend's batch endpoint takes none. */
  attachments?: EmailAttachment[];
  htmlBody?: string;
  replyTo?: string;
  subject: string;
  template: EmailTemplateKind;
  textBody: string;
  to: string;
};

export type EmailDeliveryResult = {
  accepted: string[];
  messageId?: string;
  rejected: string[];
};

export type EmailSendOptions = {
  idempotencyKey?: string;
};

type CreateEmailServiceOptions = {
  env?: EnvSource;
  /** Replaced in tests, where there is no database to read settings from. */
  resolveAddresses?: () => Promise<EmailAddresses>;
  resendClient?: Resend;
  /** Replaced in tests, so that they do not really wait. */
  wait?: (milliseconds: number) => Promise<void>;
  /** Replaced in tests, which do not talk to a mail server. */
  smtpTransport?: Pick<Transporter, "sendMail">;
};

/** How often a message Resend turned away for rate is tried again. */
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

type ResendResult = {
  error: { name: string } | null;
  headers: Record<string, string> | null;
};

function rateLimitWaitMs(headers: Record<string, string> | null): number {
  const seconds = Number(headers?.["retry-after"]);

  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS)
    : DEFAULT_RATE_LIMIT_WAIT_MS;
}

/**
 * Resend allows a team so many requests a second, across everything that
 * uses its key. A request over that is refused, not queued, so the message
 * would be lost: a signer would never get their copy. It is tried again
 * after the wait Resend names. A used-up daily or monthly quota is also a
 * 429, and is not retried: a second's wait does not bring it back.
 */
async function sendWithinRateLimit<T extends ResendResult>(
  request: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await request();

    if (
      result.error?.name !== "rate_limit_exceeded" ||
      attempt >= RATE_LIMIT_RETRIES
    ) {
      return result;
    }

    await wait(rateLimitWaitMs(result.headers));
  }
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getResendErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return "Email delivery failed.";
}

function buildResendOptions(options?: EmailSendOptions) {
  return options?.idempotencyKey
    ? {
        idempotencyKey: options.idempotencyKey,
      }
    : undefined;
}

function buildResendPayload(
  message: TransactionalEmailMessage,
  config: EmailAddresses,
) {
  return {
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            content: Buffer.from(attachment.content),
            contentType: attachment.contentType,
            filename: attachment.filename,
          })),
        }
      : {}),
    from: config.senderAddress,
    html: message.htmlBody,
    replyTo: message.replyTo ?? config.supportAddress ?? undefined,
    subject: message.subject,
    tags: [
      {
        name: "category",
        value: message.template,
      },
    ],
    text: message.textBody,
    to: [message.to],
  };
}

/** The same message, as a mail server of your own takes it. */
function buildSmtpPayload(
  message: TransactionalEmailMessage,
  config: EmailAddresses,
) {
  return {
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            content: Buffer.from(attachment.content),
            contentType: attachment.contentType,
            filename: attachment.filename,
          })),
        }
      : {}),
    from: config.senderAddress,
    headers: { "X-SignuDoc-Template": message.template },
    html: message.htmlBody,
    replyTo: message.replyTo ?? config.supportAddress ?? undefined,
    subject: message.subject,
    text: message.textBody,
    to: message.to,
  };
}

export interface EmailService {
  send(
    message: TransactionalEmailMessage,
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult>;
  sendBatch(
    messages: readonly TransactionalEmailMessage[],
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult[]>;
}

export function resolveEmailDriver(env: EnvSource = process.env): EmailDriver {
  const configuredDriver = env.EMAIL_DRIVER?.trim().toLowerCase();

  if (!configuredDriver) {
    return "resend";
  }

  if (
    configuredDriver === "capture" ||
    configuredDriver === "resend" ||
    configuredDriver === "smtp"
  ) {
    return configuredDriver;
  }

  throw new Error(
    `Unknown EMAIL_DRIVER "${configuredDriver}". Use "resend", "smtp" or "capture".`,
  );
}

/**
 * Development and test driver: nothing is sent. Each message is written as a
 * JSON file so a person (or the end-to-end test) can read the links in it.
 */
function createCaptureEmailService(
  env: EnvSource,
  resolveAddresses: () => Promise<EmailAddresses>,
): EmailService {
  // Allowed in development, and for a production build that is being run on
  // localhost (which is what the end-to-end test does). Never on a real site.
  if (env.NODE_ENV === "production" && !isLocalDeployment(env)) {
    throw new Error(
      "EMAIL_DRIVER=capture drops every email and cannot be used in production.",
    );
  }

  // The comment stops Turbopack from tracing the whole project into the
  // server bundle because of a path it cannot analyse.
  const captureDir = path.resolve(
    /*turbopackIgnore: true*/ env.EMAIL_CAPTURE_DIR?.trim() ||
      DEFAULT_CAPTURE_DIR,
  );

  async function capture(
    message: TransactionalEmailMessage,
  ): Promise<EmailDeliveryResult> {
    const config = await resolveAddresses();
    const messageId = `capture-${randomUUID()}`;
    const filePath = path.join(
      /*turbopackIgnore: true*/ captureDir,
      `${String(Date.now())}-${messageId}.json`,
    );

    const temporaryPath = `${filePath}.tmp`;

    // Written under a temporary name and renamed, so anything watching the
    // outbox never reads a half-written file.
    await mkdir(captureDir, { recursive: true });
    await writeFile(
      temporaryPath,
      JSON.stringify(
        {
          ...buildResendPayload({ ...message, attachments: undefined }, config),
          // The files themselves are not written out; their names, sizes
          // and fingerprints are enough to check what would have been sent.
          attachments: message.attachments?.map((attachment) => ({
            bytes: attachment.content.byteLength,
            contentType: attachment.contentType,
            filename: attachment.filename,
            sha256: createHash("sha256")
              .update(attachment.content)
              .digest("hex"),
          })),
          capturedAt: new Date().toISOString(),
          messageId,
          template: message.template,
        },
        null,
        2,
      ),
    );
    await rename(temporaryPath, filePath);
    console.info(
      `[email:capture] ${message.template} to ${message.to} -> ${filePath}`,
    );

    return {
      accepted: [message.to],
      messageId,
      rejected: [],
    };
  }

  return {
    send: (message) => capture(message),
    async sendBatch(messages) {
      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await capture(message));
      }

      return results;
    },
  };
}

/**
 * A mail server of your own, over SMTP: the way to run SignuDoc off Vercel
 * and still send real email. The login is optional only for a server that
 * accepts mail without one; a host that refuses it says so, and the message
 * comes back to the person who tried to send.
 */
function createSmtpEmailService({
  resolveAddresses,
  transport,
}: {
  resolveAddresses: () => Promise<EmailAddresses>;
  transport: Pick<Transporter, "sendMail">;
}): EmailService {
  async function send(
    message: TransactionalEmailMessage,
  ): Promise<EmailDeliveryResult> {
    const config = await resolveAddresses();
    const info = await transport.sendMail(
      buildSmtpPayload(message, config),
    );

    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);

    return {
      accepted: accepted.length > 0 ? accepted : [message.to],
      messageId: typeof info.messageId === "string" ? info.messageId : undefined,
      rejected,
    };
  }

  return {
    send,
    async sendBatch(messages) {
      const results: EmailDeliveryResult[] = [];

      // SMTP has no batch of its own: one message is one transaction.
      for (const message of messages) {
        results.push(await send(message));
      }

      return results;
    },
  };
}

function createSmtpTransport(env: EnvSource): Transporter {
  const host = readEnv(env, "SMTP_HOST");
  const port = Number(readEnv(env, "SMTP_PORT"));
  const user = readEnv(env, "SMTP_USER");
  const pass = readEnv(env, "SMTP_PASS");

  return nodemailer.createTransport({
    auth: user && pass ? { pass, user } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    host,
    // 465 is TLS from the first byte; every other port starts in the clear
    // and upgrades, which is what every provider this is used with expects.
    port,
    requireTLS: port !== 465,
    secure: port === 465,
    socketTimeout: 30_000,
    tls: { minVersion: "TLSv1.2" },
  });
}

/** The addresses this install sends from, as configured right now. */
export async function resolveEmailAddresses(
  env: EnvSource = process.env,
): Promise<EmailAddresses> {
  const settings = await getSettings(env);
  const driver = resolveEmailDriver(env);

  if (driver === "capture") {
    return buildEmailAddresses(settings, DEFAULT_CAPTURE_SENDER_ADDRESS);
  }

  // SMTP_FROM_EMAIL pins the sender for a mail server outside Vercel, where
  // there is no Resend account to verify a domain with. It wins over the
  // address stored in Settings, which is what a self-hosted install without
  // it falls back to.
  const smtpFrom = driver === "smtp" ? readEnv(env, "SMTP_FROM_EMAIL") : undefined;

  return smtpFrom
    ? buildEmailAddresses({ ...settings, senderAddress: smtpFrom })
    : buildEmailAddresses(settings);
}

/** What a sender is told when an action needs email and none is connected. */
export const EMAIL_NOT_CONNECTED_MESSAGE =
  "Email is not set up yet, so signers can't be emailed. An administrator can finish email setup in Settings, Organization.";

/**
 * Whether an error is createEmailService's refusal for a missing provider
 * key: a known setup state, not a server failure (issue #53).
 */
export function isEmailNotConnectedError(error: unknown): boolean {
  return (
    error instanceof ServiceConfigurationError &&
    error.message.startsWith("email service ")
  );
}

/**
 * An email service that is only built when a message is first sent. A flow
 * that sends email as a side effect after saving its own work (a signer
 * finishing or declining) uses it, so a missing provider key fails the
 * send, which that flow already logs and survives, instead of the whole
 * request (issue #96).
 */
export function createLazyEmailService(
  create: () => EmailService = () => createEmailService(),
): EmailService {
  let service: EmailService | undefined;
  const resolve = () => (service ??= create());

  return {
    send: async (message, options) => resolve().send(message, options),
    sendBatch: async (messages, options) =>
      resolve().sendBatch(messages, options),
  };
}

export function createEmailService({
  env = process.env,
  resolveAddresses = () => resolveEmailAddresses(env),
  resendClient,
  smtpTransport,
  wait = waitFor,
}: CreateEmailServiceOptions = {}): EmailService {
  const driver = resendClient ? "resend" : resolveEmailDriver(env);

  if (driver === "capture" && !resendClient) {
    return createCaptureEmailService(env, resolveAddresses);
  }

  if (driver === "smtp" && !resendClient) {
    assertServiceConfig("email", SMTP_ENV_KEYS, env);

    return createSmtpEmailService({
      resolveAddresses,
      transport: smtpTransport ?? createSmtpTransport(env),
    });
  }

  if (!resendClient) {
    assertServiceConfig("email", RESEND_ENV_KEYS, env);
  }

  const client = resendClient ?? new Resend(getEnv(env).email.apiKey!);

  return {
    async send(message, options) {
      const config = await resolveAddresses();
      const { data, error } = await sendWithinRateLimit(
        () =>
          client.emails.send(
            buildResendPayload(message, config),
            buildResendOptions(options),
          ),
        wait,
      );

      if (error) {
        throw new Error(getResendErrorMessage(error));
      }

      return {
        accepted: [message.to],
        messageId: data?.id,
        rejected: [],
      };
    },

    async sendBatch(messages, options) {
      if (messages.length === 0) {
        return [];
      }

      if (messages.some((message) => message.attachments?.length)) {
        throw new Error("Messages with attachments must be sent one by one.");
      }

      const config = await resolveAddresses();
      const { data, error } = await sendWithinRateLimit(
        () =>
          client.batch.send(
            messages.map((message) => buildResendPayload(message, config)),
            buildResendOptions(options),
          ),
        wait,
      );

      if (error) {
        throw new Error(getResendErrorMessage(error));
      }

      return messages.map((message, index) => ({
        accepted: [message.to],
        messageId: data?.data[index]?.id,
        rejected: [],
      }));
    },
  };
}

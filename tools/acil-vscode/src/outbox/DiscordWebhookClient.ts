/**
 * DiscordWebhookClient — posts messages to a Discord channel via Incoming Webhook.
 *
 * The webhook URL is stored in VS Code SecretStorage under 'acil.discordWebhook'.
 * Set it via the command: ACIL: Connect Discord Webhook
 *
 * Supports:
 *   - Plain text messages
 *   - Embeds (title, description, color, fields, footer)
 *   - Auto-truncation to Discord's 2000-char message limit
 *   - Rate limit backoff (429 retry-after)
 */

import * as https from 'https';

const DISCORD_CHAR_LIMIT = 2000;
const WEBHOOK_KEY        = 'acil.discordWebhook';

export interface DiscordEmbed {
  title?:       string;
  description?: string;
  color?:       number;   // decimal color e.g. 0x6C63FF = 7103487
  url?:         string;
  fields?:      Array<{ name: string; value: string; inline?: boolean }>;
  footer?:      { text: string };
  timestamp?:   string;  // ISO 8601
}

export interface WebhookPayload {
  content?:   string;
  username?:  string;
  embeds?:    DiscordEmbed[];
}

/** ACIL color palette for Discord embeds */
export const ACIL_COLORS = {
  normal:   0x3FB950,   // green
  advisory: 0xFFB703,   // amber
  warning:  0xFF6B2B,   // orange
  critical: 0xFF3333,   // red
  info:     0x6C63FF,   // purple (ACIL brand)
  approved: 0x56C8E8,   // cyan
  rejected: 0x888888,   // grey
};

export class DiscordWebhookClient {
  constructor(private readonly getSecret: (key: string) => Promise<string | undefined>) {}

  /** Returns true if a webhook URL is stored. */
  async isConfigured(): Promise<boolean> {
    const url = await this.getSecret(WEBHOOK_KEY);
    return !!(url && url.startsWith('https://discord.com/api/webhooks/'));
  }

  /** Store a webhook URL in SecretStorage. */
  async setWebhookUrl(
    store: (key: string, value: string) => Promise<void>,
    url: string,
  ): Promise<void> {
    if (!url.startsWith('https://discord.com/api/webhooks/')) {
      throw new Error('Invalid Discord webhook URL — must start with https://discord.com/api/webhooks/');
    }
    await store(WEBHOOK_KEY, url);
  }

  /** Post a plain text message. */
  async postText(text: string, username = 'ACIL'): Promise<void> {
    const content = text.length > DISCORD_CHAR_LIMIT
      ? text.slice(0, DISCORD_CHAR_LIMIT - 3) + '...'
      : text;
    await this._post({ content, username });
  }

  /** Post a rich embed — used for reply posts to Cursor forum. */
  async postEmbed(embed: DiscordEmbed, username = 'ACIL'): Promise<void> {
    await this._post({ username, embeds: [embed] });
  }

  /**
   * Post an approved reply draft as a formatted Discord message.
   * Used by OutboxReviewPanel after "Approve + Post to Discord".
   */
  async postReply(opts: {
    username:       string;
    replyTo:        string;
    classification: string;
    text:           string;
    forumUrl:       string;
    topicTitle:     string;
  }): Promise<void> {
    const embed: DiscordEmbed = {
      title:       `Reply to @${opts.replyTo} — ${opts.classification}`,
      description: opts.text.length > 1800
        ? opts.text.slice(0, 1797) + '...'
        : opts.text,
      color:       ACIL_COLORS.approved,
      url:         opts.forumUrl,
      fields: [
        { name: 'Thread',         value: `[${opts.topicTitle}](${opts.forumUrl})`, inline: false },
        { name: 'Classification', value: opts.classification,                      inline: true  },
        { name: 'Status',         value: '✅ APPROVED — posted via ACIL',          inline: true  },
      ],
      footer:    { text: `ACIL Bilateral Outbox — imac_$trut` },
      timestamp: new Date().toISOString(),
    };
    await this._post({ username: 'ACIL Outbox', embeds: [embed] });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async _post(payload: WebhookPayload, retries = 1): Promise<void> {
    const webhookUrl = await this.getSecret(WEBHOOK_KEY);
    if (!webhookUrl) throw new Error('Discord webhook not configured. Run: ACIL: Connect Discord Webhook');

    const url = new URL(webhookUrl);
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port:     443,
          path:     url.pathname + url.search,
          method:   'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(body),
            'User-Agent':     'ACIL-DiscordWebhook/1.0',
          },
        },
        res => {
          let raw = '';
          res.on('data', (d: Buffer) => raw += d);
          res.on('end', async () => {
            if (res.statusCode === 204 || res.statusCode === 200) {
              return resolve();
            }
            if (res.statusCode === 429 && retries > 0) {
              // Rate limited — respect retry-after
              const retryAfter = parseFloat(
                (JSON.parse(raw) as any)?.retry_after ?? '1'
              ) * 1000;
              setTimeout(() => {
                this._post(payload, retries - 1).then(resolve).catch(reject);
              }, retryAfter);
              return;
            }
            reject(new Error(`Discord webhook ${res.statusCode}: ${raw.slice(0, 200)}`));
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

/**
 * OutboxClient — GitHub Contents API r/w for ACIL outbox drafts.
 *
 * Reads REPLY_DRAFT_*.json files from:
 *   imKrisK/META-VOICE-SYSTEM / bilateral_communications/outbox/
 *
 * Writes back with status APPROVED or REJECTED.
 * Uses the same PAT stored in SecretManager under 'acil.githubToken'.
 */

import * as https from 'https';

export interface ReplyDraft {
  // BCN envelope
  type:           'REPLY_DRAFT';
  platform:       string;
  topic_id:       number;
  topic_url:      string;
  reply_to: {
    post_number:          number;
    username:             string;
    created_at:           string;
    like_count:           number;
    excerpt:              string;
    reply_to_post_number: number | null;
  };
  classification:  string;
  draft_reply:     string;
  status:          'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'POSTED';
  instructions:    string;
  generated_at:    string;
  generated_by:    string;

  // GitHub file metadata (injected by OutboxClient after fetch)
  _filename?:      string;
  _sha?:           string;
  _path?:          string;
}

const REPO_OWNER = 'imKrisK';
const REPO_NAME  = 'META-VOICE-SYSTEM';
const OUTBOX_PATH = 'bilateral_communications/outbox';
const GH_HOST    = 'api.github.com';
const USER_AGENT = 'ACIL-OutboxClient/1.0';

export class OutboxClient {
  constructor(private readonly getToken: () => Promise<string | undefined>) {}

  private async request<T>(
    method: string,
    path:   string,
    body?:  object,
  ): Promise<T | null> {
    const token = await this.getToken();
    if (!token) throw new Error('No GitHub token — connect via ACIL: Connect GitHub Account');

    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = https.request(
        {
          hostname: GH_HOST,
          port:     443,
          path:     `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
          method,
          headers: {
            'Authorization':       `Bearer ${token}`,
            'Accept':              'application/vnd.github.v3+json',
            'User-Agent':          USER_AGENT,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}),
          },
        },
        res => {
          let raw = '';
          res.on('data', (d: Buffer) => raw += d);
          res.on('end', () => {
            if (res.statusCode === 404) return resolve(null);
            if (res.statusCode! >= 400) return reject(new Error(`GH ${method} ${path} → ${res.statusCode}: ${raw.slice(0, 200)}`));
            try { resolve(raw ? JSON.parse(raw) as T : null); }
            catch (e) { reject(new Error(`JSON parse: ${e}`)); }
          });
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** List all files in the outbox directory. */
  private async listOutbox(): Promise<Array<{ name: string; sha: string; path: string }>> {
    const items = await this.request<Array<{ name: string; sha: string; path: string; type: string }>>(
      'GET', OUTBOX_PATH
    );
    if (!items) return [];
    return items.filter(i => i.type === 'file' && i.name.startsWith('REPLY_DRAFT_') && i.name.endsWith('.json'));
  }

  /** Fetch and decode a single file. */
  private async getFile(filePath: string): Promise<{ content: string; sha: string } | null> {
    const res = await this.request<{ content: string; sha: string; encoding: string }>(
      'GET', filePath
    );
    if (!res) return null;
    const content = Buffer.from(res.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { content, sha: res.sha };
  }

  /**
   * Fetch all PENDING_REVIEW drafts from the outbox.
   * Returns them sorted oldest-first (by generated_at).
   */
  async fetchPending(): Promise<ReplyDraft[]> {
    const files = await this.listOutbox();
    const drafts: ReplyDraft[] = [];

    for (const file of files) {
      const raw = await this.getFile(file.path);
      if (!raw) continue;
      try {
        const draft = JSON.parse(raw.content) as ReplyDraft;
        if (draft.status === 'PENDING_REVIEW') {
          draft._filename = file.name;
          draft._sha      = raw.sha;
          draft._path     = file.path;
          drafts.push(draft);
        }
      } catch {
        // malformed file — skip
      }
    }

    return drafts.sort((a, b) =>
      new Date(a.generated_at).getTime() - new Date(b.generated_at).getTime()
    );
  }

  /**
   * Update the status of a draft in the outbox.
   * Optionally update the draft_reply text if the user edited it.
   */
  async updateStatus(
    draft:      ReplyDraft,
    newStatus:  'APPROVED' | 'REJECTED' | 'POSTED',
    editedText?: string,
  ): Promise<void> {
    if (!draft._path || !draft._sha) throw new Error('Draft missing _path/_sha — cannot update');

    const updated: ReplyDraft = {
      ...draft,
      status:      newStatus,
      draft_reply: editedText ?? draft.draft_reply,
    };

    // Remove internal metadata before saving back
    const { _filename, _sha, _path, ...clean } = updated;

    await this.request('PUT', draft._path, {
      message: `outbox: ${newStatus} reply for @${draft.reply_to.username} post#${draft.reply_to.post_number}`,
      content: Buffer.from(JSON.stringify(clean, null, 2)).toString('base64'),
      sha:     draft._sha,
    });
  }
}

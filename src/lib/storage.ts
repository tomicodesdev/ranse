import type { Env } from '../env';

export const r2Keys = {
  rawEmail: (workspaceId: string, mailboxId: string, messageId: string) =>
    `raw/${workspaceId}/${mailboxId}/${messageId}.eml`,
  textBody: (workspaceId: string, ticketId: string, messageId: string) =>
    `bodies/${workspaceId}/${ticketId}/${messageId}.txt`,
  htmlBody: (workspaceId: string, ticketId: string, messageId: string) =>
    `bodies/${workspaceId}/${ticketId}/${messageId}.html`,
  attachment: (workspaceId: string, ticketId: string, attachmentId: string, filename: string) =>
    `attachments/${workspaceId}/${ticketId}/${attachmentId}/${filename}`,
  export: (workspaceId: string, exportId: string) =>
    `exports/${workspaceId}/${exportId}.zip`,
  workspaceAsset: (workspaceId: string, kind: 'logo', filename: string) =>
    `assets/workspace/${workspaceId}/${kind}/${filename}`,
  userAsset: (workspaceId: string, userId: string, kind: 'avatar', filename: string) =>
    `assets/user/${workspaceId}/${userId}/${kind}/${filename}`,
};

export async function putRaw(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await env.BLOB.put(key, body, { httpMetadata: { contentType } });
}

export async function getText(env: Env, key: string): Promise<string | null> {
  const obj = await env.BLOB.get(key);
  return obj ? await obj.text() : null;
}

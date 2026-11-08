// Durable storage for system states. When STATE_BUCKET is set, every saved
// state is also written to S3, and the server pulls all states down at boot,
// so states saved on the live server survive redeploys. Credentials come from
// the default AWS chain (the instance role on Elastic Beanstalk, a profile locally).
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { writeFileSync, existsSync } from 'node:fs';

const BUCKET = process.env.STATE_BUCKET || '';
const PREFIX = process.env.STATE_PREFIX || 'patchwork-states/';
const s3 = BUCKET ? new S3Client({ region: process.env.AWS_REGION || 'us-east-1' }) : null;

export const durable = () => !!s3;
export const where = () => (s3 ? `s3://${BUCKET}/${PREFIX}` : 'local disk only');

export async function putState(name, json) {
  if (!s3) return false;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${name}.json`, Body: json, ContentType: 'application/json' }));
  return true;
}

export async function getState(name) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${name}.json` }));
  return await r.Body.transformToString();
}

// Download every state in the bucket into dir (a file URL), skipping ones already there.
export async function pullAll(dir) {
  if (!s3) return [];
  const got = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      const name = o.Key.slice(PREFIX.length).replace(/\.json$/, '');
      if (!name || /[^a-z0-9_-]/.test(name)) continue;
      const f = new URL(`${name}.json`, dir);
      if (existsSync(f)) continue;
      writeFileSync(f, await getState(name));
      got.push(name);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return got;
}

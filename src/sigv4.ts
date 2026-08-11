/**
 * AWS SigV4 request signing.
 *
 * Why this exists: in SageMaker Studio, EC2, ECS, Lambda and anywhere else AWS
 * injects an execution role, there IS no API key — credentials arrive as an
 * access key / secret / session token trio, and requests are authenticated by
 * signing them. That's the natural auth path in those environments, and a
 * Bedrock API key would be a second, unnecessary credential.
 *
 * Implemented directly rather than pulling in the AWS SDK: the signing
 * algorithm is ~80 lines of HMAC chaining, and the SDK would add dozens of
 * transitive dependencies to a tool whose whole install story is "zero native
 * deps, nothing to compile".
 *
 * Verified against the signing test vectors AWS publishes for the algorithm.
 */
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  source: string;        // where they came from, for diagnostics
}

const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** ISO8601 basic format: 20260808T210000Z */
export function amzDate(d = new Date()): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Canonical request -> string to sign -> signing key -> Authorization header.
 * Header names are lowercased and sorted; the payload is hashed. Any deviation
 * produces a signature mismatch, so the ordering here is load-bearing.
 */
export function signRequest(opts: {
  method: string;
  url: string;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  headers?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const { method, body, region, service, credentials } = opts;
  const url = new URL(opts.url);
  const now = opts.now ?? new Date();
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-date": stamp,
    ...Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${headers[h]!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  // query params must be sorted and percent-encoded
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const payloadHash = sha256(body);
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
  };
}

// ────────────────────────────────────────────── credential discovery
/**
 * Find AWS credentials the way the SDKs do, in the same order. In SageMaker
 * Studio, ECS and Lambda the environment or the container endpoint is
 * populated automatically, so this returns credentials with no setup at all.
 */
export async function discoverAwsCredentials(
  profileName = process.env.AWS_PROFILE ?? "default",
): Promise<AwsCredentials | undefined> {
  // 1. environment (SageMaker Studio, CI, explicit exports)
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      source: "your environment",
    };
  }
  // 2. container credential endpoint (ECS, SageMaker, CodeBuild)
  const relUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (relUri || fullUri) {
    const url = fullUri ?? `http://169.254.170.2${relUri}`;
    const creds = await fetchContainerCredentials(url);
    if (creds) return creds;
  }
  // 3. shared credentials file (a laptop with `aws configure` run)
  const fromFile = readSharedCredentials(profileName);
  if (fromFile) return fromFile;
  return undefined;
}

async function fetchContainerCredentials(url: string): Promise<AwsCredentials | undefined> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const headers: Record<string, string> = {};
    const token = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    if (token) headers.authorization = token;
    const res = await fetch(url, { headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const b = await res.json() as Record<string, string>;
    if (!b.AccessKeyId || !b.SecretAccessKey) return undefined;
    return {
      accessKeyId: b.AccessKeyId,
      secretAccessKey: b.SecretAccessKey,
      sessionToken: b.Token,
      source: "this environment's role",
    };
  } catch {
    return undefined;
  }
}

/** Minimal INI reader for ~/.aws/credentials — no dependency needed. */
export function readSharedCredentials(
  profileName = "default",
  file = path.join(os.homedir(), ".aws", "credentials"),
): AwsCredentials | undefined {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  const wanted = profileName.replace(/^profile\s+/, "");
  let current = "";
  const section: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.split(/[#;]/)[0]!.trim();
    if (!line) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { current = header[1]!.replace(/^profile\s+/, "").trim(); continue; }
    if (current !== wanted) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    section[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  const id = section["aws_access_key_id"], secret = section["aws_secret_access_key"];
  if (!id || !secret) return undefined;
  return {
    accessKeyId: id,
    secretAccessKey: secret,
    sessionToken: section["aws_session_token"],
    source: `~/.aws/credentials [${wanted}]`,
  };
}

/**
 * Find the AWS region the way the SDKs do.
 *
 * Credentials don't carry a region, but the endpoint and the signature both
 * need one — so it has to come from somewhere. In SageMaker, Lambda and ECS
 * it's already in the environment, and on a laptop it's usually in the config
 * file, which means asking is normally an unnecessary question.
 */
export function discoverAwsRegion(
  profileName = process.env.AWS_PROFILE ?? "default",
  file = path.join(os.homedir(), ".aws", "config"),
): { region: string; source: string } | undefined {
  const env = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (env) {
    return {
      region: env,
      source: process.env.AWS_REGION ? "AWS_REGION" : "AWS_DEFAULT_REGION",
    };
  }
  // ~/.aws/config uses "[profile name]" for everything except default
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  const wanted = profileName === "default" ? "default" : `profile ${profileName}`;
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.split(/[#;]/)[0]!.trim();
    if (!line) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { current = header[1]!.trim(); continue; }
    if (current !== wanted) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim().toLowerCase() === "region") {
      const region = line.slice(eq + 1).trim();
      if (region) return { region, source: `~/.aws/config [${profileName}]` };
    }
  }
  return undefined;
}

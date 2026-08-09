import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  signRequest, amzDate, readSharedCredentials, discoverAwsCredentials,
} from "../src/sigv4.js";

const EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  source: "test",
};

test("sigv4: matches the signature AWS publishes for its worked example", () => {
  const headers = signRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    body: "",
    region: "us-east-1",
    service: "iam",
    credentials: EXAMPLE,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    now: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  });
  // This exact value is the one in AWS's signing documentation. If the
  // canonicalisation drifts by a single byte, this test fails.
  assert.match(headers.authorization!,
    /Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
  assert.match(headers.authorization!,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request/);
  assert.match(headers.authorization!, /SignedHeaders=content-type;host;x-amz-date/);
});

test("sigv4: session tokens are signed in, not just attached", () => {
  const withToken = signRequest({
    method: "POST", url: "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
    body: '{"a":1}', region: "us-east-1", service: "bedrock",
    credentials: { ...EXAMPLE, sessionToken: "FwoGZXIvYXdzEBY..." },
    now: new Date(Date.UTC(2026, 0, 1)),
  });
  assert.equal(withToken["x-amz-security-token"], "FwoGZXIvYXdzEBY...");
  assert.match(withToken.authorization!, /x-amz-security-token/,
    "the token must be inside SignedHeaders or AWS rejects the request");

  // the same request without a token signs differently
  const without = signRequest({
    method: "POST", url: "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
    body: '{"a":1}', region: "us-east-1", service: "bedrock",
    credentials: EXAMPLE, now: new Date(Date.UTC(2026, 0, 1)),
  });
  assert.notEqual(withToken.authorization, without.authorization);
});

test("sigv4: body and region are bound into the signature", () => {
  const base = {
    method: "POST", url: "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
    region: "us-east-1", service: "bedrock", credentials: EXAMPLE,
    now: new Date(Date.UTC(2026, 0, 1)),
  };
  const a = signRequest({ ...base, body: '{"messages":[]}' });
  const b = signRequest({ ...base, body: '{"messages":[{"role":"user"}]}' });
  assert.notEqual(a.authorization, b.authorization, "a tampered body must not verify");

  const other = signRequest({ ...base, body: '{"messages":[]}', region: "eu-west-1" });
  assert.notEqual(a.authorization, other.authorization, "region is part of the scope");
  assert.match(other.authorization!, /eu-west-1/);

  // the payload hash is published so AWS can verify what we sent
  assert.equal(a["x-amz-content-sha256"]!.length, 64);
});

test("sigv4: date format is the basic ISO8601 AWS requires", () => {
  assert.equal(amzDate(new Date(Date.UTC(2026, 7, 8, 21, 30, 15))), "20260808T213015Z");
  assert.ok(!amzDate().includes("-") && !amzDate().includes(":"));
});

test("aws credentials: shared file parses profiles, comments and session tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faber-aws-"));
  const file = path.join(dir, "credentials");
  fs.writeFileSync(file, `
# a comment
[default]
aws_access_key_id = AKIA_DEFAULT
aws_secret_access_key = secret_default

[profile work]
aws_access_key_id = AKIA_WORK
aws_secret_access_key = secret_work
aws_session_token = tok_work   ; trailing comment
`);
  const def = readSharedCredentials("default", file)!;
  assert.equal(def.accessKeyId, "AKIA_DEFAULT");
  assert.equal(def.sessionToken, undefined);

  const work = readSharedCredentials("work", file)!;
  assert.equal(work.accessKeyId, "AKIA_WORK", "the 'profile ' prefix is handled");
  assert.equal(work.sessionToken, "tok_work");

  assert.equal(readSharedCredentials("nope", file), undefined);
  assert.equal(readSharedCredentials("default", "/nonexistent"), undefined);
});

test("aws credentials: the environment is discovered first (this is the SageMaker path)", async () => {
  const prev = {
    id: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    token: process.env.AWS_SESSION_TOKEN,
  };
  try {
    process.env.AWS_ACCESS_KEY_ID = "AKIA_ENV";
    process.env.AWS_SECRET_ACCESS_KEY = "secret_env";
    process.env.AWS_SESSION_TOKEN = "tok_env";
    const creds = (await discoverAwsCredentials())!;
    assert.equal(creds.accessKeyId, "AKIA_ENV");
    assert.equal(creds.sessionToken, "tok_env", "role sessions always carry a token");
    assert.equal(creds.source, "environment");
  } finally {
    for (const [k, v] of Object.entries({
      AWS_ACCESS_KEY_ID: prev.id, AWS_SECRET_ACCESS_KEY: prev.secret, AWS_SESSION_TOKEN: prev.token,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

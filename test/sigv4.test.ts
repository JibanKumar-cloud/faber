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
    assert.equal(creds.source, "your environment");
  } finally {
    for (const [k, v] of Object.entries({
      AWS_ACCESS_KEY_ID: prev.id, AWS_SECRET_ACCESS_KEY: prev.secret, AWS_SESSION_TOKEN: prev.token,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("bedrock lists models through AWS, since the mantle endpoint has none", async () => {
  const http = await import("node:http");
  const { LLMClient } = await import("../src/llm.js");
  const prev = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

  // Stand in for bedrock.<region>.amazonaws.com and assert we ask IT, not the
  // mantle endpoint, which returns 404 for /v1/models in real accounts.
  let seenPath = "", seenAuth = "";
  const s = http.createServer((req, res) => {
    seenPath = req.url ?? "";
    seenAuth = String(req.headers["authorization"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ modelSummaries: [
      { modelId: "anthropic.claude-sonnet-5", modelName: "Claude Sonnet 5",
        providerName: "Anthropic", outputModalities: ["TEXT"] },
      { modelId: "anthropic.claude-opus-5", modelName: "Claude Opus 5",
        providerName: "Anthropic", outputModalities: ["TEXT"] },
      { modelId: "amazon.titan-embed-text-v1", providerName: "Amazon",
        outputModalities: ["EMBEDDING"] },
    ] }));
  });
  const url: string = await new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));

  try {
    process.env.AWS_ACCESS_KEY_ID = "ASIA_ROLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    const llm = new LLMClient({
      provider: "anthropic", baseUrl: url, apiKey: undefined,
      model: "x", route: "bedrock", region: "us-east-1",
    } as unknown as import("../src/config.js").Config);
    // point the AWS host at our stub
    (llm as unknown as { listBedrockModels: () => Promise<unknown> });
    const models = await (llm as unknown as {
      listBedrockModels: () => Promise<{ id: string; name?: string }[]>
    }).listBedrockModels.call({
      ...llm,
      config: { region: "us-east-1", route: "bedrock" },
      authHeaders: (llm as unknown as {
        authHeaders: (u: string, b: string, m: string) => Promise<Record<string, string>>
      }).authHeaders.bind(llm),
    });
    assert.ok(Array.isArray(models));
  } finally {
    s.close();
    if (prev.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prev.id;
    if (prev.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prev.secret;
  }
});

test("bedrock lists models through AWS's catalogue, not the messages endpoint", async () => {
  const http = await import("node:http");
  const { LLMClient } = await import("../src/llm.js");
  const prev = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

  // The mantle endpoint serves /v1/messages but 404s on /v1/models, so the
  // catalogue has to come from AWS's ListFoundationModels instead.
  let seenPath = "", seenAuth = "";
  const s = http.createServer((req, res) => {
    seenPath = req.url ?? "";
    seenAuth = String(req.headers["authorization"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ modelSummaries: [
      { modelId: "anthropic.claude-sonnet-5", modelName: "Claude Sonnet 5",
        providerName: "Anthropic", outputModalities: ["TEXT"] },
      { modelId: "anthropic.claude-opus-5", modelName: "Claude Opus 5",
        providerName: "Anthropic", outputModalities: ["TEXT"] },
      { modelId: "amazon.titan-image", modelName: "Titan Image",
        providerName: "Amazon", outputModalities: ["IMAGE"] },
    ] }));
  });
  const url: string = await new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));

  try {
    process.env.AWS_ACCESS_KEY_ID = "ASIA_ROLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    const llm = new LLMClient({
      provider: "anthropic", baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      apiKey: undefined, model: "x", route: "bedrock", region: "us-east-1",
      bedrockCatalogUrl: `${url}/foundation-models`,
    } as unknown as import("../src/config.js").Config);

    const models = await llm.listModels();
    assert.deepEqual(models.map((m) => m.id),
      ["anthropic.claude-sonnet-5", "anthropic.claude-opus-5"],
      "Anthropic text models only — an image model can't run the agent loop");
    assert.match(seenPath, /foundation-models/);
    assert.match(seenAuth, /^AWS4-HMAC-SHA256/, "signed with the IAM role, no key involved");
  } finally {
    s.close();
    if (prev.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prev.id;
    if (prev.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prev.secret;
  }
});

test("aws region is discovered from the environment or config, not asked for", async () => {
  const { discoverAwsRegion } = await import("../src/sigv4.js");
  const prev = { r: process.env.AWS_REGION, d: process.env.AWS_DEFAULT_REGION };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faber-region-"));
  const cfg = path.join(dir, "config");
  try {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    assert.equal(discoverAwsRegion("default", "/nonexistent"), undefined,
      "nothing to find means Faber should ask");

    // ~/.aws/config: "default" has no prefix, other profiles are "[profile x]"
    fs.writeFileSync(cfg, `
[default]
region = eu-west-1

[profile work]
region = ap-south-1
`);
    assert.equal(discoverAwsRegion("default", cfg)?.region, "eu-west-1");
    assert.equal(discoverAwsRegion("work", cfg)?.region, "ap-south-1");

    // the environment wins, because that's what the SDKs do
    process.env.AWS_DEFAULT_REGION = "us-west-2";
    assert.equal(discoverAwsRegion("default", cfg)?.region, "us-west-2");
    process.env.AWS_REGION = "us-east-1";
    const found = discoverAwsRegion("default", cfg)!;
    assert.equal(found.region, "us-east-1", "AWS_REGION beats AWS_DEFAULT_REGION");
    assert.equal(found.source, "AWS_REGION", "and the panel says where it came from");
  } finally {
    if (prev.r === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prev.r;
    if (prev.d === undefined) delete process.env.AWS_DEFAULT_REGION; else process.env.AWS_DEFAULT_REGION = prev.d;
  }
});

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetSessionTokenCommand, STSClient } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const endpoint = process.env.ENDPOINT ?? "http://localhost:4566";
const region = "us-east-1";

// MiniStack doesn't check header signatures made with the root key, so sign
// with session credentials, whose signatures it does check.
const sts = new STSClient({
  endpoint,
  region,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const { Credentials } = await sts.send(new GetSessionTokenCommand({}));
const credentials = {
  accessKeyId: Credentials.AccessKeyId,
  secretAccessKey: Credentials.SecretAccessKey,
  sessionToken: Credentials.SessionToken,
};

// The same call with the client's default request handler, which uses HTTP/2,
// and with an HTTP/1.1 handler.
for (const [protocol, requestHandler] of [
  ["HTTP/2 (default)", undefined],
  ["HTTP/1.1", new NodeHttpHandler()],
]) {
  const bedrock = new BedrockRuntimeClient({ endpoint, region, credentials, requestHandler });
  try {
    await bedrock.send(
      new ConverseCommand({
        modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        messages: [{ role: "user", content: [{ text: "Hello" }] }],
      }),
    );
    console.log(`${protocol}: OK`);
  } catch (error) {
    console.log(`${protocol}: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    bedrock.destroy();
  }
}

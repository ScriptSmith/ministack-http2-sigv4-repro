import {
  GetCallerIdentityCommand,
  GetSessionTokenCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { NodeHttp2Handler, NodeHttpHandler } from "@smithy/node-http-handler";

const endpoint = process.env.ENDPOINT ?? "http://localhost:4566";
const region = "us-east-1";

// MiniStack accepts any signature made with the root key, so sign with session
// credentials, whose signatures it verifies.
const root = new STSClient({
  endpoint,
  region,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const { Credentials } = await root.send(new GetSessionTokenCommand({}));
const credentials = {
  accessKeyId: Credentials.AccessKeyId,
  secretAccessKey: Credentials.SecretAccessKey,
  sessionToken: Credentials.SessionToken,
};

// The same call, signed the same way, over each protocol.
for (const [protocol, requestHandler] of [
  ["HTTP/1.1", new NodeHttpHandler()],
  ["HTTP/2", new NodeHttp2Handler()],
]) {
  const sts = new STSClient({ endpoint, region, credentials, requestHandler });
  try {
    await sts.send(new GetCallerIdentityCommand({}));
    console.log(`${protocol}: OK`);
  } catch (error) {
    console.log(`${protocol}: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}

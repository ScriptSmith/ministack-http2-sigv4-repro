# MiniStack rejects SigV4 requests that sign `:authority` under AUTH=true

[AI generated]

Since 1.5.27, MiniStack with `AUTH=true` rejects requests that are signed with an IAM user or STS session key when `:authority` is one of the signed headers. It answers `SignatureDoesNotMatch` (`InvalidSignatureException` from JSON protocol services) although the signature is correct.

The AWS SDK for JavaScript v3 signs `:authority` in place of `host` whenever it sends a request over HTTP/2 ([hostHeaderMiddleware.ts](https://github.com/aws/aws-sdk-js-v3/blob/v3.1160.0/packages-internal/core/src/submodules/client/middleware-host-header/hostHeaderMiddleware.ts#L44-L48)). Several of its clients use HTTP/2 by default, including Kinesis, Bedrock Runtime, Bedrock Agent Runtime, Polly, Lex Runtime V2 and Transcribe Streaming ([runtimeConfig.ts](https://github.com/aws/aws-sdk-js-v3/blob/v3.1160.0/clients/client-bedrock-runtime/src/runtimeConfig.ts#L31)). With default settings, these clients fail on every call signed with a session key, such as a call from a Lambda function using its execution role's credentials. Clients that default to HTTP/1.1, such as S3 and DynamoDB, fail the same way when given a `NodeHttp2Handler`.

## Reproduce

`repro.mjs` gets session credentials with `GetSessionToken`, then calls Bedrock `Converse` with them twice: once with the Bedrock Runtime client's default request handler, which uses HTTP/2, and once with an HTTP/1.1 handler:

```
docker compose run --rm repro
```

On 1.5.34, the current `latest`:

```
HTTP/2 (default): InvalidSignatureException: The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.
HTTP/1.1: OK
```

On 1.5.26 both calls succeed:

```
docker compose down
MINISTACK_IMAGE=ministackorg/ministack:1.5.26 docker compose run --rm repro
docker compose down
```

1.5.27 is the first release that fails, and 1.5.34 still does. To run the script against a MiniStack you already have running with `AUTH=true`, use `npm ci && node repro.mjs`, and set `ENDPOINT` if it doesn't listen on `http://localhost:4566`.

## Cause

Over HTTP/2 the host travels in the `:authority` pseudo-header, and the JavaScript SDK signs `:authority` where an HTTP/1.1 request signs `host`.

Hypercorn removes pseudo-headers before the request reaches the app, and copies `:authority` into `host`, as the [ASGI spec](https://asgi.readthedocs.io/en/latest/specs/www.html#http-connection-scope) requires ([utils.py](https://github.com/pgjones/hypercorn/blob/0.18.0/src/hypercorn/utils.py#L66-L78)):

```python
for name, value in headers:
    if name == b":authority":  # h2 & h3 libraries validate this is present
        authority = value
    elif name == b"host":
        host = value
    elif name[0] != b":"[0]:
        filtered_headers.append((name, value))
filtered_headers[0] = (b"host", authority if authority is not None else host)
```

`build_canonical_headers` looks each signed header name up in that header map ([sigv4.py](https://github.com/ministackorg/ministack/blob/v1.5.34/ministack/core/sigv4.py#L58-L64)):

```python
for name in (name for name in signed_headers.split(";") if name):
    raw = headers.get(name, headers.get(name.lower(), ""))
    canonical += f"{name.lower()}:{' '.join(str(raw).split())}\n"
```

There is no `:authority` key, so MiniStack canonicalises `:authority:` with an empty value where the client had `:authority:ministack:4566`, and the signatures differ.

MiniStack's S3 errors include the canonical request it computed, which shows the empty value. An S3 `GetObject` call made with session credentials and `requestHandler: new NodeHttp2Handler()` fails with this `CanonicalRequest`:

```
GET
/repro/object.txt
x-id=GetObject
:authority:
amz-sdk-invocation-id:5059b5e2-59c8-437a-87b6-66dd093dd57e
...
x-amz-user-agent:aws-sdk-js/3.1159.0

:authority;amz-sdk-invocation-id;amz-sdk-request;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-user-agent
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

The failure depends on the signed header name, not the protocol. An HTTP/2 request that signs `host`, such as one sent by `curl --http2-prior-knowledge --aws-sigv4`, is accepted.

[1.5.27](https://github.com/ministackorg/ministack/releases/tag/v1.5.27) started verifying header signatures for IAM user and STS session keys. Before that, this code path didn't run for them. Header signatures made with the root key (`test`, the configured `AWS_ACCESS_KEY_ID`, or a 12-digit account ID) are still not checked, so requests signed that way are not affected.

## Suggested fix

Take the value of a signed `:authority` from `host` when the header map has no `:authority`:

```python
raw = headers.get(name, headers.get(name.lower(), ""))
if name.lower() == ":authority" and ":authority" not in headers:
    raw = headers.get("host", "")
```

With this change applied to the 1.5.34 image, both calls succeed, and a request signed with the wrong secret is still rejected over either protocol.

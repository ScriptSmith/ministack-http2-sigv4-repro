# MiniStack rejects SigV4 requests sent over HTTP/2 under AUTH=true

[AI generated]

Since 1.5.27, MiniStack with `AUTH=true` rejects requests that are signed with an IAM user or STS session key and sent over HTTP/2. It answers `SignatureDoesNotMatch` (`InvalidSignatureException` from JSON protocol services) although the signature is correct. The same request over HTTP/1.1 is accepted.

The AWS SDK for JavaScript v3 sends Bedrock Runtime requests over HTTP/2 by default ([runtimeConfig.ts](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-bedrock-runtime/src/runtimeConfig.ts)), so a Lambda function that calls `InvokeModel` with its execution role's credentials fails on every invocation.

## Reproduce

`repro.mjs` gets session credentials with `GetSessionToken`, then calls `GetCallerIdentity` with them twice, swapping only the request handler between HTTP/1.1 and HTTP/2:

```
docker compose run --rm repro
```

On 1.5.34, the current `latest`:

```
HTTP/1.1: OK
HTTP/2: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.
```

On 1.5.26 both calls succeed:

```
docker compose down
MINISTACK_IMAGE=ministackorg/ministack:1.5.26 docker compose run --rm repro
```

1.5.27 is the first release that fails, and 1.5.34 still does. The JavaScript SDK's DynamoDB and Bedrock Runtime clients are rejected the same way over HTTP/2. To run the script against a MiniStack you already have running with `AUTH=true`, use `npm ci && ENDPOINT=http://localhost:4566 node repro.mjs`.

## Cause

HTTP/2 has no `Host` header. The host travels in the `:authority` pseudo-header, so the JavaScript SDK signs `:authority` where an HTTP/1.1 request signs `host`.

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

[1.5.27](https://github.com/ministackorg/ministack/releases/tag/v1.5.27) started verifying header signatures for IAM user and STS session keys. Before that, this code path didn't run for them. The root key still accepts any signature, so requests signed with it are not affected.

## Suggested fix

Take the value of a signed `:authority` from `host` when the header map has no `:authority`:

```python
raw = headers.get(name, headers.get(name.lower(), ""))
if name.lower() == ":authority" and ":authority" not in headers:
    raw = headers.get("host", "")
```

With this change applied to the 1.5.34 image, both calls succeed, and an HTTP/2 request signed with the wrong secret is still rejected.

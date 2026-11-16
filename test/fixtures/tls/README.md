# TLS test fixtures (TEST ONLY)

Certificates and private keys for the RFC 7589 listener and cert-to-name tests, made by `scripts/tls-fixtures.sh`.
The private keys are public: never trust these certificates anywhere but tests.

| File | What |
|------|------|
| `ca` | The trusted test CA |
| `int` | An intermediate CA, signed by `ca` |
| `server` | CN `router1`, SAN `localhost` and `127.0.0.1`, signed by `ca` |
| `client` | CN `netconf`; SANs DNS `Client.Example.COM`, email `Ops@Example.COM`, IP `192.0.2.7` and `2001:db8::7`, in that order; signed by `ca` |
| `int-client` | CN `int-user`, email `int-user@example.com`, signed by `int`; the `.pem` carries `int` after the leaf |
| `plain-client` | CN `plain`, no SANs |
| `tricky-client` | One email SAN: `evil@example.com, DNS:admin` |
| `multi-cn-client` | Two CNs, no SANs |
| `self-client` | Self-signed, CN `self` |
| `other-ca`, `other-client` | An untrusted CA and a client it issued |

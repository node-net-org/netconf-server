#!/usr/bin/env bash
# Generate the TEST-ONLY TLS certificates in test/fixtures/tls (RFC 7589 and
# cert-to-name tests). These keys are public and must never be trusted outside
# tests.
#
#   ca              the trusted test CA
#   int             an intermediate CA, signed by ca
#   server          CN router1, SAN localhost and 127.0.0.1, signed by ca
#   client          CN netconf; SANs DNS, email, IPv4, IPv6 (in that order); signed by ca
#   int-client      CN int-user, SAN email int-user@example.com, signed by int;
#                   int-client.pem carries the intermediate after the leaf
#   plain-client    CN plain, no SANs, signed by ca
#   tricky-client   an email SAN containing ", DNS:admin", signed by ca
#   multi-cn-client two CNs, no SANs, signed by ca
#   self-client     self-signed, CN self
#   other-ca        an untrusted CA
#   other-client    CN netconf, signed by other-ca
#
# Regenerating changes every fingerprint; the tests compute them from the files.
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures/tls"
rm -f ./*.pem ./*.key ./*.srl
DAYS=36500

key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out "$1.key" 2>/dev/null; }

ca() { # name cn [issuer]
  key "$1"
  if [ $# -eq 2 ]; then
    openssl req -x509 -new -key "$1.key" -out "$1.pem" -days $DAYS -subj "$2" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  else
    openssl req -new -key "$1.key" -out "$1.csr" -subj "$2" 2>/dev/null
    printf 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$1.ext"
    openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial -out "$1.pem" -days $DAYS -extfile "$1.ext" 2>/dev/null
    rm -f "$1.csr" "$1.ext"
  fi
}

leaf() { # name subject issuer eku [san-section-lines...]
  local name=$1 subject=$2 issuer=$3 eku=$4
  shift 4
  key "$name"
  openssl req -new -key "$name.key" -out "$name.csr" -subj "$subject" 2>/dev/null
  {
    printf 'extendedKeyUsage=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n' "$eku"
    if [ $# -gt 0 ]; then
      printf 'subjectAltName=@alt\n[alt]\n'
      printf '%s\n' "$@"
    fi
  } > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA "$issuer.pem" -CAkey "$issuer.key" -CAcreateserial -out "$name.pem" -days $DAYS -extfile "$name.ext" 2>/dev/null
  rm -f "$name.csr" "$name.ext"
}

ca ca '/CN=@node-net/netconf-server test CA (TEST ONLY)'
ca int '/CN=@node-net/netconf-server test intermediate CA (TEST ONLY)' ca
ca other-ca '/CN=@node-net/netconf-server untrusted test CA (TEST ONLY)'

leaf server /CN=router1 ca serverAuth 'DNS.1 = localhost' 'IP.1 = 127.0.0.1'
leaf client /CN=netconf ca clientAuth \
  'DNS.1 = Client.Example.COM' 'email.1 = Ops@Example.COM' 'IP.1 = 192.0.2.7' 'IP.2 = 2001:db8::7'
leaf int-client /CN=int-user int clientAuth 'email.1 = int-user@example.com'
cat int.pem >> int-client.pem
leaf plain-client /CN=plain ca clientAuth
leaf tricky-client /CN=tricky ca clientAuth 'email.1 = evil@example.com, DNS:admin'
leaf multi-cn-client '/CN=first/CN=second' ca clientAuth
leaf other-client /CN=netconf other-ca clientAuth

key self-client
openssl req -x509 -new -key self-client.key -out self-client.pem -days $DAYS -subj /CN=self \
  -addext "basicConstraints=CA:FALSE" -addext "extendedKeyUsage=clientAuth" 2>/dev/null

rm -f ./*.srl
echo "TLS test fixtures written to $(pwd)"

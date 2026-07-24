"""Preflight validation of PUBLIC_ORIGIN as a canonical browser origin.

Used by the `make up` / `make up-cloudflare` guards (closure review F5). The web
runtime derives the cookie `Secure` rule from the browser's `URL.origin`, so the
operator's value must already BE that canonical origin. This validator therefore
accepts a raw string only when a WHATWG URL parser (Node `new URL(...).origin`)
would return it unchanged, and rejects anything that parser would normalize
differently or reject outright.

Parity with the WHATWG host grammar is what the earlier `urllib`/`ipaddress`
version missed, so host parsing is done here directly rather than delegated:

- Scheme must be lowercase `http`/`https` (Cloudflare mode requires `https`); a
  browser lowercases the scheme, so any other casing is non-canonical.
- The authority must be exactly `host[:port]` — no userinfo (`@`), path (`/`),
  query (`?`) or fragment (`#`).
- A bracketed host is IPv6: zone identifiers (`%`, raw or `%25`-encoded) are
  rejected because Node rejects them; the address is re-serialized with the
  WHATWG IPv6 serializer (compress the longest zero run, lowercase hex pieces,
  never the embedded-IPv4 dotted form) and must equal the supplied brackets.
- A host whose last label is a number is parsed as IPv4 (dotted decimal only;
  octal/hex/short forms canonicalize differently and so are rejected).
- Otherwise the host is a domain: ASCII, lowercase, and free of WHATWG forbidden
  domain code points. Underscore, tilde, leading/trailing hyphen, and empty
  labels are accepted because a browser keeps them; non-ASCII is rejected because
  a browser would IDNA-encode it to a different origin.
- A non-default port is kept; an explicit default, zero-padded, empty or
  non-numeric port is rejected (a browser drops or rejects it).

Modes:
  direct       accept http OR https
  cloudflare   as `direct`, but require https
  selftest     run the fixture matrix and exit non-zero if any case misbehaves

Every failure returns ONE generic reason. It never echoes the supplied value or a
parsed credential, because malformed userinfo can carry secrets, and all parse
failures collapse to the same credential-safe message.
"""

import ipaddress
import os
import re
import sys

# This validator uses PEP 604 unions (`str | None`) that are evaluated at import
# time, so it requires Python 3.10+. Fail with a clear message rather than a cryptic
# `TypeError: unsupported operand type(s) for |` on a stale interpreter. Host/CI must
# provide 3.10+ (see repo `.mise.toml`, matching docker/Dockerfile.backend python:3.12).
if sys.version_info < (3, 10):
    raise SystemExit(
        f"validate_origin.py requires Python 3.10+ (found "
        f"{sys.version_info.major}.{sys.version_info.minor}); activate mise or use python 3.12"
    )


_DEFAULT_PORT = {"http": 80, "https": 443}
_SCHEME_RE = re.compile(r"^(https?)://(.*)$", re.DOTALL)
# Last authority label that a browser treats as an IPv4 number (decimal or 0x hex).
_IPV4ISH_LABEL = re.compile(r"^(0[xX][0-9a-fA-F]*|[0-9]+)$")
# WHATWG "forbidden domain code point"s that can appear inside a bare domain host
# once scheme/userinfo/port/path delimiters are stripped. Space, C0, DEL and C1 are
# handled by the global control check; `#`, `/`, `?`, `@`, and `:` cannot reach the
# host token. `%` is included because a browser percent-decodes it; square brackets
# are forbidden unless they delimit an IPv6 literal.
_FORBIDDEN_DOMAIN = set("%<>[\\]^|")


def _serialize_ipv6(inner: str) -> str:
    """Serialize a bracketed IPv6 literal the way WHATWG (Node) does.

    Raises ValueError for a zone identifier or any address `ipaddress` rejects.
    """
    if "%" in inner:
        # Zone identifiers (`fe80::1%eth0`, `fe80::1%25eth0`) are valid to Python
        # but rejected by the WHATWG parser.
        raise ValueError("IPv6 zone identifier")
    packed = ipaddress.IPv6Address(inner).packed
    pieces = [(packed[2 * i] << 8) | packed[2 * i + 1] for i in range(8)]

    # Index of the first longest run (length > 1) of zero pieces to compress.
    compress = -1
    best_len = 0
    run_start = -1
    run_len = 0
    for index, piece in enumerate(pieces):
        if piece == 0:
            run_start = index if run_len == 0 else run_start
            run_len += 1
            if run_len > best_len:
                best_len = run_len
                compress = run_start
        else:
            run_len = 0
    if best_len < 2:
        compress = -1

    out = ""
    ignore_zero = False
    for index, piece in enumerate(pieces):
        if ignore_zero and piece == 0:
            continue
        ignore_zero = False
        if index == compress:
            out += "::" if index == 0 else ":"
            ignore_zero = True
            continue
        out += format(piece, "x")
        if index != 7:
            out += ":"
    return out


def _canonical_domain(host: str) -> str:
    """Return the canonical domain host, or raise ValueError if a browser rejects it.

    Matches WHATWG domain acceptance for ASCII: it does not impose DNS label
    length/shape rules (underscore, tilde, leading/trailing hyphen and empty labels
    are all kept), but rejects non-ASCII (a browser IDNA-encodes it, changing the
    origin) and forbidden domain code points.
    """
    if host == "":
        raise ValueError("empty host")
    if not host.isascii():
        raise ValueError("non-ASCII host")
    if any(ch in _FORBIDDEN_DOMAIN for ch in host):
        raise ValueError("forbidden domain code point")
    # A browser lowercases the ASCII domain; returning the lowered form makes the
    # caller's raw-equality reject any input that carried uppercase.
    return host.lower()


def _canonical_host(host_token: str) -> str:
    """Return the canonical host for a non-bracketed authority, or raise ValueError."""
    parts = host_token.split(".")
    # WHATWG classifies as IPv4 when the last label (ignoring one trailing dot) is a
    # number. IPv4 is parsed strictly: dotted decimal only, so octal/hex/short/
    # trailing-dot forms — which a browser canonicalizes differently — are rejected.
    last = parts[-2] if len(parts) > 1 and parts[-1] == "" else parts[-1]
    if last != "" and _IPV4ISH_LABEL.match(last):
        return str(ipaddress.IPv4Address(host_token))
    return _canonical_domain(host_token)


def origin_violation(value: str, mode: str) -> str | None:
    """Return a generic reason `value` is not a canonical `mode` origin, or None."""
    if not value:
        return "empty"
    # Reject control data (C0, DEL, C1) and any whitespace anywhere; a browser would
    # strip or reject these, so their presence means the raw is not canonical.
    if any(
        ord(ch) < 0x20 or ord(ch) == 0x7F or 0x80 <= ord(ch) <= 0x9F or ch.isspace()
        for ch in value
    ):
        return "contains control or whitespace characters"

    match = _SCHEME_RE.match(value)
    if match is None:
        return "scheme must be lowercase http or https"
    scheme, rest = match.group(1), match.group(2)
    if mode == "cloudflare" and scheme != "https":
        return "Cloudflare mode requires an https origin"
    if "@" in rest:
        return "must not contain userinfo"
    if any(delim in rest for delim in "/?#"):
        return "must not contain a path, query, or fragment"

    try:
        if rest.startswith("["):
            end = rest.index("]")  # ValueError if no closing bracket
            canonical_host = f"[{_serialize_ipv6(rest[1:end])}]"
            after = rest[end + 1 :]
            if after == "":
                port_str = None
            elif after.startswith(":"):
                port_str = after[1:]
            else:
                raise ValueError("trailing data after IPv6 host")
        else:
            host_token, colon, port_str = rest.partition(":")
            if colon == "":
                port_str = None
            canonical_host = _canonical_host(host_token)

        if port_str is None:
            port = None
        else:
            if not port_str.isdigit():
                raise ValueError("non-numeric port")
            port = int(port_str)
            if port > 65535:
                raise ValueError("port out of range")
    except ValueError:
        # Malformed brackets, zone id, invalid host literal, or a bad port all land
        # here and collapse to one credential-safe message.
        return "malformed origin"

    netloc = canonical_host
    if port is not None and port != _DEFAULT_PORT[scheme]:
        netloc = f"{canonical_host}:{port}"
    # A browser serves this origin as exactly `scheme://netloc`. Requiring the raw
    # input to match rejects host case, explicit/zero-padded default ports, trailing
    # slashes, and non-canonical IPv6 in one comparison.
    if value != f"{scheme}://{netloc}":
        return "not a canonical browser origin (differs from URL.origin normalization)"
    return None


# (value, mode, expect_valid). Verdicts are the independent Node `URL.origin` result
# (see the differential in web/verify-deploy.test.ts): the raw is valid iff the URL
# parses, the scheme fits the mode, there is no userinfo, and `url.origin === raw`.
SELFTEST_CASES = [
    # --- Canonical, accepted. ---
    ("http://localhost:3000", "direct", True),
    ("http://localhost", "direct", True),
    ("http://192.168.1.50:3000", "direct", True),
    ("http://127.0.0.1", "direct", True),
    ("https://scheduler.example.com", "direct", True),
    ("https://scheduler.example.com", "cloudflare", True),
    ("https://a.b.example.com:8443", "cloudflare", True),
    ("https://[::1]", "direct", True),
    ("https://[2001:db8::1]", "cloudflare", True),
    ("https://[2001:db8::1]:8443", "cloudflare", True),
    ("https://[::ffff:c000:280]", "cloudflare", True),  # IPv4-mapped, Node hex spelling
    # WHATWG-legal ASCII domains a browser keeps unchanged (previously over-rejected).
    ("https://foo_bar.example", "cloudflare", True),  # underscore
    ("https://foo~bar.example", "cloudflare", True),  # tilde
    ("https://-x.example", "cloudflare", True),  # leading hyphen
    ("https://x-.example", "cloudflare", True),  # trailing hyphen
    ("https://a..b", "cloudflare", True),  # empty interior label
    ("https://example..", "cloudflare", True),  # empty trailing labels
    ("https://example.com.", "cloudflare", True),  # trailing-dot FQDN
    # --- Scheme rules. ---
    ("http://localhost:3000", "cloudflare", False),  # http rejected in cloudflare mode
    ("ftp://host", "direct", False),
    ("scheduler.example.com", "direct", False),  # no scheme
    ("HTTPS://example.com", "cloudflare", False),  # scheme case
    # --- Missing / empty. ---
    ("", "direct", False),
    ("https://", "cloudflare", False),
    ("http://", "direct", False),
    ("https://:3000", "direct", False),  # empty host
    # --- Whitespace / control data. ---
    ("  https://host", "cloudflare", False),
    ("https://host\x01", "direct", False),  # C0
    ("https://host\x7f", "cloudflare", False),  # DEL
    ("https://host\x85", "cloudflare", False),  # C1 (NEL)
    # --- Userinfo / path / query / fragment / trailing slash. ---
    ("https://user:pass@host", "cloudflare", False),
    ("https://host/", "cloudflare", False),
    ("https://host/path", "cloudflare", False),
    ("https://host?q=1", "cloudflare", False),
    ("https://host#frag", "cloudflare", False),
    # --- Host case and default / zero-padded / bad ports. ---
    ("https://EXAMPLE.COM", "cloudflare", False),
    ("https://example.com:443", "cloudflare", False),
    ("http://example.com:80", "direct", False),
    ("https://example.com:0443", "cloudflare", False),
    ("https://host:", "cloudflare", False),  # empty port
    ("https://host:notaport", "cloudflare", False),
    ("https://host:99999", "cloudflare", False),  # port out of range
    # --- Non-ASCII / forbidden domain code points. ---
    ("https://bücher.example", "cloudflare", False),  # IDN → punycode ≠ raw
    ("https://ho^st", "cloudflare", False),  # forbidden ^
    ("https://ho|st", "cloudflare", False),  # forbidden |
    ("https://a[b", "direct", False),  # bare opening bracket
    ("https://a[b", "cloudflare", False),
    ("https://a]b", "direct", False),  # bare closing bracket
    ("https://a]b", "cloudflare", False),
    # --- Invalid or non-canonical IP literals. ---
    ("http://999.999.999.999", "direct", False),
    ("http://192.168.001.1", "direct", False),  # zero-padded octet
    ("http://0x7f.0.0.1", "direct", False),  # hex octet → canonicalized
    ("http://192.168.1.50.", "direct", False),  # dotted-quad trailing dot
    ("https://[::1", "cloudflare", False),  # unclosed bracket
    ("https://[gggg::1]", "cloudflare", False),  # invalid IPv6
    ("https://[0:0:0:0:0:0:0:1]", "cloudflare", False),  # non-compressed IPv6
    (
        "https://[::ffff:192.0.2.128]",
        "cloudflare",
        False,
    ),  # dotted IPv4-mapped ≠ hex canonical
    ("https://[fe80::1%eth0]", "cloudflare", False),  # raw zone id
    ("https://[fe80::1%25eth0]", "cloudflare", False),  # percent-encoded zone id
]


def _selftest() -> int:
    failures = 0
    for value, mode, expect_valid in SELFTEST_CASES:
        if (origin_violation(value, mode) is None) != expect_valid:
            failures += 1
            # Safe to echo here: these are static fixtures, not operator secrets.
            print(
                f"  case mismatch: value={value!r} mode={mode} expected_valid={expect_valid}",
                file=sys.stderr,
            )
    total = len(SELFTEST_CASES)
    print(f"origin validator selftest: {total - failures}/{total} cases correct")
    return 1 if failures else 0


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "direct"
    if mode == "selftest":
        raise SystemExit(_selftest())
    if mode not in ("direct", "cloudflare"):
        print(
            f"usage: validate_origin.py <direct|cloudflare|selftest> (got {mode!r})",
            file=sys.stderr,
        )
        raise SystemExit(2)
    reason = origin_violation(os.environ.get("PUBLIC_ORIGIN", ""), mode)
    if reason is not None:
        print(
            f"ERROR: PUBLIC_ORIGIN is not a valid {mode}-mode origin ({reason}). See docker/.env.example.",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()

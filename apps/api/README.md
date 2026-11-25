# API web management bridge

MCP provider operations and REST provider connection routes share the web
management bridge. Set the API process environment variable
`HTP_WEB_MANAGEMENT_HOST` to exactly one of:

- `htp.hatchtech.dev` (also the default when unset)
- `htp-web-kerry-hatcher.fly.dev` (existing trusted Nitro Fly host)

The selector maps to a fixed HTTPS origin. Empty, non-Unicode, URL-shaped,
whitespace-padded, or any other values fail closed with the existing unavailable
response before sending a request. No request header or tool input selects the
origin. Endpoint paths remain selected by the existing handlers; only the bearer
identity is forwarded, and redirects remain disabled.

This setting does not change OAuth, consent, callback URLs, or hosted services.
It must be set on the API process explicitly before a static dashboard cutover;
this code change does not activate the Fly selection or deploy anything.

Native Google/Bing consent migration is opt-in and held by default. See
[PROVIDER-OAUTH.md](PROVIDER-OAUTH.md) for the static-browser contract, required
Fly callback registrations, matching legacy grant keys, and handshake routing
limits before activation.

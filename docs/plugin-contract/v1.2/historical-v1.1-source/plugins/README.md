# HTP ChatGPT plugin

The private HTP plugin is saved to the owner's ChatGPT account and verified in
the Installed plugins list:

[HTP in ChatGPT](https://chatgpt.com/plugins/plugins_6ae543b9ac44819199c48c1c6c6cf351)

- Plugin ID: `plugins_6ae543b9ac44819199c48c1c6c6cf351`
- Current release: `pluginrel_6ae69545088481919a3ec8450b356222`
- Version: `1.1.0`
- Visibility: private, personal account
- Components verified in saved release: one managed App dependency and three skills

Source is in `htp/`. The account service normalizes the publisher to the verified
creator, Kerry Hatcher; the local manifest follows that saved identity.

## Use

HTP now binds to the managed **HTP connection** App:

- App ID: `asdk_app_6ae552b518e881919bea11aaa5a358cb`
- Connection plugin: `plugin_asdk_app_6ae552b518e881919bea11aaa5a358cb`
- [Connection settings](https://chatgpt.com/plugins/plugin_asdk_app_6ae552b518e881919bea11aaa5a358cb)
- Existing HTP skill plugin identity is unchanged.

Complete **Connect HTP connection** in ChatGPT, then approve access on HTP.
After authorization, select HTP in a fresh chat and verify `list_websites` and
`website_saved_data` before claiming evidence coverage.

Version 1.0.0 uploaded a portable MCP declaration but did not provision the
managed ChatGPT App connection. Its skills loaded while data tools were absent.
A desktop `codex mcp login` signs in a separate desktop connection and does not
repair that cloud binding. Version 1.0.1 replaces the unactivated direct MCP
entry with the verified App dependency. The App owns the existing remote
endpoint, dynamic OAuth client registration, PKCE and refresh-token settings.
No credentials are included in the package.

After the owner completed browser authorization on October 30, 2026
(America/New_York), the managed ChatGPT connection exposed its MCP tools.
Authenticated `list_websites` calls traversed both pages and returned all four
websites. Live `website_saved_data` calls read source inventories (15 for
`www.civpulse.org`, 15 for `www.dreamcleanmacon.com`, 12 for `www.joinjulia.com`,
and 14 for `www.kerryhatcher.com`), a full saved analytics snapshot for each,
and profile-change history (currently empty). Repository-history calls also
succeeded for every website. This verifies connection and data access; it is
not a completed SEO review or an exhaustive traversal of every history page.
The endpoint's separate OAuth and data tests are described in
`../docs/mcp-seo.md`.

## Update

Package the contents of `htp/` as one plugin, excluding this README. Validate its
JSON, skill frontmatter, contained references, and assets; inspect the archive.
Use Plugin Creator's update flow with the existing plugin ID and a freshly read
current release ID. Preserve private visibility and do not create a duplicate.
The server stores compatibility manifests automatically alongside the portable
root manifest and MCP configuration.


## Website management release 1.1.0

Private release `pluginrel_6ae69545088481919a3ec8450b356222` adds the
`website-management` skill and updates SEO guidance for Bing and Seosmith.
The original managed App dependency, private audience, presentation and plugin
identity are preserved. Source read-back confirmed all three skills and the App
binding. The API exposes 18 protected tools: website CRUD, GA4 and Business Profile
bindings, report registration, Seosmith history/detail/import, provider connection
status/disconnection, indexed URL inspection, and the original saved-data and
repository tools. OAuth consent remains interactive. Hosts caching MCP discovery
may need a new chat or connection refresh to display the new tools.


Deployment verification (2026-11-01 UTC): API image
`deployment-01M6ABDT1EFGZEJRQV0GK6Q6DB` and web image
`deployment-01M6ABDX9NT9M1C975W9J51TK4` passed Fly health checks. An existing
non-production test account authenticated normally; all website data changes
went through the live protected MCP endpoint. Discovery returned 18 tools.
Disposable-record create/read/rename/delete, duplicate conflicts, GA4 link/unlink,
empty audit history and invalid-import handling passed, as did both provider
connection status reads. The disposable record was deleted and its absence
verified. No provider was disconnected. These checks confirm live server behavior;
this already-open chat's cached connector tool inventory was not refreshed.

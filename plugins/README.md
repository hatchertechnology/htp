# HTP ChatGPT plugin

The private HTP plugin is saved to the owner's ChatGPT account and verified in
the Installed plugins list:

[HTP in ChatGPT](https://chatgpt.com/plugins/plugins_6ae543b9ac44819199c48c1c6c6cf351)

- Plugin ID: `plugins_6ae543b9ac44819199c48c1c6c6cf351`
- Current release: `pluginrel_6ae553080ca88191a6fb36a4c315b2cc`
- Version: `1.0.1`
- Visibility: private, personal account
- Components verified in saved release: one managed App dependency and two skills

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

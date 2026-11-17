# CI and releases

- **CI** (`.github/workflows/ci.yml`): `mise run check` and `mise run test` on macOS and Windows.
- **Release** (`.github/workflows/release.yml`): pushing a `v*` tag builds a universal macOS `.dmg`
  and Windows `.msi`/`.exe` installers, each with Stockfish bundled, and attaches them to a
  **draft** GitHub Release to review and publish.

```sh
mise run release 0.2.0
git push origin main --follow-tags
```

To build the universal macOS bundle locally, fetch its engine first:
`node scripts/fetch-stockfish.mjs --target universal-apple-darwin`, then
`mise run build -- --target universal-apple-darwin`.

## Signing (optional)

Without these secrets, releases are built unsigned (ad-hoc signed on macOS). Add them as secrets of
the `release` environment (_Settings → Environments → release_, restricted to `v*` tags), e.g.
`gh secret set APPLE_ID --env release`:

| Secret                         | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `APPLE_CERTIFICATE`            | Base64 of the exported "Developer ID Application" `.p12` |
| `APPLE_CERTIFICATE_PASSWORD`   | Password of that `.p12`                                  |
| `APPLE_SIGNING_IDENTITY`       | e.g. `Developer ID Application: Your Name (TEAMID)`      |
| `APPLE_ID`                     | Apple ID email used for notarization                     |
| `APPLE_PASSWORD`               | App-specific password for that Apple ID                  |
| `APPLE_TEAM_ID`                | 10-character team ID                                     |
| `WINDOWS_CERTIFICATE`          | Base64 of a code-signing `.pfx`                          |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password of that `.pfx`                                  |

macOS signing needs the first three; notarization additionally needs the Apple ID trio. With
notarization enabled, both the app and the `.dmg` are notarized and stapled. See
[Tauri: macOS code signing](https://v2.tauri.app/distribute/sign/macos/) and
[Windows code signing](https://v2.tauri.app/distribute/sign/windows/).

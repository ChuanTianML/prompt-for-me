# Settings UI regression tests

These tests mount the real settings component with React and JSDOM. They cover edits during a save, a settings notification arriving before save completion, unchanged drafts, failures, and retries. Each case runs against both the source component and the generated client bundle.

Test dependencies are pinned in `package-lock.json`. From the project root:

```sh
npm ci
npm run check
```

`npm run check` builds the artifacts, runs the Node and React UI suites, and checks the package contents. To run only the UI tests after building:

```sh
npm run test:ui
```

To check an unpacked release instead of the default source and bundle pair:

```sh
PFM_UI_BUNDLE_PATH=/absolute/path/to/package/lib/client.cjs npm run test:ui
```

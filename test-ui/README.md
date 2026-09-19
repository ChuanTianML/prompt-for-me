# Settings UI regression tests

These tests mount the real settings component with React and JSDOM. They cover edits during a save, a settings notification arriving before save completion, unchanged drafts, failures, and retries. They run separately from the dependency-light Node suite.

Use Node.js 24 and install test tools outside the plugin so they cannot change its production dependencies or lockfile:

```sh
ui_tools=$(mktemp -d)
npm install --prefix "$ui_tools" --ignore-scripts --no-package-lock --no-audit --no-fund react@18.3.1 react-dom@18.3.1 jsdom@29.1.1
NODE_PATH="$ui_tools/node_modules" npm run test:ui
npm run build
NODE_PATH="$ui_tools/node_modules" PFM_UI_BUNDLE_PATH="$PWD/lib/client.cjs" npm run test:ui
```

`NODE_PATH` may instead point to an existing installation of these tools. `PFM_UI_BUNDLE_PATH` selects a built or unpacked release client for the same tests. CI checks both source and generated code.

// Installed transfer/sync plugins. Each plugin is a module exporting
//   { id, install(ctx) }
// where ctx = { store, toast, t, isEn, closePanel, refreshPanel, setSyncStatus, registerDataAction }.
//
// Plugins only use whole snapshots (store.exportText() / store.importData()),
// so removing a line here removes the feature with no other code changes.

import googleDrive from './google-drive/index.js';
import shareLink from './share-link.js';

export default [googleDrive, shareLink];

// Runs tidy() off the main thread so large maps (seconds of layout work) never
// freeze the page. Receives { doc }, replies { layout } or { error }.

import { tidy } from './layout.js';

self.onmessage = ({ data }) => {
  try {
    const doc = data.doc;
    tidy(doc);
    self.postMessage({ layout: doc.layout });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};

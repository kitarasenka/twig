// Evaluated before `prismjs`: Prism otherwise scans the whole page for
// `language-*` elements on load and listens for worker messages. 🌱 Twig only
// asks it to tokenize strings, so both are switched off. `self` is the page or
// the highlighting worker; in Node there is neither and Prism never looks.
if (typeof self !== 'undefined') self.Prism = { manual: true, disableWorkerMessageHandler: true };

// Evaluated before `prismjs`: Prism otherwise scans the whole page for
// `language-*` elements on load and listens for worker messages. 🌱 Twig only
// asks it to tokenize strings, so both are switched off. (In Node there is no
// window and Prism never looks.)
if (typeof window !== 'undefined') window.Prism = { manual: true, disableWorkerMessageHandler: true };

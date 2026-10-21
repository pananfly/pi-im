// Publish entry. pi labels an extension by its package name only when the
// entry is a package source whose file is named `index`; pointing
// `pi.extensions` at `dist/extension.js` made the startup list show
// "extension.js" instead of the package name. Keep this file at the package
// root so the label stays `@pananfly/pi-im`.
export { default } from "./dist/extension.js";

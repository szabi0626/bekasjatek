// Builds the game as one self-contained HTML file for publishing as a claude.ai Artifact.
// Usage: npm run build && node scripts/build-artifact.mjs  ->  artifact/flippin-frogs.html
import fs from "node:fs";
import path from "node:path";

const dist = "dist";
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const jsFile = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/)[1];
const cssFile = html.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/)[1];
const js = fs.readFileSync(path.join(dist, jsFile), "utf8").replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync(path.join(dist, cssFile), "utf8");

// The Artifact publisher supplies doctype, head and body; the page starts with its own title and style.
const page = `<title>Flippin' frogs</title>
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`;
fs.mkdirSync("artifact", { recursive: true });
fs.writeFileSync("artifact/flippin-frogs.html", page);
console.log(`artifact/flippin-frogs.html  ${(page.length / 1024).toFixed(0)} KiB`);

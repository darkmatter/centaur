import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";

const code = createCodePlugin({ themes: ["github-light", "github-dark-default"] });

export const streamdownPlugins = { cjk, code, math, mermaid };

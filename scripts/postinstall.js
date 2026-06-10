#!/usr/bin/env node
// Shown once after: npm install @cachly-dev/openclaw

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
};

const line = `${c.dim}─────────────────────────────────────────────────────${c.reset}`;

console.log(`
${line}
  ${c.bold}${c.red}🦅 @cachly-dev/openclaw${c.reset} ${c.dim}v${process.env.npm_package_version ?? ""}${c.reset}

  ${c.bold}You paid for that LLM answer. Stop paying for it again.${c.reset}

  ${c.cyan}const cache = createSemanticLLMCache({ url: process.env.CACHLY_URL })${c.reset}
  ${c.cyan}const reply = await cache.getOrSet(prompt, () => openai.chat(...))${c.reset}

  ${c.green}Same question = $0.00. Always. Free instance at cachly.dev${c.reset}

  ${c.dim}───────────────────────────────────────────────────────${c.reset}
  ${c.yellow}🧠 Also give your AI editor permanent memory:${c.reset}
  ${c.cyan}npx @cachly-dev/init${c.reset}   ${c.dim}Claude Code · Cursor · Copilot · Windsurf${c.reset}

${line}`);

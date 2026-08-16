<script lang="ts">
  import SvelteMarkdown, { buildUnsupportedHTML } from "@humanspeak/svelte-markdown";

  let { source, tone = "default" }: { source: string; tone?: "default" | "thinking" } = $props();
  const renderers = { html: buildUnsupportedHTML() };
</script>

<div class="markdown-content {tone}">
  <SvelteMarkdown {source} {renderers} options={{ gfm: true, breaks: true }} />
</div>

<style>
  .markdown-content { min-width: 0; color: #e1ece8; font: 11px/1.72 Inter, system-ui, sans-serif; overflow-wrap: anywhere; }
  .markdown-content.thinking { color: #c5bced; font-style: italic; }
  .markdown-content :global(> :first-child) { margin-top: 0; }
  .markdown-content :global(> :last-child) { margin-bottom: 0; }
  .markdown-content :global(p) { margin: 0 0 10px; }
  .markdown-content :global(strong) { color: #f0f7f4; font-weight: 750; }
  .markdown-content.thinking :global(strong) { color: #ddd6ff; }
  .markdown-content :global(em) { color: inherit; }
  .markdown-content :global(a) { color: var(--green); text-decoration: underline; text-decoration-color: rgba(93,225,158,.35); text-underline-offset: 3px; }
  .markdown-content :global(a:hover) { text-decoration-color: var(--green); }
  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3),
  .markdown-content :global(h4) { margin: 16px 0 7px; color: #edf6f2; font-size: 12px; line-height: 1.35; }
  .markdown-content :global(ul), .markdown-content :global(ol) { margin: 7px 0 11px; padding-left: 22px; }
  .markdown-content :global(li) { margin: 3px 0; padding-left: 2px; }
  .markdown-content :global(li::marker) { color: #5de19e; }
  .markdown-content :global(blockquote) { margin: 10px 0; padding: 7px 11px; border-left: 2px solid #6e62a8; color: #afa7d8; background: rgba(111,94,170,.07); }
  .markdown-content :global(code) { border: 1px solid rgba(157,190,178,.1); border-radius: 4px; padding: 1px 4px; color: #aee9ca; background: rgba(93,225,158,.055); font: 10px/1.55 "SFMono-Regular", Menlo, monospace; }
  .markdown-content :global(pre) { max-width: 100%; margin: 10px 0; overflow: auto; border: 1px solid rgba(157,190,178,.1); border-radius: 7px; padding: 11px 13px; background: #010705; }
  .markdown-content :global(pre code) { border: 0; padding: 0; color: #c7d8d2; background: transparent; font-style: normal; white-space: pre; overflow-wrap: normal; }
  .markdown-content :global(hr) { margin: 14px 0; border: 0; border-top: 1px solid rgba(157,190,178,.12); }
  .markdown-content :global(table) { width: 100%; margin: 10px 0; border-collapse: collapse; font-size: 10px; }
  .markdown-content :global(th), .markdown-content :global(td) { border: 1px solid rgba(157,190,178,.12); padding: 6px 8px; text-align: left; }
  .markdown-content :global(th) { color: #b9d0c8; background: rgba(157,190,178,.055); }
  .markdown-content :global(del) { color: #71847e; }
</style>

/** Fictional provider metadata for offline model selection and transport tests. */
export const TEST_MODEL_CATALOG = {
  providers: {
    "test-provider": {
      baseUrl: "https://models.example.invalid/v1",
      api: "openai-responses",
      apiKey: "unit-test-only",
      models: ["director-model", "implementer-model"].map((id) => ({
        id,
        reasoning: true,
        thinkingLevelMap: { high: "high", max: "max" },
        input: ["text"],
        contextWindow: 64000,
        maxTokens: 1024,
      })),
    },
  },
};

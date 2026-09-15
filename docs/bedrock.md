# OpenAI agents through Amazon Bedrock

Use the operator-owned Pi catalog in `examples/bedrock/models.json` with the
`agent.modelsPath` setting. The path resolves relative to the harness config and
is shared by the director, implementer, optional reviewers/advisors and CLI
validation. Existing configs without this field keep Pi's default catalog.

```json
{
  "agent": {
    "modelsPath": "./bedrock.models.json",
    "model": "amazon-bedrock-responses/openai.gpt-6-astra",
    "thinkingLevel": "high",
    "backend": {"type": "pi-sdk"},
    "orchestration": {"mode": "directed", "maxRevisions": 2},
    "roles": {
      "director": {"model": "amazon-bedrock-responses/openai.gpt-6-astra", "thinkingLevel": "high"},
      "implementer": {"model": "amazon-bedrock-responses/openai.gpt-5.6-luna", "thinkingLevel": "max"}
    }
  }
}
```

The example targets the regional `bedrock-mantle` endpoint in `us-west-2`:
`https://bedrock-mantle.us-west-2.api.aws/openai/v1`. Requests use OpenAI's
Responses protocol with AWS model IDs `openai.gpt-6-astra` and
`openai.gpt-5.6-luna`. `amazon-bedrock-responses` is a local provider identifier,
not a separate service. Do not substitute the generic Bedrock Converse catalog:
the bundled catalog may omit Astra and clamp Luna's `max` reasoning level.

Set `PINPOINT_BEDROCK_TOKEN_FILE` to an existing private file containing only the
Bedrock API key (mode 600). The catalog's credential command reads that file at
request time, so replacing its contents rotates the key without writing it into
the harness config. The command captures stdout internally; do not run it in a
terminal or print the key. Keep the file outside candidate workspaces and data
mounts. An OpenAI/Codex login is not used by this provider.

`validate --check-auth` checks model resolution and credential availability. It
does not invoke a model or prove inference permissions. Unit tests mock the HTTP
transport and assert both model IDs, the Oregon URL, reasoning efforts, function
tool definitions and streaming payloads. A paid live inference probe requires a
separate deliberate action.

The catalog includes AWS's regional token prices and long-context tiers as of
2026-09-15. Recorded costs are estimates; AWS billing remains authoritative.

Sources: [Astra model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html),
[Luna model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html),
[Bedrock Responses API](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html).

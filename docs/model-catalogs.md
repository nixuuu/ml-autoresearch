# Operator-supplied model catalogs

The framework does not select a deployment, provider, region or model pair for
your research. Keep those choices in the scenario's configuration. Use
`agent.modelsPath` to load an operator-owned Pi model/provider catalog without
changing framework source or a user's global Pi settings.

The path resolves relative to the harness configuration. CLI validation,
authentication checks and every agent role use the same catalog. Configurations
without this field keep Pi's default catalog.

## Configuration example

The following identifiers are placeholders. Replace them with models available
through your provider, and choose reasoning levels supported by those models.

```json
{
  "agent": {
    "modelsPath": "./models.json",
    "model": "research-provider/director-model",
    "thinkingLevel": "high",
    "backend": {"type": "pi-sdk"},
    "orchestration": {"mode": "directed", "maxRevisions": 2},
    "roles": {
      "director": {"model": "research-provider/director-model", "thinkingLevel": "high"},
      "implementer": {"model": "research-provider/implementer-model", "thinkingLevel": "high"}
    }
  }
}
```

An illustrative `models.json` for a Responses-compatible service:

```json
{
  "providers": {
    "research-provider": {
      "baseUrl": "https://models.example.invalid/v1",
      "api": "openai-responses",
      "apiKey": "$RESEARCH_PROVIDER_API_KEY",
      "models": [
        {"id": "director-model", "reasoning": true},
        {"id": "implementer-model", "reasoning": true}
      ]
    }
  }
}
```

The example endpoint is deliberately non-routable. Select the API protocol,
endpoint, model IDs, supported reasoning levels, context limits and prices from
your provider's documentation. The `openai-responses` value identifies a wire
protocol; it does not require a particular hosting provider.

## Authentication and validation

Keep credentials outside candidate workspaces, data mounts and version control.
The catalog can refer to an environment variable or a credential command, such
as `!cat -- "$RESEARCH_API_KEY_FILE"` for a private host file. Pi resolves
credential commands at request time. Do not print their output in a terminal.

`validate --check-auth` checks model resolution and credential availability. It
does not invoke a model or prove inference permissions. The runtime tests use a
fictional provider and mocked HTTP transport; they cover model selection,
reasoning effort, function-tool definitions and streaming without external calls.

Dataset definitions, metrics, research prompts, operational endpoints and
deployment procedures belong to the consuming scenario, outside this framework.

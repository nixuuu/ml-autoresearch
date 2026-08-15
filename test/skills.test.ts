import assert from "node:assert/strict";
import { test } from "bun:test";
import { getAgentSkill, listAgentSkills, renderAllAgentSkills } from "../src/skills.js";

test("bundled agent skills have valid names, frontmatter, and unique entries", () => {
  const skills = listAgentSkills();
  assert.equal(skills.length, 4);
  assert.equal(new Set(skills.map((skill) => skill.name)).size, skills.length);

  for (const skill of skills) {
    assert.match(skill.name, /^[a-z0-9-]+$/);
    assert.match(skill.content, new RegExp(`^---\\nname: ${skill.name}\\n`));
    assert.match(skill.content, /\ndescription: .+\n---\n/);
    assert.equal(getAgentSkill(skill.name)?.content, skill.content);
  }
});

test("scenario skill routes an agent to config, evaluator, and CLI guidance", () => {
  const scenario = getAgentSkill("ml-autoresearch-design-scenario");
  assert.ok(scenario);
  assert.match(scenario.content, /\$ml-autoresearch-author-config/);
  assert.match(scenario.content, /\$ml-autoresearch-build-evaluator/);
  assert.match(scenario.content, /\$ml-autoresearch-operate-cli/);

  const all = renderAllAgentSkills();
  assert.match(all, /AUTORESEARCH_METRICS_PATH/);
  assert.match(all, /maxWallTimeMinutes/);
});

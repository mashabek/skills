# example-skill

Template for a skill plugin. A skill is a `SKILL.md` Claude reads when a task matches its
description. Wrapping it in a plugin lets it be installed from the marketplace.

```bash
claude plugin install example-skill@skills
```

To make a real skill from this: copy the folder, use the same name in the folder, in
`.claude-plugin/plugin.json` and in `skills/<name>/`, write `skills/<name>/SKILL.md`, and add
the plugin to the root `marketplace.json`.

<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

> `pi-cc` is a private, operator-only fork of [earendil-works/pi](https://github.com/earendil-works/pi). It is not published and takes no outside issues or PRs.

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Pi packages](docs/packages.md) and share via npm or git.

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

Use Pi [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Pi TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install from a source checkout of `just-joshn/pi-cc`. Pi requires Node.js 22.19 or newer.

```bash
git clone https://github.com/just-joshn/pi-cc
cd pi-cc
npm install --ignore-scripts
./pi-test.sh
```

See the [quickstart](docs/quickstart.md#1-install-pi) for details.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
/path/to/pi-cc/pi-test.sh
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Development

Clone the repository, install its dependencies, and run Pi from source:

```bash
git clone https://github.com/just-joshn/pi-cc
cd pi-cc
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before merging changes, run:

```bash
npm run check
./test.sh
```

This fork is private and operator-only. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the local workflow and [AGENTS.md](../../AGENTS.md) for repository-specific implementation, testing, and dependency rules.

## License

MIT. Derived from [earendil-works/pi](https://github.com/earendil-works/pi); upstream attribution is retained.

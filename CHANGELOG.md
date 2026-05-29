# Changelog

All notable changes to Reverie are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Reverie is in active early development and has not had a tagged release yet.
The first release will be cut by pushing a `v*` tag, which triggers the release
build pipeline (see `.github/workflows/release.yml`).

### Added
- MIT license and open-source project documentation.
- Continuous integration and tag-triggered release build pipelines.
- Pre-commit linting/formatting (Biome, rustfmt) and Conventional Commit
  validation (commitlint) via Husky.

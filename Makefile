# Release helpers. `make patch|minor|major` bumps package.json, renames the CHANGELOG's "Unreleased" to the new
# version, commits, tags v<version> and pushes:
# the tag makes CI test, publish to the Marketplace and create the GitHub release.
.PHONY: patch minor major package e2e

patch minor major:
	npm version $@
	git push --follow-tags

# Local .vsix, e.g. to try a build before releasing it.
package:
	npx @vscode/vsce package

# End-to-end run against a fresh X-HEEP clone; needs the X-HEEP tools (conda env, toolchain, Verilator).
e2e:
	npm run compile-tests
	node out/test/e2e.js

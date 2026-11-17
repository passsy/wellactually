# Maintainer documentation

This directory documents current behavior and repeatable operating procedures.
Keep it aligned with the code, package scripts and workflows. Do not add plans,
proposals, implementation diaries, review reports or historical test results here;
use pull requests and issues for those. Update documentation in the same change
that changes the behavior it describes.

- [Plugin testing and releases](releasing-review.md): supported runtime versions,
  local plugin testing, testing an exact npm version, npm staging/2FA approval,
  marketplace pin promotion and rollback.
- [Detector SDK releases](releasing-detector-sdk.md): author installation,
  compatibility, independent SDK packaging/testing, bundled license notices,
  one-time npm setup and staged releases.
- [Claude findings delivery](claude-findings.md): current browser inbox behavior
  and the disabled inline card integration.

The [repository README](../README.md) covers product installation, detector
authoring and the source layout. The [scripts reference](../scripts/README.md)
describes the build and release helpers.

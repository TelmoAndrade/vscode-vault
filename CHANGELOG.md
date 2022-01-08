# Change Log

All notable changes to the "vault-to-env" extension will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 0.0.5

- Fix the write to the .env file, scroll first and then edit

## 0.0.4

- Scroll when editing the .env file

## 0.0.3

- Ability to write the .env file in the selected workspace
- Support for multiple workspaces

## 0.0.2

- Build with webpack

## 0.0.1

- Initial release

### Added
- Support for authenticating via a native Vault client
- Support for authenticating via a Username & Password backend
- Ability to read JSON payloads to Vault paths
- Ability to read key/value pairs to Vault paths
- Ability to write .env file all attribute values from existing Vault paths
# Manifest Auditor Skill

## Purpose
Validates Chrome Extension Manifest V3 files to ensure compatibility with Web Store guidelines, permissions containment, and zero external leakage of biometric or camera data.

## Workflow
1. Check `manifest_version` equals `3`.
2. Inspect `permissions` array for deprecated or overly permissive scopes.
3. Validate that content scripts specify strictly scoped URL matches.
4. Ensure facecam contexts operate strictly within isolated offline memory.

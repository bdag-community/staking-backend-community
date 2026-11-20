# Branches and deployment

Contributions go to `develop`. Maintainers promote reviewed changes to `main`.
GitHub Actions runs unprivileged tests and builds. Runtime credentials stay
with the operators of the deployment target.

This repository does not run the former provider's Kubernetes workflows.
A future deploy job must use the approved component-specific target and
a branch-restricted environment.
